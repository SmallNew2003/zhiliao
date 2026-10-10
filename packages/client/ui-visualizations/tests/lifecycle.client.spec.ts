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
  const send = vi.fn()
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
  const send = vi.fn()
  const port = { postMessage: send, close() {}, start() {}, onmessage: null } as unknown as MessagePort
  const bridge = new PreviewBridge(port, 'g', Config({ maxExportBytes: 3 }), () => {})
  const pending = bridge.export('svg')
  bridge.receive({ generation: 'g', type: 'export', requestId: sentRequestId(send) as string, mime: 'image/svg+xml', data: '你好' })
  await expect(pending).rejects.toThrow('exportTooLarge')
  bridge.dispose()
})
