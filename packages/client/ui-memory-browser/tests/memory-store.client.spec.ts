import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryBrowserController, sortBanks } from '../src/client/memory-store.ts'
import type { MemoryBrowserState } from '../src/client/memory-store.ts'
import type { MemoryBankId, MemoryId, MemoryUnitSummary } from '@deepseek-ai/dsh-host-memory-controller/types'

/** Brand helpers the way the seam constructs them; the wire carries plain strings. */
const bankId = (value: string): MemoryBankId => value as MemoryBankId
const unitId = (value: string): MemoryId => value as MemoryId

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A Remote answer as the generated client returns it. */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function refused(message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: 'gateway/internal', message } }
}

const UNAVAILABLE = { available: false as const, reason: 'unavailable' as const, detail: 'no usable memory provider' }

interface Script {
  readonly list?: () => Promise<unknown>
  readonly stats?: (bankId: string) => Promise<unknown>
  readonly pages?: (bankId: string) => Promise<unknown>
  readonly search?: (bankId: string, query: string, limit: number | undefined) => Promise<unknown>
  readonly page?: (bankId: string, pageId: string) => Promise<unknown>
  readonly units?: (
    bankId: string, query: string | undefined, factType: string | undefined,
    limit: number | undefined, offset: number | undefined,
  ) => Promise<unknown>
  readonly remember?: (bankId: string, text: string, context: string | undefined) => Promise<unknown>
  readonly curate?: (
    bankId: string, unitId: string, text: string | undefined,
    context: string | undefined, factType: string | undefined,
  ) => Promise<unknown>
}

/** Mount the controller over a Remote double answering `script`. */
async function harness(script: Script = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const calls = {
    list: vi.fn(script.list ?? (() => Promise.resolve(ok({ available: true, banks: [] })))),
    stats: vi.fn(script.stats ?? (() => Promise.resolve(ok({ available: true, stats: null })))),
    pages: vi.fn(script.pages ?? (() => Promise.resolve(ok({ available: true, pages: [] })))),
    search: vi.fn(script.search ?? (() => Promise.resolve(ok({ available: true, hits: [], total: 0 })))),
    page: vi.fn(script.page ?? (() => Promise.resolve(ok({ available: true })))),
    units: vi.fn(script.units ?? (() => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })))),
    remember: vi.fn(script.remember ?? (() => Promise.resolve(ok({ available: true, remembered: true })))),
    curate: vi.fn(script.curate ?? (() => Promise.resolve(ok({ available: true, curated: true })))),
  }
  ctx.provide('remote', { memoryController: calls })
  const controller = new MemoryBrowserController(ctx as never)
  return Object.assign(controller, { calls })
}

const BANKS = {
  available: true as const,
  banks: [
    { bankId: bankId('b-old'), name: 'old', factCount: 1, lastWriteAt: '2026-01-01T00:00:00Z' },
    { bankId: bankId('b-new'), name: 'new', factCount: 2, lastWriteAt: '2026-06-01T00:00:00Z' },
  ],
}

describe('sortBanks', () => {
  it('puts the most recently written bank first and never-written banks last', () => {
    const sorted = sortBanks([
      { bankId: bankId('a'), name: 'a', factCount: 0 },
      { bankId: bankId('b'), name: 'b', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: bankId('c'), name: 'c', factCount: 0, lastWriteAt: '2026-06-01T00:00:00Z' },
    ])
    expect(sorted.map(entry => entry.bankId)).toEqual(['c', 'b', 'a'])
  })

  it('orders same-instant banks by name so the list does not shuffle', () => {
    const sorted = sortBanks([
      { bankId: bankId('z'), name: 'zebra', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: bankId('a'), name: 'alpha', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: bankId('m'), name: 'm', factCount: 0 },
      { bankId: bankId('n'), name: 'n', factCount: 0 },
    ])
    expect(sorted.map(entry => entry.name)).toEqual(['alpha', 'zebra', 'm', 'n'])
  })
})

/** A promise plus the handles that settle it, so a test can interleave reads. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle: value => settle?.(value) }
}

describe('MemoryBrowserController', () => {
  it('reads nothing until the panel asks, then selects a bank and loads its detail', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(BANKS)) })
    const list = controller.calls.list
    expect(list).not.toHaveBeenCalled()
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(face.hooks.memoryBrowser.getSnapshot().bankId).toBe('b-new')
    expect(face.hooks.memoryBrowser.getSnapshot().banks).toHaveLength(2)
  })

  it('keeps an unavailable Host as a state with its reason rather than an error', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(UNAVAILABLE)) })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('unavailable') })
    expect(controller.getSnapshot().problem).toEqual({
      kind: 'unavailable',
      reason: 'unavailable',
      detail: 'no usable memory provider',
    })
  })

  it('keeps the banks already on screen when the daemon goes away', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(BANKS)) })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.load()
    expect(controller.getSnapshot().banks).toHaveLength(2)
  })

  it('reports a refused call as an error the page can retry', async () => {
    const controller = await harness({ list: () => Promise.resolve(refused('socket closed')) })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('error') })
    expect(controller.getSnapshot().problem).toEqual({ kind: 'error', detail: 'socket closed' })
    face.dismissProblem()
    expect(controller.getSnapshot().problem).toBeNull()
  })

  it('switches bank and drops the previous bank detail, hits, and page', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: bankId => Promise.resolve(ok({ available: true, stats: { bankId, totalNodes: 1 } })),
      pages: () => Promise.resolve(ok({ available: true, pages: [{ pageId: 'kp-a', name: 'A', stale: false }] })),
      search: () => Promise.resolve(ok({ available: true, hits: [{ pageId: 'kp-a', name: 'A', snippet: 'x' }], total: 1 })),
      page: () => Promise.resolve(ok({ available: true, page: { pageId: 'kp-a', name: 'A', body: 'b' } })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().pages).toHaveLength(1) })
    face.editQuery('memory')
    face.runSearch()
    await vi.waitFor(() => { expect(controller.getSnapshot().total).toBe(1) })
    face.openPage('kp-a')
    await vi.waitFor(() => { expect(controller.getSnapshot().openPage?.body).toBe('b') })

    face.selectBank('b-old')
    await vi.waitFor(() => { expect(controller.getSnapshot().bankId).toBe('b-old') })
    expect(controller.getSnapshot().hits).toEqual([])
    expect(controller.getSnapshot().total).toBe(0)
    expect(controller.getSnapshot().openPage).toBeNull()
    expect(controller.getSnapshot().query).toBe('memory')
  })

  it('ignores a switch to the bank already selected', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(BANKS)) })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().bankId).toBe('b-new') })
    const before = controller.getSnapshot().stats
    face.selectBank('b-new')
    expect(controller.getSnapshot().stats).toBe(before)
  })

  it('keeps a working half when the other bank read fails', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: () => Promise.resolve(refused('stats broke')),
      pages: () => Promise.resolve(ok({ available: true, pages: [{ pageId: 'kp-a', name: 'A', stale: false }] })),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().pages).toHaveLength(1) })
    expect(controller.getSnapshot().loading).toBe('none')
    expect(controller.getSnapshot().stats).toBeNull()
  })

  it('treats a blank query as no search rather than asking for everything', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(BANKS)) })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.editQuery('   ')
    face.runSearch()
    await Promise.resolve()
    expect(controller.getSnapshot().hits).toEqual([])
    expect(controller.getSnapshot().total).toBe(0)
  })

  it('reports a failed search without losing the bank beneath it', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      search: () => Promise.resolve(refused('codec mismatch')),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.editQuery('memory')
    face.runSearch()
    await vi.waitFor(() => { expect(controller.getSnapshot().searchProblem).not.toBeNull() })
    expect(controller.getSnapshot().searchProblem).toEqual({ kind: 'error', detail: 'codec mismatch' })
    expect(controller.getSnapshot().bankId).toBe('b-new')
  })

  it('reports an unavailable search as its classified reason', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      search: () => Promise.resolve(ok({ available: false, reason: 'unreachable', detail: 'no answer' })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.editQuery('memory')
    face.runSearch()
    await vi.waitFor(() => { expect(controller.getSnapshot().searchProblem).not.toBeNull() })
    expect(controller.getSnapshot().searchProblem).toEqual({
      kind: 'unavailable',
      reason: 'unreachable',
      detail: 'no answer',
    })
  })

  it('closes the reader for a page the backend has no body for', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(ok({ available: true })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-missing')
    await vi.waitFor(() => { expect(controller.getSnapshot().pageLoading).toBe(false) })
    expect(controller.getSnapshot().openPage).toBeNull()
  })

  it('reports an unavailable page read without leaving the reader spinning', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(ok({ available: false, reason: 'failed', detail: 'no such page' })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-a')
    await vi.waitFor(() => { expect(controller.getSnapshot().problem).not.toBeNull() })
    expect(controller.getSnapshot().pageLoading).toBe(false)
    expect(controller.getSnapshot().problem).toEqual({ kind: 'unavailable', reason: 'failed', detail: 'no such page' })
  })

  it('reports a refused page read without leaving the reader spinning', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(refused('codec mismatch')),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-a')
    await vi.waitFor(() => { expect(controller.getSnapshot().problem).not.toBeNull() })
    expect(controller.getSnapshot().pageLoading).toBe(false)
    expect(controller.getSnapshot().problem).toEqual({ kind: 'error', detail: 'codec mismatch' })
  })

  it('drops a second page open while one is already being read', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(ok({ available: true, page: { pageId: 'kp-a', name: 'A', body: 'first' } })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-a')
    // The reader already owns the panel; a second click must not race it.
    face.openPage('kp-b')
    await vi.waitFor(() => { expect(controller.getSnapshot().openPage?.body).toBe('first') })
  })

  it('closes an open page on request', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(ok({ available: true, page: { pageId: 'kp-a', name: 'A', body: 'b' } })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-a')
    await vi.waitFor(() => { expect(controller.getSnapshot().openPage).not.toBeNull() })
    face.closePage()
    expect(controller.getSnapshot().openPage).toBeNull()
  })

  it('coalesces overlapping reads into one rerun', async () => {
    let calls = 0
    const controller = await harness({
      list: () => { calls += 1; return Promise.resolve(ok(BANKS)) },
    })
    const face = controller.inject()
    const first = controller.load()
    const second = controller.load()
    expect(second).toBe(first)
    await first
    expect(calls).toBe(1)
    face.refresh()
    await vi.waitFor(() => { expect(calls).toBe(2) })
  })

  it('stops reading once the panel has already read the Host', async () => {
    let reads = 0
    const controller = await harness({
      list: () => { reads += 1; return Promise.resolve(ok(BANKS)) },
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    // A second ensure is a re-render, not a request.
    face.ensure()
    await Promise.resolve()
    expect(reads).toBe(1)
  })

  it('drops a bank listing that arrived after the panel was disposed', async () => {
    const slow = deferred<unknown>()
    const controller = await harness({ list: () => slow.promise })
    const pending = controller.load()
    // Disposal supersedes the read: its settlement must not reach a torn-down panel.
    controller.dispose()
    slow.settle(ok(BANKS))
    await pending
    expect(controller.getSnapshot().banks).toEqual([])
    expect(controller.getSnapshot().status).toBe('idle')
  })

  it('drops a bank detail that arrived after the panel moved to another bank', async () => {
    const slow = deferred<unknown>()
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: bankId => (bankId === 'b-new' ? slow.promise : Promise.resolve(ok({ available: true, stats: { bankId, totalNodes: 9 } }))),
      pages: bankId => Promise.resolve(ok({ available: true, pages: [{ pageId: `kp-${bankId}`, name: bankId, stale: false }] })),
    })
    const face = controller.inject()
    face.ensure()
    // The first bank's statistics are still in flight, so move to another bank before it
    // lands; the late answer belongs to a bank the panel is no longer showing.
    await vi.waitFor(() => { expect(controller.getSnapshot().bankId).toBe('b-new') })
    face.selectBank('b-old')
    await vi.waitFor(() => { expect(controller.getSnapshot().stats?.bankId).toBe('b-old') })

    slow.settle(ok({ available: true, stats: { bankId: 'b-new', totalNodes: 1 } }))
    await vi.waitFor(() => { expect(controller.getSnapshot().stats?.bankId).toBe('b-old') })
    expect(controller.getSnapshot().pages[0]?.pageId).toBe('kp-b-old')
  })

  it('drops a search that arrived after the panel moved to another bank', async () => {
    const slow = deferred<unknown>()
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      search: (_bankId, query) => (query === 'slow' ? slow.promise : Promise.resolve(ok({ available: true, hits: [], total: 0 }))),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.editQuery('slow')
    face.runSearch()
    face.selectBank('b-old')
    await vi.waitFor(() => { expect(controller.getSnapshot().bankId).toBe('b-old') })
    slow.settle(ok({ available: true, hits: [{ pageId: 'kp-a', name: 'A', snippet: 'x' }], total: 1 }))
    await Promise.resolve()
    expect(controller.getSnapshot().hits).toEqual([])
  })

  it('drops a page body that arrived after the reader was closed', async () => {
    const slow = deferred<unknown>()
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => slow.promise,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    face.openPage('kp-a')
    await vi.waitFor(() => { expect(controller.getSnapshot().pageLoading).toBe(true) })
    face.closePage()
    slow.settle(ok({ available: true, page: { pageId: 'kp-a', name: 'A', body: 'too late' } }))
    await Promise.resolve()
    expect(controller.getSnapshot().openPage).toBeNull()
  })

  it('keeps the page list standing when the page tree read is refused', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: () => Promise.resolve(ok({ available: true, stats: { bankId: 'b-new', totalNodes: 1 } })),
      pages: () => Promise.resolve(refused('tree broke')),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().loading).toBe('none') })
    // The statistics half still landed, so the panel shows what it can.
    await vi.waitFor(() => { expect(controller.getSnapshot().stats?.bankId).toBe('b-new') })
    expect(controller.getSnapshot().pages).toEqual([])
  })

  it('does nothing when a refresh or a close arrives with nothing to change', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      page: () => Promise.resolve(ok({ available: true, page: { pageId: 'kp-a', name: 'A', body: 'b' } })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    // Closing with nothing open and dismissing with nothing recorded are no-ops
    // rather than fresh store notifications the page would re-render for.
    const before = controller.getSnapshot()
    face.closePage()
    face.dismissProblem()
    face.editQuery('')
    expect(controller.getSnapshot()).toBe(before)
    controller.dispose()
    await expect(controller.load()).resolves.toBeUndefined()
  })

  it('reads nothing further when no bank is selected', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok({ available: true, banks: [] })),
      search: () => Promise.resolve(ok({ available: true, hits: [], total: 0 })),
      page: () => Promise.resolve(ok({ available: true })),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(controller.getSnapshot().bankId).toBeNull()
    face.editQuery('memory')
    face.runSearch()
    face.openPage('kp-a')
    await Promise.resolve()
    expect(controller.getSnapshot().searching).toBe(false)
    expect(controller.getSnapshot().pageLoading).toBe(false)
  })

  it('reads an available bank whose statistics the daemon reports as absent', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      // Available, but the daemon sent no stats object at all.
      stats: () => Promise.resolve(ok({ available: true })),
      pages: () => Promise.resolve(ok({ available: true, pages: [] })),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().loading).toBe('none') })
    expect(controller.getSnapshot().stats).toBeNull()
  })

  it('holds a working page list when the statistics read is refused', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: () => Promise.resolve(refused('stats broke')),
      pages: () => Promise.resolve(ok({ available: true, pages: [{ pageId: 'kp-a', name: 'A', stale: false }] })),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().pages).toHaveLength(1) })
    expect(controller.getSnapshot().stats).toBeNull()
  })

  it('drops every late settlement after disposal', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const controller = await harness({
      list: () => gate.then(() => ok(BANKS)),
    })
    const pending = controller.load()
    controller.dispose()
    release?.()
    await pending
    const state: MemoryBrowserState = controller.getSnapshot()
    expect(state.status).toBe('idle')
    expect(state.banks).toEqual([])
  })
})

describe('MemoryBrowserController memory units', () => {
  const UNITS_PAGE = {
    available: true as const,
    units: [{ id: unitId('u-1'), text: 'a fact', factType: 'world', mentionedAt: '2026-10-01T00:00:00Z' }],
    total: 42,
    limit: 20,
    offset: 0,
  }

  it('reads the units page with the bank and keeps the Host page size', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve(ok(UNITS_PAGE)),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })
    expect(controller.getSnapshot()).toMatchObject({
      unitsTotal: 42, unitsLimit: 20, unitsOffset: 0, unitsLoading: false,
    })
  })

  it('keeps a section saying so when the provider offers no statistics or pages', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      stats: () => Promise.resolve({ ok: true as const, value: { available: false as const, reason: 'unsupported' as const, detail: 'no statistics' } }),
      pages: () => Promise.resolve({ ok: true as const, value: { available: false as const, reason: 'unsupported' as const, detail: 'no pages' } }),
      units: () => Promise.resolve(ok(UNITS_PAGE)),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })
    expect(controller.getSnapshot().statsProblem).toEqual({ kind: 'unavailable', reason: 'unsupported', detail: 'no statistics' })
    expect(controller.getSnapshot().pagesProblem).toEqual({ kind: 'unavailable', reason: 'unsupported', detail: 'no pages' })
    expect(controller.getSnapshot().loading).toBe('none')
  })

  it('applies the unit filter from the first page', async () => {
    const units = vi.fn(() => Promise.resolve(ok(UNITS_PAGE)))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })
    units.mockClear()

    face.editUnitQuery('  web  ')
    // The draft alone is not a filter: the list stays until the filter runs.
    expect(units).not.toHaveBeenCalled()
    face.runUnitFilter()

    await vi.waitFor(() => { expect(units).toHaveBeenCalledTimes(1) })
    expect(units).toHaveBeenCalledWith('b-new', 'web', undefined, undefined, 0)
    expect(controller.getSnapshot().unitQuery).toBe('web')
  })

  it('reads another page of units on request', async () => {
    // The daemon echoes the requested offset, so the page on screen is the one asked for.
    const units = vi.fn((
      _bankId: string, _query: string | undefined, _factType: string | undefined,
      _limit: number | undefined, offset: number | undefined,
    ) => Promise.resolve(ok({ ...UNITS_PAGE, offset: offset ?? 0 })))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })
    units.mockClear()

    face.pageUnits(20)

    await vi.waitFor(() => { expect(units).toHaveBeenCalledWith('b-new', '', undefined, undefined, 20) })
    expect(controller.getSnapshot().unitsOffset).toBe(20)
  })

  it('reports a failed units read without losing the bank beneath it', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve(refused('units broke')),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().unitsProblem).not.toBeNull() })
    expect(controller.getSnapshot().unitsProblem).toEqual({ kind: 'error', detail: 'units broke' })
    expect(controller.getSnapshot().bankId).toBe('b-new')
  })
})

describe('MemoryBrowserController writes', () => {
  it('records a drafted finding, notes it, and refreshes the bank', async () => {
    const list = vi.fn(() => Promise.resolve(ok(BANKS)))
    const remember = vi.fn(() => Promise.resolve(ok({ available: true, remembered: true, detail: 'op-7' })))
    const controller = await harness({
      list,
      units: () => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })),
      remember,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    list.mockClear()

    face.startAdd()
    face.editAdd('text', '  keep this  ')
    face.editAdd('context', '  probe  ')
    face.submitAdd()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })
    expect(remember).toHaveBeenCalledWith('b-new', 'keep this', 'probe')
    expect(controller.getSnapshot().addDraft).toBeNull()
    expect(controller.getSnapshot().writeNote).toEqual({ kind: 'remembered', detail: 'op-7' })
    // The bank is re-read so the new fact count and unit show up.
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
  })

  it('omits an empty context when recording a finding', async () => {
    const remember = vi.fn(() => Promise.resolve(ok({ available: true, remembered: true })))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      remember,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.editAdd('text', 'keep this')
    face.editAdd('context', '   ')
    face.submitAdd()

    await vi.waitFor(() => { expect(remember).toHaveBeenCalledWith('b-new', 'keep this', undefined) })
  })

  it('ignores a submit with no text', async () => {
    const remember = vi.fn(() => Promise.resolve(ok({ available: true, remembered: true })))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      remember,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.editAdd('text', '   ')
    face.submitAdd()
    await Promise.resolve()

    expect(remember).not.toHaveBeenCalled()
  })

  it('keeps the form open with the backend detail when a write is refused', async () => {
    const remember = vi.fn(() => Promise.resolve(ok({ available: true, remembered: false, detail: 'quota reached' })))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      remember,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.editAdd('text', 'keep this')
    face.submitAdd()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })
    expect(controller.getSnapshot().writeNote).toEqual({ kind: 'refused', detail: 'quota reached' })
    expect(controller.getSnapshot().addDraft).toEqual({ text: 'keep this', context: '' })
  })

  it('reports a write the Host could not answer', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      remember: () => Promise.resolve(refused('socket closed')),
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.editAdd('text', 'keep this')
    face.submitAdd()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeProblem).not.toBeNull() })
    expect(controller.getSnapshot().writeProblem).toEqual({ kind: 'error', detail: 'socket closed' })
  })

  it('curates a unit from its prefilled draft and refreshes', async () => {
    const list = vi.fn(() => Promise.resolve(ok(BANKS)))
    const curate = vi.fn(() => Promise.resolve(ok({ available: true, curated: true })))
    const controller = await harness({
      list,
      units: () => Promise.resolve(ok({
        available: true,
        units: [{ id: unitId('u-1'), text: 'a fact', factType: 'world', context: 'chat' }],
        total: 1, limit: 20, offset: 0,
      })),
      curate,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })
    list.mockClear()

    const listed = controller.getSnapshot().units[0]
    expect(listed).toBeDefined()
    face.startEdit(listed as MemoryUnitSummary)
    expect(controller.getSnapshot().editDraft).toEqual({ unitId: 'u-1', text: 'a fact', context: 'chat', factType: 'world' })
    face.editCurate('text', 'a curated fact')
    face.editCurate('context', '')
    face.submitEdit()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })
    expect(curate).toHaveBeenCalledWith('b-new', 'u-1', 'a curated fact', '', 'world')
    expect(controller.getSnapshot().editDraft).toBeNull()
    expect(controller.getSnapshot().writeNote).toEqual({ kind: 'curated', detail: '' })
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
  })

  it('keeps the curate draft open when the backend refuses the fact type', async () => {
    const curate = vi.fn(() => Promise.resolve(ok({
      available: true, curated: false, detail: 'only world/experience facts can be curated',
    })))
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve(ok({
        available: true,
        units: [{ id: unitId('u-1'), text: 'a fact' }],
        total: 1, limit: 20, offset: 0,
      })),
      curate,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().units).toHaveLength(1) })

    face.startEdit(controller.getSnapshot().units[0] as MemoryUnitSummary)
    face.submitEdit()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })
    expect(controller.getSnapshot().writeNote).toEqual({
      kind: 'refused', detail: 'only world/experience facts can be curated',
    })
    expect(controller.getSnapshot().editDraft?.unitId).toBe('u-1')
  })

  it('closes a draft on cancel and clears the note on dismiss', async () => {
    const controller = await harness({ list: () => Promise.resolve(ok(BANKS)) })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.cancelAdd()
    expect(controller.getSnapshot().addDraft).toBeNull()

    face.startEdit({ id: unitId('u-1'), text: 'a fact' })
    face.cancelEdit()
    expect(controller.getSnapshot().editDraft).toBeNull()

    face.dismissWriteNote()
    expect(controller.getSnapshot().writeNote).toBeNull()
  })
})

describe('MemoryBrowserController action guards', () => {
  /** A harness already showing one bank, with the units read in flight settled. */
  async function loaded(script: Script = {}) {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })),
      ...script,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    return { controller, face }
  }

  it('reports an unavailable units read as the section\'s classified reason', async () => {
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve({ ok: true as const, value: { available: false as const, reason: 'unreachable' as const, detail: 'daemon slow' } }),
    })
    controller.inject().ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().unitsProblem).not.toBeNull() })
    expect(controller.getSnapshot().unitsProblem).toEqual({ kind: 'unavailable', reason: 'unreachable', detail: 'daemon slow' })
    // The rest of the bank keeps rendering.
    expect(controller.getSnapshot().bankId).toBe('b-new')
  })

  it('ignores a note dismissal with no note, and a problem dismissal with no problem', async () => {
    const { controller, face } = await loaded()

    face.dismissWriteNote()
    face.dismissProblem()

    expect(controller.getSnapshot().writeNote).toBeNull()
    expect(controller.getSnapshot().problem).toBeNull()
  })

  it('ignores a filter edit that types the text already in the box', async () => {
    const { controller, face } = await loaded()

    face.editUnitQuery('')

    expect(controller.getSnapshot().unitQueryDraft).toBe('')
  })

  it('drops a write that settles after the panel moved to another bank', async () => {
    const remember = deferred<unknown>()
    const controller = await harness({
      list: () => Promise.resolve(ok(BANKS)),
      units: () => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })),
      remember: () => remember.promise,
    })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.startAdd()
    face.editAdd('text', 'keep this')
    face.submitAdd()
    // The panel moves on while the write is in flight.
    face.selectBank('b-old')
    remember.settle({ ok: true, value: { available: true, remembered: true } })
    await remember.promise

    // The late settlement belongs to the bank that is no longer selected.
    expect(controller.getSnapshot().writeNote).toBeNull()
    expect(controller.getSnapshot().writing).toBe(false)
  })

  it('drops a bank read that settles after the panel is disposed', async () => {
    const first = deferred<unknown>()
    let reading = false
    const controller = await harness({
      list: () => { reading = true; return first.promise },
      units: () => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })),
    })
    controller.inject().ensure()
    // The read is awaiting the daemon when the panel goes away.
    await vi.waitFor(() => { expect(reading).toBe(true) })
    controller.dispose()
    first.settle({ ok: true, value: { available: true, banks: BANKS.banks } })
    await first.promise

    // The late answer lands nowhere: nothing is published after disposal. The
    // read was in flight when the panel went away, so the loading state stays.
    expect(controller.getSnapshot().banks).toEqual([])
    expect(controller.getSnapshot().status).toBe('loading')
    expect(controller.getSnapshot().problem).toBeNull()
  })

  it('dismisses a note once the outcome has been read', async () => {
    const { controller, face } = await loaded({
      remember: () => Promise.resolve(ok({ available: true, remembered: true, detail: 'op-7' })),
    })
    face.startAdd()
    face.editAdd('text', 'keep this')
    face.submitAdd()
    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })

    face.dismissWriteNote()

    expect(controller.getSnapshot().writeNote).toBeNull()
  })

  it('reports a write the Host answered unavailable', async () => {
    const { controller, face } = await loaded({
      remember: () => Promise.resolve({ ok: true as const, value: { available: false as const, reason: 'unavailable' as const, detail: 'no provider' } }),
    })
    face.startAdd()
    face.editAdd('text', 'keep this')
    face.submitAdd()

    await vi.waitFor(() => { expect(controller.getSnapshot().writeProblem).not.toBeNull() })
    expect(controller.getSnapshot().writeProblem).toEqual({ kind: 'unavailable', reason: 'unavailable', detail: 'no provider' })
    // The form stays open so the finding is not lost.
    expect(controller.getSnapshot().addDraft).toEqual({ text: 'keep this', context: '' })
    expect(controller.getSnapshot().writing).toBe(false)
  })

  it('ignores a curation submit with no form open', async () => {
    const curate = vi.fn(() => Promise.resolve(ok({ available: true, curated: true })))
    const { face } = await loaded({ curate })

    face.submitEdit()
    await Promise.resolve()

    expect(curate).not.toHaveBeenCalled()
  })

  it('ignores a unit filter run with no bank selected', async () => {
    const units = vi.fn(() => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })))
    const controller = await harness({ list: () => Promise.resolve(ok({ available: true, banks: [] })), units })
    const face = controller.inject()
    face.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    face.editUnitQuery('web')
    face.runUnitFilter()

    expect(units).not.toHaveBeenCalled()
  })

  it('ignores a filter run that changes nothing', async () => {
    const units = vi.fn(() => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })))
    const { face } = await loaded({ units })
    units.mockClear()

    face.runUnitFilter()

    expect(units).not.toHaveBeenCalled()
  })

  it('ignores a page request for the page already on screen', async () => {
    const units = vi.fn(() => Promise.resolve(ok({ available: true, units: [], total: 0, limit: 20, offset: 0 })))
    const { face } = await loaded({ units })
    units.mockClear()

    face.pageUnits(0)

    expect(units).not.toHaveBeenCalled()
  })

  it('ignores a second add form while one is open', async () => {
    const { controller, face } = await loaded()

    face.startAdd()
    face.startAdd()

    expect(controller.getSnapshot().addDraft).toEqual({ text: '', context: '' })
  })

  it('ignores draft edits with no form open', async () => {
    const { controller, face } = await loaded()

    face.editAdd('text', 'orphan')
    face.editCurate('text', 'orphan')

    expect(controller.getSnapshot().addDraft).toBeNull()
    expect(controller.getSnapshot().editDraft).toBeNull()
  })

  it('ignores a note dismissal with no note to dismiss', async () => {
    const { controller, face } = await loaded()

    face.dismissWriteNote()

    expect(controller.getSnapshot().writeNote).toBeNull()
  })

  it('ignores a write while another is in flight', async () => {
    const remember = vi.fn(() => Promise.resolve(ok({ available: true, remembered: true })))
    const { controller, face } = await loaded({ remember })
    face.startAdd()
    face.editAdd('text', 'first')
    face.submitAdd()
    // The first write is still in flight; a second submit must not double it.
    face.editAdd('text', 'second')
    face.submitAdd()
    await vi.waitFor(() => { expect(controller.getSnapshot().writeNote).not.toBeNull() })

    expect(remember).toHaveBeenCalledTimes(1)
    expect(remember).toHaveBeenCalledWith('b-new', 'first', undefined)
  })

  it('ignores a curation with no text', async () => {
    const curate = vi.fn(() => Promise.resolve(ok({ available: true, curated: true })))
    const { face } = await loaded({
      units: () => Promise.resolve(ok({
        available: true,
        units: [{ id: unitId('u-1'), text: 'a fact' }],
        total: 1, limit: 20, offset: 0,
      })),
      curate,
    })
    face.startEdit({ id: unitId('u-1'), text: 'a fact' })
    face.editCurate('text', '   ')
    face.submitEdit()
    await Promise.resolve()

    expect(curate).not.toHaveBeenCalled()
  })
})
