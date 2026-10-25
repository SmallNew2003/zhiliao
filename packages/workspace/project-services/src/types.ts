/**
 * Shared JSON records and trusted Host capabilities for project services.
 * @module
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Canonical repository identity within one execution world. */
export type ServiceProjectId = Branded<'ServiceProjectId'>
/** Canonical checkout identity within one project. */
export type ServiceCheckoutId = Branded<'ServiceCheckoutId'>
/** Provider-qualified opaque service identity. */
export type ServiceTargetId = Branded<'ServiceTargetId'>
/** Caller-issued idempotency key, scoped to its actor and project. */
export type ServiceRequestId = Branded<'ServiceRequestId'>
/** Opaque revision for optimistic concurrency. */
export type ServiceRevision = Branded<'ServiceRevision'>
/** Provider contribution identity. */
export type ServiceProviderId = Branded<'ServiceProviderId'>
/** Host operation identity. */
export type ServiceOperationId = Branded<'ServiceOperationId'>
/** Independent reader position. */
export type ServiceCursor = Branded<'ServiceCursor'>
/** Identity of the environment in which paths and commands resolve. */
export type ServiceExecutionIdentity = Branded<'ServiceExecutionIdentity'>
/** Trusted actor identity, never inferred from a request body. */
export type ServiceActorId = Branded<'ServiceActorId'>

/** Project facts resolved from the current filesystem and Git metadata. */
export interface ServiceProject {
  id: ServiceProjectId
  path: string
  executionIdentity: ServiceExecutionIdentity
  gitCommonDir?: string
}

/** Current local directory or captured checkout for a still-owned managed resource. */
export interface ServiceCheckout {
  /** Missing captured directories remain readable but cannot receive launches. */
  availability: 'present' | 'missing'
  id: ServiceCheckoutId
  projectId: ServiceProjectId
  path: string
}

/** Saved command arguments. Raw environment values and credentials are never stored here. */
export interface ServiceCommand {
  argv: readonly string[]
}

/** Native launch definition persisted after resolved operation authorization. */
export interface ServiceDefinition {
  id: ServiceTargetId
  projectId: ServiceProjectId
  checkoutId: ServiceCheckoutId
  name: string
  command: ServiceCommand
  revision: ServiceRevision
}

/** Explicit association for resources whose identity outlives a checkout scan. */
export interface ServiceAssociation {
  id: ServiceTargetId
  projectId: ServiceProjectId
  checkoutId: ServiceCheckoutId
  providerId: ServiceProviderId
  revision: ServiceRevision
}

/** Available actions apply only to this observed revision. */
export interface ServiceItem {
  id: ServiceTargetId
  providerId: ServiceProviderId
  projectId: ServiceProjectId
  checkoutId: ServiceCheckoutId
  revision: ServiceRevision
  name: string
  kind: 'native' | 'docker'
  state: 'running' | 'stopped' | 'starting' | 'unknown'
  ownership: 'managed' | 'external'
  actions: readonly ServiceAction[]
  ports?: readonly number[]
  command?: ServiceCommand
  detail?: string
  definitionId?: ServiceTargetId
  /** Retained observation whose provider could not refresh its facts. */
  stale?: boolean
}

/** Exact provider grouping. Hidden members make the entire group unreadable. */
export interface ServiceGroup {
  id: ServiceTargetId
  providerId: ServiceProviderId
  projectId: ServiceProjectId
  checkoutId: ServiceCheckoutId
  name: string
  revision: ServiceRevision
  targetIds: readonly ServiceTargetId[]
  stale?: boolean
}

/** Explicit scan health. Failed scans never masquerade as empty success. */
export interface ServiceProviderStatus {
  id: ServiceProviderId
  kind: 'native' | 'docker'
  state: 'ready' | 'stale' | 'unavailable'
  observedAt: number
  reason?: string
}

/** Mutating actions accepted by the runtime. */
export type ServiceAction = 'start' | 'stop' | 'restart'

/** Exact target facts shown to the trusted authorization callback. */
export interface ResolvedServiceOperation {
  action: ServiceAction
  project: ServiceProject
  checkout: ServiceCheckout
  /** Nonempty exact instance set, including the reserved identity of a new launch. */
  targets: readonly { id: ServiceTargetId; revision: ServiceRevision }[]
  nativeLaunch?: {
    /** Reserved identity of the range created by this launch. */
    targetId?: ServiceTargetId
    command: ServiceCommand
    cwd: string
    executionIdentity: ServiceExecutionIdentity
  }
  docker?: {
    context: string
    /**
     * Docker-owned identifiers, deliberately unbranded: they name resources in
     * the external daemon rather than harness entities, are minted by the Docker
     * CLI, and reach the model only inside an immutable operation description.
     */
    daemonId: string
    containerIds: readonly string[]
  }
}

/** Resources on which read policy is evaluated before emission. */
export type ServiceReadable =
  | ServiceProject | ServiceCheckout | ServiceItem | ServiceGroup
  | ServiceDefinition | ServiceAssociation | ServiceOperation | ServiceProviderStatus

/** Host lifetime and subprocess realm captured by the native provider. */
export interface ServiceNativeLifetime {
  subprocessRealm: symbol | undefined
  signal: AbortSignal
}

/** Owned native range with one consuming output stream and independent exit facts. */
export interface ServiceNativeProcess {
  done: Promise<SubprocessOutcome>
  /** Read newly captured output once, for retention by the native provider. */
  readOutput(): { text: string; lossy: boolean }
  /** Terminate the owned range and await quiescence; failures reject. */
  terminate(): Promise<void>
  /** Wait for range quiescence, independent of direct command outcome. */
  waitForExit(): Promise<void>
  /**
   * Observe provider-owned membership without external signalling authority.
   * @param pid - Currently observed process id.
   * @returns Membership or undefined when unavailable.
   */
  ownsProcess?(pid: number): Promise<boolean | undefined>
}

/** Exact launch facts and a capability that uses Host cancellation at publication. */
export interface ServiceNativeLaunch {
  command: ServiceCommand
  cwd: string
  /**
   * Start the prepared native range.
   * @param signal - Host-owned cancellation.
   * @returns Owned process range.
   */
  start(signal: AbortSignal): Promise<ServiceNativeProcess>
}

/** Trusted shell adapter preflights confinement and shares the native provider's Host lifetime. */
export interface ServiceNativeExecution {
  lifetime: ServiceNativeLifetime
  /**
   * Resolve all launch prerequisites without creating a process.
   * @param command - Authorized argv to execute through the sandboxed shell.
   * @param cwd - Exact checkout directory.
   * @param signal - Preparation cancellation.
   * @returns Exact resolved launch capability.
   */
  resolve(command: ServiceCommand, cwd: string, signal: AbortSignal): Promise<ServiceNativeLaunch>
}

/** Trusted same-process authority. JSON requests cannot supply these callbacks. */
export interface ServiceAccess {
  actorId: ServiceActorId
  kind: 'human' | 'agent'
  cwd: string
  executionIdentity: ServiceExecutionIdentity
  /**
   * Authorize the exact resolved operation before any lifecycle side effect.
   * @param operation - Deeply immutable resolved facts.
   * @param signal - Approval cancellation.
   * @returns Resolves only on authorization.
   */
  authorize(operation: ResolvedServiceOperation, signal: AbortSignal): Promise<void>
  /**
   * Evaluate current read authority for a candidate response resource.
   * @param resource - Candidate output.
   * @param signal - Read cancellation.
   * @returns Whether this actor may read it.
   */
  canRead(resource: ServiceReadable, signal: AbortSignal): Promise<boolean>
  /**
   * Recheck authority after approval and before response filtering.
   * Reject changed authority for an approved operation; reads apply any refreshed scope to immutable candidate facts.
   * @param signal - Cancellation.
   * @returns Resolves when current sandbox and approval policies remain valid.
   */
  revalidate(signal: AbortSignal): Promise<void>
  nativeExecution?: ServiceNativeExecution
}

/** Current-project paging request. Cursors bind to a snapshot revision. */
export interface ServiceListRequest {
  cursor?: ServiceCursor
  limit?: number
}

/** Independent bounded read of one source. */
export interface ServiceLogsRequest {
  targetId: ServiceTargetId
  cursor?: ServiceCursor
  maxBytes?: number
}

/** New definition or revision-bound operation on an existing target. */
export type ServiceControlRequest = { requestId: ServiceRequestId } & (
  | {
    action: 'start'
    definition: { name: string; checkoutId: ServiceCheckoutId; command: ServiceCommand }
  }
  | {
    action: ServiceAction
    targetId: ServiceTargetId
    expectedRevision: ServiceRevision
  }
)

/** Per-target outcome, including resources not attempted after partial failure. */
export interface ServiceTargetOutcome {
  targetId: ServiceTargetId
  state: 'succeeded' | 'failed' | 'unattempted'
  message?: string
}

/** Published Host-owned operation. Status survives initiator cancellation. */
export interface ServiceOperation {
  id: ServiceOperationId
  requestId: ServiceRequestId
  actorId: ServiceActorId
  projectId: ServiceProjectId
  checkoutId: ServiceCheckoutId
  action: ServiceAction
  targetIds: readonly ServiceTargetId[]
  state: 'running' | 'succeeded' | 'failed'
  outcomes: readonly ServiceTargetOutcome[]
}

/** Response omits both operation and pending when the current read policy denies status access. */
export interface ServiceControlResult {
  operation?: ServiceOperation
  /** Absent together with operation when status is unreadable. */
  pending?: boolean
}

/** Read-authorized current project inventory. */
export interface ServiceInventory {
  project: ServiceProject
  checkouts: readonly ServiceCheckout[]
  items: readonly ServiceItem[]
  definitions: readonly ServiceDefinition[]
  groups: readonly ServiceGroup[]
  providers: readonly ServiceProviderStatus[]
  operations: readonly ServiceOperation[]
  revision: ServiceRevision
  nextCursor?: ServiceCursor
}

/** One retained text fragment with its source identity. */
export interface ServiceLogChunk {
  targetId: ServiceTargetId
  stream: 'stdout' | 'stderr' | 'combined'
  text: string
}

/** Reader-local cursor and loss facts. Metadata counts toward the response byte cap. */
export interface ServiceLogPage {
  chunks: readonly ServiceLogChunk[]
  nextCursor?: ServiceCursor
  truncated: boolean
  gap: boolean
  unavailable?: string
}

/** Item fields every public service view publishes identically. */
export interface ServiceItemViewTail {
  actions: string[]
  ports?: number[]
  detail?: string
  stale?: boolean
}

/** One public log chunk with its source identity. */
export interface ServiceLogChunkView {
  targetId: string
  stream: 'stdout' | 'stderr' | 'combined'
  text: string
}

/**
 * Public projection of one retained log page. Keys publish in a fixed order:
 * `chunks`, `truncated`, `gap`, then the optional `nextCursor` and
 * `unavailable`.
 */
export interface ServiceLogsView {
  chunks: ServiceLogChunkView[]
  truncated: boolean
  gap: boolean
  nextCursor?: string
  unavailable?: string
}

/** Reconnect always starts with a fresh baseline. */
export type ServiceFeedFrame = {
  kind: 'baseline' | 'updated'
  snapshot: ServiceInventory
}

/** Resolved project and durable inputs supplied to a provider. */
export interface ServiceProviderContext {
  project: ServiceProject
  checkouts: readonly ServiceCheckout[]
  definitions: readonly ServiceDefinition[]
  associations: readonly ServiceAssociation[]
  /** Candidate identity for a new definition, persisted only after authorization. */
  pendingDefinition?: ServiceDefinition
}

/** A fresh provider observation. */
export interface ServiceProviderSnapshot {
  /**
   * Previously verified project-bound checkout facts for resources this provider still owns.
   * The runtime admits a missing checkout only alongside a matching managed item and permits read/stop only.
   */
  capturedCheckouts?: readonly ServiceCheckout[]
  items: readonly ServiceItem[]
  groups: readonly ServiceGroup[]
  status: ServiceProviderStatus
}

/** Settled per-target outcomes. Newly created targets return their actual ids. */
export interface ServiceExecutionResult {
  outcomes: readonly ServiceTargetOutcome[]
  associations?: readonly ServiceAssociation[]
}

/** Side-effect-free preparation must resolve both phases of a restart. */
export interface PreparedServiceOperation {
  description: ResolvedServiceOperation
  /**
   * Recheck all facts represented by the approved operation.
   * @param signal - Prepublication cancellation.
   * @returns Resolves after exact target identities and revisions still match.
   */
  validate(signal: AbortSignal): Promise<void>
  /**
   * Apply the prepared action to its frozen target set.
   * @param signal - Host-owned cancellation, independent of the initiator.
   * @returns Exact per-target outcomes.
   */
  execute(signal: AbortSignal): Promise<ServiceExecutionResult>
}

/** Host-only contribution with effect-owned registrations and subscriptions. */
export interface ProjectServiceProvider {
  id: ServiceProviderId
  kind: 'native' | 'docker'
  /**
   * Inspect current resources without lifecycle side effects.
   * @param context - Resolved project.
   * @param signal - Scan cancellation.
   * @returns Fresh observations.
   */
  inspect(context: ServiceProviderContext, signal: AbortSignal): Promise<ServiceProviderSnapshot>
  /**
   * Resolve the complete operation before requesting approval.
   * @param context - Resolved project and optional new definition identity.
   * @param request - Requested operation.
   * @param access - Trusted initiator.
   * @param signal - Preparation cancellation.
   * @returns Side-effect-free resolved operation.
   */
  prepare(
    context: ServiceProviderContext, request: ServiceControlRequest, access: ServiceAccess, signal: AbortSignal,
  ): Promise<PreparedServiceOperation>
  /**
   * Read a bounded independent log page.
   * @param target - Authorized observed resource.
   * @param request - Reader-local cursor and complete JSON byte cap.
   * @param signal - Read cancellation.
   * @returns Independent log page.
   */
  logs(target: ServiceItem, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage>
  /**
   * Subscribe to resource changes until disposal.
   * @param changed - Notification that observations may have changed.
   * @returns Disposer that prevents later notifications.
   */
  subscribe?(changed: () => void): () => void
}
