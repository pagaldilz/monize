import { McpTagsTools } from "./tags.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpTagsTools", () => {
  let tool: McpTagsTools;
  let tagsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    tagsService = {
      create: jest.fn(),
      update: jest.fn(),
    };

    tool = new McpTagsTools(tagsService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 2 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(2);
  });

  describe("create_tag", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_tag"](
        { name: "Vacation" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("creates a tag and strips HTML from name", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      tagsService.create.mockResolvedValue({ id: "tg1", name: "Vacation" });

      const result = await handlers["create_tag"](
        { name: "<b>Vacation</b>", color: "#EF4444" },
        { sessionId: "s1" },
      );

      expect(tagsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          name: "bVacation/b",
          color: "#EF4444",
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("tg1");
      expect(parsed.name).toBe("Vacation");
    });
  });

  describe("update_tag", () => {
    it("updates only provided fields", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      tagsService.update.mockResolvedValue({ id: "tg1", name: "Trip" });

      await handlers["update_tag"](
        { tagId: "tg1", name: "Trip" },
        { sessionId: "s1" },
      );

      expect(tagsService.update).toHaveBeenCalledWith(
        "u1",
        "tg1",
        expect.objectContaining({ name: "Trip" }),
      );
    });
  });
});
