import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AiService } from "../ai/ai.service";
import { AiUsageService } from "../ai/ai-usage.service";
import { FinancialContextBuilder } from "../ai/context/financial-context.builder";
import { AiAgentToolRegistry } from "../mcp/ai-agent-tool-registry";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  AiMessage,
  AiProvider,
  AiToolCall,
} from "../ai/providers/ai-provider.interface";
import { OllamaModelDoesNotSupportToolsError } from "../ai/providers/ollama.provider";
import { assessInjectionRisk } from "../ai/context/prompt-injection-detector";
import { QUERY_SAFETY_REMINDER } from "../ai/context/prompt-templates";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_MAX_HISTORY_MESSAGES } from "./dto/ai-agent-query.dto";

const MAX_ITERATIONS = 5;
const MAX_TOOL_CALLS = 15;
const QUERY_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const MAX_INPUT_TOKENS = 200_000;
const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * The scopes string passed into the in-process MCP user context.
 * Read-only = read + reports; edit = read + reports + write.
 * (Comma-separated, matching the OAuth scope encoding in mcp-context.ts.)
 */
const READONLY_SCOPES = "read,reports";
const EDIT_SCOPES = "read,reports,write";

export type AgentWriteMode = "readonly" | "edit";

export interface AgentStreamEvent {
  type:
    | "thinking"
    | "assistant_text"
    | "tool_start"
    | "tool_result"
    | "confirmation_request"
    | "content"
    | "done"
    | "error";
  [key: string]: unknown;
}

/**
 * A pending write-tool confirmation awaiting the user's approve/deny via
 * POST /ai-agent/query/confirm. Held in memory keyed by `messageId`.
 */
interface PendingConfirmation {
  userId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Resolves with true (approved) or false (denied) when the client responds. */
  resolve: (approved: boolean, reason?: string) => void;
  /** Auto-expires after this many ms so a forgotten prompt doesn't leak. */
  expiresAt: number;
}

/**
 * Agentic loop for the AI Agent chatbox (/ai-mcp).
 *
 * Structurally mirrors {@link AiQueryService.executeQueryStream} (same budgets,
 * same streaming event vocabulary, same provider abstraction) but drives the
 * 65 MCP tools in-process via {@link AiAgentToolRegistry} instead of the
 * read-only FINANCIAL_TOOLS executor. The read-only vs. edit toggle is a scope
 * switch: in read-only mode the session context carries only `read,reports`,
 * so every write tool is gated by the shared `requireScope` check (and is not
 * even advertised to the model).
 *
 * In edit mode with confirmWrites on, each write tool call is preceded by a
 * dryRun preview emitted as a `confirmation_request` event; the loop parks on
 * a promise that the controller resolves when the user approves or denies.
 */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  /** Pending confirmations keyed by `${messageId}:${toolCallId}`. */
  private readonly pending = new Map<string, PendingConfirmation>();

  /** Periodic sweep that drops expired pending confirmations. */
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly aiService: AiService,
    private readonly usageService: AiUsageService,
    private readonly contextBuilder: FinancialContextBuilder,
    private readonly toolRegistry: AiAgentToolRegistry,
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
  ) {
    this.sweepTimer = setInterval(
      () => this.sweepExpired(),
      60_000,
    );
  }

  onModuleDestroy() {
    clearInterval(this.sweepTimer);
    // Reject any still-pending confirmations so their awaiting loops unwind.
    for (const pc of this.pending.values()) {
      pc.resolve(false, "Server shutting down");
    }
    this.pending.clear();
  }

  async *executeQueryStream(
    userId: string,
    query: string,
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
    writeMode: AgentWriteMode,
    confirmWrites: boolean,
  ): AsyncGenerator<AgentStreamEvent> {
    yield { type: "thinking", message: "Analyzing your question..." };

    const startTime = Date.now();
    this.logger.log(
      `Agent query start user=${userId} writeMode=${writeMode} confirmWrites=${confirmWrites} queryLen=${query.length}`,
    );

    // Prompt-injection guard (same as the AI Assistant).
    const risk = assessInjectionRisk(query);
    if (risk.riskLevel === "high") {
      this.logger.warn(
        `High-risk prompt injection detected for user ${userId}: patterns=[${risk.matchedPatterns.join(", ")}]`,
      );
      yield {
        type: "content",
        text: "I can only answer questions about your financial data. I'm not able to modify my behavior, reveal my instructions, or bypass my guidelines. Please rephrase your question about your finances.",
      };
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      };
      return;
    }

    // Build the system prompt (reuse the AI Assistant's financial context).
    let systemPrompt: string;
    try {
      systemPrompt = await this.contextBuilder.buildQueryContext(userId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build context";
      this.logger.error(`Context build failed user=${userId}: ${message}`);
      yield { type: "error", message };
      return;
    }

    // Pick a tool-use-capable provider (same selection as the AI Assistant).
    let provider: AiProvider;
    try {
      provider = await this.aiService.getToolUseProvider(userId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No AI provider available";
      this.logger.warn(`Provider selection failed user=${userId}: ${message}`);
      yield { type: "error", message };
      return;
    }

    // Resolve scopes + advertise only the permitted tools.
    const scopes = writeMode === "edit" ? EDIT_SCOPES : READONLY_SCOPES;
    const tools = this.toolRegistry.getToolDefinitions(scopes);
    this.logger.log(
      `Agent tools advertised user=${userId} scopes=${scopes} count=${tools.length}`,
    );

    // Open an in-process MCP session for this query.
    const sessionId = this.toolRegistry.beginSession(userId, scopes);

    const messages: AiMessage[] = [
      ...this.buildHistoryMessages(conversationHistory),
      { role: "user", content: query },
      { role: "user", content: QUERY_SAFETY_REMINDER },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let model = "unknown";
    const messageId = `agent-${userId}-${startTime}`;

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (Date.now() - startTime > QUERY_TIMEOUT_MS) {
          yield {
            type: "content",
            text: "Your request took too long to process. Here is what I found so far.",
          };
          break;
        }
        if (totalToolCalls >= MAX_TOOL_CALLS) {
          yield {
            type: "content",
            text: "I've reached the maximum number of actions for this request. Here is what I've done so far.",
          };
          break;
        }
        if (totalInputTokens >= MAX_INPUT_TOKENS) {
          yield {
            type: "content",
            text: "This request has consumed the maximum analysis budget. Here is what I've done so far.",
          };
          break;
        }

        let iterationContent = "";
        let iterationToolCalls: AiToolCall[] = [];
        let iterationStopReason: "end_turn" | "tool_use" | "max_tokens" =
          "end_turn";
        let iterationInputTokens = 0;
        let iterationOutputTokens = 0;

        try {
          if (provider.streamWithTools) {
            for await (const chunk of provider.streamWithTools(
              { systemPrompt, messages, maxTokens: 4096, temperature: 0.1 },
              tools,
            )) {
              if (chunk.type === "text") {
                yield { type: "assistant_text", text: chunk.text };
              } else {
                iterationContent = chunk.content;
                iterationToolCalls = chunk.toolCalls;
                iterationStopReason = chunk.stopReason;
                model = chunk.model;
                iterationInputTokens = chunk.usage.inputTokens;
                iterationOutputTokens = chunk.usage.outputTokens;
              }
            }
          } else if (provider.completeWithTools) {
            const response = await provider.completeWithTools(
              { systemPrompt, messages, maxTokens: 4096, temperature: 0.1 },
              tools,
            );
            iterationContent = response.content;
            iterationToolCalls = response.toolCalls;
            iterationStopReason = response.stopReason;
            model = response.model;
            iterationInputTokens = response.usage.inputTokens;
            iterationOutputTokens = response.usage.outputTokens;
            if (iterationContent) {
              yield { type: "assistant_text", text: iterationContent };
            }
          } else {
            throw new Error("Configured AI provider does not support tool use");
          }
        } catch (error) {
          const rawMessage =
            error instanceof Error ? error.message : "AI provider error";
          this.logger.error(
            `Agent provider error user=${userId} iteration=${iteration}: ${rawMessage}`,
          );
          await this.logUsage(
            userId,
            provider.name,
            model,
            totalInputTokens,
            totalOutputTokens,
            Date.now() - startTime,
            rawMessage,
          );
          const userMessage =
            error instanceof OllamaModelDoesNotSupportToolsError
              ? error.message
              : "The AI provider encountered an error processing your request. Please try again.";
          yield { type: "error", message: userMessage };
          return;
        }

        totalInputTokens += iterationInputTokens;
        totalOutputTokens += iterationOutputTokens;

        if (
          iterationStopReason !== "tool_use" ||
          iterationToolCalls.length === 0
        ) {
          yield { type: "content", text: iterationContent };
          await this.logUsage(
            userId,
            provider.name,
            model,
            totalInputTokens,
            totalOutputTokens,
            Date.now() - startTime,
          );
          yield {
            type: "done",
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              toolCalls: totalToolCalls,
            },
          };
          return;
        }

        // Append the assistant's tool-call turn, then execute each call.
        messages.push({
          role: "assistant",
          content: iterationContent,
          toolCalls: iterationToolCalls,
        });

        for (const toolCall of iterationToolCalls) {
          totalToolCalls++;
          const isWrite = this.toolRegistry.isWriteTool(toolCall.name);

          yield {
            type: "tool_start",
            name: toolCall.name,
            description: toolCall.name.replace(/_/g, " "),
            input: toolCall.input,
            isWrite,
          };

          let result: CallToolResult;

          if (
            isWrite &&
            writeMode === "edit" &&
            confirmWrites &&
            toolCall.input.dryRun !== true
          ) {
            // Confirmation flow: preview with dryRun, then await approval.
            const preview = await this.toolRegistry.callTool(
              toolCall.name,
              { ...toolCall.input, dryRun: true },
              sessionId,
            );

            yield {
              type: "confirmation_request",
              messageId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              input: toolCall.input,
              preview: this.extractText(preview),
            };

            const approved = await this.awaitConfirmation(
              userId,
              messageId,
              toolCall.id,
              toolCall.name,
              toolCall.input,
            );

            if (approved) {
              result = await this.toolRegistry.callTool(
                toolCall.name,
                toolCall.input,
                sessionId,
              );
            } else {
              result = {
                content: [
                  {
                    type: "text",
                    text: "The user denied this change. Do not retry it; ask the user how they'd like to proceed instead.",
                  },
                ],
                isError: true,
              };
            }
          } else {
            result = await this.toolRegistry.callTool(
              toolCall.name,
              toolCall.input,
              sessionId,
            );
          }

          const summary = this.summarize(result);
          yield {
            type: "tool_result",
            name: toolCall.name,
            summary,
            isError: result.isError === true,
            isWrite,
          };

          // Feed the tool result back to the model.
          let toolResultContent = this.extractText(result);
          if (toolResultContent.length > MAX_TOOL_RESULT_CHARS) {
            toolResultContent =
              toolResultContent.substring(0, MAX_TOOL_RESULT_CHARS) +
              '... [truncated, data too large]"';
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: toolResultContent,
          });
        }
      }

      // Max iterations reached.
      this.logger.warn(
        `Agent max iterations user=${userId} toolCalls=${totalToolCalls}`,
      );
      yield {
        type: "content",
        text: "I've done everything I can for this request. Here's a summary of what I found and did.",
      };
      await this.logUsage(
        userId,
        provider.name,
        model,
        totalInputTokens,
        totalOutputTokens,
        Date.now() - startTime,
      );
      yield {
        type: "done",
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCalls: totalToolCalls,
        },
      };
    } finally {
      this.toolRegistry.endSession(sessionId);
      // Clean up any stray pending confirmations for this message.
      for (const key of [...this.pending.keys()]) {
        if (key.startsWith(`${messageId}:`)) {
          this.pending.get(key)?.resolve(false, "Request completed");
          this.pending.delete(key);
        }
      }
    }
  }

  /**
   * Resolve a pending confirmation from the client. Returns true if a pending
   * confirmation was found and resolved, false if it was unknown/expired
   * (e.g. the user double-clicked, or the SSE stream already ended).
   */
  resolveConfirmation(
    userId: string,
    messageId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
  ): boolean {
    const key = `${messageId}:${toolCallId}`;
    const pc = this.pending.get(key);
    if (!pc || pc.userId !== userId || pc.expiresAt < Date.now()) {
      this.pending.delete(key);
      return false;
    }
    this.pending.delete(key);
    pc.resolve(approved, reason);
    return true;
  }

  /** Read the persisted write-mode preference for a user (default readonly). */
  async getWriteMode(userId: string): Promise<{
    writeMode: AgentWriteMode;
    confirmWrites: boolean;
  }> {
    const pref = await this.prefRepo.findOne({ where: { userId } });
    return {
      writeMode: pref?.aiAgentWriteMode === "edit" ? "edit" : "readonly",
      confirmWrites: pref?.aiAgentConfirmWrites !== false,
    };
  }

  private awaitConfirmation(
    userId: string,
    messageId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const key = `${messageId}:${toolCallId}`;
      this.pending.set(key, {
        userId,
        messageId,
        toolCallId,
        toolName,
        input,
        resolve,
        // 5-minute expiry: long enough for a human to read the preview,
        // short enough that a forgotten tab doesn't hold a session forever.
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    });
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, pc] of this.pending.entries()) {
      if (pc.expiresAt < now) {
        pc.resolve(false, "Confirmation timed out");
        this.pending.delete(key);
      }
    }
  }

  private buildHistoryMessages(
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): AiMessage[] {
    if (!history || history.length === 0) return [];
    return history.slice(-AGENT_MAX_HISTORY_MESSAGES).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /** Extract the concatenated text content blocks from a CallToolResult. */
  private extractText(result: CallToolResult): string {
    if (!result.content) return "";
    return result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
  }

  /**
   * Build a short human-readable summary of a tool result for the UI's
   * tool-call pill list. Uses the first line of the text content, truncated.
   */
  private summarize(result: CallToolResult): string {
    if (result.isError) {
      const text = this.extractText(result);
      return text.slice(0, 200) || "Tool error";
    }
    const text = this.extractText(result);
    // Tool results are pretty-printed JSON; pull a one-line gist.
    const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
    return firstLine.slice(0, 200) || "Done";
  }

  private async logUsage(
    userId: string,
    providerName: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    try {
      await this.usageService.logUsage({
        userId,
        provider: providerName,
        model: modelName,
        // Distinct feature label so the usage dashboard can separate the
        // agent from the read-only AI Assistant ("query").
        feature: "agent",
        inputTokens,
        outputTokens,
        durationMs,
        ...(error && { error }),
      });
    } catch (logErr) {
      this.logger.warn(
        `Failed to log agent usage user=${userId}: ${logErr instanceof Error ? logErr.message : logErr}`,
      );
    }
  }
}
