/**
 * Merge window that turns a burst of triggers into one announcement per kind.
 * Several background sessions finishing together raise one notification
 * instead of one each, which is the behaviour the user asked for.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/coalescer
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NOTIFICATION_KINDS, type NotificationKind } from './notification-settings.ts'
import type { NotificationTrigger } from './planner.ts'

/** One merged announcement: a kind plus every session that earned it in the window. */
export interface NotificationBatch {
  /** Why the announcement is raised. */
  readonly kind: NotificationKind
  /** Sessions that earned the kind, in first-seen order. */
  readonly sessionIds: readonly SessionId[]
}

/** Timer primitives the coalescer schedules with; injectable for tests. */
export interface CoalescerTimers {
  /**
   * @param fn - callback to run once the delay elapses.
   * @param ms - delay in milliseconds.
   * @returns an opaque handle for {@link CoalescerTimers.clear}.
   */
  set(fn: () => void, ms: number): unknown
  /**
   * @param handle - handle returned by {@link CoalescerTimers.set}.
   */
  clear(handle: unknown): void
}

/** Process timers used when no injection supplies them. */
const PROCESS_TIMERS: CoalescerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/**
 * Debouncing merge window. Each trigger restarts the window, so a burst
 * collapses into one flush and a steady stream of announcements cannot
 * outpace the window and spam the OS notification centre.
 */
export class NotificationCoalescer {
  private readonly pending = new Map<NotificationKind, Set<SessionId>>()
  private handle: unknown

  /**
   * @param windowMs - quiet period after the last trigger before flushing.
   * @param flush - receives the merged batches, one per kind, in {@link NOTIFICATION_KINDS} order.
   * @param timers - scheduling primitives; defaults to the process timers.
   */
  constructor(
    private readonly windowMs: number,
    private readonly flush: (batches: readonly NotificationBatch[]) => void,
    private readonly timers: CoalescerTimers = PROCESS_TIMERS,
  ) {}

  /**
   * Record one trigger and restart the window.
   * @param trigger - announcement earned by one session.
   */
  push(trigger: NotificationTrigger): void {
    const sessions = this.pending.get(trigger.kind)
    if (sessions === undefined) this.pending.set(trigger.kind, new Set([trigger.sessionId]))
    else sessions.add(trigger.sessionId)
    if (this.handle !== undefined) this.timers.clear(this.handle)
    this.handle = this.timers.set(() => { this.emit() }, this.windowMs)
  }

  /** Flush early and drop the pending window. */
  dispose(): void {
    if (this.handle !== undefined) {
      this.timers.clear(this.handle)
      this.handle = undefined
    }
    this.pending.clear()
  }

  private emit(): void {
    this.handle = undefined
    const batches: NotificationBatch[] = []
    for (const kind of NOTIFICATION_KINDS) {
      const sessions = this.pending.get(kind)
      if (sessions === undefined || sessions.size === 0) continue
      batches.push({ kind, sessionIds: [...sessions] })
    }
    this.pending.clear()
    if (batches.length === 0) return
    this.flush(batches)
  }
}
