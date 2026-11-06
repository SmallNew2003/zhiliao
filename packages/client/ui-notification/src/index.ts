/**
 * Host registration for the durable notification preferences. The browser
 * half (exports["./client"]) owns the announcement decision, the transport,
 * and the settings row; this half only registers the schema so the Host
 * configuration surface and every browser scope resolve one value.
 *
 * @module @deepseek-ai/dsh-client-ui-notification
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SETTINGS } from './notification-settings.ts'

export {
  DEFAULT_SETTINGS, ENABLED_FIELD, ERROR_FIELD, NOTIFICATION_KINDS, NOTIFICATION_KIND_FIELDS,
  NOTIFICATION_SETTINGS_NAMESPACE, NotificationSettingsSchema, TURN_COMPLETE_FIELD, AWAITING_INPUT_FIELD,
  isKindEnabled,
  type NotificationKind, type NotificationSettings,
} from './notification-settings.ts'

/** Live notification preferences read by the client configuration form. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_SETTINGS.enabled).volatile(),
  turnComplete: z.boolean().default(DEFAULT_SETTINGS.turnComplete).volatile(),
  awaitingInput: z.boolean().default(DEFAULT_SETTINGS.awaitingInput).volatile(),
  error: z.boolean().default(DEFAULT_SETTINGS.error).volatile(),
})

/**
 * Register notification settings for the owning plugin entry.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
