/**
 * Pure translation from Session UI status transitions to notification
 * triggers. The function owns no timers, no transport, and no DOM, so the
 * decision surface is testable without a client runtime.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/planner
 */

import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isKindEnabled, type NotificationKind, type NotificationSettings } from './notification-settings.ts'

/** One announcement a single session earned between two status snapshots. */
export interface NotificationTrigger {
  /** Why the announcement is raised. */
  readonly kind: NotificationKind
  /** Session the announcement belongs to; the notification opens it on click. */
  readonly sessionId: SessionId
}

/**
 * Derive the announcements earned between two Session status snapshots.
 *
 * `turn-complete` requires the session to have stopped AND still be
 * unacknowledged outside the main view, which is exactly
 * {@link SessionStatus.completionUnread}; a stop the user is already looking
 * at never announces. A failed turn reports `error` instead, so one stop
 * never raises both. `awaiting-input` fires on the arrival of a domain
 * request, and `error` on every new agent-loop failure message.
 *
 * @param previous - status snapshot before the transition; empty on the first observation.
 * @param next - status snapshot after the transition.
 * @param settings - resolved notification preferences.
 * @returns the earned triggers, ordered by session id for a stable merge.
 */
export function detectTriggers(
  previous: SessionStatusSnapshot,
  next: SessionStatusSnapshot,
  settings: NotificationSettings,
): readonly NotificationTrigger[] {
  if (!settings.enabled) return []
  const triggers: NotificationTrigger[] = []
  for (const [sessionId, status] of next) {
    const before = previous.get(sessionId)
    const wasRunning = before?.running === true
    const error = status.lastAgentError
    if (isKindEnabled(settings, 'error') && error !== null && error !== before?.lastAgentError) {
      triggers.push({ kind: 'error', sessionId })
      // A failed turn is announced once, as an error; the completion
      // announcement below is skipped for it.
      continue
    }
    if (isKindEnabled(settings, 'turn-complete')
      && wasRunning && status.running === false && status.completionUnread && error === null) {
      triggers.push({ kind: 'turn-complete', sessionId })
      continue
    }
    if (isKindEnabled(settings, 'awaiting-input')
      && before?.pendingInteraction === undefined && status.pendingInteraction !== undefined) {
      triggers.push({ kind: 'awaiting-input', sessionId })
    }
  }
  // Session ids are unique, so the comparator never sees an equal pair.
  return triggers.sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1))
}
