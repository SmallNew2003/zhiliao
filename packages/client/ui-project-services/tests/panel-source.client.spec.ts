// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ApiServiceFeedFrameView,
  ApiServiceInventoryView,
  ApiServiceListRequest,
  ApiServiceLogsView,
} from '@deepseek-ai/dsh-api-project-services-controller/types'
import { createProjectServicesPanelSource, type ProjectServicesPanelSourceDeps } from '../src/client/panel-source.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function inventory(overrides: Partial<ApiServiceInventoryView> = {}): ApiServiceInventoryView {
  return {
    project: { id: 'proj-1', path: '/repos/my-project' },
    checkouts: [
      { id: 'main', path: '/repos/my-project', availability: 'present' },
      { id: 'feat', path: '/worktrees/feat', availability: 'present' },
    ],
    items: [],
    groups: [],
    providers: [],
    revision: '1',
    ...overrides,
  }
}

function frame(snapshot: ApiServiceInventoryView, kind: 'baseline' | 'updated' = 'updated'): ApiServiceFeedFrameView {
  return { kind, snapshot }
}

/**
 * Follow stream that yields the given frames and then holds open until its
 * signal aborts, the way a live follow does.
 * @param frames - frames to yield before holding.
 * @param signal - cancellation signal the source passes.
 * @returns the async iterable the source consumes.
 */
function followIterable(
  frames: readonly ApiServiceFeedFrameView[],
  signal?: AbortSignal,
): AsyncIterable<ApiServiceFeedFrameView> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of frames) {
        if (signal?.aborted === true) return
        yield item
      }
      await new Promise<void>((resolve) => {
        if (signal === undefined) return
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  }
}

/** Let the source's pending microtasks settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await Promise.resolve()
}

/** A control call the Host accepts; the view carries no result the panel reads. */
const settled = { ok: true, value: undefined } as unknown as RemoteResult<never>

/** A refusal the Remote face folds into its error branch rather than throwing. */
function refusal(code: string, message: string): RemoteResult<never> {
  return { ok: false, error: { code, message, details: {} } } as unknown as RemoteResult<never>
}

function bench(options: {
  readonly frames?: readonly ApiServiceFeedFrameView[]
  readonly list?: () => Promise<RemoteResult<ApiServiceInventoryView>>
  readonly logs?: () => Promise<RemoteResult<ApiServiceLogsView>>
  readonly control?: () => Promise<RemoteResult<never>>
} = {}) {
  const follow = vi.fn((_request: ApiServiceListRequest, signal?: AbortSignal) =>
    followIterable(options.frames ?? [], signal))
  const list = vi.fn(options.list ?? (() => Promise.resolve({ ok: true as const, value: inventory() })))
  const logs = vi.fn(options.logs ?? (() => Promise.resolve({
    ok: true as const,
    value: { chunks: [], truncated: false, gap: false } satisfies ApiServiceLogsView,
  })))
  const control = vi.fn(options.control ?? (() => Promise.resolve({ ok: true as const, value: undefined })))
  const resetListeners = new Set<() => void>()
  const deps: ProjectServicesPanelSourceDeps = {
    remote: { follow, list, logs, control } as unknown as ProjectServicesPanelSourceDeps['remote'],
    subscribeReset: (listener) => {
      resetListeners.add(listener)
      return () => { resetListeners.delete(listener) }
    },
  }
  const source = createProjectServicesPanelSource(deps)
  return {
    source,
    follow,
    list,
    logs,
    control,
    emitReset: () => { for (const listener of [...resetListeners]) listener() },
  }
}

describe('project services panel source', () => {
  it('starts the follow stream on the first observer and publishes the baseline inventory', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    expect(b.follow).not.toHaveBeenCalled()

    const seen: string[] = []
    const unsubscribe = b.source.panel.subscribe(() => { seen.push('change') })
    await settle()

    expect(b.follow).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
    const snapshot = b.source.panel.getSnapshot()
    expect(snapshot.inventory?.checkouts).toHaveLength(2)
    // The source selects the first checkout until the operator picks one.
    expect(snapshot.selectedCheckoutId).toBe('main')
    unsubscribe()
  })

  it('keeps the operator checkout across a later frame and falls back when it leaves the project', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().selectCheckout('feat')
    expect(b.source.panel.getSnapshot().selectedCheckoutId).toBe('feat')

    // Selecting the checkout already shown changes nothing.
    b.source.inject().selectCheckout('feat')
    expect(b.source.panel.getSnapshot().selectedCheckoutId).toBe('feat')

    const withoutFeat = inventory({
      checkouts: [{ id: 'main', path: '/repos/my-project', availability: 'present' }],
    })
    b.list.mockResolvedValueOnce({ ok: true, value: withoutFeat })
    b.source.inject().refresh()
    await settle()
    expect(b.source.panel.getSnapshot().selectedCheckoutId).toBe('main')
    unsubscribe()
  })

  it('reopens the follow stream after a connection reset and stops it when the last observer leaves', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(1)

    b.emitReset()
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(2)

    unsubscribe()
    await settle()
    const firstSignal = b.follow.mock.calls[0]?.[1]
    const secondSignal = b.follow.mock.calls[1]?.[1]
    expect(firstSignal?.aborted).toBe(true)
    expect(secondSignal?.aborted).toBe(true)

    // A reset with nobody observing reopens nothing.
    b.emitReset()
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(2)
  })

  it('ignores a failure from a follow stream it stopped itself', async () => {
    const failing = vi.fn((_request: ApiServiceListRequest, signal?: AbortSignal) => {
      const stream: AsyncIterable<ApiServiceFeedFrameView> = {
        [Symbol.asyncIterator]: async function* () {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => { resolve() }, { once: true })
          })
          throw new Error('carrier lost')
        },
      }
      return stream
    })
    const source = createProjectServicesPanelSource({
      remote: { follow: failing, list: vi.fn(), logs: vi.fn(), control: vi.fn() },
      subscribeReset: () => () => {},
    })
    const unsubscribe = source.panel.subscribe(() => {})
    await settle()
    expect(source.panel.getSnapshot().error).toBeUndefined()
    unsubscribe()
    await settle()
    // The teardown abort is a deliberate stop, not a failure to report.
    expect(source.panel.getSnapshot().error).toBeUndefined()
  })

  it('reports a live follow failure', async () => {
    const failing = vi.fn(() => {
      const stream: AsyncIterable<ApiServiceFeedFrameView> = {
        [Symbol.asyncIterator]: async function* () {
          throw new Error('stream reset by peer')
          yield { kind: 'baseline', snapshot: inventory() }
        },
      }
      return stream
    })
    const source = createProjectServicesPanelSource({
      remote: { follow: failing, list: vi.fn(), logs: vi.fn(), control: vi.fn() },
      subscribeReset: () => () => {},
    })
    const unsubscribe = source.panel.subscribe(() => {})
    await settle()
    expect(source.panel.getSnapshot().error).toBe('stream reset by peer')
    unsubscribe()
  })

  it('refreshes the inventory and reports a rejected read', async () => {
    const b = bench({ list: () => Promise.resolve(refusal('service/unavailable', 'host unreachable')) })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().refresh()
    await settle()
    expect(b.list).toHaveBeenCalledTimes(1)
    expect(b.source.panel.getSnapshot().error).toBe('host unreachable (service/unavailable)')

    b.source.inject().dismissError()
    expect(b.source.panel.getSnapshot().error).toBeUndefined()

    b.list.mockRejectedValueOnce(new Error('carrier lost'))
    b.source.inject().refresh()
    await settle()
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    unsubscribe()
  })

  it('runs a control verb with the observed revision and settles its pending marker', async () => {
    const b = bench()
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    await b.source.inject().control('restart', 'native:web', '7')
    expect(b.control).toHaveBeenCalledWith(
      { action: 'restart', targetId: 'native:web', expectedRevision: '7' },
      expect.anything(),
    )
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    const pending = b.source.inject().control('stop', 'native:web', '7')
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({ 'native:web': 'stop' })
    await pending
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    b.control.mockResolvedValueOnce(refusal('service/revision-changed', 'revision moved'))
    await b.source.inject().control('stop', 'native:web', '7')
    expect(b.source.panel.getSnapshot().error).toBe('revision moved (service/revision-changed)')
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    b.control.mockRejectedValueOnce(new Error('carrier lost'))
    await b.source.inject().control('stop', 'native:web', '7')
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    unsubscribe()
  })

  it('stops every group member and keeps their markers until the group settles', async () => {
    const b = bench()
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    const pending = b.source.inject().stopGroup([
      { targetId: 'docker:postgres', expectedRevision: '11' },
      { targetId: 'docker:redis', expectedRevision: '12' },
    ])
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({
      'docker:postgres': 'stop',
      'docker:redis': 'stop',
    })
    await pending
    expect(b.control).toHaveBeenNthCalledWith(
      1, { action: 'stop', targetId: 'docker:postgres', expectedRevision: '11' }, expect.anything(),
    )
    expect(b.control).toHaveBeenNthCalledWith(
      2, { action: 'stop', targetId: 'docker:redis', expectedRevision: '12' }, expect.anything(),
    )
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    // A member that refuses stops the group and reports the refusal.
    b.control.mockResolvedValueOnce(refusal('service/denied', 'not authorized'))
    await b.source.inject().stopGroup([
      { targetId: 'docker:postgres', expectedRevision: '11' },
      { targetId: 'docker:redis', expectedRevision: '12' },
    ])
    expect(b.control).toHaveBeenCalledTimes(3)
    expect(b.source.panel.getSnapshot().error).toBe('not authorized (service/denied)')
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    b.control.mockRejectedValueOnce(new Error('carrier lost'))
    await b.source.inject().stopGroup([{ targetId: 'docker:postgres', expectedRevision: '11' }])
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    unsubscribe()
  })

  it('opens a log viewer through its loading and loaded states and reports a refusal', async () => {
    const b = bench()
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().openLogs('native:web')
    expect(b.source.panel.getSnapshot()).toMatchObject({
      logsTargetId: 'native:web',
      logs: undefined,
      isLoadingLogs: true,
    })
    await settle()
    expect(b.logs).toHaveBeenCalledWith({ targetId: 'native:web', maxBytes: 16384 }, expect.anything())
    expect(b.source.panel.getSnapshot()).toMatchObject({ isLoadingLogs: false, logs: { chunks: [] } })

    b.logs.mockResolvedValueOnce(refusal('service/not-found', 'no retained log'))
    b.source.inject().openLogs('native:web')
    await settle()
    expect(b.source.panel.getSnapshot()).toMatchObject({
      isLoadingLogs: false,
      error: 'no retained log (service/not-found)',
    })

    b.logs.mockRejectedValueOnce(new Error('carrier lost'))
    b.source.inject().openLogs('native:web')
    await settle()
    expect(b.source.panel.getSnapshot()).toMatchObject({ isLoadingLogs: false, error: 'carrier lost' })

    b.source.inject().closeLogs()
    expect(b.source.panel.getSnapshot()).toMatchObject({
      logsTargetId: undefined,
      logs: undefined,
      isLoadingLogs: false,
    })
    unsubscribe()
  })

  it('drops a superseded log read', async () => {
    const releases: Array<(value: RemoteResult<ApiServiceLogsView>) => void> = []
    const b = bench({
      logs: () => new Promise<RemoteResult<ApiServiceLogsView>>((resolve) => { releases.push(resolve) }),
    })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().openLogs('native:web')
    b.source.inject().openLogs('native:other')
    expect(releases).toHaveLength(2)

    // The first read resolves after the second opened, so it publishes nothing.
    releases[0]?.({ ok: true, value: { chunks: [], truncated: false, gap: false } })
    await settle()
    expect(b.source.panel.getSnapshot()).toMatchObject({ logsTargetId: 'native:other', logs: undefined })

    releases[1]?.({ ok: true, value: { chunks: [], truncated: false, gap: false } })
    await settle()
    expect(b.source.panel.getSnapshot().logs).toEqual({ chunks: [], truncated: false, gap: false })
    unsubscribe()
  })

  it('withdraws an open log viewer when the checkout changes', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().openLogs('native:web')
    await settle()
    expect(b.source.panel.getSnapshot().logsTargetId).toBe('native:web')

    b.source.inject().selectCheckout('feat')
    expect(b.source.panel.getSnapshot()).toMatchObject({
      selectedCheckoutId: 'feat',
      logsTargetId: undefined,
      logs: undefined,
      isLoadingLogs: false,
    })
    unsubscribe()
  })

  it('stops the stream and the reset listener when the source is disposed', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(1)

    b.source.dispose()
    await settle()
    expect((b.follow.mock.calls[0]?.[1])?.aborted).toBe(true)

    // A second dispose with no live activation is a no-op.
    b.source.dispose()
    unsubscribe()
    b.emitReset()
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(1)
  })

  it('keeps the stream alive while any observer remains and stops it with the last', async () => {
    const b = bench({ frames: [frame(inventory(), 'baseline')] })
    const first = b.source.panel.subscribe(() => {})
    const second = b.source.panel.subscribe(() => {})
    await settle()
    expect(b.follow).toHaveBeenCalledTimes(1)

    first()
    await settle()
    // One observer remains, so the stream is still the same generation.
    expect((b.follow.mock.calls[0]?.[1])?.aborted).toBe(false)

    second()
    await settle()
    expect((b.follow.mock.calls[0]?.[1])?.aborted).toBe(true)
  })

  it('drops a superseded refresh and reports only the newest one', async () => {
    const settlers: Array<{ resolve: (value: RemoteResult<ApiServiceInventoryView>) => void; reject: (error: unknown) => void }> = []
    const b = bench({
      list: () => new Promise<RemoteResult<ApiServiceInventoryView>>((resolve, reject) => { settlers.push({ resolve, reject }) }),
    })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    b.source.inject().refresh()
    b.source.inject().refresh()
    expect(settlers).toHaveLength(2)

    settlers[0]?.resolve({ ok: true, value: inventory() })
    await settle()
    // The superseded read publishes nothing, so the snapshot keeps no inventory.
    expect(b.source.panel.getSnapshot().inventory).toBeUndefined()

    settlers[1]?.resolve({ ok: true, value: inventory({ revision: '9' }) })
    await settle()
    expect(b.source.panel.getSnapshot().inventory?.revision).toBe('9')

    b.source.inject().refresh()
    b.source.inject().refresh()
    expect(settlers).toHaveLength(4)
    settlers[2]?.reject('carrier lost')
    await settle()
    // The superseded read's rejection is not the operator's failure.
    expect(b.source.panel.getSnapshot().error).toBeUndefined()
    settlers[3]?.reject('carrier lost')
    await settle()
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    unsubscribe()
  })

  it('drops a superseded control, group stop, and log read', async () => {
    const controls: Array<{ resolve: (value: RemoteResult<never>) => void; reject: (error: unknown) => void }> = []
    const logs: Array<{ resolve: (value: RemoteResult<ApiServiceLogsView>) => void; reject: (error: unknown) => void }> = []
    const b = bench({
      control: () => new Promise<RemoteResult<never>>((resolve, reject) => { controls.push({ resolve, reject }) }),
      logs: () => new Promise<RemoteResult<ApiServiceLogsView>>((resolve, reject) => { logs.push({ resolve, reject }) }),
    })
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()

    const stale = b.source.inject().control('stop', 'native:web', '7')
    const fresh = b.source.inject().control('restart', 'native:web', '8')
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({ 'native:web': 'restart' })
    controls[0]?.resolve(settled)
    await stale
    // The superseded call reports nothing, but it did release its marker.
    expect(b.source.panel.getSnapshot().error).toBeUndefined()
    controls[1]?.resolve(settled)
    await fresh
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    const staleGroup = b.source.inject().stopGroup([{ targetId: 'docker:postgres', expectedRevision: '11' }])
    const freshGroup = b.source.inject().stopGroup([{ targetId: 'docker:redis', expectedRevision: '12' }])
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({
      'docker:postgres': 'stop',
      'docker:redis': 'stop',
    })
    controls[2]?.resolve(settled)
    await staleGroup
    controls[3]?.resolve(settled)
    await freshGroup
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})
    expect(b.source.panel.getSnapshot().error).toBeUndefined()

    b.source.inject().openLogs('native:web')
    b.source.inject().openLogs('native:other')
    logs[0]?.reject(new Error('too late'))
    await settle()
    // The superseded read's rejection is not the operator's failure.
    expect(b.source.panel.getSnapshot().error).toBeUndefined()
    logs[1]?.resolve({ ok: true, value: { chunks: [], truncated: false, gap: false } })
    await settle()
    expect(b.source.panel.getSnapshot().logs).toEqual({ chunks: [], truncated: false, gap: false })

    // A rejected read that a newer verb already superseded says nothing.
    b.source.inject().openLogs('native:web')
    b.source.inject().closeLogs()
    logs[2]?.reject(new Error('too late'))
    await settle()
    expect(b.source.panel.getSnapshot().error).toBeUndefined()

    // A verb whose read rejects after a newer verb started reports nothing.
    const staleControl = b.source.inject().control('stop', 'native:web', '7')
    const freshControl = b.source.inject().control('stop', 'native:other', '7')
    expect(controls).toHaveLength(6)
    controls[4]?.reject(new Error('too late'))
    await staleControl
    expect(b.source.panel.getSnapshot().error).toBeUndefined()
    controls[5]?.reject(new Error('carrier lost'))
    await freshControl
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    expect(b.source.panel.getSnapshot().pendingActions).toEqual({})

    const staleStop = b.source.inject().stopGroup([{ targetId: 'docker:postgres', expectedRevision: '11' }])
    const freshStop = b.source.inject().stopGroup([{ targetId: 'docker:redis', expectedRevision: '12' }])
    controls[6]?.reject(new Error('too late'))
    await staleStop
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost')
    controls[7]?.reject(new Error('carrier lost again'))
    await freshStop
    expect(b.source.panel.getSnapshot().error).toBe('carrier lost again')
    unsubscribe()
  })

  it('ignores a follow frame that arrives after the source stopped observing', async () => {
    const follow = vi.fn(() => {
      const stream: AsyncIterable<ApiServiceFeedFrameView> = {
        [Symbol.asyncIterator]: async function* () {
          yield frame(inventory(), 'baseline')
          await new Promise(resolve => setTimeout(resolve, 0))
          yield frame(inventory({ revision: '99' }))
        },
      }
      return stream
    })
    const source = createProjectServicesPanelSource({
      remote: { follow, list: vi.fn(), logs: vi.fn(), control: vi.fn() },
      subscribeReset: () => () => {},
    })
    const unsubscribe = source.panel.subscribe(() => {})
    await settle()
    expect(source.panel.getSnapshot().inventory?.revision).toBe('1')

    unsubscribe()
    await new Promise(resolve => setTimeout(resolve, 0))
    await settle()
    expect(source.panel.getSnapshot().inventory?.revision).toBe('1')
  })

  it('hands the panel hook and every verb through one inject face', async () => {
    const b = bench()
    const unsubscribe = b.source.panel.subscribe(() => {})
    await settle()
    const face = b.source.inject()

    expect(face.hooks.panel).toBe(b.source.panel)
    expect(typeof face.selectCheckout).toBe('function')
    expect(typeof face.refresh).toBe('function')
    expect(typeof face.control).toBe('function')
    expect(typeof face.stopGroup).toBe('function')
    expect(typeof face.openLogs).toBe('function')
    expect(typeof face.closeLogs).toBe('function')
    expect(typeof face.dismissError).toBe('function')

    // Every verb settles without rejecting, so a component may `void` it.
    face.refresh()
    await expect(face.control('stop', 'native:web', '7')).resolves.toBeUndefined()
    await expect(face.stopGroup([{ targetId: 'native:web', expectedRevision: '7' }])).resolves.toBeUndefined()
    face.openLogs('native:web')
    face.closeLogs()
    face.dismissError()
    await settle()
    unsubscribe()
  })
})
