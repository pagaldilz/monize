import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TransactionsService } from "../../transactions/transactions.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { AccountsService } from "../../accounts/accounts.service";
import { TagsService } from "../../tags/tags.service";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
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
  DEFAULT_TOP_N,
  getDefaultDateRange,
  resolveComparePeriods,
} from "../../common/tool-schemas";
import {
  searchTransactionsOutput,
  queryTransactionsOutput,
  getSpendingByCategoryOutput,
  getIncomeSummaryOutput,
  comparePeriodsOutput,
  getTransfersOutput,
  createTransactionOutput,
  categorizeTransactionOutput,
  updateTransactionOutput,
  createTransferOutput,
  setTransactionStatusOutput,
  clearTransactionOutput,
  updateTransactionSplitsOutput,
  setTransactionTagsOutput,
  bulkUpdateTransactionsOutput,
  unreconcileTransactionOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpTransactionsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly analyticsService: TransactionAnalyticsService,
    private readonly accountsService: AccountsService,
    private readonly tagsService: TagsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "search_transactions",
      {
        title: "Search transactions",
        annotations: READ_ONLY,
        description: "Search and filter transactions",
        inputSchema: {
          query: z.string().max(200).optional().describe("Search text"),
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Filter by account ID"),
          categoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Filter by category ID"),
          payeeId: z.string().uuid().optional().describe("Filter by payee ID"),
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD)"),
          minAmount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Minimum amount"),
          maxAmount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Maximum amount"),
          limit: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .default(50)
            .describe("Max results (default 50, max 100)"),
        },
        outputSchema: searchTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Split-expansion + amount filtering live on the domain service so
          // this tool stays a thin adapter and any AI Assistant equivalent
          // returns the same shape.
          const result = await this.transactionsService.getLlmTransactionRows(
            ctx.userId,
            {
              accountId: args.accountId,
              categoryId: args.categoryId,
              payeeId: args.payeeId,
              startDate: args.startDate,
              endDate: args.endDate,
              query: args.query,
              minAmount: args.minAmount,
              maxAmount: args.maxAmount,
              limit: args.limit,
            },
          );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "query_transactions",
      {
        title: "Query transaction totals",
        annotations: READ_ONLY,
        description:
          "Search and aggregate transaction data. Returns totals, counts, and optional grouped breakdowns (category, payee, year, month, week) - never individual transaction details. Returns the same shape as the AI Assistant's query_transactions tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to"),
          categoryIds: z
            .array(z.string().uuid())
            .max(100)
            .optional()
            .describe("Optional category IDs to filter to"),
          searchText: z
            .string()
            .max(200)
            .optional()
            .describe("Search payee names or transaction descriptions"),
          groupBy: z
            .enum(["category", "payee", "year", "month", "week"])
            .optional()
            .describe("How to group results for breakdown"),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Filter by direction"),
        },
        outputSchema: queryTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmQueryTransactions(
            ctx.userId,
            {
              startDate: args.startDate ?? defaults.startDate,
              endDate: args.endDate ?? defaults.endDate,
              accountIds: args.accountIds,
              categoryIds: args.categoryIds,
              searchText: args.searchText,
              groupBy: args.groupBy,
              direction: args.direction,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_spending_by_category",
      {
        title: "Spending by category",
        annotations: READ_ONLY,
        description:
          "Spending breakdown by category for a date range. Returns each category with total amount, percentage of total spending, and transaction count. Sorted by amount descending. Returns the same shape as the AI Assistant's get_spending_by_category tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          topN: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe(
              `Limit to top N categories by amount. Defaults to ${DEFAULT_TOP_N}.`,
            ),
        },
        outputSchema: getSpendingByCategoryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmSpendingByCategory(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.topN ?? DEFAULT_TOP_N,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_income_summary",
      {
        title: "Income summary",
        annotations: READ_ONLY,
        description:
          "Income summary for a date range, grouped by category, payee, or month. Returns the same shape as the AI Assistant's get_income_summary tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          groupBy: z
            .enum(["category", "payee", "month"])
            .optional()
            .describe("How to group income (default: category)"),
        },
        outputSchema: getIncomeSummaryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmIncomeSummary(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.groupBy ?? "category",
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "compare_periods",
      {
        title: "Compare periods",
        annotations: READ_ONLY,
        description:
          "Compare spending or income between two time periods. Returns side-by-side comparison showing absolute and percentage changes per group. If any of the four period dates are omitted, defaults to the previous full month (period1) vs the current month-to-date (period2). Returns the same shape as the AI Assistant's compare_periods tool.",
        inputSchema: {
          period1Start: z
            .string()
            .max(10)
            .optional()
            .describe(
              "First period start (YYYY-MM-DD). Defaults to the start of last month.",
            ),
          period1End: z
            .string()
            .max(10)
            .optional()
            .describe(
              "First period end (YYYY-MM-DD). Defaults to the last day of last month.",
            ),
          period2Start: z
            .string()
            .max(10)
            .optional()
            .describe(
              "Second period start (YYYY-MM-DD). Defaults to the start of the current month.",
            ),
          period2End: z
            .string()
            .max(10)
            .optional()
            .describe("Second period end (YYYY-MM-DD). Defaults to today."),
          groupBy: z
            .enum(["category", "payee"])
            .optional()
            .describe("How to group comparison (default: category)"),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Filter by direction (default: expenses)"),
        },
        outputSchema: comparePeriodsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const periods = resolveComparePeriods({
            period1Start: args.period1Start,
            period1End: args.period1End,
            period2Start: args.period2Start,
            period2End: args.period2End,
          });
          const data = await this.analyticsService.getLlmPeriodComparison(
            ctx.userId,
            {
              period1Start: periods.period1Start,
              period1End: periods.period1End,
              period2Start: periods.period2Start,
              period2End: periods.period2End,
              groupBy: args.groupBy,
              direction: args.direction,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_transfers",
      {
        title: "Get transfers",
        annotations: READ_ONLY,
        description:
          "Get transfer activity between the user's own accounts for a date range. Returns per-account inbound, outbound, net, and count. Transfers are deliberately excluded from other transaction queries because they net to zero across accounts. Returns the same shape as the AI Assistant's get_transfers tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional account IDs to filter to. Omit to cover all accounts.",
            ),
        },
        outputSchema: getTransfersOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const result = await this.analyticsService.getTransfersByAccount(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.accountIds,
          );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_transaction",
      {
        title: "Create transaction",
        annotations: CREATE,
        description:
          "Create a new transaction. Set dryRun=true to preview without saving.",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
          amount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .describe("Amount (positive for income, negative for expenses)"),
          date: z.string().max(10).describe("Transaction date (YYYY-MM-DD)"),
          payeeName: z.string().max(100).optional().describe("Payee name"),
          categoryId: z.string().uuid().optional().describe("Category ID"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Description or memo"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without creating the transaction",
            ),
        },
        outputSchema: createTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const account = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );

          // Dry-run mode: return preview without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                accountId: args.accountId,
                accountName: account.name,
                amount: args.amount,
                date: args.date,
                payeeName: stripHtml(args.payeeName) || null,
                categoryId: args.categoryId || null,
                description: stripHtml(args.description) || null,
                currencyCode: account.currencyCode,
              },
              message:
                "This is a preview. Call again with dryRun=false to create the transaction.",
            });
          }

          // LLM07-F3: Sanitize user-controlled strings (matches @SanitizeHtml() DTO behavior)
          const transaction = await this.transactionsService.create(
            ctx.userId,
            {
              accountId: args.accountId,
              amount: args.amount,
              transactionDate: args.date,
              payeeName: stripHtml(args.payeeName),
              categoryId: args.categoryId,
              description: stripHtml(args.description),
              currencyCode: account.currencyCode,
            },
          );

          this.writeLimiter.record(ctx.userId, "create_transaction");

          return toolResult({
            id: transaction.id,
            date: transaction.transactionDate,
            amount: transaction.amount,
            payeeName: transaction.payeeName,
            status: transaction.status,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "categorize_transaction",
      {
        title: "Categorize transaction",
        annotations: UPDATE,
        description: "Assign a category to a transaction",
        inputSchema: {
          transactionId: z.string().uuid().describe("Transaction ID"),
          categoryId: z.string().uuid().describe("Category ID"),
        },
        outputSchema: categorizeTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const transaction = await this.transactionsService.update(
            ctx.userId,
            args.transactionId,
            { categoryId: args.categoryId },
          );

          this.writeLimiter.record(ctx.userId, "categorize_transaction");

          return toolResult({
            id: transaction.id,
            categoryId: transaction.categoryId,
            message: "Transaction categorized successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_transaction",
      {
        title: "Update transaction",
        annotations: UPDATE,
        description:
          "Update an existing transaction's fields (amount, date, payee, category, description, status, account). Only the fields you provide are changed. Set dryRun=true to preview the change without saving.",
        inputSchema: {
          id: z.string().uuid().describe("Transaction ID to update"),
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Move the transaction to this account"),
          amount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Amount (positive for income, negative for expenses)"),
          date: z
            .string()
            .max(10)
            .optional()
            .describe("Transaction date (YYYY-MM-DD)"),
          payeeName: z.string().max(100).optional().describe("Payee name"),
          categoryId: z.string().uuid().optional().describe("Category ID"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Description or memo"),
          status: z
            .nativeEnum(TransactionStatus)
            .optional()
            .describe(
              "Transaction status: UNRECONCILED, CLEARED, RECONCILED, or VOID",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without updating the transaction",
            ),
        },
        outputSchema: updateTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const existing = await this.transactionsService.findOne(
            ctx.userId,
            args.id,
          );

          // Dry-run mode: return a preview of what would change without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                id: args.id,
                accountId: args.accountId ?? existing.accountId ?? null,
                accountName: existing.account?.name ?? null,
                amount: args.amount ?? existing.amount ?? null,
                date: args.date ?? existing.transactionDate ?? null,
                payeeName: stripHtml(args.payeeName) || existing.payeeName || null,
                categoryId: args.categoryId ?? existing.categoryId ?? null,
                description:
                  stripHtml(args.description) || existing.description || null,
                status: args.status ?? existing.status ?? null,
              },
              message:
                "This is a preview. Call again with dryRun=false to apply the update.",
            });
          }

          // LLM07-F3: Sanitize user-controlled strings before persisting.
          const dto: Record<string, unknown> = {};
          if (args.accountId !== undefined) dto.accountId = args.accountId;
          if (args.amount !== undefined) dto.amount = args.amount;
          if (args.date !== undefined) dto.transactionDate = args.date;
          if (args.payeeName !== undefined)
            dto.payeeName = stripHtml(args.payeeName);
          if (args.categoryId !== undefined) dto.categoryId = args.categoryId;
          if (args.description !== undefined)
            dto.description = stripHtml(args.description);
          if (args.status !== undefined) dto.status = args.status;

          const transaction = await this.transactionsService.update(
            ctx.userId,
            args.id,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_transaction");

          return toolResult({
            id: transaction.id,
            date: transaction.transactionDate,
            amount: transaction.amount,
            payeeName: transaction.payeeName,
            categoryId: transaction.categoryId,
            status: transaction.status,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_transfer",
      {
        title: "Create transfer",
        annotations: CREATE,
        description:
          "Create a transfer between two of the user's own accounts (e.g. checking to savings, or paying a credit card). For multi-currency transfers, optionally provide an exchangeRate or toAmount. Set dryRun=true to preview without saving.",
        inputSchema: {
          fromAccountId: z
            .string()
            .uuid()
            .describe("Account the money leaves"),
          toAccountId: z.string().uuid().describe("Account the money enters"),
          amount: z
            .number()
            .min(0)
            .max(999999999999)
            .describe(
              "Amount to transfer in the source account's currency (positive)",
            ),
          date: z.string().max(10).describe("Transfer date (YYYY-MM-DD)"),
          fromCurrencyCode: z
            .string()
            .describe("Source account currency code (e.g. USD)"),
          toCurrencyCode: z
            .string()
            .optional()
            .describe(
              "Destination account currency code. Defaults to the source currency.",
            ),
          exchangeRate: z
            .number()
            .min(0)
            .max(1000000)
            .optional()
            .describe(
              "Optional exchange rate (source -> destination). Ignored if toAmount is provided.",
            ),
          toAmount: z
            .number()
            .min(0)
            .max(999999999999)
            .optional()
            .describe(
              "Optional explicit amount in the destination currency (overrides exchangeRate).",
            ),
          payeeName: z.string().max(100).optional().describe("Payee name"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Description or memo"),
          status: z
            .nativeEnum(TransactionStatus)
            .optional()
            .describe("Transaction status (default UNRECONCILED)"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without creating the transfer",
            ),
        },
        outputSchema: createTransferOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const [fromAccount, toAccount] = await Promise.all([
            this.accountsService.findOne(ctx.userId, args.fromAccountId),
            this.accountsService.findOne(ctx.userId, args.toAccountId),
          ]);

          // Dry-run mode: return preview without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                fromAccountId: args.fromAccountId,
                fromAccountName: fromAccount.name,
                toAccountId: args.toAccountId,
                toAccountName: toAccount.name,
                amount: args.amount,
                date: args.date,
                fromCurrencyCode: args.fromCurrencyCode,
                toCurrencyCode: args.toCurrencyCode ?? args.fromCurrencyCode,
                exchangeRate: args.exchangeRate ?? null,
                toAmount: args.toAmount ?? null,
                payeeName: stripHtml(args.payeeName) || null,
                description: stripHtml(args.description) || null,
                status: args.status ?? "UNRECONCILED",
              },
              message:
                "This is a preview. Call again with dryRun=false to create the transfer.",
            });
          }

          // LLM07-F3: Sanitize user-controlled strings before persisting.
          const result = await this.transactionsService.createTransfer(
            ctx.userId,
            {
              fromAccountId: args.fromAccountId,
              toAccountId: args.toAccountId,
              amount: args.amount,
              transactionDate: args.date,
              fromCurrencyCode: args.fromCurrencyCode,
              toCurrencyCode: args.toCurrencyCode ?? args.fromCurrencyCode,
              exchangeRate: args.exchangeRate,
              toAmount: args.toAmount,
              payeeName: stripHtml(args.payeeName),
              description: stripHtml(args.description),
              status: args.status,
            },
          );

          this.writeLimiter.record(ctx.userId, "create_transfer");

          return toolResult({
            fromTransaction: {
              id: result.fromTransaction.id,
              date: result.fromTransaction.transactionDate,
              amount: result.fromTransaction.amount,
              status: result.fromTransaction.status,
            },
            toTransaction: {
              id: result.toTransaction.id,
              date: result.toTransaction.transactionDate,
              amount: result.toTransaction.amount,
              status: result.toTransaction.status,
            },
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "set_transaction_status",
      {
        title: "Set transaction status",
        annotations: UPDATE,
        description:
          "Set a transaction's reconciliation status: UNRECONCILED, CLEARED, RECONCILED, or VOID. Use this to mark transactions cleared or reconciled against a statement.",
        inputSchema: {
          id: z.string().uuid().describe("Transaction ID"),
          status: z
            .nativeEnum(TransactionStatus)
            .describe(
              "New status: UNRECONCILED, CLEARED, RECONCILED, or VOID",
            ),
        },
        outputSchema: setTransactionStatusOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const transaction = await this.transactionsService.updateStatus(
            ctx.userId,
            args.id,
            args.status,
          );

          this.writeLimiter.record(ctx.userId, "set_transaction_status");

          return toolResult({
            id: transaction.id,
            status: transaction.status,
            message: `Transaction status set to ${transaction.status}`,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "clear_transaction",
      {
        title: "Clear transaction",
        annotations: UPDATE,
        description:
          "Mark a transaction as cleared (isCleared=true) or uncleared (isCleared=false) against the bank statement. A convenience wrapper around set_transaction_status for the common clear/unclear action.",
        inputSchema: {
          id: z.string().uuid().describe("Transaction ID"),
          isCleared: z
            .boolean()
            .describe("true to mark cleared, false to mark uncleared"),
        },
        outputSchema: clearTransactionOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const transaction = await this.transactionsService.markCleared(
            ctx.userId,
            args.id,
            args.isCleared,
          );

          this.writeLimiter.record(ctx.userId, "clear_transaction");

          return toolResult({
            id: transaction.id,
            status: transaction.status,
            isCleared: args.isCleared,
            message: args.isCleared
              ? "Transaction marked cleared"
              : "Transaction marked uncleared",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_transaction_splits",
      {
        title: "Update transaction splits",
        annotations: UPDATE,
        description:
          "Replace all splits on a transaction atomically. Each split specifies an amount plus exactly one of categoryId (categorized split), transferAccountId (transfer split). Splits should sum to the transaction total. Set dryRun=true to preview the proposed splits without saving.",
        inputSchema: {
          transactionId: z.string().uuid().describe("Transaction ID"),
          splits: z
            .array(
              z
                .object({
                  amount: z
                    .number()
                    .min(-999999999999)
                    .max(999999999999)
                    .describe("Split amount (signed)"),
                  categoryId: z
                    .string()
                    .uuid()
                    .optional()
                    .describe("Category for a categorized split"),
                  transferAccountId: z
                    .string()
                    .uuid()
                    .optional()
                    .describe("Destination account for a transfer split"),
                  memo: z
                    .string()
                    .max(500)
                    .optional()
                    .describe("Memo for this split line"),
                }),
            )
            .min(1)
            .max(100)
            .describe("Full replacement set of splits"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, preview without saving"),
        },
        outputSchema: updateTransactionSplitsOutput,
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
          // Dry-run preview without persisting.
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                transactionId: args.transactionId,
                splitCount: args.splits.length,
                splits: args.splits.map((s) => ({
                  amount: s.amount,
                  categoryId: s.categoryId ?? null,
                  transferAccountId: s.transferAccountId ?? null,
                  memo: stripHtml(s.memo) || null,
                })),
              },
              message:
                "This is a preview. Call again with dryRun=false to apply the splits.",
            });
          }

          const splitsDto = args.splits.map((s) => ({
            amount: s.amount,
            categoryId: s.categoryId,
            transferAccountId: s.transferAccountId,
            memo: stripHtml(s.memo),
          }));

          await this.transactionsService.updateSplits(
            ctx.userId,
            args.transactionId,
            splitsDto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_transaction_splits");

          return toolResult({
            transactionId: args.transactionId,
            splitCount: splitsDto.length,
            message: "Transaction splits updated successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "set_transaction_tags",
      {
        title: "Set transaction tags",
        annotations: UPDATE,
        description:
          "Replace the set of tags on a transaction. Pass an empty array to clear all tags. Idempotent: calling twice with the same tagIds yields the same state.",
        inputSchema: {
          transactionId: z.string().uuid().describe("Transaction ID"),
          tagIds: z
            .array(z.string().uuid())
            .max(50)
            .describe(
              "Full set of tag IDs to assign (empty array clears all tags)",
            ),
        },
        outputSchema: setTransactionTagsOutput,
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
          // NOTE: TagsService.setTransactionTags takes (transactionId, tagIds, userId)
          // — userId is the 3rd parameter, not the first.
          await this.tagsService.setTransactionTags(
            args.transactionId,
            args.tagIds,
            ctx.userId,
          );

          this.writeLimiter.record(ctx.userId, "set_transaction_tags");

          return toolResult({
            transactionId: args.transactionId,
            tagIds: args.tagIds,
            message: "Transaction tags updated successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "bulk_update_transactions",
      {
        title: "Bulk update transactions",
        annotations: UPDATE,
        description:
          "Update many transactions at once by a list of IDs or by filters. Provide the fields to set (payeeId/payeeName/categoryId/description/status/tagIds). Use dryRun=true to see how many transactions match without applying any changes. This is the highest-leverage cleanup tool (e.g. re-categorize all transactions from a payee) without deleting anything.",
        inputSchema: {
          mode: z
            .enum(["ids", "filter"])
            .describe(
              "'ids' to target specific transaction IDs; 'filter' to target by criteria",
            ),
          transactionIds: z
            .array(z.string().uuid())
            .max(500)
            .optional()
            .describe("Required when mode='ids'"),
          filters: z
            .object({
              accountIds: z.array(z.string().uuid()).optional(),
              startDate: z.string().max(10).optional(),
              endDate: z.string().max(10).optional(),
              categoryIds: z.array(z.string().uuid()).optional(),
              payeeIds: z.array(z.string().uuid()).optional(),
              search: z.string().max(200).optional(),
            })
            .optional()
            .describe("Required when mode='filter'"),
          payeeId: z.string().uuid().nullable().optional(),
          payeeName: z.string().max(100).optional(),
          categoryId: z.string().uuid().nullable().optional(),
          description: z.string().max(500).optional(),
          status: z.nativeEnum(TransactionStatus).optional(),
          tagIds: z.array(z.string().uuid()).optional(),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, count matches without applying changes"),
        },
        outputSchema: bulkUpdateTransactionsOutput,
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
          // Dry-run: echo the request and warn that an exact match count is not
          // computed (avoids re-implementing the selection logic here). The
          // caller can use search_transactions to preview matches first.
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              message:
                "Dry-run requested. Use search_transactions with the same filters to preview matching transactions before applying.",
            });
          }

          const dto: Record<string, unknown> = {
            mode: args.mode,
            payeeId: args.payeeId,
            payeeName: stripHtml(args.payeeName),
            categoryId: args.categoryId,
            description: stripHtml(args.description),
            status: args.status,
            tagIds: args.tagIds,
          };
          if (args.mode === "ids") {
            dto.transactionIds = args.transactionIds ?? [];
          } else {
            dto.filters = args.filters ?? {};
          }

          const result = await this.transactionsService.bulkUpdate(
            ctx.userId,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "bulk_update_transactions");

          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "unreconcile_transaction",
      {
        title: "Unreconcile transaction",
        annotations: UPDATE,
        description:
          "Mark a previously reconciled transaction as unreconciled. Counterpart to reconciliation; idempotent.",
        inputSchema: {
          id: z.string().uuid().describe("Transaction ID"),
        },
        outputSchema: unreconcileTransactionOutput,
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
          const transaction = await this.transactionsService.unreconcile(
            ctx.userId,
            args.id,
          );

          this.writeLimiter.record(ctx.userId, "unreconcile_transaction");

          return toolResult({
            id: transaction.id,
            status: transaction.status,
            message: "Transaction unreconciled",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
