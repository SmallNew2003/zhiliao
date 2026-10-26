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
import { NOTIFICATION_SETTINGS_NAMESPACE, NotificationSettingsSchema } from './notification-settings.ts'

export {
  DEFAULT_SETTINGS, ENABLED_FIELD, ERROR_FIELD, NOTIFICATION_KINDS, NOTIFICATION_KIND_FIELDS,
  NOTIFICATION_SETTINGS_NAMESPACE, NotificationSettingsSchema, TURN_COMPLETE_FIELD, AWAITING_INPUT_FIELD,
  isKindEnabled,
  type NotificationKind, type NotificationSettings,
} from './notification-settings.ts'
export { detectTriggers, type NotificationTrigger } from './planner.ts'
export { NotificationCoalescer, type CoalescerTimers, type NotificationBatch } from './coalescer.ts'

/**
 * Register the durable notification section when the optional settings
 * service is composed. Registration is refused when a stored section already
 * fails the schema, so an externally edited document cannot strand a running
 * owner on defaults the user never chose.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NOTIFICATION_SETTINGS_NAMESPACE, NotificationSettingsSchema)
  })
}
