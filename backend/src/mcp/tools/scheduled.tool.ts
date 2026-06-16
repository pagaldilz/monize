import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { stripHtml } from "../../common/sanitization.util";
import {
  getUpcomingBillsOutput,
  getScheduledTransactionsOutput,
  postScheduledTransactionOutput,
  skipScheduledTransactionOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

const SCHEDULED_KIND_VALUES = [
  "bill",
  "deposit",
  "transfer",
  "investment",
  "all",
] as const;

@Injectable()
export class McpScheduledTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly scheduledService: ScheduledTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_upcoming_bills",
      {
        title: "Upcoming bills and deposits",
        annotations: READ_ONLY,
        description:
          "Get upcoming scheduled bills and deposits due within a date window. Each item is classified as bill / deposit / transfer / investment and includes a daysUntilDue value (negative when overdue). Returns the same shape as the AI Assistant's get_upcoming_bills tool.",
        inputSchema: {
          days: z
            .number()
            .min(1)
            .max(365)
            .optional()
            .default(30)
            .describe("Number of days to look ahead (default 30)"),
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow to a single kind: 'bill', 'deposit', 'transfer', 'investment'. Omit or pass 'all' for everything.",
            ),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to."),
        },
        outputSchema: getUpcomingBillsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const upcoming =
            await this.scheduledService.getLlmUpcomingBillsAndDeposits(
              ctx.userId,
              {
                days: args.days ?? 30,
                kind: args.kind,
                accountIds: args.accountIds,
              },
            );
          return toolResult(upcoming);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_scheduled_transactions",
      {
        title: "List scheduled transactions",
        annotations: READ_ONLY,
        description:
          "List all scheduled/recurring transactions (bills, deposits, transfers, investments). Returns rollup counts plus a curated per-item payload. Returns the same shape as the AI Assistant's get_scheduled_transactions tool.",
        inputSchema: {
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow to a single kind: 'bill', 'deposit', 'transfer', 'investment'. Omit or pass 'all' for everything.",
            ),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to."),
          isActive: z
            .boolean()
            .optional()
            .describe(
              "Filter by active status. Omit to include both active and paused schedules.",
            ),
        },
        outputSchema: getScheduledTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const scheduled = await this.scheduledService.getLlmScheduledList(
            ctx.userId,
            {
              kind: args.kind,
              accountIds: args.accountIds,
              isActive: args.isActive,
            },
          );
          return toolResult(scheduled);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "post_scheduled_transaction",
      {
        title: "Post scheduled transaction",
        annotations: CREATE,
        description:
          "Post a due scheduled bill/deposit into a real transaction on its next due date, then advance the schedule to the following occurrence. Optionally override the date, amount, category, or description for this posting. Set dryRun=true to preview what would be posted without creating the transaction.",
        inputSchema: {
          id: z.string().uuid().describe("Scheduled transaction ID to post"),
          transactionDate: z
            .string()
            .max(10)
            .optional()
            .describe(
              "Posting date (YYYY-MM-DD). Defaults to the next due date.",
            ),
          amount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Override the posted amount"),
          categoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Override the category for this posting"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Override the description/memo for this posting"),
          referenceNumber: z
            .string()
            .max(100)
            .optional()
            .describe("Reference number for the posted transaction"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, return a preview without posting the transaction",
            ),
        },
        outputSchema: postScheduledTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const existing = await this.scheduledService.findOne(ctx.userId, args.id);

          // Dry-run mode: preview without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                scheduledTransactionId: args.id,
                name: existing.name,
                transactionDate: args.transactionDate ?? existing.nextDueDate ?? null,
                amount: args.amount ?? existing.amount ?? null,
                categoryId: args.categoryId ?? existing.categoryId ?? null,
                description:
                  stripHtml(args.description) || existing.description || null,
              },
              message:
                "This is a preview. Call again with dryRun=false to post the transaction.",
            });
          }

          const updated = await this.scheduledService.post(ctx.userId, args.id, {
            transactionDate: args.transactionDate,
            amount: args.amount,
            categoryId: args.categoryId,
            description: stripHtml(args.description),
            referenceNumber: stripHtml(args.referenceNumber),
          });

          this.writeLimiter.record(ctx.userId, "post_scheduled_transaction");

          return toolResult({
            posted: true,
            scheduledTransactionId: args.id,
            nextDueDate: updated?.nextDueDate ?? null,
            message:
              "Scheduled transaction posted. The schedule advanced to the next due date.",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "skip_scheduled_transaction",
      {
        title: "Skip scheduled occurrence",
        annotations: UPDATE,
        description:
          "Skip the next occurrence of a scheduled bill/deposit and advance the schedule to the following due date. Useful when a recurring transaction does not apply this period.",
        inputSchema: {
          id: z
            .string()
            .uuid()
            .describe("Scheduled transaction ID to skip"),
        },
        outputSchema: skipScheduledTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const updated = await this.scheduledService.skip(ctx.userId, args.id);

          this.writeLimiter.record(ctx.userId, "skip_scheduled_transaction");

          return toolResult({
            id: updated.id,
            nextDueDate: updated.nextDueDate ?? null,
            message: "Scheduled occurrence skipped; schedule advanced.",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
