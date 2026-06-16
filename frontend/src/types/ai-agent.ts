import type { ChartPayload } from './ai';

/** The agent's write scope for a session. Read-only is the safe default. */
export type AgentWriteMode = 'readonly' | 'edit';

/**
 * A pending write-tool confirmation the backend emitted as a
 * `confirmation_request` event. The UI renders a card with Approve / Deny
 * and POSTs the decision to /ai-agent/query/confirm.
 */
export interface ConfirmationRequest {
  messageId: string;
  toolCallId: string;
  toolName: string;
  /** The arguments the model wants to pass to the write tool. */
  input: Record<string, unknown>;
  /** The dryRun preview the backend produced before pausing. */
  preview?: string;
  /** Whether the user has acted on this confirmation. */
  status?: 'pending' | 'approved' | 'denied';
}

/**
 * SSE event stream from POST /ai-agent/query/stream.
 *
 * Mirrors the AI Assistant's StreamEvent union (in types/ai.ts) and adds:
 * - `confirmation_request`: emitted when a write tool needs user approval.
 * - `isWrite` flag on `tool_start` / `tool_result`: lets the UI badge
 *   mutating vs. read-only calls distinctly.
 */
export interface AgentStreamEvent {
  type:
    | 'thinking'
    | 'assistant_text'
    | 'tool_start'
    | 'tool_result'
    | 'confirmation_request'
    | 'content'
    | 'done'
    | 'error';
  message?: string;
  name?: string;
  description?: string;
  summary?: string;
  text?: string;
  isError?: boolean;
  isWrite?: boolean;
  input?: Record<string, unknown>;
  // Fields for the `confirmation_request` event.
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
  preview?: string;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface AgentStreamCallbacks {
  onEvent: (event: AgentStreamEvent) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

export interface AgentToolCallRecord {
  name: string;
  summary: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  isWrite?: boolean;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: AgentToolCallRecord[];
  charts?: ChartPayload[];
  isStreaming?: boolean;
  error?: string;
  // Pending write-tool confirmations attached to this assistant turn.
  confirmations?: ConfirmationRequest[];
}
