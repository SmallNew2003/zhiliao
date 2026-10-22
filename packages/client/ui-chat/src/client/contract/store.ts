/** Chat-owned per-Session view state. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** One manually expanded Turn answer generation. */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
  processGroups: ProcessGroupViewEntry[]
}

/** One explicit process-group expansion choice. */
export interface ProcessGroupViewEntry {
  readonly key: string
  readonly open: boolean
}
