import { Injectable } from "@nestjs/common";
import { DailyWriteLimiter } from "../../common/daily-write-limiter";

/**
 * Maximum number of AI-Assistant-confirmed write operations per user per day.
 * Mirrors the MCP daily cap so the two LLM write surfaces are bounded the same
 * way.
 */
export const AI_DAILY_WRITE_LIMIT = 50;

/**
 * Injectable per-user daily write limiter for the AI Assistant action
 * confirmation endpoint.
 */
@Injectable()
export class AiWriteLimiter extends DailyWriteLimiter {
  constructor() {
    super(AI_DAILY_WRITE_LIMIT);
  }
}
