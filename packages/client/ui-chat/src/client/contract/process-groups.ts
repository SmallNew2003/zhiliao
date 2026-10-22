/** Process-group projection shared by the Chat snapshot and renderer. */
export type ProcessGroupActivity =
  | 'thinking' | 'read' | 'readImage' | 'write' | 'search' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** One stable renderer seat inside the ordered Chat flow. */
export type ProcessGroupSeat =
  | { readonly kind: 'node'; readonly key: string; readonly nodeKey: string; readonly part?: 'response' }
  | { readonly kind: 'group'; readonly key: string; readonly groupKey: string }

/** One member rendered inside a process group. */
export interface ProcessGroupMember {
  readonly nodeKey: string
  readonly part?: 'reasoning'
}

/** Aggregated activity for one consecutive process range. */
export interface ProcessGroupSummary {
  readonly counts: readonly { readonly kind: ProcessGroupActivity; readonly count: number }[]
  readonly toolCount: number
  readonly failedToolCount: number
  readonly running: ProcessGroupActivity | undefined
  readonly runningDetail: string
}

/** Current presentation for one stable process group. */
export interface ProcessGroup {
  readonly key: string
  readonly turn: number | undefined
  readonly members: readonly ProcessGroupMember[]
  readonly closed: boolean
  readonly summary: ProcessGroupSummary
}

/** Live process-group layout and keyed group data. */
export interface ChatProcessGroups {
  readonly layout: readonly ProcessGroupSeat[]
  get(key: string): ProcessGroup | undefined
}
