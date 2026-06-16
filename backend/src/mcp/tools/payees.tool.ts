import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PayeesService } from "../../payees/payees.service";
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
  getPayeesOutput,
  createPayeeOutput,
  updatePayeeOutput,
  mergePayeesOutput,
  reactivatePayeeOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpPayeesTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(private readonly payeesService: PayeesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_payees",
      {
        title: "List payees",
        annotations: READ_ONLY,
        description: "List payees, optionally filtered by search query",
        inputSchema: {
          search: z
            .string()
            .max(200)
            .optional()
            .describe("Search query to filter payees"),
        },
        outputSchema: getPayeesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          if (args.search) {
            const payees = await this.payeesService.search(
              ctx.userId,
              args.search,
              50,
            );
            return toolResult(payees);
          }
          const payees = await this.payeesService.findAll(ctx.userId);
          return toolResult(payees);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_payee",
      {
        title: "Create payee",
        annotations: CREATE,
        description: "Create a new payee",
        inputSchema: {
          name: z.string().max(100).describe("Payee name"),
          defaultCategoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Default category ID for this payee"),
        },
        outputSchema: createPayeeOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        try {
          const payee = await this.payeesService.create(ctx.userId, {
            name: args.name,
            defaultCategoryId: args.defaultCategoryId,
          });
          return toolResult({
            id: payee.id,
            name: payee.name,
            message: "Payee created successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_payee",
      {
        title: "Update payee",
        annotations: UPDATE,
        description:
          "Update a payee's fields (name, default category, notes, active status). Optionally apply the default category to existing transactions via applyCategoryToTransactions ('none' | 'uncategorized' | 'all'). Set dryRun=true to preview without saving.",
        inputSchema: {
          payeeId: z.string().uuid().describe("Payee ID"),
          name: z.string().max(100).optional().describe("Payee name"),
          defaultCategoryId: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe("Default category ID, or null to clear"),
          notes: z.string().max(500).optional().describe("Notes"),
          isActive: z.boolean().optional().describe("Active flag"),
          applyCategoryToTransactions: z
            .enum(["none", "uncategorized", "all"])
            .optional()
            .describe(
              "When setting a default category, backfill existing transactions: 'none' (default), 'uncategorized' (only those without a category), or 'all' (overwrite every transaction).",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, preview without saving"),
        },
        outputSchema: updatePayeeOutput,
      },
      async (args, extra) => {
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
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                payeeId: args.payeeId,
                name: stripHtml(args.name),
                defaultCategoryId: args.defaultCategoryId,
                notes: stripHtml(args.notes),
                isActive: args.isActive,
                applyCategoryToTransactions:
                  args.applyCategoryToTransactions ?? "none",
              },
              message:
                "This is a preview. Call again with dryRun=false to apply the update.",
            });
          }

          const dto: Record<string, unknown> = {};
          if (args.name !== undefined) dto.name = stripHtml(args.name);
          if (args.defaultCategoryId !== undefined)
            dto.defaultCategoryId = args.defaultCategoryId;
          if (args.notes !== undefined) dto.notes = stripHtml(args.notes);
          if (args.isActive !== undefined) dto.isActive = args.isActive;
          if (args.applyCategoryToTransactions !== undefined)
            dto.applyCategoryToTransactions = args.applyCategoryToTransactions;

          const payee = await this.payeesService.update(
            ctx.userId,
            args.payeeId,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_payee");

          return toolResult({
            id: payee.id,
            name: payee.name,
            isActive: payee.isActive,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "merge_payees",
      {
        title: "Merge payees",
        annotations: UPDATE,
        description:
          "Merge a duplicate (source) payee INTO a canonical (target) payee: the source payee's transactions migrate to the target and the source payee is REMOVED. Optionally add the source name as an alias on the target. This is the only tool that removes data; it requires confirmMerge=true as an explicit opt-in.",
        inputSchema: {
          targetPayeeId: z
            .string()
            .uuid()
            .describe("Canonical payee to merge INTO (kept)"),
          sourcePayeeId: z
            .string()
            .uuid()
            .describe("Duplicate payee to merge FROM (removed)"),
          addAsAlias: z
            .boolean()
            .optional()
            .default(true)
            .describe(
              "Add the source payee name as an alias on the target (default true)",
            ),
          confirmMerge: z
            .boolean()
            .describe(
              "Must be true to proceed. The source payee WILL be removed.",
            ),
        },
        outputSchema: mergePayeesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Explicit opt-in gate: the source payee is deleted by the merge, so we
        // require an unambiguous confirm flag to prevent accidental data loss.
        if (!args.confirmMerge) {
          return toolError(
            "This merge will REMOVE the source payee. Re-call with confirmMerge=true to proceed.",
          );
        }

        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          if (args.targetPayeeId === args.sourcePayeeId) {
            return toolError(
              "targetPayeeId and sourcePayeeId must differ.",
            );
          }

          const result = await this.payeesService.mergePayees(ctx.userId, {
            targetPayeeId: args.targetPayeeId,
            sourcePayeeId: args.sourcePayeeId,
            addAsAlias: args.addAsAlias ?? true,
          });

          this.writeLimiter.record(ctx.userId, "merge_payees");

          return toolResult({
            targetPayeeId: args.targetPayeeId,
            sourcePayeeId: args.sourcePayeeId,
            transactionsMigrated: result.transactionsMigrated,
            aliasAdded: result.aliasAdded,
            sourcePayeeDeleted: result.sourcePayeeDeleted,
            message: "Payees merged successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "reactivate_payee",
      {
        title: "Reactivate payee",
        annotations: UPDATE,
        description:
          "Reactivate an inactive payee. Idempotent: reactivating an already-active payee is a no-op.",
        inputSchema: {
          payeeId: z.string().uuid().describe("Payee ID"),
        },
        outputSchema: reactivatePayeeOutput,
      },
      async (args, extra) => {
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
          const payee = await this.payeesService.reactivatePayee(
            ctx.userId,
            args.payeeId,
          );

          this.writeLimiter.record(ctx.userId, "reactivate_payee");

          return toolResult({
            id: payee.id,
            name: payee.name,
            isActive: payee.isActive,
            message: "Payee reactivated",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
