/**
 * Notification preference row registered into the General section item slot:
 * a master switch, one switch per announcement kind, and the OS permission
 * state. Registered by this package — the notification feature owns its own
 * settings surface. Every switch writes the durable section; nothing is
 * held in component state.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/NotificationRow
 */

import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { NotificationKey } from './locales.ts'
import type { NotificationPermission } from './notifier.ts'
import type { createNotificationRowStore } from './settings-store.ts'
import {
  ENABLED_FIELD, NOTIFICATION_KIND_FIELDS,
  type NotificationKind, type NotificationSettings,
} from '../notification-settings.ts'
import css from './NotificationRow.module.css'

/** One announcement kind's row copy keys. */
const KIND_ROWS: readonly { kind: NotificationKind; labelKey: NotificationKey; hintKey: NotificationKey }[] = [
  { kind: 'turn-complete', labelKey: 'row.turnComplete', hintKey: 'row.turnCompleteHint' },
  { kind: 'awaiting-input', labelKey: 'row.awaitingInput', hintKey: 'row.awaitingInputHint' },
  { kind: 'error', labelKey: 'row.error', hintKey: 'row.errorHint' },
]

/** Injected business face: the preference write and the permission state. */
export interface NotificationRowInjected {
  readonly hooks: { readonly permission: HostObservable<NotificationPermission> }
  /** @param field - settings field carrying the switch. @param value - requested state. */
  readonly setField: (field: string, value: boolean) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type NotificationRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createNotificationRowStore>>
  & PropsLocale<'settings.notification'> & InjectFace<NotificationRowInjected>

/**
 * Render the notification preference row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function NotificationRow({ t, setField, useStore, usePermission }: NotificationRowComponentProps): ReactNode {
  const settings = useStore(s => s.settings)
  const permission = usePermission(value => value)
  const enabled = settings.enabled
  const valueOf = (kind: NotificationKind): boolean =>
    settings[NOTIFICATION_KIND_FIELDS[kind] as keyof NotificationSettings]
  return (
    <div className={css.group}>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('row.title')}</div>
          <div className={css.desc}>{t('row.description')}</div>
        </div>
        <Switch
          checked={enabled}
          onChange={(next) => { setField(ENABLED_FIELD, next) }}
          label={t('row.enabled')}
        />
      </div>
      {KIND_ROWS.map(({ kind, labelKey, hintKey }) => (
        <div className={css.subRow} key={kind}>
          <div className={css.rowText}>
            <div className={css.subTitle}>{t(labelKey)}</div>
            <div className={css.desc}>{t(hintKey)}</div>
          </div>
          <Switch
            checked={valueOf(kind)}
            onChange={(next) => { setField(NOTIFICATION_KIND_FIELDS[kind], next) }}
            label={t(labelKey)}
            disabled={!enabled}
            title={enabled ? undefined : t('row.enabled')}
          />
        </div>
      ))}
      {permission !== 'granted' && (
        <div className={css.permissionRow}>
          <span className={css.desc}>
            {permission === 'unsupported'
              ? t('row.permissionUnsupported')
              : permission === 'denied' ? t('row.permissionDenied') : t('row.permissionDefault')}
          </span>
        </div>
      )}
    </div>
  )
}
