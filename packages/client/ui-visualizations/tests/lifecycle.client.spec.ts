/** Budget arbitration and frame generation ownership. */
import { expect, it, vi } from 'vitest'
import { createPreviewBudget } from '../src/client/budget.ts'
import { PreviewBridge } from '../src/client/runtime/bridge.ts'
import { Config } from '../src/config.ts'

/** Narrow one recorded postMessage payload back to its request id. */
function sentRequestId(send: ReturnType<typeof vi.fn>): string | undefined {
  const payload: unknown = send.mock.calls.at(-1)?.[0]
  if (typeof payload !== 'object' || payload === null) return undefined
  const requestId: unknown = (payload as { readonly requestId?: unknown }).requestId
  return typeof requestId === 'string' ? requestId : undefined
}

it('bounds visible activity and requires explicit activation to evict another visible frame', () => {
  const budget = createPreviewBudget(1)
  budget.enter('a'); budget.enter('b')
  expect(budget.getSnapshot()).toEqual(['a'])
  budget.activate('b')
  expect(budget.getSnapshot()).toEqual(['b'])
  budget.leave('b')
  expect(budget.getSnapshot()).toEqual(['a'])
  budget.leave('a')
  expect(budget.getSnapshot()).toEqual([])
})

it('retires stale generations, unsolicited exports, readiness deadlines and port handlers', async () => {
  const received = vi.fn()
  const send = vi.fn<(message: { type: string; requestId: string }) => void>()
  const close = vi.fn()
  const port = { postMessage: send, close, start: vi.fn(), onmessage: null } as unknown as MessagePort
  const bridge = new PreviewBridge(port, 'generation', Config({}), received)
  bridge.receive({ generation: 'old', type: 'ready', title: 'stale', charts: [] })
  bridge.receive({ generation: 'generation', type: 'export', requestId: 'unsolicited', mime: 'image/svg+xml', data: '<svg/>' })
  expect(received).not.toHaveBeenCalled()
  bridge.receive({ generation: 'generation', type: 'height', height: 100000 })
  expect(received).toHaveBeenCalledWith({ type: 'height', height: 640 })
  const pending = bridge.export('svg')
  const requestId = sentRequestId(send)
  expect(requestId).toBeTypeOf('string')
  bridge.receive({ generation: 'generation', type: 'export', requestId: requestId as string, mime: 'image/svg+xml', data: '<svg/>' })
  await expect(pending).resolves.toMatchObject({ mime: 'image/svg+xml', data: '<svg/>' })
  const stale = bridge.export('svg')
  bridge.dispose()
  await expect(stale).rejects.toThrow('disposed')
  bridge.receive({ generation: 'generation', type: 'ready', title: 'late', charts: [] })
  expect(close).toHaveBeenCalledOnce()
  expect(port.onmessage).toBeNull()
})

it('rejects oversized and malformed export responses', async () => {
  const send = vi.fn<(message: { type: string; requestId: string }) => void>()
  const port = { postMessage: send, close() {}, start() {}, onmessage: null } as unknown as MessagePort
  const bridge = new PreviewBridge(port, 'g', Config({ maxExportBytes: 3 }), () => {})
  const pending = bridge.export('svg')
  bridge.receive({ generation: 'g', type: 'export', requestId: sentRequestId(send) as string, mime: 'image/svg+xml', data: '你好' })
  await expect(pending).rejects.toThrow('exportTooLarge')
  bridge.dispose()
})

it('validates readiness and error fields, updates themes, and settles timeout ownership', async () => {
  vi.useFakeTimers()
  try {
    const receive = vi.fn(), send = vi.fn<(message: { type: string; requestId: string }) => void>()
    const close = vi.fn()
    const port = { postMessage: send, close, start: vi.fn(), onmessage: null } as unknown as MessagePort
    const bridge = new PreviewBridge(port, 'g', Config({ readinessTimeoutMs: 10 }), receive)
    for (const value of [null, 'hello', {}, { generation: 'g', type: 'Host' }, { generation: 'g', type: 'ready', title: 1, charts: [] }, { generation: 'g', type: 'ready', title: 'x'.repeat(513), charts: [] }, { generation: 'g', type: 'ready', title: '', charts: 0 }, { generation: 'g', type: 'ready', title: '', charts: Array(65).fill('1') }, { generation: 'g', type: 'ready', title: '', charts: [1] }, { generation: 'g', type: 'ready', title: '', charts: ['a'.repeat(129)] }, { generation: 'g', type: 'height', height: 'bad' }, { generation: 'g', type: 'height', height: NaN }, { generation: 'g', type: 'error', error: 1 }, { generation: 'g', type: 'error', error: 'x'.repeat(4097) }]) bridge.receive(value)
    expect(receive).not.toHaveBeenCalled()
    port.onmessage?.({ data: { generation: 'g', type: 'ready', title: 'Hello', charts: ['1'] } } as MessageEvent)
    bridge.receive({ generation: 'g', type: 'ready', title: 'duplicate', charts: [] })
    expect(receive).toHaveBeenCalledOnce()
    bridge.theme({ colorScheme: 'dark', background: '#222', foreground: '#fff', accent: '#06f', fontFamily: 'system-ui', fontSize: 14 })
    expect(send.mock.calls[0]?.[0].type).toBe('theme')
    const exporting = bridge.export('png', '1')
    await expect(bridge.export('png', '1')).rejects.toThrow('exportPending')
    const timed = expect(exporting).rejects.toThrow('exportTimeout')
    await vi.advanceTimersByTimeAsync(10)
    await timed
    bridge.receive({ generation: 'g', type: 'error', error: 'failed' })
    bridge.receive({ generation: 'g', type: 'height', height: 200 })
    bridge.receive({ generation: 'g', type: 'error', error: 'duplicate' })
    bridge.receive({ generation: 'g', type: 'ready', title: 'late', charts: [] })
    expect(receive).toHaveBeenLastCalledWith({ type: 'error', error: 'failed' })
    await expect(bridge.export('png')).rejects.toThrow('disposed')
    bridge.dispose(); bridge.dispose()
    bridge.theme({ colorScheme: 'light', background: '', foreground: '', accent: '', fontFamily: '', fontSize: 14 })
    expect(close).toHaveBeenCalledOnce()
    const waiting = new PreviewBridge(port, 'g2', Config({ readinessTimeoutMs: 10 }), receive)
    await vi.advanceTimersByTimeAsync(10)
    expect(receive).toHaveBeenLastCalledWith({ type: 'error', error: 'readinessTimeout' })
    waiting.dispose()
  } finally { vi.useRealTimers() }
})

it('rejects mismatched MIME/data and unknown response ids without privileged effects', async () => {
  const send = vi.fn<(message: { type: string; requestId: string }) => void>()
  const port = { postMessage: send, close() {}, start() {}, onmessage: null } as unknown as MessagePort
  const bridge = new PreviewBridge(port, 'g', Config({}), () => {})
  try {
    for (const value of [{ mime: 'text/html', data: '<svg/>' }, { mime: 'image/svg+xml', data: 1 }]) {
      const exporting = bridge.export('svg')
      const requestId = send.mock.calls.at(-1)?.[0].requestId
      bridge.receive({ generation: 'g', type: 'export', requestId: 'old', ...value })
      bridge.receive({ generation: 'g', type: 'export', requestId, ...value })
      await expect(exporting).rejects.toThrow('invalidExport')
    }
  } finally { bridge.dispose() }
})

it('accepts Escape only from the live ready generation and retires it after failure', () => {
  const received = vi.fn()
  const port = { postMessage() {}, close() {}, start() {}, onmessage: null } as unknown as MessagePort
  const bridge = new PreviewBridge(port, 'g', Config({}), received)
  try {
    bridge.receive({ generation: 'g', type: 'escape' })
    bridge.receive({ generation: 'g', type: 'ready', title: '', charts: [] })
    received.mockClear()
    bridge.receive({ generation: 'old', type: 'escape' })
    expect(received).not.toHaveBeenCalled()
    bridge.receive({ generation: 'g', type: 'escape' })
    expect(received).toHaveBeenCalledWith({ type: 'escape' })
    bridge.receive({ generation: 'g', type: 'error', error: 'failed' })
    received.mockClear()
    bridge.receive({ generation: 'g', type: 'escape' })
    expect(received).not.toHaveBeenCalled()
  } finally { bridge.dispose() }
})
