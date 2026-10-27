// @vitest-environment jsdom
/**
 * The preference row: the master switch gates the per-kind switches, each
 * switch writes its own settings field, and the OS permission state selects
 * the notice shown beneath them.
 */

import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { NotificationRow } from '../src/client/NotificationRow.tsx'
import { createNotificationRowStore } from '../src/client/settings-store.ts'
import { DEFAULT_SETTINGS, type NotificationSettings } from '../src/notification-settings.ts'
import type { NotificationPermission } from '../src/client/notifier.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'row.title': '系统通知',
  'row.description': '任务需要你时，在系统通知中心提醒',
  'row.enabled': '启用系统通知',
  'row.turnComplete': '会话完成时',
  'row.turnCompleteHint': '会话在后台跑完时提醒',
  'row.awaitingInput': '等待审批或回答时',
  'row.awaitingInputHint': '需要你操作才能继续时提醒',
  'row.error': '出错时',
  'row.errorHint': '会话执行失败时提醒',
  'row.permissionDenied': '系统通知权限已被拒绝',
  'row.permissionDefault': '首次通知时系统会请求权限',
  'row.permissionUnsupported': '当前环境不支持系统通知',
}

/** Component props, read from the component so the seat types stay in step. */
type RowProps = Parameters<typeof NotificationRow>[0]

/** The row reads no Session or Workspace hook; a use throws instead of silently passing. */
const unusedHook = (): never => { throw new Error('the notification row does not consume this hook') }

function mount(settings: Partial<NotificationSettings> = {}, permission: NotificationPermission = 'granted') {
  const store = createNotificationRowStore().create()
  store.actions.sync({ ...DEFAULT_SETTINGS, ...settings }, 0)
  let state = permission
  const usePermission: RowProps['usePermission'] = selector => selector(state)
  const setField = vi.fn()
  const props: RowProps = {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    usePermission,
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    useWorkspaces: unusedHook,
    useSessionRetainInfo: unusedHook,
    usePanelInfo,
    useResource,
    t: (key: string) => COPY[key] ?? key,
    setField,
  }
  render(<NotificationRow {...props} />)
  return { setField, setPermission: (next: NotificationPermission) => { state = next } }
}

const switchByName = (name: string): HTMLElement => screen.getByRole('switch', { name })

describe('NotificationRow', () => {
  it('shows every announcement kind checked while the master switch is on', () => {
    mount()
    expect(switchByName('启用系统通知').getAttribute('aria-checked')).toBe('true')
    for (const label of ['会话完成时', '等待审批或回答时', '出错时']) {
      expect(switchByName(label).getAttribute('aria-checked')).toBe('true')
      expect(switchByName(label).hasAttribute('disabled')).toBe(false)
    }
  })

  it('disables the per-kind switches and explains why while the master switch is off', () => {
    mount({ enabled: false })
    expect(switchByName('启用系统通知').getAttribute('aria-checked')).toBe('false')
    for (const label of ['会话完成时', '等待审批或回答时', '出错时']) {
      expect(switchByName(label).hasAttribute('disabled')).toBe(true)
      expect(switchByName(label).getAttribute('title')).toBe('启用系统通知')
    }
  })

  it('writes the master switch through the settings scope', () => {
    const { setField } = mount()
    fireEvent.click(switchByName('启用系统通知'))
    expect(setField).toHaveBeenCalledWith('enabled', false)
  })

  it('writes each announcement kind through its own settings field', () => {
    const { setField } = mount({ turnComplete: false, awaitingInput: false, error: false })
    fireEvent.click(switchByName('会话完成时'))
    fireEvent.click(switchByName('等待审批或回答时'))
    fireEvent.click(switchByName('出错时'))
    expect(setField.mock.calls).toEqual([['turnComplete', true], ['awaitingInput', true], ['error', true]])
  })

  it('shows no permission notice while the OS has authorized', () => {
    mount({}, 'granted')
    expect(screen.queryByText('系统通知权限已被拒绝')).toBeNull()
    expect(screen.queryByText('首次通知时系统会请求权限')).toBeNull()
    expect(screen.queryByText('当前环境不支持系统通知')).toBeNull()
  })

  it('explains a denied permission, which only system settings can reverse', () => {
    mount({}, 'denied')
    expect(screen.getByText('系统通知权限已被拒绝')).toBeTruthy()
  })

  it('explains an undecided permission', () => {
    mount({}, 'default')
    expect(screen.getByText('首次通知时系统会请求权限')).toBeTruthy()
  })

  it('explains an unsupported environment', () => {
    mount({}, 'unsupported')
    expect(screen.getByText('当前环境不支持系统通知')).toBeTruthy()
  })
})
