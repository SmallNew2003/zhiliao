/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
import { useLayoutEffect, useState } from 'react'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import { FOLLOW_THRESHOLD, type ChatReading, type ReadingSample } from './use-chat-reading.ts'
import type { ChatViewport } from './use-chat-viewport.ts'

/** History availability and loading operations for the committed Chat window. */
export interface ChatNavigationInput extends Pick<ChatViewSlotProps, 'loadOlder' | 'loadThrough'> {
  readonly firstSeq: ChatNode['anchorSeq'] | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
}

/** Distance from the history head that starts the next older page without a click. */
const OLDER_PREFETCH_PX = 600

interface TurnJump {
  readonly turn: number
  readonly seq: SessionSeq
  phase: 'loading' | 'settled'
  landing: 'pending' | 'landed' | 'interrupted'
  repageHead: ChatNavigationInput['firstSeq']
}

/** Owns one replaceable turn jump and the anchor retained while history loads. */
export class ChatNavigation {
  private jump: TurnJump | null = null
  private settleFrame: number | null = null
  /** Head seq a view-initiated pull must lower; null when none is outstanding. */
  private pullHead: ChatNavigationInput['firstSeq'] = null
  /** A settled pull that left the head unchanged stops auto-paging until the reader retries. */
  private stalled = false

  constructor(
    private readonly viewport: ChatViewport,
    private readonly reading: ChatReading,
    private input: ChatNavigationInput,
    private readonly onBusyTurn: (turn: number | null) => void,
  ) {}

  /**
   * Adopt committed history availability without starting a request.
   * @param input - history state from the latest committed render.
   */
  setInput(input: ChatNavigationInput): void {
    const wasLoading = this.input.loadingOlder
    this.input = input
    // A view-initiated pull settled: classify its delivery after the commit that
    // prepended the page, never while the request is still open.
    if (wasLoading && !input.loadingOlder && this.pullHead !== null) this.settlePull(input.firstSeq)
  }

  /** Cancel navigation when opening a Chat view. */
  reset(): void {
    this.cancel()
    this.stalled = false
    this.pullHead = null
  }

  /** Cancel local callbacks; late history completions cannot revive a task. */
  dispose(): void {
    this.clearTask()
  }

  /** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
  cancel(): void {
    this.clearTask()
    this.onBusyTurn(null)
  }

  private clearTask(): void {
    this.cancelFrame()
    this.jump = null
    this.viewport.stopPreserving()
  }

  /**
   * Replace the current jump with an explicit turn selection.
   * @param item - loaded anchor or unloaded turn to fetch before landing.
   */
  readonly navigateToTurn = (item: TurnRailItem): void => {
    if (item.anchor.kind === 'loaded') {
      this.cancel()
      const landing = this.viewport.scrollToTurn(item.turn)
      if (landing === null) return
      this.reading.acceptNavigation(landing)
      if (this.input.loadingOlder) this.viewport.beginPreserving(landing.position)
      return
    }
    this.cancel()
    this.viewport.beginPreserving()
    this.reading.pauseFollowing()
    const jump: TurnJump = {
      turn: item.turn,
      seq: item.anchor.seq,
      phase: 'loading',
      landing: 'pending',
      repageHead: null,
    }
    this.jump = jump
    this.onBusyTurn(jump.turn)
    this.request(jump)
  }

  /** Request one older page while retaining the current semantic position. */
  readonly loadEarlier = (): void => {
    this.cancel()
    this.stalled = false
    this.viewport.beginPaging()
    this.reading.pauseFollowing()
    this.input.loadOlder()
  }

  /**
   * Page in older history when the reader approaches the head, without a click.
   * A reader following the live tail is not approaching the head: a window
   * shorter than the margin keeps an at-floor reader under it without reader
   * intent, so the distance to the floor — not the position alone — decides.
   * A settled pull that delivered nothing leaves the retry to the reader; the
   * manual button stays the fallback.
   */
  readonly maybeLoadOlder = (): void => {
    if (this.stalled || this.pullHead !== null) return
    if (!this.input.hasMore || this.input.loadingOlder) return
    if (this.jump !== null) return
    // A scrollport without layout (hidden view, pre-paint) has no reader
    // position to compare; the next scroll event or commit retries.
    const metrics = this.viewport.metrics()
    if (metrics === null || metrics.height === 0) return
    if (metrics.floor - metrics.top <= FOLLOW_THRESHOLD + 1) return
    if (metrics.top > OLDER_PREFETCH_PX) return
    this.pullHead = this.input.firstSeq
    this.viewport.beginPaging()
    this.reading.pauseFollowing()
    this.input.loadOlder()
  }

  /**
   * Classify a settled view-initiated pull. An unmoved head delivered nothing,
   * so auto-paging waits for the reader; a moved head chains the next page
   * while the reader remains inside the headroom. The chain runs after the
   * frame that prepended the page, so its anchor is captured from the
   * corrected position rather than the pre-prepend one.
   */
  private settlePull(firstSeq: ChatNavigationInput['firstSeq']): void {
    const delivered = !(this.pullHead !== null && firstSeq === this.pullHead)
    this.pullHead = null
    if (!delivered) {
      this.stalled = true
      return
    }
    this.stalled = false
    if (typeof requestAnimationFrame !== 'function') this.maybeLoadOlder()
    else requestAnimationFrame(() => { this.maybeLoadOlder() })
  }

  /**
   * Preserve reader ownership across pending history work.
   * @param sample - settled reader movement that can update or interrupt an anchor.
   */
  readerSampled(sample: ReadingSample): void {
    if (sample.movedByReader && this.jump?.landing === 'landed') this.jump.landing = 'interrupted'
    if (sample.followingTail || sample.movedByReader) this.viewport.stopPreserving()
  }

  /**
   * Preserve one paging anchor after a commit or a later size change, regardless of head identity.
   * @returns whether the retained anchor handled the layout change.
   */
  contentCommitted(): boolean {
    if (!this.viewport.preserving || this.reading.pending) return false
    if (this.landJump(false)) return true
    const landing = this.viewport.preserve()
    if (landing === null) return false
    this.reading.preservePosition(landing)
    return true
  }

  /** Retarget a still-loading page only after inner or outer reader scrolling ends. */
  readerSettled(): void {
    if (this.input.loadingOlder && this.jump === null && !this.viewport.preserving && !this.reading.followingTail) {
      this.viewport.beginPreserving()
    }
  }

  /** Land, retry, or complete the current jump against the committed window. */
  reconcile(): void {
    const jump = this.jump
    if (jump === null || this.reading.pending) return
    if (jump.phase === 'loading') {
      if (jump.landing === 'pending') this.landJump(false)
      return
    }
    if (this.input.loadingOlder) return
    if (this.landJump(true)) return
    const uncovered = this.input.firstSeq === null || this.input.firstSeq > jump.seq
    if (uncovered && this.input.hasMore && jump.repageHead !== this.input.firstSeq) {
      jump.repageHead = this.input.firstSeq
      this.viewport.beginPreserving()
      this.request(jump)
      return
    }
    const fallback = this.viewport.scrollToTurnAtOrAfter(jump.turn)
    this.cancel()
    if (fallback !== null) this.reading.acceptNavigation(fallback)
    // A jump lands on the reader row nearest the head once history is
    // exhausted or its row is gone: page the next older one in so scrolling on
    // from there stays seamless.
    this.maybeLoadOlder()
  }

  private landJump(settle: boolean): boolean {
    const jump = this.jump
    if (jump === null) return false
    if (jump.landing === 'interrupted') {
      if (settle) { this.cancel(); return true }
      return false
    }
    const landing = this.viewport.scrollToTurn(jump.turn)
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (settle) this.cancel()
    else {
      this.viewport.beginPreserving(landing.position)
      jump.landing = 'landed'
    }
    return true
  }

  private request(jump: TurnJump): void {
    jump.phase = 'loading'
    const settled = (): void => {
      if (this.jump !== jump) return
      jump.phase = 'settled'
      this.cancelFrame()
      if (typeof requestAnimationFrame !== 'function') this.reconcile()
      else this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = null
        if (this.jump === jump) this.reconcile()
      })
    }
    void this.input.loadThrough(jump.seq).then(settled, settled)
  }

  private cancelFrame(): void {
    if (this.settleFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.settleFrame)
    this.settleFrame = null
  }
}

/**
 * Retain one navigation owner for the component's lifetime.
 * @param viewport - turn-aware DOM operations.
 * @param reading - reading and follow policy receiving navigation landings.
 * @param input - committed history state and load operations.
 * @returns the navigation owner and its visible busy turn.
 */
export function useChatNavigation(
  viewport: ChatViewport, reading: ChatReading, input: ChatNavigationInput,
): { navigation: ChatNavigation; busyTurn: number | null } {
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [navigation] = useState(() => new ChatNavigation(viewport, reading, input, setBusyTurn))
  useLayoutEffect(() => { navigation.setInput(input) }, [navigation, input])
  useLayoutEffect(() => () => { navigation.dispose() }, [navigation])
  return { navigation, busyTurn }
}
