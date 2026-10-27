// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  KnowledgePageId, MemoryBankId, MemoryBankStats, MemoryBankSummary, MemoryId, MemoryKnowledgePage,
} from '@deepseek-ai/dsh-host-memory-controller/types'

/** Brand helpers the way the seam constructs them; the wire carries plain strings. */
const bankId = (value: string): MemoryBankId => value as MemoryBankId
const unitId = (value: string): MemoryId => value as MemoryId
const pageId = (value: string): KnowledgePageId => value as KnowledgePageId
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
  statsProblem: null,
  pages: [],
  pagesProblem: null,
  openPage: null,
  pageLoading: false,
  query: '',
  searching: false,
  hits: [],
  total: 0,
  searchProblem: null,
  units: [],
  unitsTotal: 0,
  unitsLimit: 20,
  unitsOffset: 0,
  unitQuery: '',
  unitQueryDraft: '',
  unitsLoading: false,
  unitsProblem: null,
  addDraft: null,
  editDraft: null,
  writing: false,
  writeProblem: null,
  writeNote: null,
}

/** Text of one element, with its nested nodes' text folded in. */
function textOf(testId: string): string {
  return document.querySelector(`[${testId}]`)?.textContent ?? ''
}

function bank(overrides: Partial<MemoryBankSummary> = {}): MemoryBankSummary {
  return {
    bankId: bankId('coding-agent::zhiliao'),
    name: 'zhiliao',
    factCount: 522,
    lastWriteAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ...overrides,
  }
}

function stats(overrides: Partial<MemoryBankStats> = {}): MemoryBankStats {
  return {
    bankId: bankId('coding-agent::zhiliao'),
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
    editUnitQuery: vi.fn(),
    runUnitFilter: vi.fn(),
    pageUnits: vi.fn(),
    startAdd: vi.fn(),
    editAdd: vi.fn(),
    submitAdd: vi.fn(),
    cancelAdd: vi.fn(),
    startEdit: vi.fn(),
    editCurate: vi.fn(),
    submitEdit: vi.fn(),
    cancelEdit: vi.fn(),
    dismissWriteNote: vi.fn(),
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
      banks: [bank(), { bankId: bankId('b'), name: 'blank', factCount: 0 }],
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
      banks: [bank(), bank({ bankId: bankId('b'), name: 'other' })],
      bankId: 'coding-agent::zhiliao',
    })
    openBank('other')
    expect(actions.selectBank).toHaveBeenCalledWith('b')
    expect(document.querySelector('[data-memory-bank-detail="b"]')).toBeTruthy()
    expect(document.querySelector('[data-memory-banks]')).toBeNull()
  })

  it('renders the bank detail with statistics, distributions, and the page list', () => {
    const pages: MemoryKnowledgePage[] = [
      { pageId: pageId('kp-a'), name: 'Component map', description: 'the parts', updatedAt: new Date().toISOString(), stale: true },
      { pageId: pageId('kp-b'), name: 'Conventions', stale: false },
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
      hits: [{ pageId: pageId('kp-a'), name: 'Conventions', snippet: '## Scope note', score: 0.9 }],
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
      openPage: { pageId: pageId('kp-a'), name: 'Conventions', body: '## Scope note' },
    })
    openBank()
    // The body renders as Markdown: the heading is an element, not fence text.
    expect(document.querySelector('[data-memory-page-body] h2')?.textContent).toBe('Scope note')
    expect(textOf('data-memory-page-body')).not.toContain('##')
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
      pages: [{ pageId: pageId('kp-a'), name: 'Conventions', stale: false }],
      openPage: { pageId: pageId('kp-a'), name: 'Conventions', body: '## Scope note' },
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
      openPage: { pageId: pageId('kp-a'), name: 'Conventions', body: '## Scope note' },
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
      pages: [{ pageId: pageId('kp-a'), name: 'Conventions', stale: false }],
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

  it('lists the selected bank\'s memory units with their fact type and an edit entry', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      units: [{ id: unitId('u-1'), text: 'a fact', factType: 'world', mentionedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }],
      unitsTotal: 1,
    })
    const actions = openBank()
    const row = document.querySelector('[data-memory-unit="u-1"]')
    expect(row?.textContent).toContain('a fact')
    expect(row?.textContent).toContain('world')
    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    expect(actions.startEdit).toHaveBeenCalledTimes(1)
  })

  it('opens the add-memory form and routes the draft through the actions', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
    })
    const actions = openBank()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(actions.startAdd).toHaveBeenCalledTimes(1)
  })

  it('renders the add form over the bank and submits through it', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      addDraft: { text: 'keep this', context: 'probe' },
    })
    const actions = openBank()
    const form = document.querySelector('[data-memory-add-form]')
    expect(form).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.addTextAria), { target: { value: 'keep more' } })
    expect(actions.editAdd).toHaveBeenCalledWith('text', 'keep more')
    fireEvent.click(screen.getByRole('button', { name: en.addSubmit }))
    expect(actions.submitAdd).toHaveBeenCalledTimes(1)
  })

  it('says the units page is being read while it crosses the wire', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      unitsLoading: true,
    })
    openBank()
    expect(document.querySelector('[data-memory-units] [role="status"]')?.textContent).toBe(en.loading)
  })

  it('renders the curate form over the unit being edited', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      units: [{ id: unitId('u-1'), text: 'a fact', factType: 'world', context: 'chat' }],
      unitsTotal: 1,
      editDraft: { unitId: unitId('u-1'), text: 'a fact', context: 'chat', factType: 'world' },
    })
    const actions = openBank()
    const form = document.querySelector('[data-memory-edit-form="u-1"]')
    expect(form).toBeTruthy()
    const context = document.querySelector<HTMLInputElement>(`[aria-label="${en.editContextAria}"]`)
    expect(context?.value).toBe('chat')
    fireEvent.click(screen.getByRole('button', { name: en.editSubmit }))
    expect(actions.submitEdit).toHaveBeenCalledTimes(1)
  })

  it('shows what the last write did, with the backend detail, and dismisses it', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      writeNote: { kind: 'remembered', detail: 'op-7' },
    })
    const actions = openBank()
    expect(screen.getByText(en.writeRemembered)).toBeTruthy()
    expect(screen.getByText('op-7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(actions.dismissWriteNote).toHaveBeenCalledTimes(1)
  })

  it('shows a refused write with its own sentence', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      writeNote: { kind: 'refused', detail: 'quota reached' },
    })
    openBank()
    expect(screen.getByText(en.writeRefused)).toBeTruthy()
  })

  it('reports a write the Host could not answer', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      writeProblem: { kind: 'error', detail: 'socket closed' },
    })
    openBank()
    expect(screen.getByText('socket closed')).toBeTruthy()
  })

  it('pages through the units with the Host\'s page size', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      units: [{ id: unitId('u-1'), text: 'a fact' }],
      unitsTotal: 42,
      unitsLimit: 20,
      unitsOffset: 20,
    })
    const actions = openBank()
    expect(screen.getByText(en.unitsRange.replace('{first}', '21').replace('{last}', '21').replace('{total}', '42'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.prevPage }))
    expect(actions.pageUnits).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
    expect(actions.pageUnits).toHaveBeenCalledWith(40)
  })

  it('reports a failed units read inside the units section', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      unitsProblem: { kind: 'error', detail: 'units broke' },
    })
    openBank()
    expect(screen.getByText('units broke')).toBeTruthy()
  })

  it('says so in place of a section the provider does not offer', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      statsProblem: { kind: 'unavailable', reason: 'unsupported', detail: 'no statistics' },
      pagesProblem: { kind: 'unavailable', reason: 'unsupported', detail: 'no pages' },
    })
    openBank()
    expect(screen.getAllByText(en.reasonUnsupported)).toHaveLength(2)
    // The knowledge search belongs to the pages section, so it goes with it.
    expect(screen.queryByRole('button', { name: en.searchRun })).toBeNull()
  })

  it('renders the open page body as Markdown rather than preformatted text', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      openPage: { pageId: pageId('kp-a'), name: 'Conventions', body: '# Conventions\n\nWe chose Cordis.' },
    })
    openBank()
    const body = document.querySelector('[data-memory-page-body]')
    expect(body?.querySelector('h1')?.textContent).toBe('Conventions')
    expect(body?.querySelector('p')?.textContent).toBe('We chose Cordis.')
  })

  it('routes every add-form field through the actions', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      addDraft: { text: 'keep this', context: 'probe' },
    })
    const actions = openBank()
    fireEvent.change(screen.getByLabelText(en.addTextAria), { target: { value: 'keep more' } })
    expect(actions.editAdd).toHaveBeenCalledWith('text', 'keep more')
    fireEvent.change(screen.getByLabelText(en.addContextAria), { target: { value: 'probe 2' } })
    expect(actions.editAdd).toHaveBeenCalledWith('context', 'probe 2')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelAdd).toHaveBeenCalledTimes(1)
  })

  it('routes every curate-form field through the actions', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      units: [{ id: unitId('u-1'), text: 'a fact' }],
      unitsTotal: 1,
      editDraft: { unitId: unitId('u-1'), text: 'a fact', context: 'chat', factType: 'world' },
    })
    const actions = openBank()
    fireEvent.change(screen.getByLabelText(en.editTextAria), { target: { value: 'curated' } })
    expect(actions.editCurate).toHaveBeenCalledWith('text', 'curated')
    fireEvent.change(screen.getByLabelText(en.editContextAria), { target: { value: 'chat 2' } })
    expect(actions.editCurate).toHaveBeenCalledWith('context', 'chat 2')
    fireEvent.change(screen.getByLabelText(en.editFactTypeAria), { target: { value: 'experience' } })
    expect(actions.editCurate).toHaveBeenCalledWith('factType', 'experience')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelEdit).toHaveBeenCalledTimes(1)
  })

  it('runs the unit filter from the box and the submit', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      // The box holds text, so the run control is enabled as it is while typing.
      unitQueryDraft: 'we',
    })
    const actions = openBank()
    fireEvent.change(screen.getByLabelText(en.unitsFilterAria), { target: { value: 'web' } })
    expect(actions.editUnitQuery).toHaveBeenCalledWith('web')
    fireEvent.click(screen.getByRole('button', { name: en.unitsFilterRun }))
    expect(actions.runUnitFilter).toHaveBeenCalledTimes(1)
    // The form submits too, so Enter in the box runs the same filter.
    fireEvent.submit(document.querySelector('[data-memory-units] form') as HTMLFormElement)
    expect(actions.runUnitFilter).toHaveBeenCalledTimes(2)
  })

  it('says the bank holds no units at all', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
    })
    openBank()
    expect(screen.getByText(en.unitsEmpty)).toBeTruthy()
  })

  it('says an empty filter matched nothing, apart from an empty bank', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      unitQuery: 'web',
    })
    openBank()
    expect(screen.getByText(en.unitsFilterEmpty)).toBeTruthy()
  })

  it('shows an accepted write without a backend detail', () => {
    const { openBank } = renderPanel({
      status: 'ready',
      banks: [bank()],
      bankId: 'coding-agent::zhiliao',
      writeNote: { kind: 'curated', detail: '' },
    })
    openBank()
    expect(screen.getByText(en.writeCurated)).toBeTruthy()
    // No detail line renders when the backend offered none.
    expect(document.querySelector('[data-memory-write-note="curated"] p:nth-of-type(2)')).toBeNull()
  })

  it('renders every user-facing string from the active dictionary', () => {
    renderPanel({ status: 'ready', banks: [bank()] }, translate(zh))
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByText(zh.intro)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.refresh })).toBeTruthy()
  })
})
