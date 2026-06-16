import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServerService } from "./mcp-server.service";
import { McpUserContext } from "./mcp-context";
import type { AiToolDefinition } from "../ai/providers/ai-provider.interface";

/**
 * The synthetic request-handler `extra` we pass into each tool's registered
 * handler when invoking it in-process (i.e. not over a JSON-RPC transport).
 *
 * Tool handlers only consume `extra.sessionId` (to resolve the user context
 * via the `resolve` callback) and `extra.signal` (for cancellation). The
 * other fields are stubbed to satisfy the type; the `sendNotification` no-op
 * mirrors what the SDK does for transports that aren't listening.
 */
function buildSyntheticExtra(sessionId: string) {
  return {
    sessionId,
    signal: new AbortController().signal,
    requestId: `agent-${sessionId}`,
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("Not supported in in-process agent mode");
    },
  } as any;
}

/**
 * In-process registry of the 65 MCP tools, built once at module init and
 * reused for every AI Agent query.
 *
 * Unlike {@link McpServerService.createServer} — which produces a transport-
 * bound `McpServer` for JSON-RPC clients (Claude Desktop etc.) — this registry
 * captures the {@link RegisteredTool} objects returned by `registerTool` so the
 * AI Agent service can:
 *   1. Advertise the tools to the LLM as plain JSON-schema `AiToolDefinition`s
 *      (the format the provider abstraction expects), filtered by the user's
 *      read-only vs. edit scope.
 *   2. Invoke a tool's handler directly, in-process, by name — no transport,
 *      no JSON-RPC round-trip.
 *
 * The user/scope is injected at call time via the per-call `sessionId`, which
 * the shared `resolve` callback maps to an {@link McpUserContext}. This means
 * every existing per-tool guard (`requireScope`, write limiter, dryRun,
 * confirmMerge, action history) is enforced identically for the agent and for
 * external MCP clients — the read-only/edit toggle is simply "does the session
 * context carry the `write` scope".
 */
@Injectable()
export class AiAgentToolRegistry {
  /**
   * name → RegisteredTool, populated once by {@link build}.
   * Re-registered fresh per registry instance so each process has its own
   * (the handlers are stateless beyond their injected services).
   */
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Per-session user contexts, keyed by a synthetic session id minted per
   * agent query. Mirrors the `sessionUsers` map on the HTTP controller but
   * lives only for the duration of a single agentic loop.
   */
  private readonly sessionContexts = new Map<string, McpUserContext>();

  constructor(private readonly mcpServerService: McpServerService) {}

  /**
   * Lazily build the registry on first use. Done lazily (not in constructor)
   * so the provider services it depends on are fully wired by the time we
   * register tools against them.
   */
  private ensureBuilt(): void {
    if (this.tools.size > 0) return;

    // Proxy the McpServer so we can capture every RegisteredTool returned by
    // `registerTool` without modifying the tool providers (they all call
    // `server.registerTool(...)` and discard the return value).
    const captured = this.tools;
    const realServer = new McpServer(
      { name: "monize-agent", version: "in-process" },
      { capabilities: { tools: {} } },
    );
    const proxiedServer: McpServer = new Proxy(realServer, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "registerTool" && typeof value === "function") {
          return (name: string, config: any, cb: any) => {
            const registered = value.call(target, name, config, cb);
            if (registered) captured.set(name, registered);
            return registered;
          };
        }
        return value;
      },
    });

    // resolve() is invoked by each tool handler with the synthetic sessionId
    // we passed in via `extra`. We look the context up in sessionContexts.
    const resolve = (sessionId?: string) =>
      sessionId ? this.sessionContexts.get(sessionId) : undefined;

    this.mcpServerService.registerAll(proxiedServer, resolve);
  }

  /**
   * Start an agent session: register a user context under a synthetic session
   * id and return that id so the agentic loop can pass it into each tool call.
   */
  beginSession(userId: string, scopes: string): string {
    this.ensureBuilt();
    const sessionId = `agent-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionContexts.set(sessionId, { userId, scopes });
    return sessionId;
  }

  /** Drop the user context for a finished agent session. */
  endSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
  }

  /**
   * The list of tool names whose annotation marks them as mutating
   * (`readOnlyHint !== true`). Used by the agent service to decide whether a
   * requested tool call needs confirmation in edit mode.
   */
  isWriteTool(name: string): boolean {
    this.ensureBuilt();
    const tool = this.tools.get(name);
    if (!tool) return false;
    return tool.annotations?.readOnlyHint !== true;
  }

  /**
   * Build the JSON-schema tool list for the LLM provider, filtered to the
   * tools the session's scopes permit. In read-only mode only read/reports
   * tools are advertised; in edit mode all 65 are.
   *
   * Read/write filtering at the advertisement layer is a courtesy to the model
   * (so it doesn't waste turns proposing writes it can't perform); the
   * authoritative gate remains `requireScope` inside each handler.
   */
  getToolDefinitions(scopes: string): AiToolDefinition[] {
    this.ensureBuilt();
    const scopeList = scopes.split(",");
    const canWrite = scopeList.includes("write");
    const defs: AiToolDefinition[] = [];
    for (const [name, tool] of this.tools) {
      const isReadOnly = tool.annotations?.readOnlyHint === true;
      if (!isReadOnly && !canWrite) continue;
      defs.push({
        name,
        description: tool.description ?? name,
        inputSchema: this.toJsonSchema(tool.inputSchema),
      });
    }
    return defs;
  }

  /**
   * Convert a registered tool's Zod input shape to a plain JSON-schema object
   * for the LLM provider. Tools registered with an empty `{}` shape (no
   * parameters) yield an empty object schema. Conversion is defensive: a tool
   * whose schema `zodToJsonSchema` can't handle falls back to a permissive
   * object schema rather than crashing the whole advertisement pass.
   */
  private toJsonSchema(inputSchema: unknown): Record<string, unknown> {
    if (!inputSchema) return { type: "object", properties: {} };
    try {
      return zodToJsonSchema(inputSchema as any, {
        target: "openApi3",
        $refStrategy: "none",
      }) as Record<string, unknown>;
    } catch {
      return { type: "object", properties: {} };
    }
  }

  /**
   * Invoke a registered tool's handler directly, in-process.
   *
   * Returns the raw {@link CallToolResult} (content blocks + structuredContent
   * + isError flag) exactly as the MCP transport would. The agent service
   * interprets `isError` and the text content block.
   */
  async callTool(
    name: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<CallToolResult> {
    this.ensureBuilt();
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Error: Unknown tool "${name}".` },
        ],
        isError: true,
      };
    }
    try {
      const result = await (tool.handler as any)(
        input,
        buildSyntheticExtra(sessionId),
      );
      return (result ?? {
        content: [{ type: "text", text: "Tool returned no output." }],
      }) as CallToolResult;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Tool execution failed";
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
}
