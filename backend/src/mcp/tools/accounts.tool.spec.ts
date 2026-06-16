import { McpAccountsTools } from "./accounts.tool";
import { UserContextResolver } from "../mcp-context";
import { BadRequestException } from "@nestjs/common";

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
      create: jest.fn(),
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

  describe("create_account", () => {
    beforeEach(() => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
    });

    it("creates a single INVESTMENT account from name + currency only", async () => {
      accountsService.create.mockResolvedValue({
        id: "inv-1",
        name: "Brokerage",
        accountType: "INVESTMENT",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
        isClosed: false,
      });

      const result = await handlers["create_account"](
        {
          accountType: "INVESTMENT",
          name: "Brokerage",
          currencyCode: "usd",
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBeUndefined();
      // currencyCode is uppercased before being forwarded
      expect(accountsService.create).toHaveBeenCalledWith("u1", {
        accountType: "INVESTMENT",
        name: "Brokerage",
        currencyCode: "USD",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("inv-1");
      expect(parsed.message).toBe("Account created successfully.");
      // pair fields should be absent on the single-account path
      expect(parsed.cashAccount).toBeUndefined();
      expect(parsed.brokerageAccount).toBeUndefined();
    });

    it("creates an INVESTMENT cash+brokerage pair when createInvestmentPair=true", async () => {
      accountsService.create.mockResolvedValue({
        cashAccount: {
          id: "cash-1",
          name: "Investment Cash",
          accountType: "INVESTMENT",
          currencyCode: "USD",
          openingBalance: 5000,
          currentBalance: 5000,
          isClosed: false,
        },
        brokerageAccount: {
          id: "brok-1",
          name: "Investment Brokerage",
          accountType: "INVESTMENT",
          currencyCode: "USD",
          openingBalance: 0,
          currentBalance: 0,
          isClosed: false,
        },
      });

      const result = await handlers["create_account"](
        {
          accountType: "INVESTMENT",
          name: "Brokerage",
          currencyCode: "USD",
          openingBalance: 5000,
          createInvestmentPair: true,
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBeUndefined();
      expect(accountsService.create).toHaveBeenCalledWith("u1", {
        accountType: "INVESTMENT",
        name: "Brokerage",
        currencyCode: "USD",
        openingBalance: 5000,
        createInvestmentPair: true,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.cashAccount.id).toBe("cash-1");
      expect(parsed.brokerageAccount.id).toBe("brok-1");
      expect(parsed.message).toContain("pair");
    });

    it("forwards loan payment-plan fields to the service", async () => {
      accountsService.create.mockResolvedValue({
        id: "loan-1",
        name: "Car Loan",
        accountType: "LOAN",
        currencyCode: "USD",
        openingBalance: -20000,
        currentBalance: -20000,
        isClosed: false,
      });

      const result = await handlers["create_account"](
        {
          accountType: "LOAN",
          name: "Car Loan",
          currencyCode: "USD",
          openingBalance: 20000,
          institution: "Big Bank",
          interestRate: 6.5,
          paymentAmount: 400,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2026-07-01",
          sourceAccountId: "11111111-1111-1111-1111-111111111111",
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBeUndefined();
      expect(accountsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountType: "LOAN",
          openingBalance: 20000,
          institution: "Big Bank",
          interestRate: 6.5,
          paymentAmount: 400,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2026-07-01",
          sourceAccountId: "11111111-1111-1111-1111-111111111111",
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("loan-1");
    });

    it("forwards mortgage-specific fields to the service", async () => {
      accountsService.create.mockResolvedValue({
        id: "mort-1",
        name: "Home",
        accountType: "MORTGAGE",
        currencyCode: "USD",
        openingBalance: -350000,
        currentBalance: -350000,
        isClosed: false,
      });

      const result = await handlers["create_account"](
        {
          accountType: "MORTGAGE",
          name: "Home",
          currencyCode: "USD",
          openingBalance: 350000,
          institution: "Big Bank",
          interestRate: 5.99,
          mortgagePaymentFrequency: "MONTHLY",
          paymentStartDate: "2026-07-01",
          sourceAccountId: "11111111-1111-1111-1111-111111111111",
          amortizationMonths: 300,
          isCanadianMortgage: true,
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBeUndefined();
      expect(accountsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountType: "MORTGAGE",
          mortgagePaymentFrequency: "MONTHLY",
          amortizationMonths: 300,
          isCanadianMortgage: true,
        }),
      );
    });

    it("surfaces a service BadRequestException as a clear tool error", async () => {
      // The loan service throws 400 when required payment fields are missing.
      accountsService.create.mockRejectedValue(
        new BadRequestException(
          "Loan accounts require paymentAmount, paymentFrequency, paymentStartDate, and sourceAccountId",
        ),
      );

      const result = await handlers["create_account"](
        {
          accountType: "LOAN",
          name: "Bad Loan",
          currencyCode: "USD",
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      // safeToolError passes the 4xx message through (not the generic "An error occurred")
      expect(result.content[0].text).toContain("paymentAmount");
    });

    it("strips HTML from free-text fields", async () => {
      accountsService.create.mockResolvedValue({
        id: "a1",
        name: "Safe",
        accountType: "SAVINGS",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
        isClosed: false,
      });

      await handlers["create_account"](
        {
          accountType: "SAVINGS",
          name: "<script>x</script>Savings",
          currencyCode: "USD",
          description: "<b>desc</b>",
          institution: "<i>bank</i>",
        },
        { sessionId: "s1" },
      );

      expect(accountsService.create).toHaveBeenCalledWith("u1", {
        accountType: "SAVINGS",
        name: expect.not.stringContaining("<script>"),
        currencyCode: "USD",
        description: expect.not.stringContaining("<b>"),
        institution: expect.not.stringContaining("<i>"),
      });
    });
  });
});
