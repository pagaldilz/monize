import { Test, TestingModule } from "@nestjs/testing";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServerService } from "./mcp-server.service";
import { AiAgentToolRegistry } from "./ai-agent-tool-registry";

/**
 * The AI Agent chatbox advertises the MCP tools to the LLM, filtered by the
 * session's scopes. These tests pin the core safety guarantee of the
 * read-only/edit toggle:
 *
 *  - In read-only mode, NO write tool is advertised (so the model can't even
 *    propose a write).
 *  - In edit mode, ALL tools are advertised.
 *  - isWriteTool() classifies tools by their annotation.
 *  - A write tool called under a read-only session is rejected by the
 *    handler's requireScope gate (returns isError).
 *
 * Rather than boot all 13 real tool providers (and their heavy service
 * dependencies), we mock `McpServerService.registerAll` to register a small,
 * controlled set of tools against a genuine McpServer via the same Proxy the
 * registry uses. This exercises the registry's capture/filter/invoke logic
 * truthfully while keeping the test hermetic.
 */

describe("AiAgentToolRegistry", () => {
  let registry: AiAgentToolRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiAgentToolRegistry,
        {
          provide: McpServerService,
          useValue: {
            // Register a representative mix: 3 read tools, 2 write tools,
            // 1 reports-scoped read tool. Mirrors the annotation shapes the
            // real providers use.
            registerAll(server: McpServer, resolve: any) {
              const READ = { readOnlyHint: true, openWorldHint: false };
              const WRITE = {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
              };

              server.registerTool(
                "get_accounts",
                { title: "Get accounts", annotations: READ, description: "List accounts.", inputSchema: {} },
                async (_a: unknown, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("read")) return err('Insufficient scope. Requires "read" scope.');
                  return ok([{ id: "1" }]);
                },
              );
              server.registerTool(
                "get_categories",
                { title: "Get categories", annotations: READ, description: "List categories.", inputSchema: {} },
                async (_a: unknown, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("read")) return err('Insufficient scope. Requires "read" scope.');
                  return ok([]);
                },
              );
              server.registerTool(
                "get_account_balance",
                {
                  title: "Get account balance",
                  annotations: READ,
                  description: "Get balance for an account.",
                  inputSchema: { accountId: z.string().uuid() },
                },
                async (args: { accountId: string }, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("read")) return err('Insufficient scope. Requires "read" scope.');
                  return ok({ id: args.accountId, balance: 0 });
                },
              );
              server.registerTool(
                "generate_report",
                { title: "Generate report", annotations: READ, description: "Generate report.", inputSchema: {} },
                async (_a: unknown, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("reports")) return err('Insufficient scope. Requires "reports" scope.');
                  return ok({});
                },
              );
              server.registerTool(
                "calculate",
                { title: "Calculate", annotations: READ, description: "Arithmetic.", inputSchema: {} },
                async () => ok({ result: 0 }),
              );
              server.registerTool(
                "create_transaction",
                { title: "Create transaction", annotations: WRITE, description: "Create a transaction.", inputSchema: {} },
                async (_a: unknown, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("write")) return err('Insufficient scope. Requires "write" scope.');
                  return ok({ id: "tx-1" });
                },
              );
              server.registerTool(
                "update_account",
                {
                  title: "Update account",
                  annotations: { ...WRITE, idempotentHint: true },
                  description: "Update an account.",
                  inputSchema: {},
                },
                async (_a: unknown, extra: { sessionId?: string }) => {
                  const ctx = resolve(extra.sessionId);
                  if (!ctx) return err("No user context");
                  if (!ctx.scopes.split(",").includes("write")) return err('Insufficient scope. Requires "write" scope.');
                  return ok({});
                },
              );
            },
          },
        },
      ],
    }).compile();

    registry = module.get(AiAgentToolRegistry);
  });

  it("advertises only read-only tools when scopes omit 'write'", () => {
    const defs = registry.getToolDefinitions("read,reports");
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([
      "calculate",
      "generate_report",
      "get_account_balance",
      "get_accounts",
      "get_categories",
    ]);
    // Write tools must be absent.
    expect(defs.find((d) => d.name === "create_transaction")).toBeUndefined();
    expect(defs.find((d) => d.name === "update_account")).toBeUndefined();
  });

  it("advertises all tools when scopes include 'write'", () => {
    const defs = registry.getToolDefinitions("read,reports,write");
    expect(defs.map((d) => d.name).sort()).toEqual([
      "calculate",
      "create_transaction",
      "generate_report",
      "get_account_balance",
      "get_accounts",
      "get_categories",
      "update_account",
    ]);
  });

  it("classifies write vs read tools via isWriteTool()", () => {
    expect(registry.isWriteTool("create_transaction")).toBe(true);
    expect(registry.isWriteTool("update_account")).toBe(true);
    expect(registry.isWriteTool("get_accounts")).toBe(false);
    expect(registry.isWriteTool("generate_report")).toBe(false);
    expect(registry.isWriteTool("calculate")).toBe(false);
    expect(registry.isWriteTool("does_not_exist")).toBe(false);
  });

  it("returns a JSON-schema inputSchema + description for every advertised tool", () => {
    const defs = registry.getToolDefinitions("read,reports,write");
    for (const def of defs) {
      expect(def.inputSchema).toBeDefined();
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it("renders real JSON-schema (properties, required, enum) — not empty {}", () => {
    // Regression: zod-to-json-schema@3.x silently returned {} for every
    // schema under Zod v4, leaving the model with no idea what arguments a
    // tool needs. Verify the native z.toJSONSchema() path produces proper
    // properties + required + type constraints.
    const defs = registry.getToolDefinitions("read,reports");
    const balance = defs.find((d) => d.name === "get_account_balance")!;
    const schema = balance.inputSchema as Record<string, unknown>;

    // Must have a non-empty properties object.
    expect(schema.properties).toBeDefined();
    const props = schema.properties as Record<string, unknown>;
    expect(props.accountId).toBeDefined();

    // accountId must be typed as a string.
    const accountIdSchema = props.accountId as Record<string, unknown>;
    expect(accountIdSchema.type).toBe("string");

    // It must be in the required array (it's z.string().uuid(), not optional).
    const required = schema.required as string[];
    expect(required).toContain("accountId");
  });

  it("rejects an unknown tool call with an error result", async () => {
    const sid = registry.beginSession("user-1", "read,reports,write");
    const result = await registry.callTool("does_not_exist", {}, sid);
    expect(result.isError).toBe(true);
    registry.endSession(sid);
  });

  it("read-only session rejects a write tool at execution time", async () => {
    // Even though the model shouldn't see write tools in read-only mode, the
    // authoritative gate is requireScope inside the handler. Verify it fires.
    const sid = registry.beginSession("user-1", "read,reports");
    const result = await registry.callTool("create_transaction", {}, sid);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.toLowerCase()).toContain("scope");
    registry.endSession(sid);
  });

  it("edit session executes a write tool successfully", async () => {
    const sid = registry.beginSession("user-1", "read,reports,write");
    const result = await registry.callTool("create_transaction", {}, sid);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("tx-1");
    registry.endSession(sid);
  });

  it("read session executes a read tool successfully", async () => {
    const sid = registry.beginSession("user-1", "read,reports");
    const result = await registry.callTool("get_accounts", {}, sid);
    expect(result.isError).toBeFalsy();
    registry.endSession(sid);
  });

  it("rejects invalid input (e.g. placeholder UUID) before reaching the handler", async () => {
    // Regression: the model passed accountId: "placeholder" and the raw value
    // reached the DB, crashing with "invalid input syntax for type uuid".
    // Now the Zod schema rejects it in-process and returns a clean error.
    const sid = registry.beginSession("user-1", "read,reports");
    const result = await registry.callTool(
      "get_account_balance",
      { accountId: "placeholder" },
      sid,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("get_account_balance");
    expect(text.toLowerCase()).toContain("uuid");
    registry.endSession(sid);
  });

  it("accepts valid input and passes parsed args to the handler", async () => {
    const sid = registry.beginSession("user-1", "read,reports");
    const result = await registry.callTool(
      "get_account_balance",
      { accountId: "00000000-0000-0000-0000-000000000000" },
      sid,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("00000000-0000-0000-0000-000000000000");
    registry.endSession(sid);
  });
});

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}
function textOf(result: { content?: Array<{ type: string; text?: string }> }) {
  return (result.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}
