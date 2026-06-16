import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CategoriesService } from "../../categories/categories.service";
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
  getCategoriesOutput,
  createCategoryOutput,
  updateCategoryOutput,
  reassignCategoryTransactionsOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpCategoriesTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(private readonly categoriesService: CategoriesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_categories",
      {
        title: "List categories",
        annotations: READ_ONLY,
        description:
          "List the user's categories with their hierarchy (parent names) and transaction counts. Optionally filter by type or search by name. Returns the same shape as the AI Assistant's get_categories tool.",
        inputSchema: {
          type: z
            .enum(["expense", "income", "all"])
            .optional()
            .describe(
              "Filter by category type. Defaults to 'all' when omitted.",
            ),
          search: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Optional case-insensitive substring match on category name. Matched subcategories' parents are included so hierarchy stays visible.",
            ),
        },
        outputSchema: getCategoriesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.categoriesService.getLlmCategories(
            ctx.userId,
            { type: args.type, search: args.search },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_category",
      {
        title: "Create category",
        annotations: CREATE,
        description:
          "Create a new category. Optionally nest it under a parent category via parentId, mark it as income, and set a color/icon.",
        inputSchema: {
          name: z.string().max(100).describe("Category name"),
          description: z.string().max(255).optional().describe("Description"),
          icon: z
            .string()
            .max(50)
            .optional()
            .describe("Emoji or icon name"),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional()
            .describe("Hex color, e.g. #4F46E5"),
          isIncome: z
            .boolean()
            .optional()
            .describe("True for income categories (default false)"),
          parentId: z
            .string()
            .uuid()
            .optional()
            .describe("Parent category ID to nest under (subcategory)"),
        },
        outputSchema: createCategoryOutput,
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
          const category = await this.categoriesService.create(ctx.userId, {
            name: stripHtml(args.name) as string,
            description: stripHtml(args.description),
            icon: args.icon,
            color: args.color,
            isIncome: args.isIncome,
            parentId: args.parentId,
          });

          this.writeLimiter.record(ctx.userId, "create_category");

          return toolResult({
            id: category.id,
            name: category.name,
            isIncome: category.isIncome,
            message: "Category created successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_category",
      {
        title: "Update category",
        annotations: UPDATE,
        description:
          "Update a category's fields (name, description, icon, color, isIncome, parentId). Only provided fields change. Set dryRun=true to preview without saving.",
        inputSchema: {
          categoryId: z.string().uuid().describe("Category ID"),
          name: z.string().max(100).optional().describe("Category name"),
          description: z.string().max(255).optional().describe("Description"),
          icon: z.string().max(50).optional().describe("Emoji or icon name"),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional()
            .describe("Hex color, e.g. #4F46E5"),
          isIncome: z.boolean().optional().describe("Income category flag"),
          parentId: z
            .string()
            .uuid()
            .optional()
            .describe("Parent category ID to nest under"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, preview without saving"),
        },
        outputSchema: updateCategoryOutput,
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
                categoryId: args.categoryId,
                name: stripHtml(args.name),
                description: stripHtml(args.description),
                icon: args.icon,
                color: args.color,
                isIncome: args.isIncome,
                parentId: args.parentId,
              },
              message:
                "This is a preview. Call again with dryRun=false to apply the update.",
            });
          }

          const dto: Record<string, unknown> = {};
          if (args.name !== undefined) dto.name = stripHtml(args.name);
          if (args.description !== undefined)
            dto.description = stripHtml(args.description);
          if (args.icon !== undefined) dto.icon = args.icon;
          if (args.color !== undefined) dto.color = args.color;
          if (args.isIncome !== undefined) dto.isIncome = args.isIncome;
          if (args.parentId !== undefined) dto.parentId = args.parentId;

          const category = await this.categoriesService.update(
            ctx.userId,
            args.categoryId,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_category");

          return toolResult({
            id: category.id,
            name: category.name,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "reassign_category_transactions",
      {
        title: "Reassign category transactions",
        annotations: UPDATE,
        description:
          "Move all transactions, splits, and scheduled transactions from one category to another (or to uncategorized by passing toCategoryId=null). The source category is NOT deleted — only its transactions are reassigned. Useful before retiring a category.",
        inputSchema: {
          fromCategoryId: z
            .string()
            .uuid()
            .describe("Source category to move transactions from"),
          toCategoryId: z
            .string()
            .uuid()
            .nullable()
            .describe(
              "Destination category ID, or null to uncategorize",
            ),
        },
        outputSchema: reassignCategoryTransactionsOutput,
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
          const result = await this.categoriesService.reassignTransactions(
            ctx.userId,
            args.fromCategoryId,
            args.toCategoryId,
          );

          this.writeLimiter.record(
            ctx.userId,
            "reassign_category_transactions",
          );

          return toolResult({
            fromCategoryId: args.fromCategoryId,
            toCategoryId: args.toCategoryId,
            transactionsUpdated: result.transactionsUpdated,
            splitsUpdated: result.splitsUpdated,
            scheduledUpdated: result.scheduledUpdated,
            message: "Transactions reassigned successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
