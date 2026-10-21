// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MemoryBankStats, MemoryBankSummary } from '@deepseek-ai/dsh-host-memory-controller/types'
import { MemoryBrowserPage } from '../src/client/MemoryBrowserPage.tsx'
import type { MemoryBrowserPageProps } from '../src/client/MemoryBrowserPage.tsx'
import type { MemoryBrowserState } from '../src/client/memory-store.ts'
import { en, zh, type MemoryBrowserLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const translate = (dict: typeof en): MemoryBrowserPageProps['t'] => ((key: MemoryBrowserLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    dict[key],
  )) as MemoryBrowserPageProps['t']

const t = translate(en)

const IDLE: MemoryBrowserState = {
  status: 'idle',
  problem: null,
  banks: [],
  bankId: null,
  loading: 'none',
  stats: null,
  pages: [],
  openPage: null,
  pageLoading: false,
  query: '',
  searching: false,
  hits: [],
  total: 0,
  searchProblem: null,
}

/** Text of one element, with its nested nodes' text folded in. */
function textOf(testId: string): string {
  return document.querySelector(`[${testId}]`)?.textContent ?? ''
}

function bank(overrides: Partial<MemoryBankSummary> = {}): MemoryBankSummary {
  return {
    bankId: 'coding-agent::zhiliao',
    name: 'zhiliao',
    factCount: 522,
    lastWriteAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ...overrides,
  }
}

function stats(overrides: Partial<MemoryBankStats> = {}): MemoryBankStats {
  return {
    bankId: 'coding-agent::zhiliao',
    totalNodes: 522,
    totalLinks: 9963,
    totalDocuments: 16,
    nodesByFactType: [{ label: 'experience', count: 202 }, { label: 'observation', count: 192 }],
    linksByLinkType: [{ label: 'temporal', count: 4925 }],
    pendingOperations: 0,
    failedOperations: 0,
    ...overrides,
  }
}

function renderPanel(state: Partial<MemoryBrowserState> = {}, tSeat: MemoryBrowserPageProps['t'] = t) {
  const store = createSnapshotStore<MemoryBrowserState>({ ...IDLE, ...state })
  const actions = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    selectBank: vi.fn(),
    editQuery: vi.fn(),
    runSearch: vi.fn(),
    openPage: vi.fn(),
    closePage: vi.fn(),
    dismissProblem: vi.fn(),
  }
  const props = {
    t: tSeat,
    ...actions,
    useMemoryBrowser: bindSnapshotSelector(store),
  } as unknown as MemoryBrowserPageProps
  render(<MemoryBrowserPage {...props} />)
  return {
    store,
    actions,
    set: (next: Partial<MemoryBrowserState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) },
    /** The bank view is reached by picking a bank, exactly as a person does. */
    openBank: (name = 'zhiliao') => {
      fireEvent.click(screen.getByText(name))
      return actions
    },
  }
}

describe('MemoryBrowserPage', () => {
  it('asks the store once mounted and reads the Host only through the actions', () => {
    const { actions } = renderPanel({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('lists the banks with their fact counts, last write, and a count line', () => {
    const { actions } = renderPanel({
      status: 'ready',
      banks: [bank(), { bankId: 'b', name: 'blank', factCount: 0 }],
    })
    expect(screen.getByText(en.bankCount.replace('{count}', '2'))).toBeTruthy()
    expect(textOf('data-memory-bank="coding-agent::zhiliao"')).toContain('522 facts')
    expect(textOf('data-memory-bank="coding-agent::zhiliao"')).toContain('3h')
    // A bank nothing has written to says so in words rather than showing a gap.
    expect(textOf('data-memory-bank="b"')).toContain(en.neverWritten)
    fireEvent.click(screen.getByText('blank'))
    expect(actions.selectBank).toHaveBeenCalledWith('b')
  })

  it('shows an empty state when the deployment retains no banks', () => {
    renderPanel({ status: 'ready', banks: [] })
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('says which condition the Host classified rather than showing a blank panel', () => {
    const { actions, set } = renderPanel({
      status: 'unavailable',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      problem: { kind: 'unavailable', reason: 'unreachable', detail: 'the daemon did not answer' },
    })
    const note = screen.getByRole('status')
    expect(note.dataset.memoryProblem).toBe('unreachable')
    expect(note.textContent).toContain(en.reasonUnreachable)
    expect(note.textContent).toContain('the daemon did not answer')
    // A classified condition has nothing to retry: the Host, not this panel, is what to fix.
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    set({ problem: { kind: 'error', detail: 'socket closed' } })
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.dismissProblem).toHaveBeenCalledTimes(1)
    expect(actions.refresh).toHaveBeenCalledTimes(1)
  })

  it('words a transport failure with its own message instead of repeating it as detail', () => {
    renderPanel({ status: 'error', problem: { kind: 'error', detail: 'socket closed' } })
    const note = screen.getByRole('status')
    expect(note.dataset.memoryProblem).toBe('error')
    // The detail block is where a classified diagnostic would go; a transport
    // failure has none, so the message appears once.
    expect(document.querySelector('[class*="problemDetail"]')).toBeNull()
    expect(note.querySelector('[class*="problemText"]')?.textContent).toBe('socket closed')
  })

  it('opens a bank, asks the store to select it, and leaves the list', () => {
    const { actions, openBank } = renderPanel({
      status: 'ready',
      banks: [bank(), bank({ bankId: 'b', name: 'other' })],
      bankId: 'coding-agent::zhiliao',
    })
    openBank('other')
    expect(actions.selectBank).toHaveBeenCalledWith('b')
    expect(document.querySelector('[data-memory-bank-detail="b"]')).toBeTruthy()
    expect(document.querySelector('[data-memory-banks]')).toBeNull()
  })

  it('renders the bank detail with statistics, distributions, and the page list', () => {
    const pages = [
      { pageId: 'kp-a', name: 'Component map', description: 'the parts', updatedAt: new Date().toISOString(), stale: true },
      { pageId: 'kp-b', name: 'Conventions', stale: false },
    ]
    const { actions, openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      stats: stats(),
      pages,
    })
    openBank()
    expect(textOf('data-memory-stat="nodes"')).toContain('522')
    expect(textOf('data-memory-stat="links"')).toContain('9963')
    expect(textOf('data-memory-stat="documents"')).toContain('16')
    expect(textOf('data-memory-stat="pending"')).toContain('0')
    expect(textOf('data-memory-stat="failed"')).toContain('0')
    expect(textOf('data-memory-bar="experience"')).toContain('202')
    expect(textOf('data-memory-bar="temporal"')).toContain('4925')
    expect(screen.getByText(en.pagesCount.replace('{count}', '2'))).toBeTruthy()
    expect(screen.getByText(en.pageStale)).toBeTruthy()
    expect(textOf('data-memory-page-row="kp-a"')).toContain('the parts')
    fireEvent.click(screen.getByRole('button', { name: en.openPage.replace('{name}', 'Conventions') }))
    expect(actions.openPage).toHaveBeenCalledWith('kp-b')
  })

  it('ranks the largest distribution entry as the full-width bar', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      stats: stats({ nodesByFactType: [{ label: 'big', count: 10 }, { label: 'small', count: 1 }] }),
      pages: [],
    })
    openBank()
    const width = (label: string): string =>
      document.querySelector(`[data-memory-bar="${label}"] [class*="barFill"]`)?.getAttribute('style') ?? ''
    expect(width('big')).toContain('100%')
    expect(width('small')).toContain('10%')
  })

  it('says a bank has no knowledge pages rather than drawing an empty list', () => {
    const { openBank } = renderPanel({ status: 'ready', banks: [bank()], bankId: 'coding-agent::zhiliao', pages: [] })
    openBank()
    expect(screen.getByText(en.pagesEmpty)).toBeTruthy()
  })

  it('says a distribution was not reported rather than drawing zero-width bars', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      stats: stats({ nodesByFactType: [], linksByLinkType: [] }),
      pages: [],
    })
    openBank()
    expect(screen.getAllByText(en.distributionEmpty)).toHaveLength(2)
    expect(document.querySelector('[data-memory-bar]')).toBeNull()
  })

  it('holds the search idle until a term is typed, then searches on submit', () => {
    const { actions, openBank } = renderPanel({ status: 'ready', banks: [bank()], bankId: 'coding-agent::zhiliao', pages: [] })
    openBank()
    expect(screen.getByText(en.searchIdle)).toBeTruthy()
    const run = screen.getByRole('button', { name: en.searchRun })
    // A blank query is not a search: the daemon would match everything.
    expect(run.hasAttribute('disabled')).toBe(true)
    const box = screen.getByRole('searchbox', { name: en.searchAria })
    fireEvent.change(box, { target: { value: 'memory' } })
    expect(actions.editQuery).toHaveBeenCalledWith('memory')
    act(() => { actions.runSearch.mockClear() })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    expect(actions.runSearch).toHaveBeenCalledTimes(1)
  })

  it('runs the search from the button as well as from Enter', () => {
    const { actions, openBank, set } = renderPanel({ status: 'ready', banks: [bank()], bankId: 'coding-agent::zhiliao', pages: [] })
    openBank()
    set({ query: 'memory' })
    fireEvent.click(screen.getByRole('button', { name: en.searchRun }))
    expect(actions.runSearch).toHaveBeenCalledTimes(1)
  })

  it('disables search while one is in flight', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      query: 'memory',
      searching: true,
    })
    openBank()
    expect(screen.getByRole('button', { name: en.searchRun }).hasAttribute('disabled')).toBe(true)
  })

  it('opens a search hit and reports the backend total beside the hits', () => {
    const { actions, openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      query: 'memory',
      hits: [{ pageId: 'kp-a', name: 'Conventions', snippet: '## Scope note', score: 0.9 }],
      total: 7,
    })
    openBank()
    // The backend counted seven; one page is rendered. Both numbers are shown.
    expect(textOf('data-memory-hit-count="7"')).toContain('7')
    expect(textOf('data-memory-hit="kp-a"')).toContain('## Scope note')
    fireEvent.click(screen.getByRole('button', { name: en.openHit.replace('{name}', 'Conventions') }))
    expect(actions.openPage).toHaveBeenCalledWith('kp-a')
  })

  it('says a search matched nothing once it has run', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      query: 'nothing',
      hits: [],
    })
    openBank()
    expect(document.querySelector('[data-memory-search-idle]')?.textContent).toBe(en.searchEmpty)
  })

  it('shows a failed search as its own note without losing the bank', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      query: 'memory',
      searchProblem: { kind: 'error', detail: 'codec mismatch' },
    })
    openBank()
    expect(screen.getByText('codec mismatch')).toBeTruthy()
    expect(document.querySelector('[data-memory-search-idle]')).toBeNull()
  })

  it('closes the open page from its own close control', () => {
    const { actions, openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      openPage: { pageId: 'kp-a', name: 'Conventions', body: '## Scope note' },
    })
    openBank()
    expect(textOf('data-memory-page-body')).toContain('## Scope note')
    fireEvent.click(within(document.querySelector('[data-memory-page="kp-a"]') as HTMLElement)
      .getByRole('button', { name: en.pageTitle }))
    expect(actions.closePage).toHaveBeenCalledTimes(1)
  })

  it('reads the page body over the bank without hiding the bank beneath it', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      stats: stats(),
      pages: [{ pageId: 'kp-a', name: 'Conventions', stale: false }],
      openPage: { pageId: 'kp-a', name: 'Conventions', body: '## Scope note' },
    })
    openBank()
    expect(screen.getByText('Conventions', { selector: '[data-memory-page-row="kp-a"] *' })).toBeTruthy()
    expect(textOf('data-memory-stats="coding-agent::zhiliao"')).toContain('522')
  })

  it('returns to the bank list from the crumb, closing the open page', () => {
    const { actions, openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
      openPage: { pageId: 'kp-a', name: 'Conventions', body: '## Scope note' },
    })
    openBank()
    fireEvent.click(screen.getByRole('button', { name: en.backToBanks }))
    expect(actions.closePage).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-memory-banks]')).toBeTruthy()
  })

  it('falls back to the panel title when the open bank left the list', () => {
    const { set } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [],
    })
    // The bank is opened, then a refresh reports a list without it.
    fireEvent.click(screen.getByText('zhiliao'))
    set({ banks: [] })
    // The bank view closes rather than titling itself with a name that is gone.
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('says the page is being read while the body crosses the wire', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      pages: [{ pageId: 'kp-a', name: 'Conventions', stale: false }],
      pageLoading: true,
    })
    openBank()
    expect(screen.getAllByText(en.loading).length).toBeGreaterThan(0)
  })

  it('refreshes only once the Host has answered at least once', () => {
    const { actions, set } = renderPanel({ status: 'idle' })
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    set({ status: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
  })

  it('renders every user-facing string from the active dictionary', () => {
    renderPanel({ status: 'ready', banks: [bank()] }, translate(zh))
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByText(zh.intro)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.refresh })).toBeTruthy()
  })
})
