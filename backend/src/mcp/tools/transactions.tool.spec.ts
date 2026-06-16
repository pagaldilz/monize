import { McpTransactionsTools } from "./transactions.tool";
import { UserContextResolver } from "../mcp-context";
import { MCP_DAILY_WRITE_LIMIT } from "../mcp-write-limiter";

describe("McpTransactionsTools", () => {
  let tool: McpTransactionsTools;
  let transactionsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let tagsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      getLlmTransactionRows: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      createTransfer: jest.fn(),
      updateStatus: jest.fn(),
      markCleared: jest.fn(),
      updateSplits: jest.fn(),
      bulkUpdate: jest.fn(),
      unreconcile: jest.fn(),
    };

    analyticsService = {
      getTransfersByAccount: jest.fn(),
      getLlmQueryTransactions: jest.fn(),
      getLlmSpendingByCategory: jest.fn(),
      getLlmIncomeSummary: jest.fn(),
      getLlmPeriodComparison: jest.fn(),
    };

    accountsService = {
      findOne: jest.fn(),
    };

    tagsService = {
      setTransactionTags: jest.fn(),
    };

    tool = new McpTransactionsTools(
      transactionsService as any,
      analyticsService as any,
      accountsService as any,
      tagsService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 16 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(16);
  });

  describe("query_transactions", () => {
    it("delegates to analyticsService.getLlmQueryTransactions", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmQueryTransactions.mockResolvedValue({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      });

      await handlers["query_transactions"](
        { startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "category" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmQueryTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          groupBy: "category",
        }),
      );
    });

    it("fills in default dates when startDate/endDate are omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmQueryTransactions.mockResolvedValue({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      });

      await handlers["query_transactions"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmQueryTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  describe("get_spending_by_category", () => {
    it("delegates to analyticsService.getLlmSpendingByCategory", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmSpendingByCategory.mockResolvedValue({
        categories: [],
        totalSpending: 0,
      });

      await handlers["get_spending_by_category"](
        { startDate: "2026-01-01", endDate: "2026-01-31", topN: 5 },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        5,
      );
    });

    it("defaults topN to 10 and fills in dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmSpendingByCategory.mockResolvedValue({
        categories: [],
        totalSpending: 0,
      });

      await handlers["get_spending_by_category"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        10,
      );
    });
  });

  describe("get_income_summary", () => {
    it("delegates to analyticsService.getLlmIncomeSummary with default groupBy", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmIncomeSummary.mockResolvedValue({
        items: [],
        totalIncome: 0,
        groupedBy: "category",
      });

      await handlers["get_income_summary"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmIncomeSummary).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        "category",
      );
    });

    it("fills in default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmIncomeSummary.mockResolvedValue({
        items: [],
        totalIncome: 0,
        groupedBy: "category",
      });

      await handlers["get_income_summary"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmIncomeSummary).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        "category",
      );
    });
  });

  describe("compare_periods", () => {
    it("delegates to analyticsService.getLlmPeriodComparison", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "2025-12-01", end: "2025-12-31", total: 0 },
        period2: { start: "2026-01-01", end: "2026-01-31", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"](
        {
          period1Start: "2025-12-01",
          period1End: "2025-12-31",
          period2Start: "2026-01-01",
          period2End: "2026-01-31",
        },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: "2025-12-01",
          period2Start: "2026-01-01",
        }),
      );
    });

    it("fills in all four dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "", end: "", total: 0 },
        period2: { start: "", end: "", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period1End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  describe("get_transfers", () => {
    it("delegates to shared analytics service", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [
          {
            accountName: "Savings",
            currency: "USD",
            inbound: 1500,
            outbound: 0,
            net: 1500,
            transferCount: 3,
          },
        ],
        totalInbound: 1500,
        totalOutbound: 0,
        transferCount: 3,
      });

      const result = await handlers["get_transfers"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        undefined,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalInbound).toBe(1500);
      expect(parsed.accounts).toHaveLength(1);
    });

    it("requires read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["get_transfers"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("passes accountIds filter through", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [],
        totalInbound: 0,
        totalOutbound: 0,
        transferCount: 0,
      });

      await handlers["get_transfers"](
        {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
        },
        { sessionId: "s1" },
      );
      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        ["00000000-0000-0000-0000-000000000001"],
      );
    });

    it("fills in default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [],
        totalInbound: 0,
        totalOutbound: 0,
        transferCount: 0,
      });

      await handlers["get_transfers"]({}, { sessionId: "s1" });

      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        undefined,
      );
    });
  });

  describe("search_transactions", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should require read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns the rows the domain service produces", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.getLlmTransactionRows.mockResolvedValue({
        transactions: [
          {
            id: "t1",
            date: "2025-01-15",
            payeeName: "Store",
            categoryName: "Food",
            amount: -50,
            accountName: "Checking",
            description: "Groceries",
            status: "cleared",
          },
        ],
        total: 1,
        hasMore: false,
      });

      const result = await handlers["search_transactions"](
        { query: "store", limit: 10 },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactions).toHaveLength(1);
      expect(parsed.transactions[0].payeeName).toBe("Store");
      expect(parsed.total).toBe(1);
    });

    it("delegates the filter args to the domain service (thin adapter)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.getLlmTransactionRows.mockResolvedValue({
        transactions: [],
        total: 0,
        hasMore: false,
      });

      await handlers["search_transactions"](
        {
          query: "q",
          accountId: "a1",
          categoryId: "c1",
          payeeId: "p1",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
          minAmount: -150,
          maxAmount: -10,
          limit: 999,
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.getLlmTransactionRows).toHaveBeenCalledWith(
        "u1",
        {
          query: "q",
          accountId: "a1",
          categoryId: "c1",
          payeeId: "p1",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
          minAmount: -150,
          maxAmount: -10,
          limit: 999,
        },
      );
    });
  });

  describe("create_transaction", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_transaction"](
        { accountId: "a1", amount: -50, date: "2025-01-15" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should create transaction with account currency", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
        amount: -50,
        payeeName: "Store",
        status: "pending",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "Store",
          dryRun: false,
        },
        { sessionId: "s1" },
      );
      expect(accountsService.findOne).toHaveBeenCalledWith("u1", "a1");
      expect(transactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          currencyCode: "USD",
          amount: -50,
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
    });

    it("should return preview in dry-run mode without creating", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({
        name: "Checking",
        currencyCode: "USD",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -75,
          date: "2025-02-01",
          payeeName: "Coffee Shop",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      // Should NOT call create
      expect(transactionsService.create).not.toHaveBeenCalled();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.amount).toBe(-75);
      expect(parsed.preview.accountName).toBe("Checking");
      expect(parsed.preview.currencyCode).toBe("USD");
      expect(parsed.message).toContain("preview");
    });

    it("should strip HTML from payeeName and description (LLM07-F3)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
        amount: -50,
        payeeName: "script alert XSS /script",
        status: "pending",
      });

      await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "<script>alert('XSS')</script>",
          description: "Purchase at <b>Store</b>",
          dryRun: false,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          payeeName: "scriptalert('XSS')/script",
          description: "Purchase at bStore/b",
        }),
      );
    });

    it("should strip HTML in dry-run preview (LLM07-F3)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({
        name: "Checking",
        currencyCode: "USD",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "<img src=x>",
          description: "Test <script>",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.preview.payeeName).toBe("img src=x");
      expect(parsed.preview.description).toBe("Test script");
    });

    it("should enforce daily write rate limit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t-new",
        transactionDate: "2025-01-15",
        amount: -10,
        payeeName: "Store",
        status: "pending",
      });

      // Exhaust the rate limit by creating a new tool instance
      // and manually filling up the limiter
      const freshTool = new McpTransactionsTools(
        transactionsService as any,
        analyticsService as any,
        accountsService as any,
        tagsService as any,
      );
      const freshHandlers: Record<string, (...args: any[]) => any> = {};
      const freshServer = {
        registerTool: jest.fn((name: string, _opts: any, handler: any) => {
          freshHandlers[name] = handler;
        }),
      };
      freshTool.register(freshServer as any, resolve);

      // Fill up the limiter via internal access
      const limiter = (freshTool as any).writeLimiter;
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("u1", "create_transaction");
      }

      const result = await freshHandlers["create_transaction"](
        {
          accountId: "a1",
          amount: -10,
          date: "2025-01-15",
          dryRun: false,
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit reached");
    });
  });

  describe("categorize_transaction", () => {
    it("should categorize a transaction", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.update.mockResolvedValue({
        id: "t1",
        categoryId: "c1",
      });

      const result = await handlers["categorize_transaction"](
        { transactionId: "t1", categoryId: "c1" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain("categorized");
    });

    it("should enforce daily write rate limit for categorization", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });

      const freshTool = new McpTransactionsTools(
        transactionsService as any,
        analyticsService as any,
        accountsService as any,
        tagsService as any,
      );
      const freshHandlers: Record<string, (...args: any[]) => any> = {};
      const freshServer = {
        registerTool: jest.fn((name: string, _opts: any, handler: any) => {
          freshHandlers[name] = handler;
        }),
      };
      freshTool.register(freshServer as any, resolve);

      const limiter = (freshTool as any).writeLimiter;
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("u1", "categorize_transaction");
      }

      const result = await freshHandlers["categorize_transaction"](
        { transactionId: "t1", categoryId: "c1" },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit reached");
    });
  });

  describe("update_transaction", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["update_transaction"](
        { id: "t1", amount: -50 },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns a preview in dry-run mode without persisting", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.findOne.mockResolvedValue({
        id: "t1",
        amount: -40,
        transactionDate: "2025-01-15",
        payeeName: "Old",
        description: "prev",
        status: "UNRECONCILED",
        account: { name: "Checking" },
      });

      const result = await handlers["update_transaction"](
        { id: "t1", amount: -50, payeeName: "<b>New</b>", dryRun: true },
        { sessionId: "s1" },
      );

      expect(transactionsService.update).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.amount).toBe(-50);
      expect(parsed.preview.payeeName).toBe("bNew/b"); // HTML stripped
    });

    it("applies only provided fields and strips HTML", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.update.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
        amount: -50,
        payeeName: "New",
        categoryId: "c1",
        status: "UNRECONCILED",
      });

      await handlers["update_transaction"](
        { id: "t1", amount: -50, payeeName: "<script>x</script>" },
        { sessionId: "s1" },
      );

      expect(transactionsService.update).toHaveBeenCalledWith(
        "u1",
        "t1",
        expect.objectContaining({
          amount: -50,
          payeeName: "scriptx/script",
        }),
      );
    });
  });

  describe("create_transfer", () => {
    it("returns a preview in dry-run mode", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne
        .mockResolvedValueOnce({ name: "Checking", currencyCode: "USD" })
        .mockResolvedValueOnce({ name: "Savings", currencyCode: "USD" });

      const result = await handlers["create_transfer"](
        {
          fromAccountId: "a1",
          toAccountId: "a2",
          amount: 100,
          date: "2025-01-15",
          fromCurrencyCode: "USD",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.createTransfer).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.fromAccountName).toBe("Checking");
      expect(parsed.preview.toAccountName).toBe("Savings");
    });

    it("creates the transfer and records both sides", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne
        .mockResolvedValueOnce({ name: "Checking", currencyCode: "USD" })
        .mockResolvedValueOnce({ name: "Savings", currencyCode: "USD" });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: {
          id: "t1",
          transactionDate: "2025-01-15",
          amount: -100,
          status: "UNRECONCILED",
        },
        toTransaction: {
          id: "t2",
          transactionDate: "2025-01-15",
          amount: 100,
          status: "UNRECONCILED",
        },
      });

      const result = await handlers["create_transfer"](
        {
          fromAccountId: "a1",
          toAccountId: "a2",
          amount: 100,
          date: "2025-01-15",
          fromCurrencyCode: "USD",
        },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.fromTransaction.id).toBe("t1");
      expect(parsed.toTransaction.id).toBe("t2");
    });
  });

  describe("set_transaction_status", () => {
    it("delegates to transactionsService.updateStatus", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.updateStatus.mockResolvedValue({
        id: "t1",
        status: "CLEARED",
      });

      const result = await handlers["set_transaction_status"](
        { id: "t1", status: "CLEARED" },
        { sessionId: "s1" },
      );
      expect(transactionsService.updateStatus).toHaveBeenCalledWith(
        "u1",
        "t1",
        "CLEARED",
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("CLEARED");
    });
  });

  describe("clear_transaction", () => {
    it("delegates to transactionsService.markCleared", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.markCleared.mockResolvedValue({
        id: "t1",
        status: "CLEARED",
      });

      const result = await handlers["clear_transaction"](
        { id: "t1", isCleared: true },
        { sessionId: "s1" },
      );
      expect(transactionsService.markCleared).toHaveBeenCalledWith(
        "u1",
        "t1",
        true,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.isCleared).toBe(true);
    });
  });
});
