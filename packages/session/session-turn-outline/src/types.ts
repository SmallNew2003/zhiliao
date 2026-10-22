/**
 * Pure types of the turn-outline domain: the ONE home of the `turnOutline`
 * projection-key declaration, free of this package's host-side value imports
 * (zod, the projection definition). Host consumers import `./types`; client
 * aggregates import `./client`, which re-exports this module.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

export {}

/** One started turn's outline facts, independent of what a client has paged in. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number (the `turn/start` payload). */
  readonly turn: number
  /** Earliest seq needed to load the turn, including a preceding edit event. */
  readonly seq: SessionSeq
  /** Bounded first-human-prompt preview (one rail-card line); `''` until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview (up to three rail-card lines); `''` until the turn ends with assistant text. */
  readonly response: string
}

/**
 * Fold state: served entries, response draft, and one pre-latest-input snapshot.
 * A pending edit supplies the next turn's prompt and paging anchor. The
 * draft buffers the newest text-bearing assistant message until `turn/end`
 * commits it, and the wire view projects only `turns` — draft-only applies
 * keep that array's identity, so the change feed stays quiet between turn
 * boundaries.
 */
export interface TurnOutlineState {
  /** Started turns in ascending turn order. */
  readonly turns: readonly TurnOutlineEntry[]
  /** Newest text-bearing assistant preview of the open turn; `''` outside one. */
  readonly draft: string
  /** Effective outline immediately before the latest human input. */
  readonly latestInput: { readonly seq: SessionSeq; readonly turns: readonly TurnOutlineEntry[]; readonly draft: string } | null
  /** Edited input awaiting the next turn boundary. */
  readonly pendingEdit: { readonly seq: SessionSeq; readonly prompt: string } | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whole-log turn outline fold state (entries plus the open turn's response draft). */
    turnOutline: TurnOutlineState
  }
  interface SessionProjectionMap {
    /** Every started turn with its `turn/start` seq and bounded previews, strictly increasing by turn; see {@link TurnOutlineEntry}. */
    turnOutline: readonly TurnOutlineEntry[]
  }
}
