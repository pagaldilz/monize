import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonteCarloService } from "../../monte-carlo/monte-carlo.service";
import { LoanMortgageAccountService } from "../../accounts/loan-mortgage-account.service";
import { LoanPaymentDetectorService } from "../../accounts/loan-payment-detector.service";
import { AiInsightsService } from "../../ai/insights/ai-insights.service";
import {
  PAYMENT_FREQUENCIES,
  MORTGAGE_PAYMENT_FREQUENCIES,
} from "../../accounts/dto/create-account.dto";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  runMonteCarloOutput,
  getMonteCarloHistoricalStatsOutput,
  previewLoanAmortizationOutput,
  previewMortgageAmortizationOutput,
  detectLoanPaymentsOutput,
  getAiInsightsOutput,
} from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

// Monte Carlo cash-flow input shape (matches CashFlowDto on the backend).
const cashFlowInput = z.object({
  name: z.string().max(255).describe("Label for this cash-flow event"),
  amount: z
    .number()
    .min(-999999999999)
    .max(999999999999)
    .describe("Signed amount (positive = income, negative = expense)"),
  flowType: z
    .enum(["ONE_TIME", "RECURRING"])
    .describe("ONE_TIME applies once; RECURRING repeats each year in range"),
  startYear: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("Year offset from today (1 = first simulated year)"),
  endYear: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Inclusive end year for RECURRING (omit to run to the horizon end)",
    ),
  inflationAdjust: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, escalate the amount by inflation each year"),
});

@Injectable()
export class McpPlanningTools {
  constructor(
    private readonly monteCarloService: MonteCarloService,
    private readonly loanMortgageService: LoanMortgageAccountService,
    private readonly loanPaymentDetector: LoanPaymentDetectorService,
    private readonly aiInsightsService: AiInsightsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "run_monte_carlo",
      {
        title: "Run Monte Carlo simulation",
        annotations: READ_ONLY,
        description:
          "Project a portfolio's future value with a Monte Carlo simulation (random returns), returning percentile outcome bands (p10/p25/p50/p75/p90), final-balance distribution, performance summary (TWR, max drawdown, safe/perpetual withdrawal rates), and depletion rate. Pure simulation — does not modify any data. Either seed from selected investment accounts (accountIds) or supply an explicit startingValue.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .optional()
            .describe(
              "Investment account IDs to seed the starting value from. Omit to use startingValue.",
            ),
          startingValue: z
            .number()
            .min(0)
            .max(999999999999)
            .optional()
            .describe(
              "Explicit portfolio starting value (used when accountIds is omitted). Defaults to 0.",
            ),
          yearsToRetirement: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe("Accumulation (contribution) years (default 20)"),
          yearsInRetirement: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe("Withdrawal years (default 30)"),
          annualContribution: z
            .number()
            .min(-999999999)
            .max(999999999)
            .optional()
            .describe("Annual contribution during accumulation (default 0)"),
          annualWithdrawal: z
            .number()
            .min(0)
            .max(999999999)
            .optional()
            .describe("Annual withdrawal during retirement (default 0)"),
          expectedReturn: z
            .number()
            .min(-1)
            .max(1)
            .optional()
            .describe(
              "Expected mean annual return as a decimal (0.07 = 7%). Default 0.07.",
            ),
          volatility: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Annualized volatility as a decimal (0.15 = 15%). Default 0.15.",
            ),
          inflationRate: z
            .number()
            .min(-1)
            .max(1)
            .optional()
            .describe("Annual inflation as a decimal (default 0.025)"),
          simulationCount: z
            .number()
            .int()
            .min(100)
            .max(50000)
            .optional()
            .describe("Number of simulated paths (default 1000)"),
          showRealValues: z
            .boolean()
            .optional()
            .describe(
              "If true, deflate values to today's purchasing power (default false)",
            ),
          cashFlows: z
            .array(cashFlowInput)
            .max(50)
            .optional()
            .describe(
              "Optional one-time or recurring cash-flow events layered on top of the base phases.",
            ),
        },
        outputSchema: runMonteCarloOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Build the RunScenarioDto with sensible defaults for the many
          // required ScenarioInputs fields the underlying service expects.
          const data = await this.monteCarloService.runAdHoc(ctx.userId, {
            accountIds: args.accountIds ?? [],
            startingValue: args.startingValue ?? 0,
            useCurrentBalance: (args.accountIds?.length ?? 0) > 0,
            yearsToRetirement: args.yearsToRetirement ?? 20,
            annualContribution: args.annualContribution ?? 0,
            contributionGrowthRate: 0,
            yearsInRetirement: args.yearsInRetirement ?? 30,
            annualWithdrawal: args.annualWithdrawal ?? 0,
            expectedReturn: args.expectedReturn ?? 0.07,
            volatility: args.volatility ?? 0.15,
            inflationRate: args.inflationRate ?? 0.025,
            showRealValues: args.showRealValues ?? false,
            useHistoricalReturns: false,
            simulationCount: args.simulationCount ?? 1000,
            cashFlows: args.cashFlows as any,
          });
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_monte_carlo_historical_stats",
      {
        title: "Monte Carlo historical stats",
        annotations: READ_ONLY,
        description:
          "Historical mean return and volatility computed from the user's own investment-account transaction history, plus the current balance. Useful to feed realistic expectedReturn/volatility into a Monte Carlo run.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Investment account IDs to compute stats over. Omit to use all investment accounts.",
            ),
        },
        outputSchema: getMonteCarloHistoricalStatsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.monteCarloService.getHistoricalStats(
            ctx.userId,
            args.accountIds ?? [],
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "preview_loan_amortization",
      {
        title: "Preview loan amortization",
        annotations: READ_ONLY,
        description:
          "Compute a loan payoff projection from a loan amount, interest rate, payment amount, payment frequency, and start date. Returns the principal/interest split of the first payment, total number of payments, and estimated payoff date. Pure calculation — does not modify any account.",
        inputSchema: {
          loanAmount: z
            .number()
            .min(0.01)
            .max(999999999999)
            .describe("Loan principal"),
          interestRate: z
            .number()
            .min(0)
            .max(100)
            .describe("Annual interest rate as a percentage (e.g. 5.5 = 5.5%)"),
          paymentAmount: z
            .number()
            .min(0.01)
            .max(999999999999)
            .describe("Payment amount per period"),
          paymentFrequency: z
            .enum(PAYMENT_FREQUENCIES)
            .describe("Payment frequency"),
          paymentStartDate: z
            .string()
            .max(10)
            .describe("First payment date (YYYY-MM-DD)"),
        },
        outputSchema: previewLoanAmortizationOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const result = this.loanMortgageService.previewLoanAmortization(
            args.loanAmount,
            args.interestRate,
            args.paymentAmount,
            args.paymentFrequency,
            new Date(args.paymentStartDate),
          );
          return toolResult({
            ...result,
            endDate: result.endDate
              ? new Date(result.endDate).toISOString().slice(0, 10)
              : null,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "preview_mortgage_amortization",
      {
        title: "Preview mortgage amortization",
        annotations: READ_ONLY,
        description:
          "Compute a mortgage payment and payoff projection from a mortgage amount, interest rate, amortization period, payment frequency, and start date. Supports Canadian (semi-annual compounding) and variable-rate mortgages. Returns the computed payment amount, principal/interest split, total payments, total interest, and estimated payoff date. Pure calculation — does not modify any account.",
        inputSchema: {
          mortgageAmount: z
            .number()
            .min(0.01)
            .max(999999999999)
            .describe("Mortgage principal"),
          interestRate: z
            .number()
            .min(0)
            .max(100)
            .describe("Annual interest rate as a percentage (e.g. 5.99 = 5.99%)"),
          amortizationMonths: z
            .number()
            .int()
            .min(1)
            .max(600)
            .describe("Total amortization period in months (e.g. 300 = 25 years)"),
          paymentFrequency: z
            .enum(MORTGAGE_PAYMENT_FREQUENCIES)
            .describe("Mortgage payment frequency"),
          paymentStartDate: z
            .string()
            .max(10)
            .describe("First payment date (YYYY-MM-DD)"),
          isCanadian: z
            .boolean()
            .optional()
            .describe(
              "If true, use Canadian semi-annual compounding (fixed rate). Default false (US monthly compounding).",
            ),
          isVariableRate: z
            .boolean()
            .optional()
            .describe(
              "If true (Canadian), use monthly compounding for variable rate. Default false.",
            ),
        },
        outputSchema: previewMortgageAmortizationOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const result = this.loanMortgageService.previewMortgageAmortization(
            args.mortgageAmount,
            args.interestRate,
            args.amortizationMonths,
            args.paymentFrequency,
            new Date(args.paymentStartDate),
            args.isCanadian ?? false,
            args.isVariableRate ?? false,
          );
          return toolResult({
            ...result,
            endDate: result.endDate
              ? new Date(result.endDate).toISOString().slice(0, 10)
              : null,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "detect_loan_payments",
      {
        title: "Detect loan payment pattern",
        annotations: READ_ONLY,
        description:
          "Analyze a loan/mortgage account's transaction history to infer the recurring payment pattern: payment amount, frequency, confidence, estimated interest rate, source account, and principal/interest categories. Returns detected=false when no clear pattern is found. Read-only — does not modify the account.",
        inputSchema: {
          accountId: z.string().uuid().describe("Loan/mortgage account ID"),
        },
        outputSchema: detectLoanPaymentsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.loanPaymentDetector.detectPaymentPattern(
            ctx.userId,
            args.accountId,
          );
          // detectPaymentPattern returns null when no pattern is found; surface
          // that as an explicit not-found message rather than an error.
          if (!data) {
            return toolResult({ detected: false });
          }
          return toolResult({ detected: true, ...data });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_ai_insights",
      {
        title: "Get AI insights",
        annotations: READ_ONLY,
        description:
          "Retrieve precomputed AI spending insights (anomalies, trends, subscriptions, budget pace, seasonal patterns, new recurring charges). Optionally filter by type or severity. These are generated by the backend's insight engine, not computed on demand. Requires an AI provider to have been configured to generate them.",
        inputSchema: {
          type: z
            .enum([
              "anomaly",
              "trend",
              "subscription",
              "budget_pace",
              "seasonal",
              "new_recurring",
            ])
            .optional()
            .describe("Filter to a single insight type"),
          severity: z
            .enum(["info", "warning", "alert"])
            .optional()
            .describe("Filter to a single severity"),
          includeDismissed: z
            .boolean()
            .optional()
            .describe("Include previously dismissed insights (default false)"),
        },
        outputSchema: getAiInsightsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.aiInsightsService.getInsights(
            ctx.userId,
            args.type as any,
            args.severity as any,
            args.includeDismissed ?? false,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
