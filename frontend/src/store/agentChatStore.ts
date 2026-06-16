import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { agentApi } from '@/lib/ai-agent';
import type {
  AgentChatMessage,
  AgentStreamEvent,
  AgentToolCallRecord,
  AgentWriteMode,
  ConfirmationRequest,
} from '@/types/ai-agent';
import type { ChartPayload } from '@/types/ai';

// Distinct from the AI Assistant's key so the two chatboxes keep separate
// histories. Cleared on logout via authStore (see AGENT_CHAT_STORAGE_KEY).
export const AGENT_CHAT_STORAGE_KEY = 'monize:agent-chat-messages';

export interface AgentThinkingState {
  active: boolean;
  message: string;
  liveText: string;
  tools: Array<{
    name: string;
    status: 'running' | 'done';
    summary?: string;
    isError?: boolean;
    isWrite?: boolean;
  }>;
}

const IDLE_THINKING: AgentThinkingState = {
  active: false,
  message: '',
  liveText: '',
  tools: [],
};

interface AgentChatState {
  messages: AgentChatMessage[];
  isLoading: boolean;
  thinking: AgentThinkingState;
  /** Effective write mode for the next submission (reflects the in-chat toggle). */
  writeMode: AgentWriteMode;
  /** Whether write tools require confirmation (only meaningful in edit mode). */
  confirmWrites: boolean;
  _abortController: AbortController | null;
  _activeAssistantId: string | null;

  /** Hydrate the write-mode/confirm toggles from the user preference store. */
  setWriteMode: (mode: AgentWriteMode) => void;
  setConfirmWrites: (value: boolean) => void;

  submit: (query: string) => void;
  cancel: () => void;
  clear: () => void;
  /** Resolve a pending write-tool confirmation (Approve/Deny). */
  resolveConfirmation: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
  ) => Promise<void>;
  _heal: () => void;
}

export const useAgentChatStore = create<AgentChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      thinking: IDLE_THINKING,
      writeMode: 'readonly',
      confirmWrites: true,
      _abortController: null,
      _activeAssistantId: null,

      setWriteMode: (mode) => set({ writeMode: mode }),
      setConfirmWrites: (value) => set({ confirmWrites: value }),

      submit: (query: string) => {
        const trimmed = query.trim();
        if (!trimmed || get().isLoading) return;

        const userMsgId = `agent-user-${Date.now()}`;
        const assistantMsgId = `agent-assistant-${Date.now()}`;
        const { writeMode, confirmWrites } = get();

        set((state) => ({
          messages: [
            ...state.messages,
            { id: userMsgId, role: 'user', content: trimmed },
          ],
          isLoading: true,
          thinking: {
            active: true,
            message: 'Analyzing your question...',
            liveText: '',
            tools: [],
          },
          _activeAssistantId: assistantMsgId,
        }));

        const toolsUsed: AgentToolCallRecord[] = [];
        const charts: ChartPayload[] = [];
        const confirmations: ConfirmationRequest[] = [];
        let contentBuffer = '';
        let hasStartedContent = false;

        const history = get()
          .messages.filter(
            (m) => !m.isStreaming && !m.error && m.content.length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content }));

        const controller = agentApi.queryStream(
          {
            query: trimmed,
            conversationHistory: history,
            writeMode,
            confirmWrites,
          },
          {
            onEvent: (event: AgentStreamEvent) => {
              switch (event.type) {
                case 'thinking':
                  set((state) => ({
                    thinking: {
                      ...state.thinking,
                      message: event.message || 'Thinking...',
                    },
                  }));
                  break;

                case 'assistant_text':
                  set((state) => ({
                    thinking: {
                      ...state.thinking,
                      liveText: state.thinking.liveText + (event.text || ''),
                    },
                  }));
                  break;

                case 'tool_start':
                  toolsUsed.push({
                    name: event.name || '',
                    summary: '',
                    input: event.input,
                    isWrite: event.isWrite,
                  });
                  set((state) => ({
                    thinking: {
                      ...state.thinking,
                      message: `Running ${event.name?.replace(/_/g, ' ')}...`,
                      liveText: '',
                      tools: [
                        ...state.thinking.tools,
                        {
                          name: event.name || '',
                          status: 'running',
                          isWrite: event.isWrite,
                        },
                      ],
                    },
                  }));
                  break;

                case 'tool_result': {
                  for (let i = 0; i < toolsUsed.length; i++) {
                    if (
                      toolsUsed[i].name === event.name &&
                      !toolsUsed[i].summary &&
                      toolsUsed[i].isError === undefined
                    ) {
                      toolsUsed[i] = {
                        ...toolsUsed[i],
                        summary: event.summary || '',
                        isError: event.isError === true,
                      };
                      break;
                    }
                  }
                  let updated = false;
                  set((state) => ({
                    thinking: {
                      ...state.thinking,
                      tools: state.thinking.tools.map((t) => {
                        if (
                          !updated &&
                          t.name === event.name &&
                          t.status === 'running'
                        ) {
                          updated = true;
                          return {
                            ...t,
                            status: 'done',
                            summary: event.summary,
                            isError: event.isError === true,
                          };
                        }
                        return t;
                      }),
                    },
                  }));
                  break;
                }

                case 'confirmation_request': {
                  const confirmation: ConfirmationRequest = {
                    messageId: event.messageId || '',
                    toolCallId: event.toolCallId || '',
                    toolName: event.toolName || '',
                    input: event.input || {},
                    preview: event.preview,
                    status: 'pending',
                  };
                  confirmations.push(confirmation);
                  // Attach to the in-progress assistant message if it exists,
                  // otherwise hold until 'content' creates the message.
                  if (hasStartedContent) {
                    set((state) => ({
                      messages: state.messages.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, confirmations: [...confirmations] }
                          : m,
                      ),
                    }));
                  }
                  break;
                }

                case 'content':
                  if (!hasStartedContent) {
                    hasStartedContent = true;
                    set((state) => ({
                      thinking: IDLE_THINKING,
                      messages: [
                        ...state.messages,
                        {
                          id: assistantMsgId,
                          role: 'assistant',
                          content: event.text || '',
                          toolsUsed: [...toolsUsed],
                          charts: charts.length > 0 ? [...charts] : undefined,
                          confirmations:
                            confirmations.length > 0
                              ? [...confirmations]
                              : undefined,
                          isStreaming: true,
                        },
                      ],
                    }));
                  }
                  contentBuffer = event.text || '';
                  set((state) => ({
                    messages: state.messages.map((m) =>
                      m.id === assistantMsgId
                        ? {
                            ...m,
                            content: contentBuffer,
                            toolsUsed: [...toolsUsed],
                            charts: charts.length > 0 ? [...charts] : m.charts,
                            confirmations:
                              confirmations.length > 0
                                ? [...confirmations]
                                : m.confirmations,
                          }
                        : m,
                    ),
                  }));
                  break;

                case 'done':
                  set((state) => ({
                    messages: state.messages.map((m) =>
                      m.id === assistantMsgId
                        ? {
                            ...m,
                            isStreaming: false,
                            charts: charts.length > 0 ? [...charts] : m.charts,
                            confirmations:
                              confirmations.length > 0
                                ? [...confirmations]
                                : m.confirmations,
                          }
                        : m,
                    ),
                    isLoading: false,
                    thinking: IDLE_THINKING,
                    _abortController: null,
                    _activeAssistantId: null,
                  }));
                  break;

                case 'error':
                  set((state) => {
                    const errorMsg =
                      (event.message as string) || 'An error occurred';
                    if (hasStartedContent) {
                      return {
                        messages: state.messages.map((m) =>
                          m.id === assistantMsgId
                            ? { ...m, isStreaming: false, error: errorMsg }
                            : m,
                        ),
                        isLoading: false,
                        thinking: IDLE_THINKING,
                        _abortController: null,
                        _activeAssistantId: null,
                      };
                    }
                    return {
                      messages: [
                        ...state.messages,
                        {
                          id: assistantMsgId,
                          role: 'assistant',
                          content: '',
                          error: errorMsg,
                        },
                      ],
                      isLoading: false,
                      thinking: IDLE_THINKING,
                      _abortController: null,
                      _activeAssistantId: null,
                    };
                  });
                  break;
              }
            },
            onDone: () => {
              if (get().isLoading) {
                set({
                  isLoading: false,
                  thinking: IDLE_THINKING,
                  _abortController: null,
                  _activeAssistantId: null,
                });
              }
            },
            onError: (error) => {
              set((state) => {
                const errorMsg =
                  error.message || 'Failed to connect to the AI service.';
                if (!hasStartedContent) {
                  return {
                    messages: [
                      ...state.messages,
                      {
                        id: assistantMsgId,
                        role: 'assistant',
                        content: '',
                        error: errorMsg,
                      },
                    ],
                    isLoading: false,
                    thinking: IDLE_THINKING,
                    _abortController: null,
                    _activeAssistantId: null,
                  };
                }
                return {
                  isLoading: false,
                  thinking: IDLE_THINKING,
                  _abortController: null,
                  _activeAssistantId: null,
                };
              });
            },
          },
        );

        set({ _abortController: controller });
      },

      cancel: () => {
        const { _abortController, _activeAssistantId } = get();
        _abortController?.abort();
        set((state) => ({
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
          messages: _activeAssistantId
            ? state.messages.map((m) =>
                m.id === _activeAssistantId
                  ? { ...m, isStreaming: false }
                  : m,
              )
            : state.messages,
        }));
      },

      clear: () => {
        get()._abortController?.abort();
        set({
          messages: [],
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
        });
      },

      resolveConfirmation: async (
        messageId,
        toolCallId,
        approved,
        reason,
      ) => {
        // Optimistically mark the confirmation as resolved in the UI.
        set((state) => ({
          messages: state.messages.map((m) =>
            m.confirmations
              ? {
                  ...m,
                  confirmations: m.confirmations.map((c) =>
                    c.toolCallId === toolCallId && c.messageId === messageId
                      ? { ...c, status: approved ? 'approved' : 'denied' }
                      : c,
                  ),
                }
              : m,
          ),
        }));
        try {
          await agentApi.confirmAction({ messageId, toolCallId, approved, reason });
        } catch {
          // The backend is the source of truth for whether the write actually
          // ran; a network failure here just means the user may need to retry.
          // Flip the status back to pending so the UI offers the action again.
          set((state) => ({
            messages: state.messages.map((m) =>
              m.confirmations
                ? {
                    ...m,
                    confirmations: m.confirmations.map((c) =>
                      c.toolCallId === toolCallId && c.messageId === messageId
                        ? { ...c, status: 'pending' }
                        : c,
                    ),
                  }
                : m,
            ),
          }));
        }
      },

      _heal: () => {
        set((state) => {
          if (!state.messages.some((m) => m.isStreaming)) return {};
          return {
            messages: state.messages.map((m) =>
              m.isStreaming ? { ...m, isStreaming: false } : m,
            ),
          };
        });
      },
    }),
    {
      name: AGENT_CHAT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist messages + the toggle state (so the user's read-only/edit
      // choice survives a reload). Transient stream state is in-memory only.
      partialize: (state) => ({
        messages: state.messages,
        writeMode: state.writeMode,
        confirmWrites: state.confirmWrites,
      }),
      onRehydrateStorage: () => (state) => {
        state?._heal();
      },
    },
  ),
);
