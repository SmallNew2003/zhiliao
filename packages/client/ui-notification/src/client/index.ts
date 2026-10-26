/**
 * Browser half of the notification feature. Owns the announcement decision
 * (the shell overlay bridge), the transport (Electron shell or browser
 * Notification API), and the preference row registered into the settings
 * General section. The Host half only registers the durable schema.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ctx.locale and ctx.slots Context merges.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NotificationKey } from './locales.ts'
import type { NotificationBridgeInjected } from './NotificationBridge.tsx'
import { NotificationBridge } from './NotificationBridge.tsx'
import type { NotificationRowInjected } from './NotificationRow.tsx'
import { NotificationRow } from './NotificationRow.tsx'
import { NotificationRuntime, SETTINGS_NS } from './runtime.ts'
import { createNotificationRowStore } from './settings-store.ts'
import { en, zh } from './locales.ts'
import { NOTIFICATION_SETTINGS_NAMESPACE, type NotificationSettings } from '../notification-settings.ts'

export { NotificationRuntime, SETTINGS_NS, COALESCE_WINDOW_MS } from './runtime.ts'
export type { NotificationBridgeComponentProps, NotificationBridgeInjected } from './NotificationBridge.tsx'
export type { NotificationRowComponentProps, NotificationRowInjected } from './NotificationRow.tsx'
export type { NotificationKey } from './locales.ts'
export type { NotificationPermission, Notifier, NotificationShowRequest } from './notifier.ts'
export type {
  DesktopGlobal, DesktopNotificationBridge, DesktopNotificationPermission, DesktopNotificationRequest,
} from './desktop-bridge.ts'

/** Optional collaborator: workspace navigation, present only when ui-workspace is composed. */
interface SessionOpener {
  /**
   * @param sessionId - session to show in the main view.
   */
  openSession(sessionId: SessionId): void
}

/** Settings namespace owning this feature's row copy and announced headlines. */
const NS = SETTINGS_NS

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The notification row's copy and the announced headlines. */
    'settings.notification': NotificationKey
  }
}

/** Required services: slots and locale for the surfaces, sessions for titles, settingsScope for preferences. */
export const inject = ['slots', 'locale', 'sessions', 'settingsScope']

/**
 * Client plugin body: mirror the durable preferences, select the transport,
 * and register the preference row and the global announcement bridge.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as ISessions
  const openSession = (sessionId: SessionId): void => {
    // ui-workspace is an optional collaborator: without it a click still
    // focuses the window, it just cannot pick the conversation.
    const workspace = ctx.get('uiWorkspace') as SessionOpener | undefined
    workspace?.openSession(sessionId)
  }
  const host = ctx.settingsScope.bind<NotificationSettings>({ namespace: NOTIFICATION_SETTINGS_NAMESPACE })
  const runtime = new NotificationRuntime(ctx, sessions, host, openSession)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notification: dictionaries')

  const store = createNotificationRowStore()
  let bound: BoundActions<typeof store> | undefined
  const rowInjected = (actions: BoundActions<typeof store>): NotificationRowInjected => {
    bound = actions
    // Re-sync from the runtime so no adoption is lost between registration
    // and first render (the store's revision guard drops stale duplicates).
    actions.sync(runtime.settings.getSnapshot(), host.getSnapshot().revision ?? 0)
    return {
      hooks: { permission: runtime.permission },
      setField: (field, value) => { void host.set(field, value) },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'notification',
    order: 12,
    store,
    locale: NS,
    inject: rowInjected,
  }, NotificationRow))
  ctx.effect(() => host.subscribe(() => {
    bound?.sync(runtime.settings.getSnapshot(), host.getSnapshot().revision ?? 0)
  }), 'ui-notification: settings row mirror')

  const bridgeInjected = (): NotificationBridgeInjected => ({
    hooks: { settings: runtime.settings },
    push: (trigger) => { runtime.push(trigger) },
  })
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'notification',
    locale: NS,
    inject: bridgeInjected,
  }, NotificationBridge)), 'ui-notification: announcement bridge')

  ctx.effect(() => () => { runtime.dispose() }, 'ui-notification: lifetime')
}
