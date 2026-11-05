/** Host-wide assistant records and assistant tasks with scoped execution Sessions. */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assistantDomain,
  isTerminalTaskStatus,
  type AssistantRecord,
  type AssistantTaskRecord,
} from './storage.ts'
import {
  AssistantTaskError,
  type AssistantConversationEntry,
  type AssistantExecutionEntry,
  type AssistantId,
  type AssistantsEnsureRequest,
  type AssistantsListRequest,
  type AssistantTaskCreateRequest,
  type AssistantTaskCreateValue,
  type AssistantTaskFailure,
  type AssistantTaskId,
  type AssistantTaskStatus,
  type AssistantTasksCancelRequest,
  type AssistantTasksListRequest,
  type AssistantTaskView,
  type AssistantView,
  type AssistantVisibilityValue,
} from './types.ts'

export * from './types.ts'
export type { AssistantRecord, AssistantTaskRecord } from './storage.ts'
export { assistantDomain } from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable assistant records and assistant task management. */
    assistantTasks: AssistantTaskService
  }
}

/** Configuration for the Host assistant domain. */
export interface Config {
  /** Agent preset used for assistant conversation Sessions; omission defaults to `assistant`. */
  assistantPreset?: string
  /** Agent preset used for task execution Sessions; omission defaults to `standard`. */
  workerPreset?: string
  /** Maximum tasks one assistant turn may create; omission defaults to 3. */
  maxTasksPerTurn?: number
  /** Maximum non-terminal tasks one assistant may own; omission defaults to 5. */
  maxActiveTasks?: number
  /** Maximum UTF-8 bytes of one task prompt; omission defaults to 65,536. */
  maxPromptBytes?: number
  /** Maximum characters of one task title; omission defaults to 120. */
  maxTitleChars?: number
  /** Default task-list page size; omission defaults to 50. */
  listPageSize?: number
}

const DEFAULT_ASSISTANT_PRESET = 'assistant'
const DEFAULT_WORKER_PRESET = 'standard'
const DEFAULT_MAX_TASKS_PER_TURN = 3
const DEFAULT_MAX_ACTIVE_TASKS = 5
const DEFAULT_MAX_PROMPT_BYTES = 65_536
const DEFAULT_MAX_TITLE_CHARS = 120
const DEFAULT_LIST_PAGE_SIZE = 50

/** Stable refusal when task creation has no Session controller to create with. */
const NO_SESSION_CONTROLLER = 'the Host has no Session controller; assistant tasks cannot create execution Sessions'

/** Session tool-call identity carried by `tool/call` and `tool/result` events. */
type SessionToolCallId = Extract<SessionEvent, { readonly type: 'tool/call' }>['data']['callId']

/**
 * Host-wide assistant records and assistant tasks.
 *
 * Assistant conversations are ordinary Sessions; task execution Sessions are
 * ordinary root Sessions created through the same Session controller the Web
 * client uses. This service owns only the durable mapping, status derivation,
 * and separation identity; it never writes task markers into Session headers.
 */
export class AssistantTaskService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'agents']

  static Config: z<Config> = z.object({
    assistantPreset: z.string().default(DEFAULT_ASSISTANT_PRESET),
    workerPreset: z.string().default(DEFAULT_WORKER_PRESET),
    maxTasksPerTurn: z.number().step(1).min(1).max(100).default(DEFAULT_MAX_TASKS_PER_TURN),
    maxActiveTasks: z.number().step(1).min(1).max(1_000).default(DEFAULT_MAX_ACTIVE_TASKS),
    maxPromptBytes: z.number().step(1).min(1).max(16 * 1024 * 1024).default(DEFAULT_MAX_PROMPT_BYTES),
    maxTitleChars: z.number().step(1).min(1).max(1_000).default(DEFAULT_MAX_TITLE_CHARS),
    listPageSize: z.number().step(1).min(1).max(500).default(DEFAULT_LIST_PAGE_SIZE),
  })

  private readonly config: Config
  private readonly ready: Promise<Domain<typeof assistantDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private domain: Domain<typeof assistantDomain> | undefined
  private stopping = false
  private readonly executionTasks = new Map<SessionId, AssistantTaskId>()
  private readonly assistantSessions = new Map<SessionId, AssistantId>()
  private readonly missingSessions = new Set<SessionId>()
  private readonly pendingApprovals = new Map<SessionId, number>()
  /** `ask_user_question` calls that have not returned a result yet. */
  private readonly pendingQuestionCalls = new Map<SessionId, Set<SessionToolCallId>>()
  private readonly currentTurns = new Map<SessionId, number>()

  /**
   * @param ctx - Host services owning storage, Sessions, Agents, and Session activation.
   * @param config - Validated assistant and task limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'assistantTasks')
    this.config = config
    this.ready = ctx.storageDomain.open(assistantDomain)
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      for (const [id, record] of domain.table('assistants').entries()) {
        this.indexAssistant(id, record)
      }
      for (const [id, record] of domain.table('tasks').entries()) {
        this.executionTasks.set(record.sessionId, id)
      }
      const offSession = ctx.on('session/event', (session, event) => {
        this.observeSessionEvent(session, event)
      }, { global: true })
      const offAgent = ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'running') return
        const taskId = this.executionTasks.get(agent.id)
        if (taskId === undefined) return
        const current = domain.table('tasks').get(taskId)
        if (current === undefined || isTerminalTaskStatus(current.status)) return
        if ((this.pendingApprovals.get(agent.id) ?? 0) > 0) return
        if (this.questionPending(agent.id)) return
        this.queueStatus(taskId, 'running')
      })
      await this.reconcile()
      return async () => {
        this.stopping = true
        offSession()
        offAgent()
        await this.chain
        await domain.close()
      }
    })
  }

  async [Service.init](): Promise<void> {
    const assistantPreset = this.config.assistantPreset ?? DEFAULT_ASSISTANT_PRESET
    const workerPreset = this.config.workerPreset ?? DEFAULT_WORKER_PRESET
    if (workerPreset === assistantPreset) {
      throw new Error('assistant task config: workerPreset must differ from assistantPreset')
    }
    await this.initialized
  }

  /**
   * Create or reuse one assistant in the requested scope.
   * @param request - Global or project scope; a project must name a registered Workspace.
   * @returns The current assistant record.
   */
  @Remote('ensureAssistant')
  async ensureAssistant(request: AssistantsEnsureRequest): Promise<AssistantView> {
    try {
      return await this.serialize(() => this.ensureAssistantLocked(request))
    } catch (error: unknown) {
      this.rethrowRemote(error)
    }
  }

  /**
   * List assistant records.
   * @param request - Optional scope filter.
   * @returns Matching assistants, global first.
   */
  @Remote('assistants')
  listAssistants(request?: AssistantsListRequest): AssistantView[] {
    const assistants = this.domain?.table('assistants')
    if (assistants === undefined) return []
    return [...assistants.entries()]
      .map(([, record]) => record)
      .filter(record => request?.kind === undefined || record.kind === request.kind)
      .filter(record => request?.workspaceId === undefined || record.workspaceId === request.workspaceId)
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'global' ? -1 : 1
        return (left.workspaceId ?? left.id).localeCompare(right.workspaceId ?? right.id)
      })
      .map(record => this.viewOf(record))
  }

  /**
   * List assistant tasks newest first.
   * @param request - Optional assistant, project, and page bounds.
   * @returns One bounded page of task views.
   */
  @Remote('tasks')
  listTasks(request?: AssistantTasksListRequest): AssistantTaskView[] {
    const tasks = this.domain?.table('tasks')
    if (tasks === undefined) return []
    const limit = this.boundedLimit(request?.limit)
    const offset = request?.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RemoteError('gateway/bad-request', 'offset must be a non-negative integer', {})
    }
    return [...tasks.entries()]
      .map(([, record]) => record)
      .filter(record => request?.assistantId === undefined || record.assistantId === request.assistantId)
      .filter(record => request?.workspaceId === undefined || record.workspaceId === request.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(offset, offset + limit)
      .map(record => this.taskViewOf(record))
  }

  /**
   * Cancel one assistant task.
   * @param request - Task identity.
   * @returns The updated task view, or the unchanged terminal task.
   */
  @Remote('cancelTask')
  async cancelTask(request: AssistantTasksCancelRequest): Promise<AssistantTaskView> {
    try {
      return await this.serialize(async () => {
        const tasks = this.requireTasks()
        const record = tasks.get(request.id)
        if (record === undefined) throw new AssistantTaskError('task_not_found', `assistant task "${request.id}" not found`)
        if (isTerminalTaskStatus(record.status)) return this.taskViewOf(record)
        const controller = this.ctx.get('sessionController')
        if (controller !== undefined && this.ctx.agents.get(record.sessionId) !== undefined) {
          try {
            controller.cancel({ sessionId: record.sessionId })
          } catch (error: unknown) {
            // A live Agent that refuses cancellation is still marked cancelled for the task surface.
            this.ctx.logger.warn(`assistant: cancel of "${record.sessionId}" failed: ${String(error)}`)
          }
        }
        await this.writeStatus(request.id, 'cancelled')
        return this.taskViewOf(tasks.get(request.id) ?? record)
      })
    } catch (error: unknown) {
      this.rethrowRemote(error)
    }
  }

  /**
   * Read the Session ids the assistant surface must separate from user tasks.
   * @returns Current and retired assistant Sessions, every task execution
   *   Session, and each one's owning assistant or task.
   */
  @Remote('visibility')
  visibility(): AssistantVisibilityValue {
    const ids = new Set<SessionId>()
    const conversations: AssistantConversationEntry[] = []
    const assistants = this.domain?.table('assistants')
    for (const [sessionId, assistantId] of this.assistantSessions) {
      ids.add(sessionId)
      const record = assistants?.get(assistantId)
      conversations.push({
        sessionId,
        assistantId,
        ...(record?.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
        retired: record === undefined || record.sessionId !== sessionId,
      })
    }
    const executions: AssistantExecutionEntry[] = []
    const tasks = this.domain?.table('tasks')
    for (const [sessionId, taskId] of this.executionTasks) {
      ids.add(sessionId)
      const record = tasks?.get(taskId)
      if (record === undefined) continue
      executions.push({
        sessionId,
        taskId,
        assistantId: record.assistantId,
        ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      })
    }
    return { sessionIds: [...ids], conversations, executions }
  }

  /**
   * Create one assistant task and deliver its first prompt through the Session controller.
   * @param request - Caller assistant Session, prompt, optional title and target project.
   * @returns The task and its reserved execution Session.
   */
  async createTask(request: AssistantTaskCreateRequest): Promise<AssistantTaskCreateValue> {
    return await this.serialize(() => this.createTaskLocked(request))
  }

  /** Whether the Session is a registered assistant conversation. */
  isAssistant(sessionId: SessionId): boolean {
    return this.assistantSessions.has(sessionId)
  }

  /** Read one task view by id, if present. */
  getTask(id: AssistantTaskId): AssistantTaskView | undefined {
    const record = this.domain?.table('tasks').get(id)
    return record === undefined ? undefined : this.taskViewOf(record)
  }

  private async ensureAssistantLocked(request: AssistantsEnsureRequest): Promise<AssistantView> {
    const assistants = this.requireAssistants()
    const state: { globalAssistantId?: AssistantId } = this.requireDomain().global.get()
    if (request.kind === 'global') {
      if (request.workspaceId !== undefined) {
        throw new AssistantTaskError('workspace_scope_denied', 'the global assistant does not belong to a project')
      }
      const existingId = state.globalAssistantId
      const existing = existingId === undefined ? undefined : assistants.get(existingId)
      if (existing !== undefined && await this.sessionAvailable(existing.sessionId)) return this.viewOf(existing)
      const record = await this.createAssistantRecord('global', undefined, existing)
      return this.viewOf(record)
    }
    if (request.workspaceId === undefined) {
      throw new AssistantTaskError('workspace_not_registered', 'a project assistant requires a registered Workspace')
    }
    const workspace = this.ctx.get('workspaceRegistry')?.get(request.workspaceId)
    if (workspace === undefined) {
      throw new AssistantTaskError('workspace_not_registered', `workspace "${request.workspaceId}" is not registered`)
    }
    const existing = [...assistants.entries()]
      .map(([, record]) => record)
      .find(record => record.kind === 'project' && record.workspaceId === request.workspaceId)
    if (existing !== undefined && await this.sessionAvailable(existing.sessionId)) return this.viewOf(existing)
    const record = await this.createAssistantRecord('project', request.workspaceId, existing, workspace.title)
    return this.viewOf(record)
  }

  private async createAssistantRecord(
    kind: 'global' | 'project',
    workspaceId: WorkspaceId | undefined,
    previous: AssistantRecord | undefined,
    workspaceTitle?: string,
  ): Promise<AssistantRecord> {
    const controller = this.requireSessionController()
    let created: { sessionId: SessionId }
    try {
      created = await controller.create({
        ...(workspaceId === undefined ? {} : { workspaceId }),
        agentPreset: this.config.assistantPreset ?? DEFAULT_ASSISTANT_PRESET,
      })
    } catch (error: unknown) {
      throw this.mapAssistantCreateError(error)
    }
    const now = new Date().toISOString()
    const id = previous?.id ?? brandString<AssistantId>(`assistant-${kind}-${randomUUID()}`)
    const record: AssistantRecord = {
      id,
      kind,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      name: kind === 'global' ? 'global' : (workspaceTitle ?? 'project'),
      sessionId: created.sessionId,
      retiredSessionIds: previous === undefined ? [] : [...previous.retiredSessionIds, previous.sessionId],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    await this.requireAssistants().put(id, record)
    if (kind === 'global') {
      await this.requireDomain().global.set({ ...this.requireDomain().global.get(), globalAssistantId: id })
    }
    this.indexAssistant(id, record)
    this.ctx.emit('assistant/changed')
    return record
  }

  private async createTaskLocked(request: AssistantTaskCreateRequest): Promise<AssistantTaskCreateValue> {
    const callerId = this.assistantIdForSession(request.callerSessionId)
    if (callerId === undefined) {
      throw new AssistantTaskError('not_an_assistant', 'create_task is only available to a registered assistant Session')
    }
    const assistants = this.requireAssistants()
    const assistant = assistants.get(callerId)
    if (assistant === undefined) {
      throw new AssistantTaskError('not_an_assistant', 'the caller assistant record no longer exists')
    }
    const prompt = request.prompt.trim()
    if (prompt.length === 0) throw new AssistantTaskError('prompt_empty', 'the task prompt must not be empty')
    const promptBytes = Buffer.byteLength(prompt, 'utf8')
    const maxPromptBytes = this.config.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES
    if (promptBytes > maxPromptBytes) {
      throw new AssistantTaskError('prompt_too_large', `the task prompt exceeds ${maxPromptBytes} bytes`)
    }
    const tasks = this.requireTasks()
    const targetWorkspaceId = this.resolveTargetWorkspace(assistant, request.workspaceId)
    if (request.requestId !== undefined) {
      const existing = [...tasks.entries()]
        .map(([, record]) => record)
        .find(record => record.assistantId === callerId && record.requestId === request.requestId)
      if (existing !== undefined) return await this.retryExisting(existing, request)
    } else {
      const turn = this.currentTurns.get(request.callerSessionId) ?? 0
      const retry = [...tasks.entries()]
        .map(([, record]) => record)
        .find(record => record.assistantId === callerId
          && record.creatorTurn === turn
          && record.workspaceId === targetWorkspaceId
          && record.prompt === prompt
          && record.promptDelivered !== true
          && (record.status === 'failed' || record.status === 'created'))
      if (retry !== undefined) return await this.retryExisting(retry, request)
    }
    const cwd = await this.resolveCwd(request.callerSessionId, targetWorkspaceId)
    const active = [...tasks.entries()]
      .map(([, record]) => record)
      .filter(record => record.assistantId === callerId && !isTerminalTaskStatus(record.status))
    const maxActive = this.config.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_TASKS
    if (active.length >= maxActive) {
      throw new AssistantTaskError('quota_exceeded', `this assistant already owns ${active.length} active tasks`)
    }
    const turn = this.currentTurns.get(request.callerSessionId) ?? 0
    const turnCount = [...tasks.entries()]
      .map(([, record]) => record)
      .filter(record => record.assistantId === callerId && record.creatorTurn === turn)
      .length
    const maxPerTurn = this.config.maxTasksPerTurn ?? DEFAULT_MAX_TASKS_PER_TURN
    if (turnCount >= maxPerTurn) {
      throw new AssistantTaskError('quota_exceeded', `this assistant turn already created ${turnCount} tasks`)
    }
    const title = this.titleOf(request.title, prompt)
    const taskId = brandString<AssistantTaskId>(`assistant-task-${randomUUID()}`)
    const reservedSessionId = brandString<SessionId>(`session-assistant-task-${randomUUID()}`)
    const now = new Date().toISOString()
    const record: AssistantTaskRecord = {
      id: taskId,
      assistantId: callerId,
      ...(targetWorkspaceId === undefined ? {} : { workspaceId: targetWorkspaceId }),
      cwd,
      title,
      prompt,
      sessionId: reservedSessionId,
      status: 'created',
      creatorTurn: turn,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      createdAt: now,
      updatedAt: now,
    }
    try {
      await tasks.put(taskId, record)
    } catch (error: unknown) {
      throw new AssistantTaskError('task_store_failed', `the task record could not be written: ${String(error)}`, { taskId })
    }
    this.executionTasks.set(reservedSessionId, taskId)
    const controller = this.requireSessionController()
    let sessionId = reservedSessionId
    let sessionReady = false
    try {
      if (!await this.sessionExists(sessionId)) {
        const created = await controller.create({
          sessionId,
          cwd,
          agentPreset: this.config.workerPreset ?? DEFAULT_WORKER_PRESET,
        })
        if (created.sessionId !== sessionId) {
          this.executionTasks.delete(sessionId)
          sessionId = created.sessionId
          this.executionTasks.set(sessionId, taskId)
          await this.putTask(taskId, { ...record, sessionId, updatedAt: new Date().toISOString() })
        }
      }
      sessionReady = true
      request.signal?.throwIfAborted()
      await controller.prompt({
        requestId: brandString<SessionRequestId>(`assistant-task-${taskId}`),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, request.signal ?? new AbortController().signal)
    } catch (error: unknown) {
      const failure = this.failureOf(error)
      if (!sessionReady && !await this.sessionExists(sessionId)) this.missingSessions.add(sessionId)
      await this.failTask(taskId, failure)
      throw new AssistantTaskError(this.createErrorCode(failure.code), failure.message, { taskId, sessionId })
    }
    const delivered: AssistantTaskRecord = {
      ...record,
      sessionId,
      status: 'running',
      promptDelivered: true,
      updatedAt: new Date().toISOString(),
    }
    await this.putTask(taskId, delivered)
    this.missingSessions.delete(sessionId)
    this.ctx.emit('assistant-task/changed', taskId)
    return { taskId, sessionId }
  }

  /**
   * Retry one partial creation without duplicating its task or Session.
   * @param record - Existing task found by the caller's idempotency key.
   * @param request - Retry carrying the same key and the caller's cancellation.
   * @returns The existing task identity, or the retried running task.
   */
  private async retryExisting(
    record: AssistantTaskRecord,
    request: AssistantTaskCreateRequest,
  ): Promise<AssistantTaskCreateValue> {
    const retryable = (record.status === 'failed' || record.status === 'created') && record.promptDelivered !== true
    if (!retryable) return { taskId: record.id, sessionId: record.sessionId }
    const controller = this.requireSessionController()
    let sessionId = record.sessionId
    let sessionReady = false
    try {
      if (!await this.sessionExists(sessionId)) {
        const created = await controller.create({
          sessionId,
          cwd: record.cwd,
          agentPreset: this.config.workerPreset ?? DEFAULT_WORKER_PRESET,
        })
        if (created.sessionId !== sessionId) {
          this.executionTasks.delete(sessionId)
          sessionId = created.sessionId
          this.executionTasks.set(sessionId, record.id)
          await this.putTask(record.id, { ...record, sessionId, updatedAt: new Date().toISOString() })
        }
      }
      sessionReady = true
      request.signal?.throwIfAborted()
      await controller.prompt({
        requestId: brandString<SessionRequestId>(`assistant-task-${record.id}`),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: record.prompt }],
      }, request.signal ?? new AbortController().signal)
    } catch (error: unknown) {
      const failure = this.failureOf(error)
      if (!sessionReady && !await this.sessionExists(sessionId)) this.missingSessions.add(sessionId)
      await this.failTask(record.id, failure)
      throw new AssistantTaskError(this.createErrorCode(failure.code), failure.message, { taskId: record.id, sessionId })
    }
    const delivered: AssistantTaskRecord = {
      ...record,
      sessionId,
      status: 'running',
      promptDelivered: true,
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }
    await this.putTask(record.id, delivered)
    this.missingSessions.delete(sessionId)
    this.ctx.emit('assistant-task/changed', record.id)
    return { taskId: record.id, sessionId }
  }

  private createErrorCode(code: string): 'worker_preset_unavailable' | 'prompt_rejected' | 'session_create_failed' {
    switch (code) {
      case 'worker_preset_unavailable': return 'worker_preset_unavailable'
      case 'prompt_rejected': return 'prompt_rejected'
      default: return 'session_create_failed'
    }
  }

  private resolveTargetWorkspace(assistant: AssistantRecord, requested: WorkspaceId | undefined): WorkspaceId | undefined {
    if (assistant.kind === 'project') {
      if (assistant.workspaceId === undefined) return undefined
      if (requested !== undefined && requested !== assistant.workspaceId) {
        throw new AssistantTaskError('workspace_scope_denied', 'a project assistant may create tasks only in its own project')
      }
      return assistant.workspaceId
    }
    if (requested === undefined) return undefined
    const workspace = this.ctx.get('workspaceRegistry')?.get(requested)
    if (workspace === undefined) {
      throw new AssistantTaskError('workspace_not_registered', `workspace "${requested}" is not registered`)
    }
    return requested
  }

  private async resolveCwd(
    callerSessionId: SessionId,
    workspaceId: WorkspaceId | undefined,
  ): Promise<string> {
    if (workspaceId !== undefined) {
      const workspace = this.ctx.get('workspaceRegistry')?.get(workspaceId)
      if (workspace === undefined) {
        throw new AssistantTaskError('workspace_not_registered', `workspace "${workspaceId}" is not registered`)
      }
      return workspace.path
    }
    const live = this.ctx.sessions.get(callerSessionId)
    const cwd = live?.header.cwd ?? (await this.ctx.get('sessionPersistence')?.stat(callerSessionId))?.header.cwd
    if (cwd === undefined) {
      throw new AssistantTaskError('workspace_unavailable', 'the assistant Session has no working directory for task execution')
    }
    return cwd
  }

  private titleOf(title: string | undefined, prompt: string): string {
    const max = this.config.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS
    const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
    const candidate = title?.trim() || firstLine
    if (candidate.length === 0) throw new AssistantTaskError('prompt_empty', 'the task prompt must not be empty')
    return candidate.length > max ? candidate.slice(0, max) : candidate
  }

  private failureOf(error: unknown): AssistantTaskFailure {
    if (error instanceof AssistantTaskError) return { code: error.code, message: error.message }
    if (error instanceof RemoteError) {
      if (error.code === 'agent-preset/not-found' || error.code === 'agent-preset/invalid') {
        return { code: 'worker_preset_unavailable', message: error.message }
      }
      if (error.code === 'workspace/not-found') {
        return { code: 'workspace_not_registered', message: error.message }
      }
      if (error.code === 'session/agent-busy' || error.code === 'session/not-found') {
        return { code: 'prompt_rejected', message: error.message }
      }
    }
    return { code: 'session_create_failed', message: error instanceof Error ? error.message : String(error) }
  }

  private mapAssistantCreateError(error: unknown): AssistantTaskError {
    if (error instanceof RemoteError && (error.code === 'agent-preset/not-found' || error.code === 'agent-preset/invalid')) {
      return new AssistantTaskError('worker_preset_unavailable', error.message)
    }
    return new AssistantTaskError('assistant_session_unavailable', error instanceof Error ? error.message : String(error))
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      if (this.assistantSessions.has(session.id)) this.currentTurns.set(session.id, event.data.turn)
      const taskId = this.executionTasks.get(session.id)
      if (taskId !== undefined) {
        this.pendingQuestionCalls.delete(session.id)
        this.pendingApprovals.delete(session.id)
        this.queueStatus(taskId, 'running')
      }
      return
    }
    const taskId = this.executionTasks.get(session.id)
    if (taskId === undefined) return
    switch (event.type) {
      case 'approval/asked': {
        this.pendingApprovals.set(session.id, (this.pendingApprovals.get(session.id) ?? 0) + 1)
        this.queueStatus(taskId, 'waiting-approval')
        return
      }
      case 'approval/decided': {
        const pending = Math.max(0, (this.pendingApprovals.get(session.id) ?? 1) - 1)
        this.pendingApprovals.set(session.id, pending)
        this.refreshTaskStatus(session.id, taskId)
        return
      }
      case 'tool/call': {
        if (event.data.name !== 'ask_user_question') return
        const calls = this.pendingQuestionCalls.get(session.id) ?? new Set<SessionToolCallId>()
        calls.add(event.data.callId)
        this.pendingQuestionCalls.set(session.id, calls)
        this.queueStatus(taskId, 'waiting-answer')
        return
      }
      case 'tool/result': {
        const calls = this.pendingQuestionCalls.get(session.id)
        if (calls === undefined || !calls.delete(event.data.message.source.callId)) return
        if (calls.size === 0) this.pendingQuestionCalls.delete(session.id)
        this.refreshTaskStatus(session.id, taskId)
        return
      }
      case 'turn/end': {
        const current = this.domain?.table('tasks').get(taskId)
        if (current?.status === 'cancelled') return
        this.pendingQuestionCalls.delete(session.id)
        this.pendingApprovals.delete(session.id)
        const reason = event.data.reason
        if (reason.kind === 'completed') this.queueStatus(taskId, 'done')
        else if (reason.kind === 'aborted') this.queueStatus(taskId, 'cancelled')
        else if (reason.kind === 'interrupted') this.queueStatus(taskId, 'failed', { code: 'interrupted', message: 'The turn was interrupted.' })
        else if (reason.kind === 'error') this.queueStatus(taskId, 'failed', { code: 'turn_error', message: reason.error.message })
        else this.queueStatus(taskId, 'failed', { code: reason.kind, message: `The turn ended with ${reason.kind}.` })
        return
      }
      default:
        return
    }
  }

  /** Whether a question blocks this execution Session. */
  private questionPending(sessionId: SessionId): boolean {
    return (this.pendingQuestionCalls.get(sessionId)?.size ?? 0) > 0
  }

  /** Restore the highest-priority non-terminal status from the pending interaction facts. */
  private refreshTaskStatus(sessionId: SessionId, taskId: AssistantTaskId): void {
    const current = this.domain?.table('tasks').get(taskId)
    if (current === undefined || isTerminalTaskStatus(current.status)) return
    if ((this.pendingApprovals.get(sessionId) ?? 0) > 0) {
      this.queueStatus(taskId, 'waiting-approval')
      return
    }
    this.queueStatus(taskId, this.questionPending(sessionId) ? 'waiting-answer' : 'running')
  }

  private queueStatus(taskId: AssistantTaskId, status: AssistantTaskStatus, failure?: AssistantTaskFailure): void {
    void this.serialize(async () => {
      await this.writeStatus(taskId, status, failure)
    })
  }

  private async writeStatus(taskId: AssistantTaskId, status: AssistantTaskStatus, failure?: AssistantTaskFailure): Promise<void> {
    if (this.stopping) return
    const tasks = this.domain?.table('tasks')
    if (tasks === undefined) return
    const current = tasks.get(taskId)
    if (current === undefined || current.status === status && current.failure?.code === failure?.code) return
    const next: AssistantTaskRecord = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
      ...(failure === undefined ? { failure: undefined } : { failure }),
    }
    await tasks.put(taskId, next)
    this.ctx.emit('assistant-task/changed', taskId)
  }

  private async failTask(taskId: AssistantTaskId, failure: AssistantTaskFailure): Promise<void> {
    await this.writeStatus(taskId, 'failed', failure)
  }

  private async putTask(taskId: AssistantTaskId, record: AssistantTaskRecord): Promise<void> {
    await this.requireTasks().put(taskId, record)
  }

  private async reconcile(): Promise<void> {
    if (this.stopping) return
    const tasks = this.requireTasks()
    for (const [id, record] of tasks.entries()) {
      if (isTerminalTaskStatus(record.status)) continue
      const live = this.ctx.agents.get(record.sessionId)
      if (live !== undefined) continue
      const exists = await this.sessionExists(record.sessionId)
      const failure: AssistantTaskFailure = exists
        ? { code: 'interrupted', message: 'The Host restarted before the task finished.' }
        : { code: 'not_started', message: 'The task never reached an execution Session.' }
      await this.writeStatus(id, 'failed', failure)
    }
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    if (this.ctx.agents.get(sessionId) !== undefined) return true
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    try {
      return await persistence.stat(sessionId) !== undefined
    } catch (error: unknown) {
      this.ctx.logger.warn(`assistant: session stat failed for "${sessionId}": ${String(error)}`)
      return false
    }
  }

  private async sessionAvailable(sessionId: SessionId): Promise<boolean> {
    if (this.ctx.workspaceRegistry?.archivedSessionIds.includes(sessionId)) return false
    return await this.sessionExists(sessionId)
  }

  private assistantIdForSession(sessionId: SessionId): AssistantId | undefined {
    return this.assistantSessions.get(sessionId)
  }

  private indexAssistant(id: AssistantId, record: AssistantRecord): void {
    this.assistantSessions.set(record.sessionId, id)
    for (const retired of record.retiredSessionIds) this.assistantSessions.set(retired, id)
  }

  private viewOf(record: AssistantRecord): AssistantView {
    return {
      id: record.id,
      kind: record.kind,
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      sessionId: record.sessionId,
      retiredSessionIds: record.retiredSessionIds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private taskViewOf(record: AssistantTaskRecord): AssistantTaskView {
    const unavailable = this.missingSessions.has(record.sessionId)
      || record.failure?.code === 'not_started'
      || record.failure?.code === 'session_create_failed'
      || record.failure?.code === 'worker_preset_unavailable'
    return {
      id: record.id,
      assistantId: record.assistantId,
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      title: record.title,
      status: record.status,
      sessionId: record.sessionId,
      sessionAvailable: !unavailable,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.failure === undefined ? {} : { failure: record.failure }),
    }
  }

  private boundedLimit(limit: number | undefined): number {
    const max = this.config.listPageSize ?? DEFAULT_LIST_PAGE_SIZE
    if (limit === undefined) return max
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
      throw new RemoteError('gateway/bad-request', `limit must be between 1 and ${max}`, {})
    }
    return limit
  }

  private requireDomain(): Domain<typeof assistantDomain> {
    if (this.domain === undefined) throw new AssistantTaskError('task_store_failed', 'the assistant domain is not open')
    return this.domain
  }

  private requireAssistants() {
    return this.requireDomain().table('assistants')
  }

  private requireTasks() {
    return this.requireDomain().table('tasks')
  }

  private requireSessionController() {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new AssistantTaskError('assistant_session_unavailable', NO_SESSION_CONTROLLER)
    return controller
  }

  private rethrowRemote(error: unknown): never {
    if (error instanceof AssistantTaskError) {
      throw new RemoteError('assistant/task-error', error.message, { code: error.code })
    }
    throw error
  }

  private serialize<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.chain.then(work, work)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

export default AssistantTaskService
