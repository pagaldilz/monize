import { McpInvestmentsTools } from "./investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let sectorWeightingService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    portfolioService = {
      getPortfolioSummary: jest.fn(),
      getLlmSummary: jest.fn(),
      getAssetAllocation: jest.fn(),
      getTopMovers: jest.fn(),
      getIntradayValueSeries: jest.fn(),
    };

    holdingsService = {
      findAll: jest.fn(),
    };

    investmentTransactionsService = {
      getLlmInvestmentTransactions: jest.fn(),
      getLlmCapitalGains: jest.fn(),
      getRealizedGains: jest.fn(),
      getSecurityTransactionHistory: jest.fn(),
    };

    securitiesService = {
      search: jest.fn(),
      findOne: jest.fn(),
      findOneBySymbolOrNull: jest.fn(),
      create: jest.fn(),
      findOrCreate: jest.fn(),
    };

    securityPriceService = {
      refreshPricesForSecurities: jest.fn(),
    };

    sectorWeightingService = {
      getSectorWeightings: jest.fn(),
    };

    tool = new McpInvestmentsTools(
      portfolioService as any,
      holdingsService as any,
      investmentTransactionsService as any,
      securitiesService as any,
      securityPriceService as any,
      sectorWeightingService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 13 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(13);
  });

  describe("get_portfolio_summary", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should return portfolio summary via shared getLlmSummary", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 2,
        totalPortfolioValue: 10000,
        totalGainLoss: 500,
        holdings: [],
        allocation: [],
      });

      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith(
        "u1",
        undefined,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalPortfolioValue).toBe(10000);
      expect(parsed.totalGainLoss).toBe(500);
    });

    it("passes accountIds filter through to getLlmSummary", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        holdings: [],
        allocation: [],
      });

      await handlers["get_portfolio_summary"](
        { accountIds: ["00000000-0000-0000-0000-000000000001"] },
        { sessionId: "s1" },
      );
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith("u1", [
        "00000000-0000-0000-0000-000000000001",
      ]);
    });

    it("returns error when getLlmSummary throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockRejectedValue(new Error("fail"));
      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("query_investment_transactions", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["query_investment_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmInvestmentTransactions with all filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 2,
          totalAmount: 1000,
          totalCommission: 9.99,
          totalQuantity: 10,
          actionCounts: { BUY: 2 },
          groupedBy: "security",
          groups: [
            {
              key: "AAPL",
              transactionCount: 2,
              totalQuantity: 10,
              totalAmount: 1000,
              totalCommission: 9.99,
            },
          ],
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      const result = await handlers["query_investment_transactions"](
        {
          startDate: "2026-01-01",
          endDate: "2026-03-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
          symbols: ["AAPL"],
          actions: ["BUY"],
          groupBy: "security",
        },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountIds: ["00000000-0000-0000-0000-000000000001"],
        symbols: ["AAPL"],
        actions: ["BUY"],
        groupBy: "security",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactionCount).toBe(2);
      expect(parsed.groupedBy).toBe("security");
      expect(parsed.groups[0].key).toBe("AAPL");
    });

    it("defaults groupBy to 'security' and leaves other filters undefined when no args provided", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 0,
          totalAmount: 0,
          totalCommission: 0,
          totalQuantity: 0,
          actionCounts: {},
          groupedBy: null,
          groups: null,
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      await handlers["query_investment_transactions"]({}, { sessionId: "s1" });

      expect(
        investmentTransactionsService.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith("u1", {
        startDate: undefined,
        endDate: undefined,
        accountIds: undefined,
        symbols: undefined,
        actions: undefined,
        groupBy: "security",
      });
    });

    it("returns a safe error on service failure", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["query_investment_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_capital_gains", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmCapitalGains with all filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: {
          realizedGain: 50,
          unrealizedGain: 100,
          totalCapitalGain: 150,
        },
        groupedBy: "security",
        entries: [
          {
            month: null,
            accountName: null,
            symbol: "AAA",
            securityName: "Alpha",
            currency: "CAD",
            startValue: 1000,
            endValue: 1100,
            realizedGain: 50,
            unrealizedGain: 100,
            totalCapitalGain: 150,
          },
        ],
        entryCount: 1,
        truncatedEntryList: false,
      });

      const result = await handlers["get_capital_gains"](
        {
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
          symbols: ["AAA"],
          groupBy: "security",
        },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["00000000-0000-0000-0000-000000000001"],
        symbols: ["AAA"],
        groupBy: "security",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totals.totalCapitalGain).toBe(150);
      expect(parsed.entries[0].symbol).toBe("AAA");
    });

    it("defaults groupBy to 'month' when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: { realizedGain: 0, unrealizedGain: 0, totalCapitalGain: 0 },
        groupedBy: "month",
        entries: [],
        entryCount: 0,
        truncatedEntryList: false,
      });

      await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ groupBy: "month" }),
      );
    });

    it("returns a safe error on service failure", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_holding_details", () => {
    it("should return holdings", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      holdingsService.findAll.mockResolvedValue([{ id: "h1", symbol: "AAPL" }]);

      const result = await handlers["get_holding_details"](
        { accountId: "a1" },
        { sessionId: "s1" },
      );
      expect(holdingsService.findAll).toHaveBeenCalledWith("u1", "a1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].symbol).toBe("AAPL");
    });

    it("should handle service errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      holdingsService.findAll.mockRejectedValue(new Error("fail"));

      const result = await handlers["get_holding_details"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("create_security", () => {
    it("requires write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });

      const result = await handlers["create_security"](
        { symbol: "AAPL", name: "Apple", currencyCode: "USD" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(securitiesService.findOrCreate).not.toHaveBeenCalled();
    });

    it("dry-run returns the existing record when the symbol is present", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.findOneBySymbolOrNull.mockResolvedValue({
        id: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        currencyCode: "USD",
        exchange: "NASDAQ",
      });

      const result = await handlers["create_security"](
        {
          symbol: "aapl",
          name: "Apple",
          currencyCode: "USD",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(false);
      expect(parsed.existing.symbol).toBe("AAPL");
      // Dry-run must not consume the write quota or insert.
      expect(securitiesService.findOrCreate).not.toHaveBeenCalled();
    });

    it("dry-run previews a create when the symbol is absent", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.findOneBySymbolOrNull.mockResolvedValue(null);

      const result = await handlers["create_security"](
        {
          symbol: "MSFT",
          name: "Microsoft Corp",
          currencyCode: "usd",
          securityType: "STOCK",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(true);
      expect(parsed.preview.currencyCode).toBe("USD");
      expect(securitiesService.findOrCreate).not.toHaveBeenCalled();
    });

    it("delegates to findOrCreate on the idempotent path (default)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.findOrCreate.mockResolvedValue({
        id: "sec-2",
        symbol: "MSFT",
        name: "Microsoft Corp",
        securityType: "STOCK",
        currencyCode: "USD",
        exchange: "NASDAQ",
        isActive: true,
        isFavourite: false,
        _created: true,
      });

      const result = await handlers["create_security"](
        {
          symbol: "MSFT",
          name: "Microsoft Corp",
          currencyCode: "USD",
        },
        { sessionId: "s1" },
      );

      expect(securitiesService.findOrCreate).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ symbol: "MSFT", currencyCode: "USD" }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(true);
      expect(parsed.id).toBe("sec-2");
    });

    it("returns created=false when findOrCreate surfaces an existing record", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.findOrCreate.mockResolvedValue({
        id: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        currencyCode: "USD",
        exchange: "NASDAQ",
        isActive: true,
        isFavourite: false,
        _created: false,
      });

      const result = await handlers["create_security"](
        {
          symbol: "aapl",
          name: "Apple",
          currencyCode: "USD",
        },
        { sessionId: "s1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(false);
      expect(parsed.symbol).toBe("AAPL");
    });

    it("delegates to create() with onConflict:'error' in strict mode", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.create.mockResolvedValue({
        id: "sec-3",
        symbol: "TSLA",
        name: "Tesla Inc.",
        securityType: "STOCK",
        currencyCode: "USD",
        isActive: true,
        isFavourite: false,
      });

      const result = await handlers["create_security"](
        {
          symbol: "TSLA",
          name: "Tesla Inc.",
          currencyCode: "USD",
          onConflict: "error",
        },
        { sessionId: "s1" },
      );

      expect(securitiesService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ symbol: "TSLA" }),
        { onConflict: "error" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.created).toBe(true);
    });

    it("surfaces a conflict in strict mode as a safe error", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const conflict = new (require("@nestjs/common").ConflictException)(
        "already exists",
      );
      securitiesService.create.mockRejectedValue(conflict);

      const result = await handlers["create_security"](
        {
          symbol: "AAPL",
          name: "Apple",
          currencyCode: "USD",
          onConflict: "error",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
