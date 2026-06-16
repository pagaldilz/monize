/**
 * LLM08-F1: Rate limiter for MCP write operations.
 *
 * Enforces a per-user daily limit on write operations (create, update, categorize)
 * performed through MCP tools to prevent an external AI tool from making
 * excessive modifications to financial data.
 *
 * The mechanism lives in the shared `DailyWriteLimiter` so the AI Assistant's
 * action-confirmation endpoint enforces the same kind of cap.
 */

import {
  DailyWriteLimiter,
  WriteOperation,
} from "../common/daily-write-limiter";

export type { WriteOperation };

/**
 * Maximum number of write operations per user per day via MCP.
 */
export const MCP_DAILY_WRITE_LIMIT = 50;

export class McpWriteLimiter extends DailyWriteLimiter {
  constructor() {
    super(MCP_DAILY_WRITE_LIMIT);
  }
}
