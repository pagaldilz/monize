import {
  Controller,
  Logger,
  Post,
  Body,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { AiAgentService } from "./ai-agent.service";
import { AiAgentQueryDto } from "./dto/ai-agent-query.dto";
import { AiAgentConfirmDto } from "./dto/ai-agent-confirm.dto";
import { tr } from "../i18n/translate";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";

@ApiTags("AI")
@Controller("ai-agent")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
// Like the AI Assistant, the agent is reachable only with the "ai" delegate
// section grant. Note: delegates run with the OWNER's effective user id and
// the owner's write-mode preference, so a delegate granted "ai" can use the
// agent exactly as the owner can — same delegation model as /ai.
@DelegateRequiresSection("ai")
export class AiAgentController {
  private readonly logger = new Logger(AiAgentController.name);

  constructor(private readonly agentService: AiAgentService) {}

  @Post("query/stream")
  @AllowDelegate()
  @ApiOperation({
    summary:
      "Run the MCP-powered AI Agent with SSE streaming (read-only by default, edit mode opt-in)",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async streamQuery(
    @Request() req: { user: { id: string } },
    @Body() dto: AiAgentQueryDto,
    @Res() res: Response,
  ) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const streamStart = Date.now();
    const userId = req.user.id;
    this.logger.log(
      `Agent SSE stream open user=${userId} queryLen=${dto.query.length}`,
    );

    // Resolve effective write mode + confirmWrites: per-request override
    // takes precedence, else the persisted preference.
    const pref = await this.agentService.getWriteMode(userId);
    const writeMode = dto.writeMode ?? pref.writeMode;
    const confirmWrites = dto.confirmWrites ?? pref.confirmWrites;

    const abortController = new AbortController();
    res.on("close", () => {
      if (!abortController.signal.aborted) {
        this.logger.warn(
          `Agent SSE client disconnected user=${userId} after=${Date.now() - streamStart}ms`,
        );
      }
      abortController.abort();
    });

    const heartbeat = setInterval(() => {
      if (!abortController.signal.aborted && !res.writableEnded) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);

    let eventCount = 0;
    try {
      for await (const event of this.agentService.executeQueryStream(
        userId,
        dto.query,
        dto.conversationHistory ?? [],
        writeMode,
        confirmWrites,
      )) {
        if (abortController.signal.aborted) break;
        if (event) {
          eventCount++;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const rawMessage =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.error(
          `Agent SSE stream error user=${userId} after=${Date.now() - streamStart}ms events=${eventCount}: ${rawMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
        const message = tr(
          "errors.ai.queryStreamFailed",
          "An unexpected error occurred while processing your request.",
        );
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
    }

    this.logger.log(
      `Agent SSE stream close user=${userId} totalMs=${Date.now() - streamStart} events=${eventCount} aborted=${abortController.signal.aborted}`,
    );

    if (!abortController.signal.aborted) {
      res.end();
    }
  }

  @Post("query/confirm")
  @AllowDelegate()
  @ApiOperation({
    summary: "Approve or deny a pending write-tool confirmation from the agent",
  })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async confirm(
    @Request() req: { user: { id: string } },
    @Body() dto: AiAgentConfirmDto,
  ): Promise<{ resolved: boolean }> {
    const resolved = this.agentService.resolveConfirmation(
      req.user.id,
      dto.messageId,
      dto.toolCallId,
      dto.approved,
      dto.reason,
    );
    return { resolved };
  }
}
