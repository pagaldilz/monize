'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'react-hot-toast';
import { aiApi } from '@/lib/ai';
import { SuggestedQueries } from '../ai/SuggestedQueries';
import { AgentChatMessage } from './AgentChatMessage';
import type { AiStatus } from '@/types/ai';
import {
  useAgentChatStore,
  AGENT_CHAT_STORAGE_KEY,
} from '@/store/agentChatStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import Link from 'next/link';

// Re-exported for authStore logout cleanup and tests.
export { AGENT_CHAT_STORAGE_KEY };

export function AgentChatInterface() {
  const t = useTranslations('aiAgent');
  const messages = useAgentChatStore((s) => s.messages);
  const isLoading = useAgentChatStore((s) => s.isLoading);
  const thinking = useAgentChatStore((s) => s.thinking);
  const writeMode = useAgentChatStore((s) => s.writeMode);
  const confirmWrites = useAgentChatStore((s) => s.confirmWrites);
  const submit = useAgentChatStore((s) => s.submit);
  const cancel = useAgentChatStore((s) => s.cancel);
  const clear = useAgentChatStore((s) => s.clear);
  const setWriteMode = useAgentChatStore((s) => s.setWriteMode);
  const setConfirmWrites = useAgentChatStore((s) => s.setConfirmWrites);
  const resolveConfirmation = useAgentChatStore(
    (s) => s.resolveConfirmation,
  );

  const preferences = usePreferencesStore((s) => s.preferences);
  const updatePreferences = usePreferencesStore((s) => s.updatePreferences);

  const [input, setInput] = useState('');
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Hydrate the toggle state from persisted preferences on mount, and keep
  // it in sync if the preference changes elsewhere (e.g. a settings page).
  useEffect(() => {
    if (preferences) {
      setWriteMode(preferences.aiAgentWriteMode ?? 'readonly');
      setConfirmWrites(preferences.aiAgentConfirmWrites ?? true);
    }
  }, [preferences, setWriteMode, setConfirmWrites]);

  useEffect(() => {
    aiApi
      .getStatus()
      .then((status) => {
        setAiStatus(status);
        setStatusLoading(false);
      })
      .catch(() => setStatusLoading(false));
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, thinking, scrollToBottom]);

  const handleSubmit = useCallback(
    (queryText?: string) => {
      const query = queryText || input;
      if (!query.trim() || isLoading) return;
      setInput('');
      submit(query);
    },
    [input, isLoading, submit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Persist the toggle changes back to the user preference so they survive a
  // reload and apply on other devices. Failures are non-fatal — the in-memory
  // store still updates immediately for a responsive UI.
  const toggleWriteMode = useCallback(
    async (next: 'readonly' | 'edit') => {
      setWriteMode(next);
      updatePreferences({ aiAgentWriteMode: next });
      try {
        await userSettingsApi.updatePreferences({ aiAgentWriteMode: next });
      } catch {
        toast.error(t('errors.preferenceSaveFailed'));
      }
    },
    [setWriteMode, updatePreferences, t],
  );

  const toggleConfirmWrites = useCallback(
    async (next: boolean) => {
      setConfirmWrites(next);
      updatePreferences({ aiAgentConfirmWrites: next });
      try {
        await userSettingsApi.updatePreferences({ aiAgentConfirmWrites: next });
      } catch {
        toast.error(t('errors.preferenceSaveFailed'));
      }
    },
    [setConfirmWrites, updatePreferences, t],
  );

  const handleResolveConfirmation = useCallback(
    (messageId: string, toolCallId: string, approved: boolean) => {
      void resolveConfirmation(messageId, toolCallId, approved);
    },
    [resolveConfirmation],
  );

  const aiNotConfigured = !statusLoading && aiStatus && !aiStatus.configured;

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* AI not configured banner */}
      {aiNotConfigured && (
        <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-3">
            <svg
              className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('notConfigured.heading')}
              </h3>
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                {t.rich('notConfigured.message', {
                  link: (chunks) => (
                    <Link
                      href="/settings/ai"
                      className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Mode toggle bar */}
      <div className="flex items-center justify-between gap-3 px-2 pb-3 mb-1 border-b border-gray-200 dark:border-gray-700 flex-wrap">
        <div className="flex items-center gap-2">
          {/* Read-only / Edit segmented toggle */}
          <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
            <button
              type="button"
              onClick={() => toggleWriteMode('readonly')}
              disabled={isLoading}
              className={
                writeMode === 'readonly'
                  ? 'px-3 py-1.5 text-xs font-medium bg-blue-600 text-white'
                  : 'px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }
              title={t('mode.readonlyTooltip')}
            >
              {t('mode.readonly')}
            </button>
            <button
              type="button"
              onClick={() => toggleWriteMode('edit')}
              disabled={isLoading}
              className={
                writeMode === 'edit'
                  ? 'px-3 py-1.5 text-xs font-medium bg-amber-600 text-white'
                  : 'px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }
              title={t('mode.editTooltip')}
            >
              {t('mode.edit')}
            </button>
          </div>

          {writeMode === 'edit' && (
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmWrites}
                onChange={(e) => toggleConfirmWrites(e.target.checked)}
                disabled={isLoading}
                className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
              />
              {t('mode.confirmWrites')}
            </label>
          )}
        </div>

        {writeMode === 'edit' && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
            <svg
              className="h-2.5 w-2.5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
              />
            </svg>
            {t('mode.editBadge')}
          </span>
        )}

        {messages.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="text-xs text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 transition-colors ml-auto"
          >
            {t('chat.clearConversation')}
          </button>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-2 py-4">
        {messages.length === 0 && !thinking.active ? (
          <SuggestedQueries
            onSelect={handleSubmit}
            disabled={!!aiNotConfigured}
          />
        ) : (
          <>
            {messages.map((msg) => (
              <AgentChatMessage
                key={msg.id}
                message={msg}
                onResolveConfirmation={handleResolveConfirmation}
              />
            ))}

            {/* Thinking indicator */}
            {thinking.active && (
              <div className="flex justify-start mb-4">
                <div className="max-w-[85%]">
                  <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-700/60">
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                      <svg
                        className="w-4 h-4 animate-spin"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      {thinking.message}
                    </div>
                    {thinking.liveText && (
                      <div className="mt-2 text-sm text-gray-600 dark:text-gray-300 italic whitespace-pre-wrap break-words">
                        {thinking.liveText}
                      </div>
                    )}
                    {thinking.tools.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {thinking.tools.map((tool, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500"
                          >
                            {tool.status === 'running' ? (
                              <svg
                                className="w-3 h-3 animate-spin"
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <circle
                                  className="opacity-25"
                                  cx="12"
                                  cy="12"
                                  r="10"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                />
                                <path
                                  className="opacity-75"
                                  fill="currentColor"
                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                />
                              </svg>
                            ) : tool.isError ? (
                              <svg
                                className="w-3 h-3 text-red-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={2}
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                            ) : tool.isWrite ? (
                              <svg
                                className="w-3 h-3 text-amber-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={2}
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                                />
                              </svg>
                            ) : (
                              <svg
                                className="w-3 h-3 text-green-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={2}
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M4.5 12.75l6 6 9-13.5"
                                />
                              </svg>
                            )}
                            {tool.name.replace(/_/g, ' ')}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 pb-2">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              aiNotConfigured
                ? t('chat.inputPlaceholderDisabled')
                : writeMode === 'edit'
                  ? t('chat.inputPlaceholderEdit')
                  : t('chat.inputPlaceholderReadonly')
            }
            disabled={isLoading || !!aiNotConfigured}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
          />
          {isLoading ? (
            <button
              onClick={cancel}
              className="flex-shrink-0 p-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors"
              title={t('chat.cancelTitle')}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleSubmit()}
              disabled={!input.trim() || !!aiNotConfigured}
              className={
                writeMode === 'edit'
                  ? 'flex-shrink-0 p-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white transition-colors disabled:cursor-not-allowed'
                  : 'flex-shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white transition-colors disabled:cursor-not-allowed'
              }
              title={t('chat.sendTitle')}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                />
              </svg>
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 text-center">
          {writeMode === 'edit'
            ? t('chat.editModeHint')
            : t('chat.keyboardHint')}
        </p>
      </div>
    </div>
  );
}
