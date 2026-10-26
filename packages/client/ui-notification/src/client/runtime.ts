/**
 * Notification feature runtime: mirrors the durable preferences, owns the
 * transport, renders the announced copy, and opens the session a click
 * names. It holds no React state, so the announcement path runs whether or
 * not a component is mounted.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/runtime
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NotificationBatch } from '../coalescer.ts'
import type { NotificationTrigger } from '../planner.ts'
import {
  DEFAULT_SETTINGS,
  type NotificationKind, type NotificationSettings,
} from '../notification-settings.ts'
import { NotificationCoalescer } from '../coalescer.ts'
import { selectNotifier, type NotificationPermission, type Notifier } from './notifier.ts'
import type { NotificationKey } from './locales.ts'

/** Settings namespace owning this feature's row copy and announced headlines. */
export const SETTINGS_NS = 'settings.notification'

declare module '@deepseek-ai/dsh-client-locale/client' {
  interface LocaleNamespaceMap {
    /** The notification row's copy and the announced headlines. */
    'settings.notification': NotificationKey
  }
}

/** Quiet period after the last trigger before the merged announcement is raised. */
export const COALESCE_WINDOW_MS = 800

/** Dictionary-key prefix carrying one announcement kind's headline copy. */
const KIND_PREFIX: Readonly<Record<NotificationKind, string>> = {
  'turn-complete': 'notification.turnComplete',
  'awaiting-input': 'notification.awaitingInput',
  error: 'notification.error',
}

/**
 * Owns the announcement decision inputs and the transport. The settings
 * mirror is the only value a settings row reads; the durable scope remains
 * the authority and the writer.
 */
export class NotificationRuntime {
  /** Resolved preferences mirrored from the durable scope. */
  readonly settings: SnapshotStore<NotificationSettings> = createSnapshotStore<NotificationSettings>(DEFAULT_SETTINGS)
  /** Latest OS authorization state; `default` until the first read resolves. */
  readonly permission: SnapshotStore<NotificationPermission> = createSnapshotStore<NotificationPermission>('default')

  private readonly notifier: Notifier | undefined
  private readonly coalescer: NotificationCoalescer
  private readonly t: TranslateNS<'settings.notification'>

  /**
   * @param ctx - client root context.
   * @param sessions - Session Controller used for display titles.
   * @param host - durable settings scope bound by the caller's plugin lifecycle.
   * @param openSession - opens one session in the main view.
   */
  constructor(
    ctx: ClientContext,
    private readonly sessions: ISessions,
    host: SettingsScope<NotificationSettings>,
    private readonly openSession: (sessionId: SessionId) => void,
  ) {
    this.t = ctx.locale.bind(SETTINGS_NS)
    this.notifier = selectNotifier()
    this.coalescer = new NotificationCoalescer(COALESCE_WINDOW_MS, (batches) => { this.announce(batches) })
    const adopt = (): void => { this.settings.set(host.getSnapshot().value ?? DEFAULT_SETTINGS) }
    adopt()
    ctx.effect(() => host.subscribe(adopt), 'ui-notification: settings adoption')
    const notifier = this.notifier
    if (notifier === undefined) return
    ctx.effect(() => notifier.subscribe((sessionId) => {
      // The click arrives as a bare string over IPC or the browser event; the
      // branded id is restored at this wire boundary.
      this.openSession(sessionId as SessionId)
    }), 'ui-notification: click routing')
    void this.refreshPermission(notifier)
  }

  /**
   * Record one earned trigger; the merge window decides when it is announced.
   * @param trigger - announcement earned by one session.
   */
  push(trigger: NotificationTrigger): void {
    this.coalescer.push(trigger)
  }

  /** Flush and drop the pending merge window. */
  dispose(): void {
    this.coalescer.dispose()
  }

  private async refreshPermission(notifier: Notifier): Promise<void> {
    this.permission.set(await notifier.permission())
  }

  /**
   * Render and present one merged announcement per kind. Copy follows the
   * active locale; the click target is the batch's first session.
   * @param batches - merged batches in the fixed kind order.
   */
  private announce(batches: readonly NotificationBatch[]): void {
    if (this.notifier === undefined) return
    for (const batch of batches) {
      const sessionId = batch.sessionIds[0]
      void this.notifier.show({
        title: this.headline(batch),
        body: this.detail(batch, sessionId),
        ...(sessionId !== undefined ? { sessionId } : {}),
      }).catch((error: unknown) => {
        // A refused or failed presentation is not actionable here: the next
        // trigger retries, and the settings row already shows the permission.
        console.warn('ui-notification: presentation failed', error)
      })
    }
  }

  /**
   * @param batch - one merged announcement.
   * @returns the headline, singular when the batch carries one session.
   */
  private headline(batch: NotificationBatch): string {
    const prefix = KIND_PREFIX[batch.kind]
    return batch.sessionIds.length === 1
      ? this.t(`${prefix}.one` as NotificationKey)
      : this.t(`${prefix}.many` as NotificationKey, { count: batch.sessionIds.length })
  }

  /**
   * @param batch - one merged announcement.
   * @param sessionId - the session the click opens.
   * @returns the detail line: the session title for one, a prompt for many.
   */
  private detail(batch: NotificationBatch, sessionId: SessionId | undefined): string {
    if (batch.sessionIds.length !== 1 || sessionId === undefined) return this.t('notification.body.many')
    return this.t('notification.body.one', { title: this.titleOf(sessionId) })
  }

  /**
   * @param sessionId - session whose display title is wanted.
   * @returns the stored display title, or the id when the list has none yet.
   */
  private titleOf(sessionId: SessionId): string {
    const summary = this.sessions.list.getSnapshot().byId[sessionId]
    return summary?.displayTitle ?? sessionId
  }
}
