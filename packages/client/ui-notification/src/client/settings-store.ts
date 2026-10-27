/**
 * Notification row slot store: a mirror of the settings scope snapshot. The
 * plugin's scope subscription is the only writer; the row reads via
 * props.useStore.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/settings-store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { DEFAULT_SETTINGS, type NotificationSettings } from '../notification-settings.ts'

/** Store state mirrored from the notification settings scope. */
export interface NotificationRowState {
  /** Resolved preferences the row renders; replaced whole, so its fields stay readonly. */
  settings: NotificationSettings
  /** Scope revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type NotificationRowActions = {
  sync: (draft: NotificationRowState, settings: NotificationSettings, revision: number) => void
}

/**
 * Declares the notification row state and write surface.
 * @returns the store handle.
 */
export function createNotificationRowStore(): EngineStoreHandle<NotificationRowState, NotificationRowActions> {
  return defineStore({
    init: (): NotificationRowState => ({ settings: DEFAULT_SETTINGS, revision: -1 }),
    actions: {
      sync: (d, settings: NotificationSettings, revision: number) => {
        if (revision <= d.revision) return
        d.settings = settings
        d.revision = revision
      },
    },
  })
}
