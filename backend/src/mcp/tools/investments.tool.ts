import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortfolioService } from "../../securities/portfolio.service";
import { HoldingsService } from "../../securities/holdings.service";
import { SecuritiesService } from "../../securities/securities.service";
import { SecurityPriceService } from "../../securities/security-price.service";
import { SectorWeightingService } from "../../securities/sector-weighting.service";
import {
  InvestmentTransactionsService,
  LlmCapitalGainsGroupBy,
  LlmInvestmentTxGroupBy,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
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
  getPortfolioSummaryOutput,
  queryInvestmentTransactionsOutput,
  getCapitalGainsOutput,
  getHoldingDetailsOutput,
  getAssetAllocationOutput,
  getTopMoversOutput,
  getSectorWeightingsOutput,
  getIntradayValueOutput,
  getRealizedGainsOutput,
  getSecurityHistoryOutput,
  searchSecuritiesOutput,
  refreshSecurityPricesOutput,
  createSecurityOutput,
} from "../tool-output-schemas";
import { READ_ONLY, UPDATE, CREATE } from "../mcp-annotations";

const INTRADAY_RANGES = ["1d", "1w", "1m"] as const;

@Injectable()
export class McpInvestmentsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly holdingsService: HoldingsService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
    private readonly securityPriceService: SecurityPriceService,
    private readonly sectorWeightingService: SectorWeightingService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_portfolio_summary",
      {
        title: "Portfolio summary",
        annotations: READ_ONLY,
        description:
          "Get investment portfolio overview with holdings, gains/losses, and allocation. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to. Omit to cover all investment accounts.",
            ),
        },
        outputSchema: getPortfolioSummaryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const summary = await this.portfolioService.getLlmSummary(
            ctx.userId,
            args.accountIds,
          );
          return toolResult(summary);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "query_investment_transactions",
      {
        title: "Query investment transactions",
        annotations: READ_ONLY,
        description:
          "Query brokerage investment-account transactions (buys, sells, dividends, interest, capital gains, splits, transfers, reinvestments, share adjustments). Filter by account, security symbol, action, and date; optionally group by account, date, security, or action. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional end date (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          actions: z
            .array(z.nativeEnum(InvestmentAction))
            .max(11)
            .optional()
            .describe(
              "Optional transaction types (BUY, SELL, DIVIDEND, INTEREST, CAPITAL_GAIN, SPLIT, TRANSFER_IN, TRANSFER_OUT, REINVEST, ADD_SHARES, REMOVE_SHARES).",
            ),
          groupBy: z
            .enum(["account", "date", "security", "action"])
            .optional()
            .describe(
              "Grouping: by account name, transaction date, security symbol, or action type. Defaults to 'security' when omitted.",
            ),
        },
        outputSchema: queryInvestmentTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result =
            await this.investmentTransactionsService.getLlmInvestmentTransactions(
              ctx.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds: args.accountIds,
                symbols: args.symbols,
                actions: args.actions,
                groupBy:
                  (args.groupBy as LlmInvestmentTxGroupBy | undefined) ??
                  "security",
              },
            );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_capital_gains",
      {
        title: "Capital gains",
        annotations: READ_ONLY,
        description:
          "Per-period capital gains (realized + unrealized) for the user's investment accounts. Replays transaction history and snapshots positions against historical close prices, so the output includes mark-to-market movement on currently-held positions in addition to realized SELL gains. Requires startDate and endDate. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Start date of the window (YYYY-MM-DD)"),
          endDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("End date of the window (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          groupBy: z
            .enum(["month", "security", "account"])
            .optional()
            .describe(
              "Bucket the breakdown by month, security, or account. Defaults to 'month' when omitted.",
            ),
        },
        outputSchema: getCapitalGainsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result =
            await this.investmentTransactionsService.getLlmCapitalGains(
              ctx.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds: args.accountIds,
                symbols: args.symbols,
                groupBy:
                  (args.groupBy as LlmCapitalGainsGroupBy | undefined) ??
                  "month",
              },
            );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_holding_details",
      {
        title: "Holding details",
        annotations: READ_ONLY,
        description: "Get details for holdings in a specific account",
        inputSchema: {
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Account ID to filter holdings"),
        },
        outputSchema: getHoldingDetailsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const holdings = await this.holdingsService.findAll(
            ctx.userId,
            args.accountId,
          );
          return toolResult(holdings);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_asset_allocation",
      {
        title: "Asset allocation",
        annotations: READ_ONLY,
        description:
          "Current portfolio allocation broken down by holding (cash vs. each security), with value and percentage of total. Useful for diversification and rebalancing questions.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to. Omit to cover all investment accounts.",
            ),
        },
        outputSchema: getAssetAllocationOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.portfolioService.getAssetAllocation(
            ctx.userId,
            args.accountIds,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_top_movers",
      {
        title: "Top movers",
        annotations: READ_ONLY,
        description:
          "Today's biggest daily gainers and losers across the user's held securities, with daily change in value and percent.",
        inputSchema: {},
        outputSchema: getTopMoversOutput,
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.portfolioService.getTopMovers(ctx.userId);
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_sector_weightings",
      {
        title: "Sector weightings",
        annotations: READ_ONLY,
        description:
          "Portfolio exposure broken down by economic sector. Combines direct stock sectors with ETF-derived sector exposure, plus an unclassified bucket. Useful for diversification analysis.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to. Omit to cover all investment accounts.",
            ),
          securityIds: z
            .array(z.string().uuid())
            .max(100)
            .optional()
            .describe(
              "Optional security IDs to scope the sector breakdown.",
            ),
        },
        outputSchema: getSectorWeightingsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.sectorWeightingService.getSectorWeightings(
            ctx.userId,
            args.accountIds,
            args.securityIds,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_intraday_value",
      {
        title: "Intraday portfolio value",
        annotations: READ_ONLY,
        description:
          "Portfolio value time series at fine granularity: 1 day (minute intervals), 1 week, or 1 month. Falls back to daily closes when intraday quotes are unavailable. Useful for short-term performance questions.",
        inputSchema: {
          range: z
            .enum(INTRADAY_RANGES)
            .optional()
            .default("1d")
            .describe("Time window: '1d', '1w', or '1m' (default '1d')"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to.",
            ),
          displayCurrency: z
            .string()
            .max(10)
            .optional()
            .describe(
              "Optional currency code to convert all values into.",
            ),
        },
        outputSchema: getIntradayValueOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.portfolioService.getIntradayValueSeries(
            ctx.userId,
            {
              range: args.range,
              accountIds: args.accountIds,
              displayCurrency: args.displayCurrency,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_realized_gains",
      {
        title: "Realized gains",
        annotations: READ_ONLY,
        description:
          "Per-SELL realized gains using average-cost basis, optionally filtered by account and date range. Use this (rather than get_capital_gains) when you only need realized, tax-relevant gains from sales.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional end date (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
        },
        outputSchema: getRealizedGainsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data =
            await this.investmentTransactionsService.getRealizedGains(
              ctx.userId,
              {
                accountIds: args.accountIds,
                startDate: args.startDate,
                endDate: args.endDate,
              },
            );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_security_history",
      {
        title: "Security transaction history",
        annotations: READ_ONLY,
        description:
          "Full transaction history for a single security across all of the user's accounts, with per-account and cumulative running share totals. Use this when the user asks about a specific ticker's buy/sell/dividend activity over time.",
        inputSchema: {
          securityId: z.string().uuid().describe("Security ID"),
        },
        outputSchema: getSecurityHistoryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data =
            await this.investmentTransactionsService.getSecurityTransactionHistory(
              ctx.userId,
              args.securityId,
            );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "search_securities",
      {
        title: "Search securities",
        annotations: READ_ONLY,
        description:
          "Search the user's own securities catalog by symbol or name. Returns matching securities with their IDs, types, and currencies. Use this to resolve a ticker symbol to a securityId before calling get_security_history or refresh_security_prices.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(200)
            .describe("Symbol or name fragment to search for"),
        },
        outputSchema: searchSecuritiesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.securitiesService.search(
            ctx.userId,
            args.query.slice(0, 200),
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "refresh_security_prices",
      {
        title: "Refresh security prices",
        annotations: UPDATE,
        description:
          "Fetch the latest prices for a set of the user's securities from the quote provider (Yahoo/MSN). Use this when prices look stale or the user asks to update quotes. Best-effort: per-security failures are reported but do not fail the whole call.",
        inputSchema: {
          securityIds: z
            .array(z.string().uuid())
            .min(1)
            .max(100)
            .describe(
              "Security IDs (max 100). All must belong to the calling user.",
            ),
        },
        outputSchema: refreshSecurityPricesOutput,
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
          // Verify every ID belongs to the calling user (matches controller).
          for (const id of args.securityIds) {
            await this.securitiesService.findOne(ctx.userId, id);
          }

          const result =
            await this.securityPriceService.refreshPricesForSecurities(
              args.securityIds,
            );

          this.writeLimiter.record(ctx.userId, "refresh_security_prices");

          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_security",
      {
        title: "Create security",
        annotations: CREATE,
        description:
          "Add a security (stock / ETF / mutual fund / bond / etc.) to the user's catalog so it can be tracked, priced, and held in investment accounts. Requires symbol + name + currencyCode; optionally set securityType, exchange, quoteProvider, msnInstrumentId, isActive, isFavourite. Idempotent by default: if a security with the same (normalized) symbol already exists for the user, it is returned as success with created=false instead of erroring — variant forms like 'aapl', 'BRK-B', and 'BRK B' all normalize to the same record ('AAPL', 'BRK.B'). Pass onConflict='error' to opt into strict duplicate-rejection. Supports dryRun=true to preview create-vs-return-existing without writing.",
        inputSchema: {
          symbol: z
            .string()
            .min(1)
            .max(20)
            .describe(
              "Ticker symbol (e.g. AAPL, BRK.B). Normalized to uppercase with separators unified, so 'brk-b' and 'BRK B' both become 'BRK.B'.",
            ),
          name: z.string().max(255).describe("Full security name"),
          currencyCode: z
            .string()
            .length(3)
            .describe("ISO 4217 currency code (e.g. USD, CAD)"),
          securityType: z
            .string()
            .max(50)
            .optional()
            .describe(
              "Free-form type (e.g. STOCK, ETF, MUTUAL_FUND, BOND, OPTION, CRYPTO, OTHER).",
            ),
          exchange: z
            .string()
            .max(50)
            .optional()
            .describe("Exchange (e.g. NASDAQ, NYSE, TSX)."),
          isActive: z
            .boolean()
            .optional()
            .describe("Whether the security is active (default true)."),
          isFavourite: z
            .boolean()
            .optional()
            .describe("Pin to the dashboard Favourite Securities widget."),
          quoteProvider: z
            .enum(["yahoo", "msn"])
            .optional()
            .describe(
              "Per-security quote provider override. Omit to use the user default.",
            ),
          msnInstrumentId: z
            .string()
            .max(50)
            .optional()
            .describe("MSN Financial Instrument ID (advanced override)."),
          onConflict: z
            .enum(["return", "error"])
            .optional()
            .default("return")
            .describe(
              "What to do if a security with the same symbol already exists. 'return' (default) returns it as success with created=false; 'error' fails with a 409 conflict.",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, preview the result (create vs. return-existing) without writing.",
            ),
        },
        outputSchema: createSecurityOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        const onConflict = args.onConflict ?? "return";

        // Dry-run: look up the normalized symbol and report what would happen
        // without writing or consuming the write quota.
        if (args.dryRun) {
          try {
            const existing =
              await this.securitiesService.findOneBySymbolOrNull(
                ctx.userId,
                args.symbol,
              );
            if (existing) {
              return toolResult({
                dryRun: true,
                created: false,
                existing: {
                  id: existing.id,
                  symbol: existing.symbol,
                  name: existing.name,
                  securityType: existing.securityType,
                  currencyCode: existing.currencyCode,
                  exchange: existing.exchange,
                },
                message: `Security "${existing.symbol}" already exists. No changes would be made.`,
              });
            }
            return toolResult({
              dryRun: true,
              created: true,
              preview: {
                symbol: args.symbol,
                name: args.name,
                currencyCode: (args.currencyCode as string).toUpperCase(),
                securityType: args.securityType,
                exchange: args.exchange,
                isActive: args.isActive,
                isFavourite: args.isFavourite,
                quoteProvider: args.quoteProvider,
                msnInstrumentId: args.msnInstrumentId,
              },
              message:
                "Would create this security. Call again with dryRun=false to apply.",
            });
          } catch (err: unknown) {
            return safeToolError(err);
          }
        }

        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          if (onConflict === "return") {
            // Idempotent: returns existing (created=false) or inserts (created=true).
            const result = await this.securitiesService.findOrCreate(
              ctx.userId,
              {
                symbol: args.symbol,
                name: stripHtml(args.name) as string,
                currencyCode: (args.currencyCode as string).toUpperCase(),
                ...(args.securityType !== undefined && {
                  securityType: stripHtml(args.securityType),
                }),
                ...(args.exchange !== undefined && {
                  exchange: stripHtml(args.exchange),
                }),
                ...(args.isActive !== undefined && { isActive: args.isActive }),
                ...(args.isFavourite !== undefined && {
                  isFavourite: args.isFavourite,
                }),
                ...(args.quoteProvider !== undefined && {
                  quoteProvider: args.quoteProvider,
                }),
                ...(args.msnInstrumentId !== undefined && {
                  msnInstrumentId: stripHtml(args.msnInstrumentId),
                }),
              },
            );
            this.writeLimiter.record(ctx.userId, "create_security");
            return toolResult({
              id: result.id,
              symbol: result.symbol,
              name: result.name,
              securityType: result.securityType,
              currencyCode: result.currencyCode,
              exchange: result.exchange,
              isActive: result.isActive,
              isFavourite: result.isFavourite,
              created: result._created,
              message: result._created
                ? "Security created successfully."
                : `Security "${result.symbol}" already exists; returned the existing record.`,
            });
          }

          // Strict mode: delegate to create(), which throws ConflictException on dup.
          const created = await this.securitiesService.create(
            ctx.userId,
            {
              symbol: args.symbol,
              name: stripHtml(args.name) as string,
              currencyCode: (args.currencyCode as string).toUpperCase(),
              ...(args.securityType !== undefined && {
                securityType: stripHtml(args.securityType),
              }),
              ...(args.exchange !== undefined && {
                exchange: stripHtml(args.exchange),
              }),
              ...(args.isActive !== undefined && { isActive: args.isActive }),
              ...(args.isFavourite !== undefined && {
                isFavourite: args.isFavourite,
              }),
              ...(args.quoteProvider !== undefined && {
                quoteProvider: args.quoteProvider,
              }),
              ...(args.msnInstrumentId !== undefined && {
                msnInstrumentId: stripHtml(args.msnInstrumentId),
              }),
            },
            { onConflict: "error" },
          );
          this.writeLimiter.record(ctx.userId, "create_security");
          return toolResult({
            id: created.id,
            symbol: created.symbol,
            name: created.name,
            securityType: created.securityType,
            currencyCode: created.currencyCode,
            exchange: created.exchange,
            isActive: created.isActive,
            isFavourite: created.isFavourite,
            created: true,
            message: "Security created successfully.",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
