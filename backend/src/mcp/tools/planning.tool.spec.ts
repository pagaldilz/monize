import { McpPlanningTools } from "./planning.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpPlanningTools", () => {
  let tool: McpPlanningTools;
  let monteCarloService: Record<string, jest.Mock>;
  let loanMortgageService: Record<string, jest.Mock>;
  let loanPaymentDetector: Record<string, jest.Mock>;
  let aiInsightsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    monteCarloService = {
      runAdHoc: jest.fn(),
      getHistoricalStats: jest.fn(),
    };
    loanMortgageService = {
      previewLoanAmortization: jest.fn(),
      previewMortgageAmortization: jest.fn(),
    };
    loanPaymentDetector = {
      detectPaymentPattern: jest.fn(),
    };
    aiInsightsService = {
      getInsights: jest.fn(),
    };

    tool = new McpPlanningTools(
      monteCarloService as any,
      loanMortgageService as any,
      loanPaymentDetector as any,
      aiInsightsService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 6 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  describe("run_monte_carlo", () => {
    it("should require read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["run_monte_carlo"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("delegates to monteCarloService.runAdHoc with sensible defaults", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      monteCarloService.runAdHoc.mockResolvedValue({
        yearLabels: ["2026", "2056"],
        percentiles: { p10: [], p25: [], p50: [], p75: [], p90: [] },
        finalDistribution: {
          min: 0,
          max: 0,
          mean: 0,
          median: 0,
          stdev: 0,
          depletionRate: 0,
        },
        performanceSummary: {},
        successRate: null,
        inputsSnapshot: {},
        realValues: false,
        ranAt: "2026-01-01T00:00:00.000Z",
      });

      await handlers["run_monte_carlo"](
        { startingValue: 100000, yearsToRetirement: 25, expectedReturn: 0.06 },
        { sessionId: "s1" },
      );

      expect(monteCarloService.runAdHoc).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startingValue: 100000,
          yearsToRetirement: 25,
          expectedReturn: 0.06,
          useCurrentBalance: false,
          accountIds: [],
        }),
      );
    });
  });

  describe("get_monte_carlo_historical_stats", () => {
    it("delegates to monteCarloService.getHistoricalStats", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      monteCarloService.getHistoricalStats.mockResolvedValue({
        yearsObserved: 10,
        meanReturn: 0.08,
        volatility: 0.15,
        currentBalance: 50000,
      });

      await handlers["get_monte_carlo_historical_stats"](
        { accountIds: ["00000000-0000-0000-0000-000000000001"] },
        { sessionId: "s1" },
      );

      expect(monteCarloService.getHistoricalStats).toHaveBeenCalledWith("u1", [
        "00000000-0000-0000-0000-000000000001",
      ]);
    });
  });

  describe("preview_loan_amortization", () => {
    it("should require reports scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["preview_loan_amortization"](
        {
          loanAmount: 10000,
          interestRate: 5,
          paymentAmount: 200,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2026-01-01",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to loanMortgageService.previewLoanAmortization and ISO-formats endDate", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      loanMortgageService.previewLoanAmortization.mockReturnValue({
        principalPayment: 158,
        interestPayment: 42,
        remainingBalance: 9842,
        totalPayments: 57,
        endDate: new Date("2030-09-01T00:00:00.000Z"),
      });

      const result = await handlers["preview_loan_amortization"](
        {
          loanAmount: 10000,
          interestRate: 5,
          paymentAmount: 200,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2026-01-01",
        },
        { sessionId: "s1" },
      );
      expect(
        loanMortgageService.previewLoanAmortization,
      ).toHaveBeenCalledWith(10000, 5, 200, "MONTHLY", new Date("2026-01-01"));
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalPayments).toBe(57);
      expect(parsed.endDate).toBe("2030-09-01");
    });
  });

  describe("preview_mortgage_amortization", () => {
    it("delegates to loanMortgageService.previewMortgageAmortization", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      loanMortgageService.previewMortgageAmortization.mockReturnValue({
        paymentAmount: 1500,
        principalPayment: 400,
        interestPayment: 1100,
        totalPayments: 300,
        endDate: new Date("2051-01-01T00:00:00.000Z"),
        totalInterest: 150000,
      });

      const result = await handlers["preview_mortgage_amortization"](
        {
          mortgageAmount: 250000,
          interestRate: 4.5,
          amortizationMonths: 300,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2026-01-01",
          isCanadian: true,
        },
        { sessionId: "s1" },
      );
      expect(
        loanMortgageService.previewMortgageAmortization,
      ).toHaveBeenCalledWith(
        250000,
        4.5,
        300,
        "MONTHLY",
        new Date("2026-01-01"),
        true,
        false,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.paymentAmount).toBe(1500);
    });
  });

  describe("detect_loan_payments", () => {
    it("returns detected=false when no pattern found", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      loanPaymentDetector.detectPaymentPattern.mockResolvedValue(null);

      const result = await handlers["detect_loan_payments"](
        { accountId: "00000000-0000-0000-0000-000000000001" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.detected).toBe(false);
    });

    it("surfaces the detected pattern", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      loanPaymentDetector.detectPaymentPattern.mockResolvedValue({
        paymentAmount: 1500,
        paymentFrequency: "MONTHLY",
        confidence: 0.95,
        isMortgage: true,
        currentBalance: 200000,
      });

      const result = await handlers["detect_loan_payments"](
        { accountId: "00000000-0000-0000-0000-000000000001" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.detected).toBe(true);
      expect(parsed.isMortgage).toBe(true);
    });
  });

  describe("get_ai_insights", () => {
    it("delegates to aiInsightsService.getInsights", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      aiInsightsService.getInsights.mockResolvedValue({
        insights: [
          {
            id: "i1",
            type: "anomaly",
            title: "Big spend",
            description: "Unusually large",
            severity: "alert",
            data: {},
            isDismissed: false,
            generatedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
        lastGeneratedAt: null,
        isGenerating: false,
      });

      const result = await handlers["get_ai_insights"](
        { type: "anomaly" },
        { sessionId: "s1" },
      );
      expect(aiInsightsService.getInsights).toHaveBeenCalledWith(
        "u1",
        "anomaly",
        undefined,
        false,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(1);
    });
  });
});
