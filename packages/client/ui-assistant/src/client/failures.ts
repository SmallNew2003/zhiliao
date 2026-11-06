/** Locale keys for assistant task failure reasons. */

import type { AssistantLocale } from './locales.ts'

/** Failure copy selected by a persisted or tool-result failure code. */
export type AssistantFailureKey = Extract<keyof AssistantLocale, `failure${string}`>

/**
 * Map a Host failure code to its localized explanation.
 * @param code - persisted task failure code or create_task error code.
 * @returns the matching locale key, or the generic failure key.
 */
export function failureKey(code: string | undefined): AssistantFailureKey {
  switch (code) {
    case 'not_started': return 'failureNotStarted'
    case 'interrupted': return 'failureInterrupted'
    case 'turn_error':
    case 'aborted':
    case 'error': return 'failureTurnError'
    case 'session_create_failed':
    case 'assistant_session_unavailable':
    case 'worker_preset_unavailable':
    case 'workspace_unavailable': return 'failureExecution'
    case 'prompt_rejected':
    case 'prompt_empty':
    case 'prompt_too_large': return 'failurePrompt'
    case 'task_store_failed': return 'failureStore'
    case 'quota_exceeded': return 'failureQuota'
    case 'workspace_not_registered':
    case 'workspace_scope_denied': return 'failureScope'
    case 'not_an_assistant': return 'failureNotAllowed'
    default: return 'failureUnknown'
  }
}
