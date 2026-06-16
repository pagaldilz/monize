import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionHistoryService } from "../../action-history/action-history.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";
import {
  undoLastActionOutput,
  redoActionOutput,
  getActionHistoryOutput,
} from "../tool-output-schemas";
import { READ_ONLY, UPDATE } from "../mcp-annotations";

/**
 * Undo/redo safety net for MCP-driven writes.
 *
 * As the write surface grows (transactions, transfers, categories, payees,
 * tags, accounts...), the ability to reverse a mistaken AI action becomes
 * increasingly important. The underlying ActionHistoryService already
 * supports undo/redo for transaction, transfer, investment-transaction,
 * category, payee, tag, and bulk operations, so these tools are thin
 * adapters over it.
 */
@Injectable()
export class McpSafetyTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(private readonly actionHistoryService: ActionHistoryService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "undo_last_action",
      {
        title: "Undo last action",
        annotations: UPDATE,
        description:
          "Reverse the most recent undoable action performed by this user (a create/update on transactions, transfers, investments, categories, payees, tags, or bulk operations). Use this as a safety net when an AI-driven change was incorrect. Returns the description of the undone action, or a not-found message if there is nothing to undo.",
        inputSchema: {},
        outputSchema: undoLastActionOutput,
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const result = await this.actionHistoryService.undo(ctx.userId);

          this.writeLimiter.record(ctx.userId, "undo_last_action");

          return toolResult({
            undone: true,
            description: result.description,
            entityType: result.action.entityType,
            action: result.action.action,
            message: `Undone: ${result.description}`,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "redo_action",
      {
        title: "Redo action",
        annotations: UPDATE,
        description:
          "Re-apply the most recently undone action (the counterpart to undo_last_action). Returns the description of the redone action, or a not-found message if there is nothing to redo.",
        inputSchema: {},
        outputSchema: redoActionOutput,
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const result = await this.actionHistoryService.redo(ctx.userId);

          this.writeLimiter.record(ctx.userId, "redo_action");

          return toolResult({
            redone: true,
            description: result.description,
            entityType: result.action.entityType,
            action: result.action.action,
            message: `Redone: ${result.description}`,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_action_history",
      {
        title: "Get action history",
        annotations: READ_ONLY,
        description:
          "List the user's recent actions (most recent first), showing what each did and whether it has been undone. Use this to see what is available to undo before calling undo_last_action.",
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(20)
            .describe("Number of recent actions to return (default 20, max 50)"),
        },
        outputSchema: getActionHistoryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const history = await this.actionHistoryService.getHistory(
            ctx.userId,
            args.limit,
          );
          return toolResult(history);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
