import {
  IsString,
  MaxLength,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  IsIn,
  IsBoolean,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

class ConversationMessageDto {
  @IsIn(["user", "assistant"])
  role: "user" | "assistant";

  @IsString()
  @MaxLength(50000)
  content: string;
}

/**
 * Maximum number of conversation history messages the client may send.
 * Mirrors the AI Assistant's MAX_HISTORY_MESSAGES.
 */
export const AGENT_MAX_HISTORY_MESSAGES = 20;

export class AiAgentQueryDto {
  @IsString()
  @MaxLength(2000)
  @IsNotEmpty()
  @SanitizeHtml()
  query: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConversationMessageDto)
  conversationHistory?: ConversationMessageDto[];

  /**
   * Optional per-request override of the persisted write-mode preference.
   * Lets the UI toggle read-only/edit for a single turn without persisting.
   * When omitted, the user's `ai_agent_write_mode` preference is used.
   */
  @IsOptional()
  @IsIn(["readonly", "edit"])
  writeMode?: "readonly" | "edit";

  /**
   * Optional per-request override of the persisted confirm-writes preference.
   */
  @IsOptional()
  @IsBoolean()
  confirmWrites?: boolean;
}
