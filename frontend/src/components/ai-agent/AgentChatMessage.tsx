'use client';

import { useTranslations } from 'next-intl';
import { AssistantMarkdown } from '../ai/AssistantMarkdown';
import { ResultChart } from '../ai/ResultChart';
import { ConfirmationCard } from './ConfirmationCard';
import type { AgentChatMessage } from '@/types/ai-agent';

interface AgentChatMessageProps {
  message: AgentChatMessage;
  onResolveConfirmation: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
  ) => void;
}

/**
 * Renders a single agent turn. Mirrors the AI Assistant's ChatMessage bubble
 * but renders pending write-tool confirmations inline (above the text) and
 * badges write tool calls distinctly from read-only ones.
 */
export function AgentChatMessage({
  message,
  onResolveConfirmation,
}: AgentChatMessageProps) {
  const t = useTranslations('aiAgent');

  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-blue-600 text-white whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%] w-full">
        <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-700/60">
          {/* Pending write-tool confirmations render first so they're actionable
              even before the final text arrives. */}
          {message.confirmations?.map((c) => (
            <ConfirmationCard
              key={c.toolCallId}
              confirmation={c}
              onResolve={onResolveConfirmation}
            />
          ))}

          {message.error ? (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <svg
                className="h-5 w-5 flex-shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
              <span>{message.error}</span>
            </div>
          ) : (
            <>
              {message.content && (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <AssistantMarkdown content={message.content} />
                </div>
              )}
              {message.isStreaming && !message.content && (
                <div className="text-sm text-gray-400 dark:text-gray-500">
                  {t('thinking')}
                </div>
              )}
            </>
          )}

          {/* Tool-call badges. Write calls get an amber badge to signal they
              mutated data; read-only calls stay neutral. */}
          {message.toolsUsed && message.toolsUsed.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.toolsUsed.map((tool, i) => (
                <span
                  key={i}
                  className={
                    tool.isError
                      ? 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                      : tool.isWrite
                        ? 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200'
                        : 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-200 dark:bg-gray-600/60 text-gray-600 dark:text-gray-300'
                  }
                  title={tool.summary}
                >
                  {tool.isWrite && (
                    <svg
                      className="h-2.5 w-2.5 mr-1"
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
                  )}
                  {tool.name.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}

          {/* Charts render below the text, same as the AI Assistant. */}
          {message.charts && message.charts.length > 0 && (
            <div className="mt-3 space-y-3">
              {message.charts.map((chart, i) => (
                <ResultChart key={i} chart={chart} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
