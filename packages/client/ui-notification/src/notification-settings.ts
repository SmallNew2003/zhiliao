/**
 * Durable user-settings section owned by the notification feature. The schema
 * is the single authority for every default, so the Host configuration
 * surface and the browser scope resolve one value without a second constant.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/notification-settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace registered by this package. */
export const NOTIFICATION_SETTINGS_NAMESPACE = 'ui-notification'

/** Field carrying the master switch. */
export const ENABLED_FIELD = 'enabled'

/** Field carrying the turn-completion announcement switch. */
export const TURN_COMPLETE_FIELD = 'turnComplete'

/** Field carrying the pending-interaction announcement switch. */
export const AWAITING_INPUT_FIELD = 'awaitingInput'

/** Field carrying the agent-loop failure announcement switch. */
export const ERROR_FIELD = 'error'

/**
 * Why a notification is raised. `turn-complete` covers a session that stopped
 * outside the main view, `awaiting-input` a domain request waiting for the
 * user, and `error` an agent-loop failure.
 */
export type NotificationKind = 'turn-complete' | 'awaiting-input' | 'error'

/** Every announcement kind, in the order the settings rows render. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['turn-complete', 'awaiting-input', 'error']

/** Resolved notification preferences. */
export interface NotificationSettings {
  /** Master switch; `false` silences every kind without losing the per-kind choices. */
  readonly enabled: boolean
  /** Announce a session that stopped while its conversation was not on screen. */
  readonly turnComplete: boolean
  /** Announce a domain request waiting for the user. */
  readonly awaitingInput: boolean
  /** Announce an agent-loop failure. */
  readonly error: boolean
}

/** Preferences applied when the user-settings document has no section. */
export const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  turnComplete: true,
  awaitingInput: true,
  error: true,
}

/** Durable notification schema; also the wire envelope the browser scope validates against. */
export const NotificationSettingsSchema: z<NotificationSettings> = z.object({
  [ENABLED_FIELD]: z.boolean().default(DEFAULT_SETTINGS.enabled),
  [TURN_COMPLETE_FIELD]: z.boolean().default(DEFAULT_SETTINGS.turnComplete),
  [AWAITING_INPUT_FIELD]: z.boolean().default(DEFAULT_SETTINGS.awaitingInput),
  [ERROR_FIELD]: z.boolean().default(DEFAULT_SETTINGS.error),
})

/** Settings field name carrying one announcement kind. */
export const NOTIFICATION_KIND_FIELDS: Readonly<Record<NotificationKind, string>> = {
  'turn-complete': TURN_COMPLETE_FIELD,
  'awaiting-input': AWAITING_INPUT_FIELD,
  error: ERROR_FIELD,
}

/**
 * Whether one kind is announced under the supplied preferences.
 * @param settings - resolved preferences.
 * @param kind - announcement kind under test.
 * @returns whether the kind survives both the master switch and its own switch.
 */
export function isKindEnabled(settings: NotificationSettings, kind: NotificationKind): boolean {
  if (!settings.enabled) return false
  return settings[NOTIFICATION_KIND_FIELDS[kind] as keyof NotificationSettings]
}
