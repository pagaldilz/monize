'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ConfirmationRequest } from '@/types/ai-agent';

interface ConfirmationCardProps {
  confirmation: ConfirmationRequest;
  onResolve: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
  ) => void;
}

/**
 * Renders a pending write-tool confirmation: the tool name, the proposed
 * inputs, the dryRun preview, and Approve / Deny buttons.
 *
 * Once resolved (status !== 'pending') the buttons are replaced with the
 * outcome badge and the card becomes read-only.
 */
export function ConfirmationCard({
  confirmation,
  onResolve,
}: ConfirmationCardProps) {
  const t = useTranslations('aiAgent');
  const [busy, setBusy] = useState(false);
  const resolved = confirmation.status && confirmation.status !== 'pending';

  const handle = (approved: boolean) => {
    setBusy(true);
    onResolve(confirmation.messageId, confirmation.toolCallId, approved);
  };

  return (
    <div className="my-2 rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-amber-200 dark:border-amber-800/60 flex items-center gap-2">
        <svg
          className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0"
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
        <span className="text-xs font-semibold text-amber-800 dark:text-amber-200">
          {t('confirmation.title', { tool: confirmation.toolName.replace(/_/g, ' ') })}
        </span>
      </div>

      {confirmation.preview && (
        <pre className="px-3 py-2 text-xs text-amber-900 dark:text-amber-100 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-amber-50/60 dark:bg-black/10">
          {confirmation.preview}
        </pre>
      )}

      <div className="px-3 py-2 flex items-center gap-2">
        {resolved ? (
          <span
            className={
              confirmation.status === 'approved'
                ? 'text-xs font-medium text-green-700 dark:text-green-400'
                : 'text-xs font-medium text-red-700 dark:text-red-400'
            }
          >
            {confirmation.status === 'approved'
              ? t('confirmation.approved')
              : t('confirmation.denied')}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => handle(true)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 transition-colors"
            >
              {t('confirmation.approve')}
            </button>
            <button
              type="button"
              onClick={() => handle(false)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 disabled:opacity-50 transition-colors"
            >
              {t('confirmation.deny')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
