import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { AccountType, Account } from "../../accounts/entities/account.entity";
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
import { McpWriteLimiter } from "../mcp-write-limiter";
import { stripHtml } from "../../common/sanitization.util";
import {
  getAccountsOutput,
  getAccountBalanceOutput,
  getAccountBalancesOutput,
  createAccountOutput,
  updateAccountOutput,
  closeAccountOutput,
  reopenAccountOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpAccountsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_accounts",
      {
        title: "List accounts",
        annotations: READ_ONLY,
        description: "List all accounts with balances",
        inputSchema: {
          includeInactive: z
            .boolean()
            .optional()
            .describe("Include closed accounts"),
        },
        outputSchema: getAccountsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const accounts = await this.accountsService.findAll(
            ctx.userId,
            args.includeInactive || false,
          );
          return toolResult(accounts);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_account_balance",
      {
        title: "Get account balance",
        annotations: READ_ONLY,
        description: "Get detailed balance for a specific account",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
        },
        outputSchema: getAccountBalanceOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const account = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );
          return toolResult({
            id: account.id,
            name: account.name,
            type: account.accountType,
            currentBalance: account.currentBalance,
            creditLimit: account.creditLimit,
            currencyCode: account.currencyCode,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_account_balances",
      {
        title: "Get account balances",
        annotations: READ_ONLY,
        description:
          "Get current account balances with per-account type and currency, plus total assets, total liabilities, and net worth. Returns the same shape as the AI Assistant's get_account_balances tool. Brokerage accounts show market value; every other account shows currentBalance + futureTransactionsSum. Totals match the dashboard Net Worth widget.",
        inputSchema: {
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe(
              "Optional: filter to specific account names. Omit to cover all accounts.",
            ),
          status: z
            .enum(["open", "closed", "all"])
            .optional()
            .describe(
              "Which accounts to include by status. Defaults to 'open'.",
            ),
          accountTypes: z
            .array(z.nativeEnum(AccountType))
            .max(10)
            .optional()
            .describe(
              "Optional: filter to specific account types (CHEQUING, SAVINGS, CREDIT_CARD, LOAN, MORTGAGE, INVESTMENT, CASH, LINE_OF_CREDIT, ASSET, OTHER). Omit to include all types.",
            ),
        },
        outputSchema: getAccountBalancesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Service owns the "open" default so it stays in one place.
          const data = await this.accountsService.getLlmBalances(
            ctx.userId,
            args.accountNames,
            args.status,
            args.accountTypes,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_account",
      {
        title: "Create account",
        annotations: CREATE,
        description:
          "Create a new account. Common types (CHEQUING, SAVINGS, CREDIT_CARD, CASH, LINE_OF_CREDIT, ASSET, OTHER) need only accountType + name + currencyCode (openingBalance defaults to 0). INVESTMENT also needs just name + currency; set createInvestmentPair=true to create a linked cash + brokerage pair in one call. LOAN and MORTGAGE need more: the loan/mortgage principal as openingBalance, an annual interestRate, the lender's name as institution, a sourceAccountId (an existing account the payments will be drawn from), a paymentStartDate (YYYY-MM-DD), and a payment schedule (paymentAmount + paymentFrequency for loans; amortizationMonths + mortgagePaymentFrequency for mortgages — the mortgage payment amount is derived for you). Returns the new account's id and starting balance. Tip: for loans/mortgages you can first call preview_loan_amortization / preview_mortgage_amortization to show the user the projected payoff before creating.",
        inputSchema: {
          accountType: z
            .nativeEnum(AccountType)
            .describe(
              "Account type. One of: CHEQUING, SAVINGS, CREDIT_CARD, LOAN, MORTGAGE, INVESTMENT, CASH, LINE_OF_CREDIT, ASSET, OTHER.",
            ),
          name: z.string().max(100).describe("Account name"),
          currencyCode: z
            .string()
            .length(3)
            .describe("ISO 4217 currency code (e.g. USD, CAD, EUR)"),
          openingBalance: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe(
              "Opening balance (defaults to 0). Becomes the starting current balance.",
            ),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Account description"),
          accountNumber: z
            .string()
            .max(100)
            .optional()
            .describe("Account number (masked/last-4 is typical)"),
          institution: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Institution name (free text). Prefer institutionId if the institution is already linked.",
            ),
          institutionId: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe("Linked institution ID"),
          creditLimit: z
            .number()
            .min(0)
            .optional()
            .describe(
              "Credit limit (credit cards / lines of credit). Must be positive.",
            ),
          interestRate: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe(
              "Annual interest rate as a percentage (e.g. 19.99). 0-100.",
            ),
          isFavourite: z
            .boolean()
            .optional()
            .describe("Mark the new account as a favourite (default false)"),
          excludeFromNetWorth: z
            .boolean()
            .optional()
            .describe(
              "Exclude this account from net worth calculations (default false)",
            ),
          // Investment pairing
          createInvestmentPair: z
            .boolean()
            .optional()
            .describe(
              "INVESTMENT only. When true, creates a linked cash (INVESTMENT_CASH) + brokerage (INVESTMENT_BROKERAGE) account pair. openingBalance is applied to the cash half; the brokerage half starts at 0. Default false = single investment account.",
            ),
          // Loan & mortgage payment-plan fields
          paymentAmount: z
            .number()
            .min(0.01)
            .max(999999999999)
            .optional()
            .describe(
              "LOAN only (required). Payment amount per period.",
            ),
          paymentFrequency: z
            .enum(PAYMENT_FREQUENCIES)
            .optional()
            .describe(
              "LOAN only (required). One of: WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY.",
            ),
          mortgagePaymentFrequency: z
            .enum(MORTGAGE_PAYMENT_FREQUENCIES)
            .optional()
            .describe(
              "MORTGAGE only (required). One of: MONTHLY, SEMI_MONTHLY, BIWEEKLY, ACCELERATED_BIWEEKLY, WEEKLY, ACCELERATED_WEEKLY.",
            ),
          paymentStartDate: z
            .string()
            .max(10)
            .optional()
            .describe(
              "LOAN/MORTGAGE (required). First payment date (YYYY-MM-DD).",
            ),
          sourceAccountId: z
            .string()
            .uuid()
            .optional()
            .describe(
              "LOAN/MORTGAGE (required). UUID of the existing account that loan/mortgage payments will be drawn from (e.g. the user's chequing account).",
            ),
          interestCategoryId: z
            .string()
            .uuid()
            .optional()
            .describe(
              "LOAN/MORTGAGE. Category for the interest portion of payments. If omitted, the service auto-selects a 'Loan Interest' category.",
            ),
          // Mortgage-specific fields
          amortizationMonths: z
            .number()
            .int()
            .min(1)
            .max(600)
            .optional()
            .describe(
              "MORTGAGE only (required). Total amortization period in months (e.g. 300 = 25 years).",
            ),
          termMonths: z
            .number()
            .int()
            .min(0)
            .max(600)
            .optional()
            .describe(
              "MORTGAGE. Mortgage term length in months (e.g. 60 = 5-year term). 0 means no term.",
            ),
          isCanadianMortgage: z
            .boolean()
            .optional()
            .describe(
              "MORTGAGE. If true, use Canadian semi-annual compounding (fixed rate). Default false (US-style monthly compounding).",
            ),
          isVariableRate: z
            .boolean()
            .optional()
            .describe(
              "MORTGAGE. If true (Canadian), use monthly compounding for a variable rate. Default false.",
            ),
        },
        outputSchema: createAccountOutput,
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
          // create() returns Account for the common types and for loans,
          // mortgages, and single investment accounts; it returns
          // { cashAccount, brokerageAccount } when an INVESTMENT pair is
          // requested (createInvestmentPair=true).
          const result = (await this.accountsService.create(ctx.userId, {
            accountType: args.accountType,
            name: stripHtml(args.name) as string,
            currencyCode: (args.currencyCode as string).toUpperCase(),
            ...(args.openingBalance !== undefined && {
              openingBalance: args.openingBalance,
            }),
            ...(args.description !== undefined && {
              description: stripHtml(args.description),
            }),
            ...(args.accountNumber !== undefined && {
              accountNumber: stripHtml(args.accountNumber),
            }),
            ...(args.institution !== undefined && {
              institution: stripHtml(args.institution),
            }),
            ...(args.institutionId !== undefined && {
              // null clears the institution; map to undefined so the service
              // treats it as "not provided" rather than rejecting the DTO.
              institutionId: args.institutionId ?? undefined,
            }),
            ...(args.creditLimit !== undefined && {
              creditLimit: args.creditLimit,
            }),
            ...(args.interestRate !== undefined && {
              interestRate: args.interestRate,
            }),
            ...(args.isFavourite !== undefined && {
              isFavourite: args.isFavourite,
            }),
            ...(args.excludeFromNetWorth !== undefined && {
              excludeFromNetWorth: args.excludeFromNetWorth,
            }),
            // Investment pairing
            ...(args.createInvestmentPair !== undefined && {
              createInvestmentPair: args.createInvestmentPair,
            }),
            // Loan & mortgage payment-plan fields
            ...(args.paymentAmount !== undefined && {
              paymentAmount: args.paymentAmount,
            }),
            ...(args.paymentFrequency !== undefined && {
              paymentFrequency: args.paymentFrequency,
            }),
            ...(args.mortgagePaymentFrequency !== undefined && {
              mortgagePaymentFrequency: args.mortgagePaymentFrequency,
            }),
            ...(args.paymentStartDate !== undefined && {
              paymentStartDate: args.paymentStartDate,
            }),
            ...(args.sourceAccountId !== undefined && {
              sourceAccountId: args.sourceAccountId,
            }),
            ...(args.interestCategoryId !== undefined && {
              interestCategoryId: args.interestCategoryId,
            }),
            // Mortgage-specific fields
            ...(args.amortizationMonths !== undefined && {
              amortizationMonths: args.amortizationMonths,
            }),
            ...(args.termMonths !== undefined && {
              termMonths: args.termMonths,
            }),
            ...(args.isCanadianMortgage !== undefined && {
              isCanadianMortgage: args.isCanadianMortgage,
            }),
            ...(args.isVariableRate !== undefined && {
              isVariableRate: args.isVariableRate,
            }),
          })) as Account | { cashAccount: Account; brokerageAccount: Account };

          this.writeLimiter.record(ctx.userId, "create_account");

          // Investment pair: surface both account IDs so follow-up tool calls
          // (e.g. update_account) can target either half.
          if (
            result &&
            typeof result === "object" &&
            "cashAccount" in result &&
            "brokerageAccount" in result
          ) {
            return toolResult({
              cashAccount: {
                id: result.cashAccount.id,
                name: result.cashAccount.name,
                accountType: result.cashAccount.accountType,
                currencyCode: result.cashAccount.currencyCode,
                openingBalance: result.cashAccount.openingBalance,
                currentBalance: result.cashAccount.currentBalance,
              },
              brokerageAccount: {
                id: result.brokerageAccount.id,
                name: result.brokerageAccount.name,
                accountType: result.brokerageAccount.accountType,
                currencyCode: result.brokerageAccount.currencyCode,
                openingBalance: result.brokerageAccount.openingBalance,
                currentBalance: result.brokerageAccount.currentBalance,
              },
              message:
                "Investment account pair created: a cash account and a brokerage account, linked together.",
            });
          }

          const account = result as Account;
          return toolResult({
            id: account.id,
            name: account.name,
            accountType: account.accountType,
            currencyCode: account.currencyCode,
            openingBalance: account.openingBalance,
            currentBalance: account.currentBalance,
            isClosed: account.isClosed,
            message: "Account created successfully.",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "update_account",
      {
        title: "Update account",
        annotations: UPDATE,
        description:
          "Update an account's commonly-used fields (name, currency, description, credit limit, interest rate, favourite flag, exclude-from-net-worth, account number, institution). Only provided fields change. Set dryRun=true to preview against the current account without saving. Loan/mortgage-specific account edits remain on the REST API.",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
          name: z.string().max(100).optional().describe("Account name"),
          currencyCode: z
            .string()
            .max(10)
            .optional()
            .describe("ISO 4217 currency code (e.g. USD)"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Account description"),
          creditLimit: z
            .number()
            .min(0)
            .optional()
            .describe("Credit limit (credit cards / lines of credit)"),
          interestRate: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Annual interest rate as a percentage (loans/mortgages)"),
          isFavourite: z
            .boolean()
            .optional()
            .describe("Mark as a favourite account"),
          excludeFromNetWorth: z
            .boolean()
            .optional()
            .describe("Exclude this account from net worth calculations"),
          accountNumber: z
            .string()
            .max(100)
            .optional()
            .describe("Account number (masked/last-4 is typical)"),
          institutionId: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe("Institution ID, or null to clear"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, preview without saving"),
        },
        outputSchema: updateAccountOutput,
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
          const existing = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );

          // Dry-run: show current vs. proposed values.
          if (args.dryRun) {
            const proposed: Record<string, unknown> = {
              name: args.name !== undefined ? args.name : existing.name,
              currencyCode:
                args.currencyCode !== undefined
                  ? args.currencyCode
                  : existing.currencyCode,
              description:
                args.description !== undefined
                  ? stripHtml(args.description)
                  : existing.description,
              creditLimit:
                args.creditLimit !== undefined
                  ? args.creditLimit
                  : existing.creditLimit,
              interestRate:
                args.interestRate !== undefined
                  ? args.interestRate
                  : existing.interestRate,
              isFavourite:
                args.isFavourite !== undefined
                  ? args.isFavourite
                  : existing.isFavourite,
              excludeFromNetWorth:
                args.excludeFromNetWorth !== undefined
                  ? args.excludeFromNetWorth
                  : existing.excludeFromNetWorth,
              accountNumber:
                args.accountNumber !== undefined
                  ? args.accountNumber
                  : existing.accountNumber,
              institutionId:
                args.institutionId !== undefined
                  ? args.institutionId
                  : existing.institutionId,
            };
            return toolResult({
              dryRun: true,
              preview: proposed,
              message:
                "This is a preview. Call again with dryRun=false to apply the update.",
            });
          }

          const dto: Record<string, unknown> = {};
          if (args.name !== undefined) dto.name = stripHtml(args.name);
          if (args.currencyCode !== undefined)
            dto.currencyCode = args.currencyCode;
          if (args.description !== undefined)
            dto.description = stripHtml(args.description);
          if (args.creditLimit !== undefined) dto.creditLimit = args.creditLimit;
          if (args.interestRate !== undefined)
            dto.interestRate = args.interestRate;
          if (args.isFavourite !== undefined) dto.isFavourite = args.isFavourite;
          if (args.excludeFromNetWorth !== undefined)
            dto.excludeFromNetWorth = args.excludeFromNetWorth;
          if (args.accountNumber !== undefined)
            dto.accountNumber = args.accountNumber;
          if (args.institutionId !== undefined)
            dto.institutionId = args.institutionId;

          const account = await this.accountsService.update(
            ctx.userId,
            args.accountId,
            dto as any,
          );

          this.writeLimiter.record(ctx.userId, "update_account");

          return toolResult({
            id: account.id,
            name: account.name,
            currencyCode: account.currencyCode,
            isClosed: account.isClosed,
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "close_account",
      {
        title: "Close account",
        annotations: UPDATE,
        description:
          "Soft-close an account (reversible via reopen_account). Closed accounts are excluded from balances by default but retain all transaction history. Not a deletion.",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
        },
        outputSchema: closeAccountOutput,
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
          const account = await this.accountsService.close(
            ctx.userId,
            args.accountId,
          );

          this.writeLimiter.record(ctx.userId, "close_account");

          return toolResult({
            id: account.id,
            name: account.name,
            isClosed: account.isClosed,
            message: "Account closed. Use reopen_account to reverse.",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "reopen_account",
      {
        title: "Reopen account",
        annotations: UPDATE,
        description:
          "Reopen a previously closed account. Idempotent: reopening an already-open account is a no-op.",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
        },
        outputSchema: reopenAccountOutput,
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
          const account = await this.accountsService.reopen(
            ctx.userId,
            args.accountId,
          );

          this.writeLimiter.record(ctx.userId, "reopen_account");

          return toolResult({
            id: account.id,
            name: account.name,
            isClosed: account.isClosed,
            message: "Account reopened",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
