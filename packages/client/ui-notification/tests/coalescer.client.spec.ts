/**
 * Merge-window coverage: a burst collapses into one announcement per kind,
 * the window is debounced by the last trigger, and disposal drops what is
 * pending. Timers are injected so no fake clock is involved.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { NotificationCoalescer, type CoalescerTimers, type NotificationBatch } from '../src/coalescer.ts'
import type { NotificationTrigger } from '../src/planner.ts'

const sessionId = (value: string): SessionId => value as SessionId

/** Recording timers: run() advances the pending callback by hand. */
function benchTimers(): CoalescerTimers & { run(): void; pending: number } {
  let callback: (() => void) | undefined
  return {
    get pending() { return callback === undefined ? 0 : 1 },
    set: (fn) => { callback = fn; return callback },
    clear: () => { callback = undefined },
    run: () => { const fn = callback; callback = undefined; fn?.() },
  }
}

const trigger = (kind: NotificationTrigger['kind'], id: string): NotificationTrigger =>
  ({ kind, sessionId: sessionId(id) })

describe('NotificationCoalescer', () => {
  it('flushes one batch per kind after the window elapses', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('turn-complete', 's1'))
    expect(flush).not.toHaveBeenCalled()
    timers.run()
    expect(flush).toHaveBeenCalledWith([{ kind: 'turn-complete', sessionIds: [sessionId('s1')] }])
    coalescer.dispose()
  })

  it('merges a burst of the same kind into one batch, deduplicating sessions', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('turn-complete', 's1'))
    coalescer.push(trigger('turn-complete', 's2'))
    coalescer.push(trigger('turn-complete', 's1'))
    timers.run()
    expect(flush).toHaveBeenCalledWith([{ kind: 'turn-complete', sessionIds: [sessionId('s1'), sessionId('s2')] }])
    coalescer.dispose()
  })

  it('keeps kinds apart and emits them in the fixed kind order', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('error', 's1'))
    coalescer.push(trigger('turn-complete', 's1'))
    coalescer.push(trigger('awaiting-input', 's1'))
    timers.run()
    expect(flush.mock.calls[0]?.[0].map(batch => batch.kind)).toEqual(['turn-complete', 'awaiting-input', 'error'])
    coalescer.dispose()
  })

  it('restarts the window on every trigger, so a steady stream never outpaces it', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('turn-complete', 's1'))
    coalescer.push(trigger('turn-complete', 's2'))
    expect(timers.pending).toBe(1)
    timers.run()
    expect(flush).toHaveBeenCalledTimes(1)
    coalescer.dispose()
  })

  it('cancels the scheduled window on the process timers when disposed before it elapses', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
      const coalescer = new NotificationCoalescer(800, flush)
      coalescer.push(trigger('turn-complete', 's1'))
      coalescer.dispose()
      vi.advanceTimersByTime(800)
      expect(flush).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh window after a flush', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('turn-complete', 's1'))
    timers.run()
    coalescer.push(trigger('turn-complete', 's2'))
    timers.run()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush.mock.calls[1]?.[0]).toEqual([{ kind: 'turn-complete', sessionIds: [sessionId('s2')] }])
    coalescer.dispose()
  })

  it('flushes on the process timers when none are injected', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
      const coalescer = new NotificationCoalescer(800, flush)
      coalescer.push(trigger('turn-complete', 's1'))
      vi.advanceTimersByTime(799)
      expect(flush).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(flush).toHaveBeenCalledWith([{ kind: 'turn-complete', sessionIds: [sessionId('s1')] }])
      coalescer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the pending window on dispose without flushing', () => {
    const timers = benchTimers()
    const flush = vi.fn<(batches: readonly NotificationBatch[]) => void>()
    const coalescer = new NotificationCoalescer(800, flush, timers)
    coalescer.push(trigger('turn-complete', 's1'))
    coalescer.dispose()
    expect(timers.pending).toBe(0)
    expect(flush).not.toHaveBeenCalled()
  })
})
