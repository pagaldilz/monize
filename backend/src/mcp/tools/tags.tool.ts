import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TagsService } from "../../tags/tags.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { stripHtml } from "../../common/sanitization.util";
import { createTagOutput, updateTagOutput } from "../tool-output-schemas";
import { CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpTagsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(private readonly tagsService: TagsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "create_tag",
      {
        title: "Create tag",
        annotations: CREATE,
        description:
          "Create a new transaction tag. Tags are labels (with optional color/icon) that can be attached to transactions for grouping.",
        inputSchema: {
          name: z.string().max(100).describe("Tag name"),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional()
            .describe("Hex color, e.g. #EF4444"),
          icon: z.string().max(50).optional().describe("Emoji or icon name"),
        },
        outputSchema: createTagOutput,
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
          const tag = await this.tagsService.create(ctx.userId, {
            name: stripHtml(args.name) as string,
            color: args.color,
            icon: args.icon,
          });

          this.writeLimiter.record(ctx.userId, "create_tag");

          return toolResult({
            id: tag.id,
            name: tag.name,
            message: "Tag created successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_tag",
      {
        title: "Update tag",
        annotations: UPDATE,
        description:
          "Update a tag's name, color, or icon. Only provided fields change.",
        inputSchema: {
          tagId: z.string().uuid().describe("Tag ID"),
          name: z.string().max(100).optional().describe("Tag name"),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional()
            .describe("Hex color, e.g. #EF4444"),
          icon: z.string().max(50).optional().describe("Emoji or icon name"),
        },
        outputSchema: updateTagOutput,
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
          const dto: Record<string, unknown> = {};
          if (args.name !== undefined) dto.name = stripHtml(args.name);
          if (args.color !== undefined) dto.color = args.color;
          if (args.icon !== undefined) dto.icon = args.icon;

          const tag = await this.tagsService.update(
            ctx.userId,
            args.tagId,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_tag");

          return toolResult({
            id: tag.id,
            name: tag.name,
            message: "Tag updated successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
