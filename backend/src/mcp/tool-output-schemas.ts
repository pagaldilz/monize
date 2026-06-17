import { z } from "zod";

/**
 * Output schemas for every MCP tool.
 *
 * Each export is a Zod raw shape (the same form accepted by `inputSchema` in
 * `registerTool`). When a tool declares an `outputSchema`, the MCP SDK requires
 * the tool to return `structuredContent` and validates it against the schema,
 * so these shapes describe the structured payload produced by `toolResult`.
 *
 * Schemas are intentionally tolerant: Zod strips undeclared keys by default, so
 * extra/relation/timestamp fields on entity payloads never fail validation, and
 * we only model the fields the tools meaningfully expose. Tools that return a
 * bare array have their payload wrapped under `items` by `toStructuredContent`.
 */

// Monetary and other decimal values arrive as JS numbers at runtime (the
// entity `numericTransformer` converts PostgreSQL decimals). Decimals may be
// null-equivalent: a divide-by-zero percentage produces NaN at runtime, which
// `toolResult` normalizes to null (NaN's JSON form) so it both passes
// structured-output validation and serializes. `num` must therefore accept
// null. It must NOT use `z.nan()`: the SDK serializes each tool's outputSchema
// to JSON Schema for `tools/list`, and `z.nan()` is unrepresentable there
// ("NaN cannot be represented in JSON Schema"), which fails the whole
// tools/list response and leaves every client showing zero tools.
const num = z.number().nullable();
const numNull = num;

// Every output object is loose. Tools return entity payloads that carry fields
// beyond the modeled subset (timestamps, foreign keys, relations). The SDK
// serializes each outputSchema to JSON Schema in OUTPUT mode for `tools/list`,
// where a default (strip) object becomes `additionalProperties: false`; the
// client then rejects the extra fields with an output-validation error. `.loose()`
// emits `additionalProperties: {}` so the real payloads validate. (The server
// side validates with Zod, which strips unknown keys -- the strictness only
// bites on the client.)
const looseObject = (shape: z.ZodRawShape) => z.object(shape).loose();
const str = z.string();
const strNull = z.string().nullable();
const bool = z.boolean();

// ---------------------------------------------------------------------------
// accounts.tool.ts
// ---------------------------------------------------------------------------

export const getAccountsOutput = {
  items: z.array(
    looseObject({
      id: str,
      name: str,
      accountType: str.optional(),
      currencyCode: str.optional(),
      currentBalance: numNull.optional(),
      openingBalance: numNull.optional(),
      creditLimit: numNull.optional(),
      isClosed: bool.optional(),
      futureTransactionsSum: numNull.optional(),
    }),
  ),
};

export const getAccountBalanceOutput = {
  id: str,
  name: str,
  type: str,
  currentBalance: numNull,
  creditLimit: numNull,
  currencyCode: str,
};

export const getAccountBalancesOutput = {
  accounts: z.array(
    looseObject({
      name: str,
      type: str,
      balance: num,
      currency: str,
      isClosed: bool,
    }),
  ),
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
  totalAccounts: num,
};

// ---------------------------------------------------------------------------
// net-worth.tool.ts
// ---------------------------------------------------------------------------

export const getNetWorthOutput = {
  totalAccounts: num,
  totalBalance: num,
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
};

export const getNetWorthHistoryOutput = {
  items: z.array(
    looseObject({
      month: str,
      assets: num,
      liabilities: num,
      netWorth: num,
    }),
  ),
};

// ---------------------------------------------------------------------------
// transactions.tool.ts
// ---------------------------------------------------------------------------

export const searchTransactionsOutput = {
  transactions: z.array(
    looseObject({
      id: str,
      splitId: str.optional(),
      date: str,
      payeeName: strNull,
      categoryName: str.optional(),
      amount: num,
      accountName: str.optional(),
      description: strNull,
      status: str,
      isSplit: bool.optional(),
    }),
  ),
  total: num,
  hasMore: bool,
};

export const queryTransactionsOutput = {
  totalIncome: num,
  totalExpenses: num,
  netCashFlow: num,
  transactionCount: num,
  byCurrency: z
    .record(
      z.string(),
      looseObject({
        totalIncome: num,
        totalExpenses: num,
        netCashFlow: num,
        transactionCount: num,
      }),
    )
    .optional(),
  breakdown: z.unknown().optional(),
};

export const getSpendingByCategoryOutput = {
  categories: z.array(
    looseObject({
      category: str,
      amount: num,
      percentage: num,
      transactionCount: num,
    }),
  ),
  totalSpending: num,
};

export const getIncomeSummaryOutput = {
  items: z.array(
    looseObject({
      label: str,
      amount: num,
      count: num,
    }),
  ),
  totalIncome: num,
  groupedBy: str,
};

export const comparePeriodsOutput = {
  period1: looseObject({ start: str, end: str, total: num }),
  period2: looseObject({ start: str, end: str, total: num }),
  totalChange: num,
  totalChangePercent: num,
  comparison: z.array(
    looseObject({
      label: str,
      period1Amount: num,
      period2Amount: num,
      change: num,
      changePercent: num,
    }),
  ),
};

export const getTransfersOutput = {
  accounts: z.array(
    looseObject({
      accountName: str,
      currency: str,
      inbound: num,
      outbound: num,
      net: num,
      transferCount: num,
    }),
  ),
  totalInbound: num,
  totalOutbound: num,
  transferCount: num,
};

export const createTransactionOutput = {
  // Dry-run preview branch.
  dryRun: bool.optional(),
  preview: z
    .object({
      accountId: str.optional(),
      accountName: str.optional(),
      amount: num.optional(),
      date: str.optional(),
      payeeName: strNull.optional(),
      categoryId: strNull.optional(),
      categoryName: strNull.optional(),
      description: strNull.optional(),
      currencyCode: str.optional(),
    })
    .optional(),
  message: str.optional(),
  // Created-transaction branch.
  id: str.optional(),
  date: str.optional(),
  amount: num.optional(),
  payeeName: strNull.optional(),
  status: str.optional(),
};

export const categorizeTransactionOutput = {
  id: str,
  categoryId: strNull,
  message: str,
};

export const updateTransactionOutput = {
  // Dry-run preview branch.
  dryRun: bool.optional(),
  preview: z
    .object({
      id: str.optional(),
      accountId: str.optional(),
      accountName: str.optional(),
      amount: num.optional(),
      date: str.optional(),
      payeeName: strNull.optional(),
      categoryId: strNull.optional(),
      description: strNull.optional(),
      status: str.optional(),
    })
    .optional(),
  message: str.optional(),
  // Updated-transaction branch.
  id: str.optional(),
  date: str.optional(),
  amount: num.optional(),
  payeeName: strNull.optional(),
  categoryId: strNull.optional(),
  status: str.optional(),
};

export const createTransferOutput = {
  // Dry-run preview branch.
  dryRun: bool.optional(),
  preview: z
    .object({
      fromAccountId: str.optional(),
      fromAccountName: str.optional(),
      toAccountId: str.optional(),
      toAccountName: str.optional(),
      amount: num.optional(),
      date: str.optional(),
      fromCurrencyCode: str.optional(),
      toCurrencyCode: str.optional(),
      exchangeRate: numNull.optional(),
      toAmount: numNull.optional(),
      payeeName: strNull.optional(),
      description: strNull.optional(),
      status: str.optional(),
    })
    .optional(),
  message: str.optional(),
  // Created-transfer branch.
  fromTransaction: z
    .object({
      id: str.optional(),
      date: str.optional(),
      amount: num.optional(),
      status: str.optional(),
    })
    .optional(),
  toTransaction: z
    .object({
      id: str.optional(),
      date: str.optional(),
      amount: num.optional(),
      status: str.optional(),
    })
    .optional(),
};

export const setTransactionStatusOutput = {
  id: str,
  status: str,
  message: str,
};

export const clearTransactionOutput = {
  id: str,
  status: str,
  isCleared: bool,
  message: str,
};

// ---------------------------------------------------------------------------
// categories.tool.ts
// ---------------------------------------------------------------------------

export const getCategoriesOutput = {
  categories: z.array(
    looseObject({
      id: str,
      name: str,
      parentName: strNull,
      isIncome: bool,
      transactionCount: num,
    }),
  ),
  totalCount: num,
};

// ---------------------------------------------------------------------------
// payees.tool.ts
// ---------------------------------------------------------------------------

export const getPayeesOutput = {
  items: z.array(
    looseObject({
      id: str,
      name: str,
      defaultCategoryId: strNull.optional(),
      notes: str.optional(),
      isActive: bool.optional(),
      transactionCount: num.optional(),
      lastUsedDate: strNull.optional(),
      aliasCount: num.optional(),
      uncategorizedCount: num.optional(),
    }),
  ),
};

export const createPayeeOutput = {
  id: str,
  name: str,
  message: str,
};

// ---------------------------------------------------------------------------
// reports.tool.ts
// ---------------------------------------------------------------------------

export const generateReportOutput = {
  data: z.array(z.unknown()).optional(),
  totals: z.unknown().optional(),
  totalSpending: num.optional(),
  totalIncome: num.optional(),
};

export const monthlyComparisonOutput = {
  currentMonth: str.optional(),
  previousMonth: str.optional(),
  currentMonthLabel: str.optional(),
  previousMonthLabel: str.optional(),
  currency: str.optional(),
  incomeExpenses: z.record(z.string(), z.unknown()).optional(),
  notes: z.record(z.string(), z.unknown()).optional(),
  expenses: z.record(z.string(), z.unknown()).optional(),
  topCategories: z.record(z.string(), z.unknown()).optional(),
  netWorth: z.record(z.string(), z.unknown()).optional(),
  investments: z.record(z.string(), z.unknown()).optional(),
};

export const getAnomaliesOutput = {
  statistics: looseObject({ mean: num, stdDev: num }),
  anomalies: z.array(
    looseObject({
      type: str,
      severity: str,
      title: str,
      description: str,
      amount: num.optional(),
      transactionId: str.optional(),
      transactionDate: str.optional(),
      payeeName: strNull.optional(),
      categoryId: strNull.optional(),
      categoryName: strNull.optional(),
      currentPeriodAmount: num.optional(),
      previousPeriodAmount: num.optional(),
      percentChange: num.optional(),
    }),
  ),
  counts: looseObject({ high: num, medium: num, low: num }),
};

// ---------------------------------------------------------------------------
// investments.tool.ts
// ---------------------------------------------------------------------------

export const getPortfolioSummaryOutput = {
  holdingCount: num,
  totalCashValue: num,
  totalHoldingsValue: num,
  totalCostBasis: num,
  totalPortfolioValue: num,
  totalGainLoss: num,
  totalGainLossPercent: numNull,
  timeWeightedReturn: numNull,
  cagr: numNull,
  holdings: z.array(
    looseObject({
      symbol: str,
      name: str,
      securityType: str,
      currency: str,
      quantity: num,
      averageCost: numNull,
      costBasis: num,
      marketValue: numNull,
      gainLoss: numNull,
      gainLossPercent: numNull,
    }),
  ),
  allocation: z.array(
    looseObject({
      name: str,
      symbol: strNull,
      type: str,
      value: num,
      percentage: num,
    }),
  ),
};

export const queryInvestmentTransactionsOutput = {
  transactionCount: num,
  totalAmount: num,
  totalCommission: num,
  totalQuantity: num,
  actionCounts: z.record(z.string(), num),
  groupedBy: strNull,
  groups: z
    .array(
      looseObject({
        key: str,
        transactionCount: num,
        totalQuantity: num,
        totalAmount: num,
        totalCommission: num,
      }),
    )
    .nullable(),
  transactions: z.array(
    looseObject({
      transactionDate: str,
      action: str,
      accountName: strNull,
      symbol: strNull,
      securityName: strNull,
      quantity: numNull,
      price: numNull,
      commission: num,
      totalAmount: num,
      currency: strNull,
      description: strNull,
    }),
  ),
  truncatedTransactionList: bool,
};

export const getCapitalGainsOutput = {
  startDate: str,
  endDate: str,
  totals: looseObject({
    realizedGain: num,
    unrealizedGain: num,
    totalCapitalGain: num,
  }),
  groupedBy: str,
  entries: z.array(
    looseObject({
      month: strNull,
      accountName: strNull,
      symbol: strNull,
      securityName: strNull,
      currency: strNull,
      startValue: num,
      endValue: num,
      realizedGain: num,
      unrealizedGain: num,
      totalCapitalGain: num,
    }),
  ),
  entryCount: num,
  truncatedEntryList: bool,
};

export const getHoldingDetailsOutput = {
  items: z.array(
    looseObject({
      id: str,
      accountId: str,
      securityId: str,
      quantity: num,
      averageCost: numNull,
    }),
  ),
};

export const getAssetAllocationOutput = {
  totalValue: num,
  allocation: z.array(
    z.object({
      name: str,
      symbol: strNull,
      type: str,
      value: num,
      percentage: num,
    }),
  ),
};

export const getTopMoversOutput = {
  items: z.array(
    z.object({
      securityId: str,
      symbol: str,
      name: str,
      currencyCode: str,
      currentPrice: num,
      previousPrice: num,
      dailyChange: num,
      dailyChangePercent: num,
      marketValue: numNull,
    }),
  ),
};

export const getSectorWeightingsOutput = {
  totalPortfolioValue: num,
  totalDirectValue: num,
  totalEtfValue: num,
  unclassifiedValue: num,
  items: z.array(
    z.object({
      sector: str,
      directValue: num,
      etfValue: num,
      totalValue: num,
      percentage: num,
    }),
  ),
};

export const getIntradayValueOutput = {
  interval: str,
  currency: str,
  range: str,
  fetchedAt: str,
  skippedSymbols: z.array(str),
  failedSymbols: z.array(str),
  fallbackToDaily: bool,
  points: z.array(
    z.object({
      timestamp: str,
      value: num,
    }),
  ),
};

export const getRealizedGainsOutput = {
  items: z.array(z.unknown()),
};

export const getSecurityHistoryOutput = {
  securityId: str,
  symbol: str,
  name: str,
  currencyCode: str,
  isActive: bool,
  currentQuantityAll: num,
  accounts: z.array(
    z.object({
      accountId: str,
      accountName: str,
      isClosed: bool,
      currentQuantity: num,
    }),
  ),
  transactions: z.array(
    z.object({
      id: str,
      transactionDate: str,
      accountId: str,
      accountName: str,
      action: str,
      quantity: numNull,
      price: numNull,
      commission: num,
      totalAmount: num,
      description: strNull,
      runningQuantityAccount: num,
      runningQuantityAll: num,
    }),
  ),
};

export const searchSecuritiesOutput = {
  items: z.array(
    z.object({
      id: str.optional(),
      symbol: str,
      name: strNull,
      securityType: strNull.optional(),
      currencyCode: strNull.optional(),
      exchange: strNull.optional(),
      sector: strNull.optional(),
      isActive: bool.optional(),
    }),
  ),
};

export const refreshSecurityPricesOutput = {
  totalSecurities: num,
  updated: num,
  failed: num,
  skipped: num,
  lastUpdated: str,
  results: z.array(
    z.object({
      symbol: str,
      success: bool,
      price: numNull.optional(),
      error: strNull.optional(),
    }),
  ),
};

// create_security: insert or (idempotently) return an existing security.
// `created` distinguishes a freshly-inserted row (true) from an existing one
// surfaced via onConflict='return' (false). The dry-run branch surfaces
// `preview` (would-create) or `existing` (already-present) instead of writing.
export const createSecurityOutput = {
  id: str.optional(),
  symbol: str.optional(),
  name: str.optional(),
  securityType: strNull.optional(),
  currencyCode: str.optional(),
  exchange: strNull.optional(),
  isActive: bool.optional(),
  isFavourite: bool.optional(),
  created: bool,
  // Dry-run branches (mutually exclusive with the created row above).
  dryRun: bool.optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
  existing: z.record(z.string(), z.unknown()).optional(),
  message: str,
};

// ---------------------------------------------------------------------------
// planning.tool.ts
// ---------------------------------------------------------------------------

const percentileBand = z.object({
  p10: num,
  p25: num,
  p50: num,
  p75: num,
  p90: num,
});

export const runMonteCarloOutput = {
  yearLabels: z.array(str),
  percentiles: z.object({
    p10: z.array(num),
    p25: z.array(num),
    p50: z.array(num),
    p75: z.array(num),
    p90: z.array(num),
  }),
  finalDistribution: z.object({
    min: num,
    max: num,
    mean: num,
    median: num,
    stdev: num,
    depletionRate: num,
  }),
  performanceSummary: z.object({
    twrNominal: percentileBand,
    twrReal: percentileBand,
    endBalanceNominal: percentileBand,
    endBalanceReal: percentileBand,
    meanReturnNominal: percentileBand,
    annualizedVolatility: percentileBand,
    maxDrawdown: percentileBand,
    maxDrawdownExcludingCashflows: percentileBand,
    safeWithdrawalRate: percentileBand,
    perpetualWithdrawalRate: percentileBand,
  }),
  successRate: numNull,
  inputsSnapshot: z.record(z.string(), z.unknown()),
  realValues: bool,
  ranAt: str,
};

export const getMonteCarloHistoricalStatsOutput = {
  yearsObserved: num,
  meanReturn: numNull,
  volatility: numNull,
  currentBalance: num,
};

export const previewLoanAmortizationOutput = {
  paymentAmount: num.optional(),
  principalPayment: num.optional(),
  interestPayment: num.optional(),
  remainingBalance: num.optional(),
  totalPayments: num.optional(),
  endDate: strNull.optional(),
  schedule: z
    .array(
      z.object({
        paymentNumber: num.optional(),
        date: strNull.optional(),
        payment: num.optional(),
        principal: num.optional(),
        interest: num.optional(),
        balance: num.optional(),
      }),
    )
    .optional(),
};

export const previewMortgageAmortizationOutput = previewLoanAmortizationOutput;

export const detectLoanPaymentsOutput = {
  paymentAmount: numNull.optional(),
  paymentFrequency: strNull.optional(),
  confidence: numNull.optional(),
  sourceAccountId: strNull.optional(),
  sourceAccountName: strNull.optional(),
  interestCategoryId: strNull.optional(),
  interestCategoryName: strNull.optional(),
  principalCategoryId: strNull.optional(),
  estimatedInterestRate: numNull.optional(),
  suggestedNextDueDate: strNull.optional(),
  firstPaymentDate: strNull.optional(),
  lastPaymentDate: strNull.optional(),
  paymentCount: numNull.optional(),
  currentBalance: numNull.optional(),
  isMortgage: bool.optional(),
  averageExtraPrincipal: numNull.optional(),
  extraPrincipalCount: numNull.optional(),
  lastPrincipalAmount: numNull.optional(),
  lastInterestAmount: numNull.optional(),
};

export const getAiInsightsOutput = {
  insights: z.array(
    z.object({
      id: str,
      type: str,
      title: str,
      description: str,
      severity: str,
      data: z.record(z.string(), z.unknown()).optional(),
      isDismissed: bool,
      generatedAt: str,
      expiresAt: str,
      createdAt: str,
    }),
  ),
  total: num,
  lastGeneratedAt: strNull,
  isGenerating: bool,
};

// ---------------------------------------------------------------------------
// Batch 2: update/create tools (no deletes)
// ---------------------------------------------------------------------------

// transactions.tool.ts (Phase 1)
export const updateTransactionSplitsOutput = {
  dryRun: bool.optional(),
  preview: z
    .object({
      transactionId: str.optional(),
      splitCount: num.optional(),
      splits: z
        .array(
          z.object({
            amount: num,
            categoryId: strNull.optional(),
            transferAccountId: strNull.optional(),
            memo: strNull.optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  message: str.optional(),
  transactionId: str.optional(),
  splitCount: num.optional(),
};

export const setTransactionTagsOutput = {
  transactionId: str,
  tagIds: z.array(str),
  message: str,
};

export const bulkUpdateTransactionsOutput = {
  dryRun: bool.optional(),
  matchCount: num.optional(),
  message: str.optional(),
  updated: num.optional(),
  skipped: num.optional(),
  skippedReasons: z.array(str).optional(),
};

export const unreconcileTransactionOutput = {
  id: str,
  status: str,
  message: str,
};

// accounts.tool.ts (Phase 2)
// Single-account return (common types, loans, mortgages, single investment).
// All fields except `message` are optional because the investment-pair branch
// (below) returns cashAccount/brokerageAccount instead of the top-level fields.
const accountSummary = looseObject({
  id: str,
  name: str,
  accountType: str.optional(),
  currencyCode: str.optional(),
  openingBalance: num.optional(),
  currentBalance: num.optional(),
  isClosed: bool.optional(),
});
export const createAccountOutput = {
  id: str.optional(),
  name: str.optional(),
  accountType: str.optional(),
  currencyCode: str.optional(),
  openingBalance: num.optional(),
  currentBalance: num.optional(),
  isClosed: bool.optional(),
  // Investment-pair return (createInvestmentPair=true): two linked accounts.
  cashAccount: accountSummary.optional(),
  brokerageAccount: accountSummary.optional(),
  message: str,
};

export const updateAccountOutput = {
  dryRun: bool.optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
  message: str.optional(),
  id: str.optional(),
  name: str.optional(),
  currencyCode: str.optional(),
  isClosed: bool.optional(),
};

export const closeAccountOutput = {
  id: str,
  name: str,
  isClosed: bool,
  message: str,
};

export const reopenAccountOutput = {
  id: str,
  name: str,
  isClosed: bool,
  message: str,
};

// categories.tool.ts (Phase 3)
export const createCategoryOutput = {
  id: str,
  name: str,
  isIncome: bool.optional(),
  message: str,
};

export const updateCategoryOutput = {
  dryRun: bool.optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
  message: str.optional(),
  id: str.optional(),
  name: str.optional(),
};

export const reassignCategoryTransactionsOutput = {
  fromCategoryId: str,
  toCategoryId: strNull,
  transactionsUpdated: num,
  splitsUpdated: num,
  scheduledUpdated: num,
  message: str,
};

// payees.tool.ts (Phase 4)
export const updatePayeeOutput = {
  dryRun: bool.optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
  message: str.optional(),
  id: str.optional(),
  name: str.optional(),
  isActive: bool.optional(),
};

export const mergePayeesOutput = {
  targetPayeeId: str,
  sourcePayeeId: str,
  transactionsMigrated: num,
  aliasAdded: bool,
  sourcePayeeDeleted: bool,
  message: str,
};

export const reactivatePayeeOutput = {
  id: str,
  name: str,
  isActive: bool,
  message: str,
};

// tags.tool.ts (Phase 5)
export const createTagOutput = {
  id: str,
  name: str,
  message: str,
};

export const updateTagOutput = {
  id: str,
  name: str,
  message: str,
};

// safety.tool.ts (Phase 6)
export const undoLastActionOutput = {
  undone: bool,
  description: str.optional(),
  entityType: str.optional(),
  action: str.optional(),
  message: str,
};

export const redoActionOutput = {
  redone: bool,
  description: str.optional(),
  entityType: str.optional(),
  action: str.optional(),
  message: str,
};

export const getActionHistoryOutput = {
  items: z.array(
    z.object({
      id: str,
      entityType: str,
      action: str,
      description: str,
      isUndone: bool,
      createdAt: str,
    }),
  ),
};

// ---------------------------------------------------------------------------
// scheduled.tool.ts
// ---------------------------------------------------------------------------

const scheduledItem = looseObject({
  id: str,
  name: str,
  accountId: str,
  accountName: str,
  payeeName: strNull,
  categoryName: strNull,
  amount: num,
  currency: str,
  frequency: str,
  nextDueDate: str,
  daysUntilDue: num,
  isActive: bool,
  autoPost: bool,
  kind: str,
  description: strNull,
});

export const getUpcomingBillsOutput = {
  daysWindow: num,
  itemCount: num,
  overdueCount: num,
  totalUpcomingBills: num,
  totalUpcomingDeposits: num,
  items: z.array(scheduledItem),
};

export const getScheduledTransactionsOutput = {
  totalCount: num,
  activeCount: num,
  autoPostCount: num,
  billCount: num,
  depositCount: num,
  items: z.array(scheduledItem),
};

export const postScheduledTransactionOutput = {
  // Dry-run preview branch.
  dryRun: bool.optional(),
  preview: z
    .object({
      scheduledTransactionId: str.optional(),
      name: str.optional(),
      transactionDate: str.optional(),
      amount: num.optional(),
      categoryId: strNull.optional(),
      description: strNull.optional(),
    })
    .optional(),
  message: str.optional(),
  // Posted branch: the service returns the scheduled transaction (updated with
  // the new next-due date) or null. We model both shapes tolerantly.
  posted: bool.optional(),
  scheduledTransactionId: strNull.optional(),
  nextDueDate: strNull.optional(),
};

export const skipScheduledTransactionOutput = {
  id: str,
  nextDueDate: strNull,
  message: str,
};

// ---------------------------------------------------------------------------
// calculate.tool.ts
// ---------------------------------------------------------------------------

export const calculateOutput = {
  result: num,
  formattedResult: str,
  operation: str,
  label: str.optional(),
};

// ---------------------------------------------------------------------------
// budgets.tool.ts
// ---------------------------------------------------------------------------

export const getBudgetStatusOutput = {
  // Success branch (all optional so the not-found error branch validates too).
  budgetName: str.optional(),
  strategy: str.optional(),
  period: looseObject({ start: str, end: str }).optional(),
  totalBudgeted: num.optional(),
  totalSpent: num.optional(),
  totalIncome: num.optional(),
  remaining: num.optional(),
  percentUsed: num.optional(),
  overBudgetCategories: z
    .array(
      looseObject({
        category: str,
        budgeted: num,
        spent: num,
        percentUsed: num,
      }),
    )
    .optional(),
  nearLimitCategories: z
    .array(
      looseObject({
        category: str,
        budgeted: num,
        spent: num,
        remaining: num,
        percentUsed: num,
      }),
    )
    .optional(),
  categoryCount: num.optional(),
  velocity: z
    .object({
      dailyBurnRate: num,
      safeDailySpend: num,
      projectedTotal: num,
      projectedVariance: num,
      daysRemaining: num,
      paceStatus: str,
    })
    .optional(),
  healthScore: looseObject({ score: num, label: str }).optional(),
  // Not-found error branch.
  error: str.optional(),
  availableBudgets: z.array(str).optional(),
};
