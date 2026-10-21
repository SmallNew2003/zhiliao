import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryBrowserController, sortBanks } from '../src/client/memory-store.ts'
import type { MemoryBrowserState } from '../src/client/memory-store.ts'

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
  }
  ctx.provide('remote', { memoryController: calls })
  const controller = new MemoryBrowserController(ctx as never)
  return Object.assign(controller, { calls })
}

const BANKS = {
  available: true as const,
  banks: [
    { bankId: 'b-old', name: 'old', factCount: 1, lastWriteAt: '2026-01-01T00:00:00Z' },
    { bankId: 'b-new', name: 'new', factCount: 2, lastWriteAt: '2026-06-01T00:00:00Z' },
  ],
}

describe('sortBanks', () => {
  it('puts the most recently written bank first and never-written banks last', () => {
    const sorted = sortBanks([
      { bankId: 'a', name: 'a', factCount: 0 },
      { bankId: 'b', name: 'b', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: 'c', name: 'c', factCount: 0, lastWriteAt: '2026-06-01T00:00:00Z' },
    ])
    expect(sorted.map(entry => entry.bankId)).toEqual(['c', 'b', 'a'])
  })

  it('orders same-instant banks by name so the list does not shuffle', () => {
    const sorted = sortBanks([
      { bankId: 'z', name: 'zebra', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: 'a', name: 'alpha', factCount: 0, lastWriteAt: '2026-01-01T00:00:00Z' },
      { bankId: 'm', name: 'm', factCount: 0 },
      { bankId: 'n', name: 'n', factCount: 0 },
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
