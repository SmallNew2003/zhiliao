/**
 * Wire contracts for the ProjectServices Remote API.
 * @module
 */

/** Paging and directory scope for listing project services. */
export interface ApiServiceListRequest {
  cwd?: string
  cursor?: string
  limit?: number
}

/** Parameter options for reading retained service logs. */
export interface ApiServiceLogsRequest {
  cwd?: string
  targetId: string
  cursor?: string
  maxBytes?: number
}

/** Service launch definition input for starting a new native command. */
export interface ApiServiceLaunchDefinitionInput {
  name: string
  checkoutId: string
  command: string[]
}

/** Mutating control command for service lifecycles. */
export interface ApiServiceControlRequest {
  cwd?: string
  requestId?: string
  /**
   * Caller identity this mutation runs under. The Host rejects a mutation that
   * cannot name one, so an operation log entry always names a real caller
   * instead of one shared placeholder.
   */
  caller?: string
  action: 'start' | 'stop' | 'restart'
  /**
   * Target to stop or restart. Required unless `definition` launches a new
   * service; the Host rejects a target-bound mutation that omits it.
   */
  targetId?: string
  /**
   * Revision `list` reported for `targetId`. Required for every target-bound
   * mutation: a revision that no longer matches fails the call instead of
   * acting on a service the caller no longer sees.
   */
  expectedRevision?: string
  /** Launch definition for a new native service; valid only with `action: 'start'`. */
  definition?: ApiServiceLaunchDefinitionInput
}

/** Public representation of a service item in UI / Remote clients. */
export interface ApiServiceItemView {
  id: string
  providerId: string
  projectId: string
  checkoutId: string
  revision: string
  name: string
  kind: 'native' | 'docker'
  state: 'running' | 'stopped' | 'starting' | 'unknown'
  ownership: 'managed' | 'external'
  actions: string[]
  ports?: number[]
  detail?: string
  stale?: boolean
}

/** Public representation of a service group in UI / Remote clients. */
export interface ApiServiceGroupView {
  id: string
  name: string
  checkoutId: string
  revision: string
  targetIds: string[]
  stale?: boolean
}

/** Public representation of a service provider in UI / Remote clients. */
export interface ApiServiceProviderView {
  id: string
  kind: 'native' | 'docker'
  state: string
  observedAt: number
  reason?: string
}

/** Public representation of a Git checkout / worktree in UI / Remote clients. */
export interface ApiServiceCheckoutView {
  id: string
  path: string
  availability: 'present' | 'missing'
}

/** Public representation of a project services inventory snapshot. */
export interface ApiServiceInventoryView {
  project: {
    id: string
    path: string
  }
  checkouts: ApiServiceCheckoutView[]
  items: ApiServiceItemView[]
  groups: ApiServiceGroupView[]
  providers: ApiServiceProviderView[]
  revision: string
  nextCursor?: string
}

/** Single log chunk entry. */
export interface ApiServiceLogChunkView {
  targetId: string
  stream: 'stdout' | 'stderr' | 'combined'
  text: string
}

/** Public representation of a page of service logs. */
export interface ApiServiceLogsView {
  chunks: ApiServiceLogChunkView[]
  truncated: boolean
  gap: boolean
  nextCursor?: string
  unavailable?: string
}

/** Public representation of an authorized service operation outcome. */
export interface ApiServiceControlView {
  operation?: {
    id: string
    requestId: string
    actorId: string
    action: string
    targetIds: string[]
    state: string
    outcomes: {
      targetId: string
      state: string
    }[]
  }
  pending?: boolean
}

/** Streamed update frame for live subscription. */
export interface ApiServiceFeedFrameView {
  kind: 'baseline' | 'updated'
  snapshot: ApiServiceInventoryView
}
