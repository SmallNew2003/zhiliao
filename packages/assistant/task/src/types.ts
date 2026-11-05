/** Browser-safe assistant and assistant-task vocabulary. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Durable identity of one global or project assistant. */
export type AssistantId = Branded<'assistant-id'>

/** Durable identity of one assistant task. */
export type AssistantTaskId = Branded<'assistant-task-id'>

/** Whether an assistant covers the Host or one registered project. */
export type AssistantKind = 'global' | 'project'

/** One durable assistant record as exposed to clients. */
export interface AssistantView {
  readonly id: AssistantId
  readonly kind: AssistantKind
  /** Registered Workspace of a project assistant; absent for the global assistant. */
  readonly workspaceId?: WorkspaceId
  /** Current persistent assistant Session. */
  readonly sessionId: SessionId
  /** Replaced assistant Sessions that must remain separated from user tasks. */
  readonly retiredSessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Lifecycle state of one assistant task. */
export type AssistantTaskStatus =
  | 'created'
  | 'running'
  | 'waiting-approval'
  | 'waiting-answer'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Structured task failure preserved across restarts. */
export interface AssistantTaskFailure {
  readonly code: string
  readonly message: string
}

/** One durable assistant task as exposed to clients; the full prompt stays in storage. */
export interface AssistantTaskView {
  readonly id: AssistantTaskId
  readonly assistantId: AssistantId
  /** Target project of the task; absent when it runs in the global assistant directory. */
  readonly workspaceId?: WorkspaceId
  readonly title: string
  readonly status: AssistantTaskStatus
  /** Reserved execution Session identity. */
  readonly sessionId: SessionId
  /** Whether the execution Session currently exists and can be opened. */
  readonly sessionAvailable: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly failure?: AssistantTaskFailure
}

/** Request to create or reuse one assistant in the requested scope. */
export interface AssistantsEnsureRequest {
  readonly kind: AssistantKind
  /** Required for a project assistant; rejected for the global assistant. */
  readonly workspaceId?: WorkspaceId
}

/** Request to list assistant records. */
export interface AssistantsListRequest {
  readonly kind?: AssistantKind
  readonly workspaceId?: WorkspaceId
}

/** Request to list assistant tasks in one scope. */
export interface AssistantTasksListRequest {
  /** Restrict to one assistant; omitted lists every task in scope. */
  readonly assistantId?: AssistantId
  /** Restrict to one project; omitted lists all projects. */
  readonly workspaceId?: WorkspaceId
  /** Page size, 1 through the service maximum. */
  readonly limit?: number
  /** Number of newest-first rows to skip. */
  readonly offset?: number
}

/** Request to cancel one assistant task. */
export interface AssistantTasksCancelRequest {
  readonly id: AssistantTaskId
}

/** Request to read the separated Session ids owned by the assistant surface. */
export interface AssistantVisibilityRequest {
  /** Reserved for future scoping; clients pass no fields today. */
  readonly unused?: never
}

/** One assistant conversation Session as exposed for client presentation. */
export interface AssistantConversationEntry {
  readonly sessionId: SessionId
  readonly assistantId: AssistantId
  /** Registered Workspace of a project assistant; absent for the global assistant. */
  readonly workspaceId?: WorkspaceId
  /** Whether this is a replaced Session kept only for separation. */
  readonly retired: boolean
}

/** One assistant task execution Session as exposed for client presentation. */
export interface AssistantExecutionEntry {
  readonly sessionId: SessionId
  readonly taskId: AssistantTaskId
  readonly assistantId: AssistantId
  /** Target project of the task; absent when it runs in the global assistant directory. */
  readonly workspaceId?: WorkspaceId
}

/** Current separated Session ids: assistant Sessions and assistant task execution Sessions. */
export interface AssistantVisibilityValue {
  readonly sessionIds: readonly SessionId[]
  /** Assistant conversation Sessions with their owning assistant. */
  readonly conversations: readonly AssistantConversationEntry[]
  /** Task execution Sessions with their owning task. */
  readonly executions: readonly AssistantExecutionEntry[]
}

/** Host-only request accepted by the assistant task service. */
export interface AssistantTaskCreateRequest {
  /** Exact assistant Session that dispatched the tool. */
  readonly callerSessionId: SessionId
  readonly prompt: string
  readonly title?: string
  /** Target project; project assistants must name their own project. */
  readonly workspaceId?: WorkspaceId
  /** Caller idempotency key; a repeated key reuses the existing task and Session. */
  readonly requestId?: string
  /** Caller cancellation, observed before durable creation. */
  readonly signal?: AbortSignal
}

/** Host-only creation result. */
export interface AssistantTaskCreateValue {
  readonly taskId: AssistantTaskId
  readonly sessionId: SessionId
}

/** Stable failure codes for assistant task operations. */
export type AssistantTaskErrorCode =
  | 'not_an_assistant'
  | 'workspace_not_registered'
  | 'workspace_scope_denied'
  | 'workspace_unavailable'
  | 'prompt_empty'
  | 'prompt_too_large'
  | 'title_too_long'
  | 'quota_exceeded'
  | 'worker_preset_unavailable'
  | 'session_create_failed'
  | 'prompt_rejected'
  | 'task_store_failed'
  | 'task_not_found'
  | 'assistant_session_unavailable'

/** Task and Session identities preserved on a failed creation. */
export interface AssistantTaskErrorDetails {
  readonly taskId?: AssistantTaskId
  readonly sessionId?: SessionId
}

/** Structured assistant-task failure raised by the Host service. */
export class AssistantTaskError extends Error {
  /**
   * @param code - stable failure discriminator.
   * @param message - actionable detail safe for the model and clients.
   * @param details - durable identities the caller can still open or retry.
   */
  constructor(
    readonly code: AssistantTaskErrorCode,
    message: string,
    readonly details?: AssistantTaskErrorDetails,
  ) {
    super(message)
    this.name = 'AssistantTaskError'
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An assistant task operation failed before or after durable creation. */
    'assistant/task-error': { readonly code: AssistantTaskErrorCode }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One assistant task changed; clients refresh the named task or catalog.
     * @mode emit
     */
    'assistant-task/changed'(taskId: AssistantTaskId): void
    /** One assistant record was created, replaced, or retired.
     * @mode emit
     */
    'assistant/changed'(): void
  }
}
