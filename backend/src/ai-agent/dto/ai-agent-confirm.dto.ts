import { IsString, IsNotEmpty, IsBoolean, IsOptional } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

/**
 * Body for POST /ai-agent/query/confirm.
 *
 * Resolves a pending confirmation: a write tool the agent proposed (and ran
 * in dryRun mode) is either approved (the controller re-runs it for real) or
 * denied (the agent is told the user declined, so it can adjust).
 *
 * `messageId` ties the confirmation back to the SSE `confirmation_request`
 * event the client received; `toolCallId` ties it to the specific tool call
 * within that turn.
 */
export class AiAgentConfirmDto {
  @IsString()
  @IsNotEmpty()
  messageId: string;

  @IsString()
  @IsNotEmpty()
  toolCallId: string;

  @IsBoolean()
  approved: boolean;

  /** Optional user note explaining the denial, surfaced to the model. */
  @IsOptional()
  @SanitizeHtml()
  reason?: string;
}
