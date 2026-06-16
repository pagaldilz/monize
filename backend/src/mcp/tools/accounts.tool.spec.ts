import { McpAccountsTools } from "./accounts.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpAccountsTools", () => {
  let tool: McpAccountsTools;
  let accountsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    accountsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      getSummary: jest.fn(),
      getLlmBalances: jest.fn(),
      update: jest.fn(),
      close: jest.fn(),
      reopen: jest.fn(),
    };

    tool = new McpAccountsTools(accountsService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 7 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(7);
  });

  describe("get_account_balances", () => {
    it("delegates to accountsService.getLlmBalances (service applies 'open' default)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.getLlmBalances.mockResolvedValue({
        accounts: [],
        totalAssets: 1000,
        totalLiabilities: 0,
        netWorth: 1000,
        totalAccounts: 1,
      });

      const result = await handlers["get_account_balances"](
        { accountNames: ["Checking"] },
        { sessionId: "s1" },
      );

      expect(accountsService.getLlmBalances).toHaveBeenCalledWith(
        "u1",
        ["Checking"],
        undefined,
        undefined,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.netWorth).toBe(1000);
    });

    it("passes status and accountTypes filters through", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.getLlmBalances.mockResolvedValue({
        accounts: [],
        totalAssets: 0,
        totalLiabilities: 0,
        netWorth: 0,
        totalAccounts: 0,
      });

      await handlers["get_account_balances"](
        { status: "closed", accountTypes: ["CHEQUING", "SAVINGS"] },
        { sessionId: "s1" },
      );

      expect(accountsService.getLlmBalances).toHaveBeenCalledWith(
        "u1",
        undefined,
        "closed",
        ["CHEQUING", "SAVINGS"],
      );
    });
  });

  describe("get_accounts", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_accounts"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("should require read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["get_accounts"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("read");
    });

    it("should return accounts on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findAll.mockResolvedValue([
        { id: "a1", name: "Checking" },
      ]);

      const result = await handlers["get_accounts"]({}, { sessionId: "s1" });
      expect(result.isError).toBeUndefined();
      expect(accountsService.findAll).toHaveBeenCalledWith("u1", false);
      expect(JSON.parse(result.content[0].text)).toEqual([
        { id: "a1", name: "Checking" },
      ]);
    });

    it("should pass includeInactive flag", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findAll.mockResolvedValue([]);

      await handlers["get_accounts"](
        { includeInactive: true },
        { sessionId: "s1" },
      );
      expect(accountsService.findAll).toHaveBeenCalledWith("u1", true);
    });

    it("should handle service errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findAll.mockRejectedValue(new Error("DB error"));

      const result = await handlers["get_accounts"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("An error occurred");
    });
  });

  describe("get_account_balance", () => {
    it("should return account details on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findOne.mockResolvedValue({
        id: "a1",
        name: "Checking",
        accountType: "checking",
        currentBalance: 1000,
        creditLimit: null,
        currencyCode: "USD",
      });

      const result = await handlers["get_account_balance"](
        { accountId: "a1" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("a1");
      expect(parsed.currentBalance).toBe(1000);
    });

    it("should handle not found errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findOne.mockRejectedValue(new Error("Not found"));

      const result = await handlers["get_account_balance"](
        { accountId: "bad" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_account_balances error paths", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_account_balances"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns error on insufficient scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write_only" } as any);
      const result = await handlers["get_account_balances"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.getLlmBalances.mockRejectedValue(new Error("DB fail"));

      const result = await handlers["get_account_balances"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
