import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { AccountType, Account } from "../../accounts/entities/account.entity";
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
          "Create a new account. Requires an account type, a name, and a 3-letter currency code (e.g. USD). Optionally set the opening balance (defaults to 0), description, account number, institution, credit limit, interest rate, and favourite/exclude-from-net-worth flags. Returns the new account's id and starting balance. Creating loans, mortgages, or paired investment accounts requires additional fields and remains on the REST API — use this tool only for the common account types (chequing, savings, credit card, cash, line of credit, asset, other).",
        inputSchema: {
          accountType: z
            .nativeEnum(AccountType)
            .describe(
              "Account type. One of: CHEQUING, SAVINGS, CREDIT_CARD, CASH, LINE_OF_CREDIT, ASSET, OTHER. (LOAN, MORTGAGE, and INVESTMENT require the REST API.)",
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

        // Block the specialized account types that need multi-field
        // orchestration the REST API handles (loan/mortgage payment plans,
        // investment cash+brokerage pairs). Mirrors update_account's note.
        if (
          args.accountType === AccountType.LOAN ||
          args.accountType === AccountType.MORTGAGE ||
          args.accountType === AccountType.INVESTMENT
        ) {
          return toolError(
            `Creating ${args.accountType} accounts requires payment-plan / pairing details that this tool doesn't support. Please create it via the Monize app's Add Account flow, then I can update it.`,
          );
        }

        try {
          // create() returns Account | { cashAccount, brokerageAccount }, but
          // only the INVESTMENT branch yields the pair — and we block that
          // above. Cast so we can read the single-account fields below.
          const account = (await this.accountsService.create(ctx.userId, {
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
          })) as Account;

          this.writeLimiter.record(ctx.userId, "create_account");

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
