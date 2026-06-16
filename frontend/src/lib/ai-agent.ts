import Cookies from 'js-cookie';
import apiClient, { attemptTokenRefresh } from './api';
import type {
  AgentStreamCallbacks,
  AgentWriteMode,
} from '@/types/ai-agent';

export interface AgentQueryParams {
  query: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Per-request override; omit to use the persisted preference. */
  writeMode?: AgentWriteMode;
  confirmWrites?: boolean;
}

export interface AgentConfirmParams {
  messageId: string;
  toolCallId: string;
  approved: boolean;
  reason?: string;
}

/**
 * Client for the MCP-powered AI Agent (/ai-agent endpoints).
 *
 * Mirrors the AI Assistant's `aiApi.queryStream` (cookie-auth SSE with CSRF
 * header + 401→refresh→retry) but talks to the agent endpoints and adds a
 * `confirmAction` method for resolving write-tool confirmations.
 */
export const agentApi = {
  /**
   * Open the SSE stream and dispatch each event to `callbacks.onEvent`.
   * Returns an AbortController so the store can cancel an in-flight turn.
   */
  queryStream: (
    params: AgentQueryParams,
    callbacks: AgentStreamCallbacks,
  ): AbortController => {
    const controller = new AbortController();

    const openStream = (): Promise<Response> => {
      const csrfToken = Cookies.get('csrf_token') || '';
      return fetch('/api/v1/ai-agent/query/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          query: params.query,
          conversationHistory: params.conversationHistory,
          writeMode: params.writeMode,
          confirmWrites: params.confirmWrites,
        }),
        credentials: 'include',
        signal: controller.signal,
      });
    };

    (async () => {
      try {
        let response = await openStream();

        // The access token is 15m; if it expired while the user idled in the
        // conversation, the first POST returns 401. Replicate the axios
        // interceptor's refresh-and-retry here (fetch bypasses it).
        if (response.status === 401) {
          const refreshed = await attemptTokenRefresh();
          if (refreshed) {
            response = await openStream();
          }
        }

        if (!response.ok) {
          const text = await response.text();
          let message = `Request failed: ${response.status}`;
          try {
            const json = JSON.parse(text);
            message = json.message || message;
          } catch {
            // Use default message
          }
          callbacks.onError?.(new Error(message));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          callbacks.onError?.(new Error('No response body'));
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              // Skip SSE comment keepalives (": heartbeat ...").
              if (trimmed.startsWith(':')) continue;
              if (trimmed.startsWith('data: ')) {
                try {
                  const event = JSON.parse(trimmed.slice(6));
                  callbacks.onEvent(event);
                } catch {
                  // Skip malformed events
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        callbacks.onDone?.();
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError?.(error as Error);
        }
      }
    })();

    return controller;
  },

  /** Approve or deny a pending write-tool confirmation. */
  confirmAction: async (
    params: AgentConfirmParams,
  ): Promise<{ resolved: boolean }> => {
    const response = await apiClient.post<{ resolved: boolean }>(
      '/ai-agent/query/confirm',
      params,
    );
    return response.data;
  },
};
