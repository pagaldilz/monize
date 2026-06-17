import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserContextResolver } from "./mcp-context";
import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpNetWorthTools } from "./tools/net-worth.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpCalculateTools } from "./tools/calculate.tool";
import { McpBudgetsTools } from "./tools/budgets.tool";
import { McpPlanningTools } from "./tools/planning.tool";
import { McpTagsTools } from "./tools/tags.tool";
import { McpSafetyTools } from "./tools/safety.tool";
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

// Version comes from the backend package.json at build/run time so the MCP
// server advertises the same version as the published image. Using require
// keeps the read synchronous and avoids ESM import-assertion issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

@Injectable()
export class McpServerService {
  constructor(
    private readonly accountsTools: McpAccountsTools,
    private readonly transactionsTools: McpTransactionsTools,
    private readonly categoriesTools: McpCategoriesTools,
    private readonly payeesTools: McpPayeesTools,
    private readonly reportsTools: McpReportsTools,
    private readonly investmentsTools: McpInvestmentsTools,
    private readonly netWorthTools: McpNetWorthTools,
    private readonly scheduledTools: McpScheduledTools,
    private readonly calculateTools: McpCalculateTools,
    private readonly budgetsTools: McpBudgetsTools,
    private readonly planningTools: McpPlanningTools,
    private readonly tagsTools: McpTagsTools,
    private readonly safetyTools: McpSafetyTools,
    private readonly accountListResource: McpAccountListResource,
    private readonly categoryTreeResource: McpCategoryTreeResource,
    private readonly recentTransactionsResource: McpRecentTransactionsResource,
    private readonly financialSummaryResource: McpFinancialSummaryResource,
    private readonly financialReviewPrompt: McpFinancialReviewPrompt,
    private readonly budgetCheckPrompt: McpBudgetCheckPrompt,
    private readonly transactionLookupPrompt: McpTransactionLookupPrompt,
    private readonly spendingAnalysisPrompt: McpSpendingAnalysisPrompt,
  ) {}

  createServer(resolve: UserContextResolver): McpServer {
    const server = new McpServer(
      { name: "monize", version: backendPkg.version },
      {
        instructions: [
          "Monize is a personal finance management service. You can query accounts, transactions, investments, and generate financial reports.",
          "",
          "## General guidelines",
          "- Prefer summary and report tools over listing raw transactions. Use get_net_worth, generate_report, monthly_comparison, and get_portfolio_summary to answer questions when possible.",
          "- Only use search_transactions when the user asks about specific transactions (e.g. 'show me my Amazon purchases').",
          "- Amounts are signed: positive = income/deposit, negative = expense/withdrawal.",
          "- All dates use YYYY-MM-DD format. Report months use YYYY-MM.",
          "- Account IDs and category IDs are UUIDs. Use get_accounts or get_categories first to resolve names to IDs before calling other tools.",
          "",
          "## Answering common questions",
          "- 'How much did I spend on X?' → generate_report with type spending_by_category or spending_by_payee, not search_transactions.",
          "- 'How am I doing this month?' → monthly_comparison for the current month, or the financial-review prompt.",
          "- 'What's my net worth?' → get_net_worth for current breakdown, get_net_worth_history for trends.",
          "- 'Any unusual spending?' → get_anomalies rather than manually scanning transactions.",
          "- 'What bills are coming up?' → get_upcoming_bills.",
          "- 'How are my investments doing?' → get_portfolio_summary for the overview, get_holding_details only if they ask about a specific account.",
          "",
          "## Resources",
          "- monize://financial-summary provides a quick snapshot (net worth, current month income/expenses) without needing any tool calls.",
          "- monize://accounts and monize://categories are useful for resolving names to IDs.",
          "- monize://recent-transactions is a summarized view of the last 30 days.",
          "",
          "## Math accuracy",
          "- Never perform arithmetic yourself (addition, subtraction, multiplication, division, percentages). Use the calculate tool instead.",
          "- When tool results already include a computed value (e.g., percentage, netCashFlow), present it as-is rather than recomputing it.",
          "- If you need to derive a value not in the tool results (e.g., 'What percentage of income goes to rent?'), call the calculate tool with the relevant numbers.",
          "",
          "## Tips",
          "- Combine get_net_worth + monthly_comparison for a comprehensive financial overview in fewer calls.",
          "- When the user asks about trends, prefer generate_report with type monthly_trend over fetching transactions for each month.",
          "- Keep transaction searches focused: use date ranges, category/payee filters, and reasonable limits to avoid large result sets.",
          "- Use the available prompts (financial-review, budget-check, spending-analysis, transaction-lookup) as guides for multi-step workflows.",
          "",
          "## Investments & planning",
          "- For allocation/diversification: get_asset_allocation (by holding) and get_sector_weightings (by sector).",
          "- For short-term performance: get_top_movers (today's gainers/losers) and get_intraday_value (1d/1w/1m series).",
          "- For tax planning: get_realized_gains (realized only) vs. get_capital_gains (realized + unrealized).",
          "- For a single ticker's history: search_securities to resolve the symbol, then get_security_history.",
          "- To add a new ticker to track: create_security (idempotent by default — re-adding an existing symbol returns it with created=false rather than failing).",
          "- For projections: run_monte_carlo (feed get_monte_carlo_historical_stats into expectedReturn/volatility for realism), preview_loan_amortization / preview_mortgage_amortization, and detect_loan_payments to infer an existing loan's terms.",
          "- For precomputed spending insights (anomalies, subscriptions, trends): get_ai_insights.",
          "- Use refresh_security_prices when the user asks to update stale quotes.",
          "",
          "## Writing data",
          "- create_transaction / create_transfer / update_transaction / set_transaction_status / clear_transaction / categorize_transaction.",
          "- update_transaction_splits (replace splits), set_transaction_tags (replace tags), bulk_update_transactions (update many at once), unreconcile_transaction.",
          "- post_scheduled_transaction converts a due bill/deposit into a real transaction; skip_scheduled_transaction skips one occurrence.",
          "- Accounts: update_account / close_account / reopen_account.",
          "- Categories: create_category / update_category / reassign_category_transactions.",
          "- Payees: create_payee / update_payee / merge_payees (requires confirmMerge=true) / reactivate_payee.",
          "- Securities: create_security (add a stock/ETF/etc.; idempotent by default, strict with onConflict='error').",
          "- Tags: create_tag / update_tag.",
          "- Safety net: undo_last_action / redo_action / get_action_history — reverse a mistaken change.",
          "- No tool deletes data except merge_payees (which removes the source payee and requires an explicit confirmMerge=true).",
          "- All writes require 'write' scope, are HTML-sanitized, are rate-limited (50/day per user), and most support dryRun=true to preview first.",
        ].join("\n"),
        capabilities: {
          logging: {},
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    this.registerAll(server, resolve);

    return server;
  }

  /**
   * Register every tool, resource, and prompt provider onto `server`.
   *
   * Extracted from `createServer` so the in-process AI Agent registry can
   * reuse the exact same registration flow against a capturing proxy server
   * (to obtain the `RegisteredTool` objects for direct in-process invocation)
   * without duplicating the provider list in two places.
   */
  registerAll(server: McpServer, resolve: UserContextResolver): void {
    this.accountsTools.register(server, resolve);
    this.transactionsTools.register(server, resolve);
    this.categoriesTools.register(server, resolve);
    this.payeesTools.register(server, resolve);
    this.reportsTools.register(server, resolve);
    this.investmentsTools.register(server, resolve);
    this.netWorthTools.register(server, resolve);
    this.scheduledTools.register(server, resolve);
    this.calculateTools.register(server);
    this.budgetsTools.register(server, resolve);
    this.planningTools.register(server, resolve);
    this.tagsTools.register(server, resolve);
    this.safetyTools.register(server, resolve);

    this.accountListResource.register(server, resolve);
    this.categoryTreeResource.register(server, resolve);
    this.recentTransactionsResource.register(server, resolve);
    this.financialSummaryResource.register(server, resolve);

    this.financialReviewPrompt.register(server);
    this.budgetCheckPrompt.register(server);
    this.transactionLookupPrompt.register(server);
    this.spendingAnalysisPrompt.register(server);
  }
}
