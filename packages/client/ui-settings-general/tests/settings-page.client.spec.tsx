// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsPage } from '../src/client/SettingsPage.tsx'
import type { SettingsPageComponentProps } from '../src/client/shell-contract.ts'
import { en } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(() => {
  cleanup()
})

type Row = { id: string; order: number; label: string }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

function mount({
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  activeId = undefined as string | undefined,
}: {
  rows?: Row[]
  activeId?: string | undefined
} = {}) {
  // Mutable sources standing in for the bound hooks; bump()/select() play a
  // ledger or selection change through the same observable contract.
  let current = rows
  let currentActiveId = activeId
  const listeners = new Set<() => void>()
  const closeSettings = vi.fn()
  const selectSection = vi.fn((id: string) => {
    act(() => {
      currentActiveId = id
      for (const fn of [...listeners]) fn()
    })
  })
  const sectionOwners: unknown[] = []
  const renderSlot = vi.fn(
    ((key: string, owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') {
        sectionOwners.push(owner)
        return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      }
      return SEAT_CONTENT[key]
    }) as SettingsPageComponentProps['renderSlot'],
  )
  const props: SettingsPageComponentProps = {
    useSessions: () => { throw new Error('unused by SettingsPage') },
    useSessionStatus: () => { throw new Error('unused by SettingsPage') },
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: () => { throw new Error('unused by SettingsPage') },
    closeSettings,
    selectSection,
    t: makeTranslate(en),
    useActiveSection: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(currentActiveId)
    },
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsPage {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  const setActive = (next: string | undefined) => {
    act(() => {
      currentActiveId = next
      for (const fn of [...listeners]) fn()
    })
  }
  return { view, renderSlot, closeSettings, selectSection, bump, setActive, listeners, sectionOwners }
}

describe('SettingsPage chrome seats', () => {
  it('names the page and its nav via aria-labelledby pointing at the header seat node', () => {
    mount()
    const page = screen.getByRole('region', { name: 'Settings Title' })
    expect(page.hasAttribute('data-settings-page')).toBe(true)
    const titleId = page.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    const nav = screen.getByRole('navigation')
    expect(nav.getAttribute('aria-labelledby')).toBe(titleId)
  })

  it('leaves settings via document-level Escape while mounted and unhooks the listener', () => {
    const { view, closeSettings } = mount()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(closeSettings).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeSettings).toHaveBeenCalledOnce()
    view.unmount()
    // Ignored after unmount (the listener went with the page).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeSettings).toHaveBeenCalledOnce()
  })

  it('names the close control through the visually-hidden close seat text', () => {
    mount()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot, closeSettings } = mount()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
    screen.getByRole('button', { name: 'Close' }).click()
    expect(closeSettings).toHaveBeenCalledOnce()
  })
})

describe('SettingsPage navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'archived-sessions', order: 40, label: 'Archived sessions' },
        { id: 'contributed', order: 50, label: 'Contributed' },
      ],
    })
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Archived sessions', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The four ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 5)).size).toBe(5)
    expect(glyphs[5]).toBe(glyphs[0])
  })

  it('switches the rendered section on nav click through the shared selection', () => {
    const { selectSection } = mount()
    screen.getByRole('button', { name: 'Models' }).click()
    expect(selectSection).toHaveBeenCalledWith('models')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('renders the shared selection\u2019s section on mount', () => {
    mount({ activeId: 'models' })
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
  })

  it('passes the shell close to the section owner props', () => {
    const { closeSettings, sectionOwners } = mount()
    const owner = sectionOwners.at(-1) as { close: () => void }
    expect(typeof owner.close).toBe('function')
    owner.close()
    expect(closeSettings).toHaveBeenCalledOnce()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount({ activeId: 'models' })
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the source subscriptions on unmount', () => {
    const { view, listeners, setActive } = mount()
    setActive('models')
    expect(listeners.size).toBeGreaterThan(0)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})
