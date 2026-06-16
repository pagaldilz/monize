import { McpSafetyTools } from "./safety.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpSafetyTools", () => {
  let tool: McpSafetyTools;
  let actionHistoryService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    actionHistoryService = {
      undo: jest.fn(),
      redo: jest.fn(),
      getHistory: jest.fn(),
    };

    tool = new McpSafetyTools(actionHistoryService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 3 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(3);
  });

  describe("undo_last_action", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["undo_last_action"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("delegates to actionHistoryService.undo and surfaces the description", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      actionHistoryService.undo.mockResolvedValue({
        action: {
          entityType: "transactions",
          action: "update",
        },
        description: "Updated transaction",
      });

      const result = await handlers["undo_last_action"](
        {},
        { sessionId: "s1" },
      );

      expect(actionHistoryService.undo).toHaveBeenCalledWith("u1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.undone).toBe(true);
      expect(parsed.description).toBe("Updated transaction");
      expect(parsed.entityType).toBe("transactions");
    });
  });

  describe("redo_action", () => {
    it("delegates to actionHistoryService.redo", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      actionHistoryService.redo.mockResolvedValue({
        action: { entityType: "transactions", action: "update" },
        description: "Updated transaction",
      });

      const result = await handlers["redo_action"]({}, { sessionId: "s1" });

      expect(actionHistoryService.redo).toHaveBeenCalledWith("u1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.redone).toBe(true);
    });
  });

  describe("get_action_history", () => {
    it("delegates to actionHistoryService.getHistory with a limit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      actionHistoryService.getHistory.mockResolvedValue([
        {
          id: "h1",
          entityType: "transactions",
          action: "create",
          description: "Created transaction",
          isUndone: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      const result = await handlers["get_action_history"](
        { limit: 5 },
        { sessionId: "s1" },
      );

      expect(actionHistoryService.getHistory).toHaveBeenCalledWith("u1", 5);
      // getHistory returns a bare array; toolResult's text is the raw array JSON.
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].entityType).toBe("transactions");
    });
  });
});
