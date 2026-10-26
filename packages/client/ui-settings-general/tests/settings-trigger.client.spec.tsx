// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsTriggerComponentProps } from '../src/client/shell-contract.ts'
import { SettingsTrigger } from '../src/client/SettingsTrigger.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { DesktopUpdateView } from '../src/client/desktop-update-bridge.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
}

type ConnectionSnapshot = Parameters<Parameters<SettingsTriggerComponentProps['useConnectionState']>[0]>[0]
type AttentionSnapshot = Parameters<Parameters<SettingsTriggerComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()

function mount({
  wide = true,
  dictionary = en,
  connectionState = 'connected',
  desktopUpdate = { failed: false, opening: false },
  onboardingActive = true,
  mainView = true,
  panelId = null,
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: {
  wide?: boolean
  dictionary?: typeof en | typeof zh
  connectionState?: ConnectionSnapshot
  desktopUpdate?: DesktopUpdateView
  onboardingActive?: boolean
  mainView?: boolean
  panelId?: string | null
  steps?: Step[]
} = {}) {
  let currentConnectionState = connectionState
  let currentPanelId = panelId
  const connectionListeners = new Set<() => void>()
  const reconnect = vi.fn()
  const openSettings = vi.fn()
  const openSettingsSection = vi.fn()
  const renderSlot = vi.fn(
    (key: string, _owner: unknown, _opts?: { only?: string }) => SEAT_CONTENT[key],
  )
  const activeId = SessionId('active-session')
  const sessions: SessionListState = {
    ids: [activeId],
    byId: {
      [activeId]: {
        id: activeId,
        displayTitle: 'Active',
        blank: onboardingActive,
        running: false,
        retainedBy: mainView ? { mainView: 1 } : {},
        updatedAt: 0,
      },
    },
    phase: 'ready', subagentsByParent: {}, jobsBySession: {},
  }
  const props: SettingsTriggerComponentProps = {
    useSessions: select => select(sessions),
    useSessionStatus: selector => selector(noAttention),
    usePanelInfo: selector => selector({ activePanelId: currentPanelId as never }),
    useResource, useSessionRetainInfo: () => undefined,
    useWorkspaces: () => { throw new Error('unused by SettingsTrigger') },
    wide,
    reconnect,
    openSettings,
    openSettingsSection,
    openDesktopUpdate: () => {},
    useDesktopUpdate: select => select(desktopUpdate),
    t: makeTranslate(dictionary),
    useConnectionState: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener) }
      }, [])
      return select(currentConnectionState)
    },
    useOnboardingSteps: select => select(steps),
    renderSlot: renderSlot as SettingsTriggerComponentProps['renderSlot'],
  }
  const view = render(<SettingsTrigger {...props} />)
  const setConnectionState = (next: typeof currentConnectionState) => {
    act(() => {
      currentConnectionState = next
      for (const fn of [...connectionListeners]) fn()
    })
  }
  const setPanelId = (next: string | null) => {
    act(() => {
      currentPanelId = next
      view.rerender(<SettingsTrigger {...props} />)
    })
  }
  const setDesktopUpdate = (next: DesktopUpdateView) => {
    desktopUpdate = next
    view.rerender(<SettingsTrigger {...props} />)
  }
  return { view, renderSlot, reconnect, openSettings, openSettingsSection, setConnectionState, setDesktopUpdate, setPanelId }
}

describe('SettingsTrigger', () => {
  it.each([
    { column: 'expanded English', wide: true, dictionary: en, name: 'Settings' },
    { column: 'collapsed English', wide: false, dictionary: en, name: 'Settings' },
    { column: 'expanded Chinese', wide: true, dictionary: zh, name: '设置' },
    { column: 'collapsed Chinese', wide: false, dictionary: zh, name: '设置' },
  ])('uses the locale name and selects the settings page for the $column trigger', ({
    wide, dictionary, name,
  }) => {
    const { renderSlot, openSettings } = mount({ wide, dictionary })
    const trigger = screen.getByRole('button', { name })
    expect(trigger.getAttribute('aria-label')).toBe(name)
    expect(trigger.getAttribute('aria-current')).toBeNull()
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide })
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    expect(openSettings).toHaveBeenCalledWith(null)
  })

  it('marks the trigger current while the settings page is selected', () => {
    const mounted = mount()
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBeNull()
    mounted.setPanelId('settings')
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page')
    mounted.setPanelId(null)
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBeNull()
  })

  it('hands the current panel to the navigation when already on settings', () => {
    const mounted = mount({ panelId: 'plugins' })
    screen.getByRole('button', { name: 'Settings' }).click()
    expect(mounted.openSettings).toHaveBeenCalledWith('plugins')
  })

  it('shows installation instead of expected backend reconnection and restores connection feedback after failure', () => {
    const presentation = { phase: 'installing' as const, version: '1.0.1' }
    const f = mount({ dictionary: zh, connectionState: 'connecting',
      desktopUpdate: { failed: false, opening: false, presentation } })
    expect(screen.getByRole('button', { name: '正在准备重启…' })).toBeTruthy()
    expect(screen.queryByText('重新连接中')).toBeNull()
    f.setDesktopUpdate({ failed: false, opening: false,
      presentation: { phase: 'error', version: presentation.version, failure: 'install' } })
    expect(screen.queryByRole('button', { name: '重试更新' })).toBeNull()
    expect(screen.getByText('重新连接中')).toBeTruthy()
  })

  it('shows outage, retry progress, and a two-second recovery confirmation', () => {
    vi.useFakeTimers()
    const mounted = mount()
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()

    mounted.setConnectionState('disconnected')
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(mounted.reconnect).toHaveBeenCalledOnce()

    mounted.setConnectionState('connecting')
    expect(screen.getByRole('button', { name: 'Reconnecting, reconnect now' }).textContent)
      .toContain('Reconnecting...')

    // An attempt that resolves instantly still shows the connecting pill for
    // its 800ms minimum before the confirmation replaces it.
    mounted.setConnectionState('connected')
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { vi.advanceTimersByTime(800) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window is measured from visibility, not the transition.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window closes at 2s, then the pill fades for 150ms.
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the attempt label steady through the hold and confirms for the full window', () => {
    vi.useFakeTimers()
    const mounted = mount({ dictionary: zh })
    mounted.setConnectionState('connecting')
    const attempt = screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' })
    expect(attempt.textContent).toContain('重新连接中')
    fireEvent.click(attempt)
    expect(mounted.reconnect).toHaveBeenCalledOnce()
    expect(attempt.textContent).toContain('重新连接中')
    // An attempt that resolves mid-hold keeps its label until the hold ends.
    act(() => { vi.advanceTimersByTime(100) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' }).textContent)
      .toContain('重新连接中')
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    // The full two-second confirmation follows the delayed appearance.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('skips the hold when the attempt already stayed visible long enough', () => {
    vi.useFakeTimers()
    const mounted = mount()
    mounted.setConnectionState('connecting')
    act(() => { vi.advanceTimersByTime(800) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_000) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the reconnect indicator out of the collapsed rail', () => {
    mount({ wide: false, connectionState: 'disconnected' })
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()
  })
})

describe('SettingsTrigger onboarding', () => {
  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })
  })

  it('forwards a step\u2019s openSection to the shell navigation with the current panel', () => {
    const { renderSlot, openSettingsSection } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    act(() => {
      (first?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(openSettingsSection).toHaveBeenCalledWith('models', null)
  })

  it('keeps onboarding active before a main Session is retained', () => {
    const { renderSlot } = mount({ mainView: false })

    expect(renderSlot.mock.calls.some(call => call[0] === 'settings.onboarding')).toBe(true)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('mounts no step once onboarding is inactive', () => {
    const { renderSlot } = mount({ onboardingActive: false })
    expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')).toHaveLength(0)
  })
})
