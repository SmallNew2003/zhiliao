/** Host-wide assistant records and assistant tasks with scoped execution Sessions. */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { readColdSessionLog } from '@deepseek-ai/dsh-session-query'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { MAX_RESULT_CHARS, WORKER_SESSION_PREFIX, publicFailure, turnOutcome, workerOutcome, type WorkerOutcome } from './outcome.ts'
import { noticeReceipts, resultNotice } from './notices.ts'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-api-remote-access'
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
  type AssistantTaskRequest,
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
  /** Maximum UTF-16 units retained from a task result; omission defaults to 2,048. */
  maxResultChars?: number
  /** Default task-list page size; omission defaults to 50. */
  listPageSize?: number
}

const DEFAULT_ASSISTANT_PRESET = 'assistant'
const DEFAULT_WORKER_PRESET = 'standard'
const DEFAULT_MAX_TASKS_PER_TURN = 3
const DEFAULT_MAX_ACTIVE_TASKS = 5
const DEFAULT_MAX_PROMPT_BYTES = 65_536
const DEFAULT_MAX_TITLE_CHARS = 120
const DEFAULT_MAX_RESULT_CHARS = 2_048
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
  static inject = ['storageDomain', 'sessions', 'agents', 'remoteAccess', 'sessionProjections']

  static Config: z<Config> = z.object({
    assistantPreset: z.string().default(DEFAULT_ASSISTANT_PRESET),
    workerPreset: z.string().default(DEFAULT_WORKER_PRESET),
    maxTasksPerTurn: z.number().step(1).min(1).max(100).default(DEFAULT_MAX_TASKS_PER_TURN),
    maxActiveTasks: z.number().step(1).min(1).max(1_000).default(DEFAULT_MAX_ACTIVE_TASKS),
    maxPromptBytes: z.number().step(1).min(1).max(16 * 1024 * 1024).default(DEFAULT_MAX_PROMPT_BYTES),
    maxTitleChars: z.number().step(1).min(1).max(1_000).default(DEFAULT_MAX_TITLE_CHARS),
    maxResultChars: z.number().step(1).min(1).max(MAX_RESULT_CHARS).default(DEFAULT_MAX_RESULT_CHARS),
    listPageSize: z.number().step(1).min(1).max(500).default(DEFAULT_LIST_PAGE_SIZE),
  })

  private readonly config: Config
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private domain: Domain<typeof assistantDomain> | undefined
  private phase: 'recovering' | 'ready' | 'stopping' = 'recovering'
  private outcomes!: ProjectionHandle<WorkerOutcome>
  private readonly starts = new Map<AssistantTaskId, { stop: AbortController; done: Promise<AssistantTaskCreateValue> }>()
  private receipts!: ProjectionHandle<string[]>
  private readonly cancellations = new Map<AssistantTaskId, Promise<AssistantTaskView>>()
  private readonly deliveries = new Map<string, Promise<void>>()
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
    const assistantPreset = config.assistantPreset ?? DEFAULT_ASSISTANT_PRESET
    const workerPreset = config.workerPreset ?? DEFAULT_WORKER_PRESET
    if (workerPreset === assistantPreset) {
      throw new Error('assistant task config: workerPreset must differ from assistantPreset')
    }
    const admission = ctx.on('agent/pre-step', async ({ agent }, next) => {
      const id = this.executionTasks.get(agent.id)
      if (id !== undefined && (this.cancellations.has(id) || this.domain?.table('tasks').get(id)?.status === 'cancelling')) {
        return { kind: 'reject' }
      }
      return await next()
    }, { global: true })
    const initialized = ctx.effect(async function* (this: AssistantTaskService) {
      try {
        const domain = await ctx.storageDomain.open(assistantDomain)
        yield () => domain.close()
        yield await this.activateDomain(ctx, domain)
      } catch (error: unknown) {
        admission()
        throw error
      }
    }.bind(this), 'assistantTasks.openDomain()')
    this.initialized = initialized
    ctx.effect(function* () {
      yield admission
      yield initialized
    }, 'assistantTasks.drainBeforeRemovingAdmission()')
  }

  private async activateDomain(ctx: Context, domain: Domain<typeof assistantDomain>): Promise<() => Promise<void>> {
    this.receipts = await ctx.sessionProjections.register(noticeReceipts)
    this.outcomes = await ctx.sessionProjections.register(workerOutcome)
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
    const stop = async () => {
      this.phase = 'stopping'
      offSession()
      offAgent()
      await this.chain
      for (const start of this.starts.values()) start.stop.abort()
      await Promise.allSettled([...this.starts.values()].map(start => start.done))
      await Promise.allSettled([...this.deliveries.values(), ...this.cancellations.values()])
      await this.chain
      await this.outcomes.dispose()
      await this.receipts.dispose()
    }
    try {
      await this.serialize(() => this.reconcile())
      this.phase = 'ready'
      ctx.inject(['sessionController'], () => {
        for (const [id, task] of domain.table('tasks').entries()) {
          if (task.status === 'cancelling') {
            void this.cancelTask({ id }).catch((error: unknown) => {
              ctx.logger.warn(`assistant task cancellation ${id}: ${String(error)}`)
            })
          } else {
            this.scheduleNotices(task)
          }
        }
      })
      return stop
    } catch (error) {
      await stop()
      throw error
    }
  }

  async [Service.init](): Promise<void> {
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
      .filter(record => this.entityVisible(record.sessionId, record.workspaceId))
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
      .filter(record => this.entityVisible(record.sessionId, record.workspaceId))
      .filter(record => request?.assistantId === undefined || record.assistantId === request.assistantId)
      .filter(record => request?.workspaceId === undefined || record.workspaceId === request.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(offset, offset + limit)
      .map(record => this.taskViewOf(record))
  }

  /**
   * Read one task after authorizing the execution Session and target Workspace.
   * @param request - Task identity.
   * @returns Current task details.
   */
  @Remote('task')
  task(request: AssistantTaskRequest): AssistantTaskView {
    const record = this.requireTasks().get(request.id)
    if (record === undefined) this.rethrowRemote(new AssistantTaskError('task_not_found', 'Assistant task not found.'))
    this.assertEntityVisible(record.sessionId, record.workspaceId)
    return this.taskViewOf(record)
  }

  /**
   * List the calling assistant's own tasks.
   * @param caller - Calling conversation.
   * @param page - Task-list page bounds.
   * @returns Current task details in newest-first order.
   */
  listForAssistant(caller: SessionId, page: Pick<AssistantTasksListRequest, 'limit' | 'offset'>): AssistantTaskView[] {
    return this.listTasks({ ...page, assistantId: this.requireCaller(caller) })
  }

  /**
   * Read a task belonging to the calling assistant.
   * @param caller - Calling conversation.
   * @param id - Task identity supplied by the model.
   * @returns Current task details.
   */
  taskForAssistant(caller: SessionId, id: AssistantTaskId): AssistantTaskView {
    const assistantId = this.requireCaller(caller)
    const task = this.requireTasks().get(id)
    if (task === undefined || task.assistantId !== assistantId || !this.entityVisible(task.sessionId, task.workspaceId)) {
      throw new AssistantTaskError('task_not_found', 'Assistant task not found.')
    }
    return this.taskViewOf(task)
  }

  private requireCaller(caller: SessionId): AssistantId {
    const id = this.assistantIdForSession(caller)
    if (id === undefined) throw new AssistantTaskError('not_an_assistant', 'Only a registered assistant can read its tasks.')
    return id
  }

  /**
   * Stop admission and join the execution Agent and its descendants.
   * @param request - Task identity.
   * @returns The task after quiescence, or its unchanged terminal state.
   */
  @Remote('cancelTask')
  async cancelTask(request: AssistantTasksCancelRequest): Promise<AssistantTaskView> {
    try {
      const task = this.task(request)
      if (isTerminalTaskStatus(task.status)) return task
      const existing = this.cancellations.get(task.id)
      if (existing !== undefined) return await existing
      if (this.phase === 'stopping') throw new RemoteError('gateway/internal', 'The assistant task service is stopping.', {})
      const drain = this.cancelAndJoin(task).finally(() => this.cancellations.delete(task.id))
      this.cancellations.set(task.id, drain)
      return await drain
    } catch (error: unknown) {
      this.rethrowRemote(error)
    }
  }

  private async cancelAndJoin(task: AssistantTaskView): Promise<AssistantTaskView> {
    const start = this.starts.get(task.id)
    start?.stop.abort()
    await this.serialize(() => this.writeStatus(task.id, 'cancelling'))
    const current = this.requireRecord(task.id)
    if (isTerminalTaskStatus(current.status)) return this.taskViewOf(current)
    try {
      if (start !== undefined) await Promise.allSettled([start.done])
      const sessionId = this.requireRecord(task.id).sessionId
      let agent = this.ctx.agents.get(sessionId)
      if (agent === undefined && await this.sessionExists(sessionId)) {
        const resolved = await this.requireSessionController().resolveAgent(sessionId)
        if ('error' in resolved) throw resolved.error
        agent = resolved.agent
      }
      if (agent !== undefined) await this.drainAgent(agent)
      await this.serialize(() => this.writeStatus(task.id, 'cancelled', undefined, true))
      return this.taskViewOf(this.requireRecord(task.id))
    } catch (error: unknown) {
      const failure = publicFailure('cancel_failed')
      this.ctx.logger.warn(`assistant task cancellation ${task.id}: ${String(error)}`)
      await this.serialize(() => this.writeStatus(task.id, 'cancelling', failure))
      throw new RemoteError('gateway/internal', failure.message, {})
    }
  }

  private async drainAgent(agent: Agent): Promise<void> {
    const descendants = this.ctx.get('subagents')?.drainDescendants([agent])
    const root = async () => {
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    }
    const outcomes = await Promise.allSettled([descendants, root()])
    // Descendant teardown can enqueue one last follow-up after an earlier root idle.
    if (descendants !== undefined) await root()
    for (const result of outcomes) if (result.status === 'rejected') throw result.reason
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
      const record = assistants?.get(assistantId)
      if (!this.entityVisible(sessionId, record?.workspaceId)) continue
      ids.add(sessionId)
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
      const record = tasks?.get(taskId)
      if (record === undefined || !this.entityVisible(sessionId, record.workspaceId)) continue
      ids.add(sessionId)
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
    if (this.phase === 'stopping') throw new AssistantTaskError('assistant_session_unavailable', 'The assistant task service is stopping.')
    const start = await this.serialize(() => this.createTaskLocked(request))
    return await start.done
  }

  /**
   * Check whether the Session is a registered assistant conversation.
   * @param sessionId - candidate conversation Session.
   * @returns whether the assistant domain owns this conversation.
   */
  isAssistant(sessionId: SessionId): boolean {
    return this.assistantSessions.has(sessionId)
  }

  /**
   * Read one task view by id, if present.
   * @param id - task identity.
   * @returns current task view, or undefined when absent.
   */
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
      if (existing !== undefined) this.assertEntityVisible(existing.sessionId, existing.workspaceId)
      if (existing !== undefined && await this.sessionAvailable(existing.sessionId)) return this.viewOf(existing)
      this.assertAssistantCreationAllowed()
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
    if (existing !== undefined) this.assertEntityVisible(existing.sessionId, existing.workspaceId)
    if (existing !== undefined && await this.sessionAvailable(existing.sessionId)) return this.viewOf(existing)
    this.assertAssistantCreationAllowed()
    const record = await this.createAssistantRecord('project', request.workspaceId, existing, workspace.title)
    return this.viewOf(record)
  }

  private entityVisible(sessionId: SessionId, workspaceId?: WorkspaceId): boolean {
    return this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId })
      && (workspaceId === undefined || this.ctx.remoteAccess.allows({ kind: 'workspace', id: workspaceId }))
  }

  private assertEntityVisible(sessionId: SessionId, workspaceId?: WorkspaceId): void {
    if (!this.entityVisible(sessionId, workspaceId)) this.denyEntityAccess()
  }

  private assertAssistantCreationAllowed(): void {
    if (principalOf(this.ctx.invocation) !== undefined) this.denyEntityAccess()
  }

  private denyEntityAccess(): never {
    const request = this.ctx.invocation?.request
    throw new RemoteError('remote-access/denied', 'assistant resource access denied', {
      action: request === undefined ? 'assistantTasks/ensureAssistant' : `${request.namespace}/${request.method}`,
      reason: 'no-allow',
    })
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

  private async createTaskLocked(request: AssistantTaskCreateRequest): Promise<{ done: Promise<AssistantTaskCreateValue> }> {
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
        .find(record => record.assistantId === callerId
          && (record.creatorSessionId === undefined || record.creatorSessionId === request.callerSessionId)
          && record.requestId === request.requestId)
      if (existing !== undefined) return await this.retryExisting(existing, request)
    } else {
      const turn = this.currentTurns.get(request.callerSessionId) ?? 0
      const retry = [...tasks.entries()]
        .map(([, record]) => record)
        .find(record => record.assistantId === callerId
          && (record.creatorSessionId === undefined || record.creatorSessionId === request.callerSessionId)
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
    const reservedSessionId = brandString<SessionId>(`${WORKER_SESSION_PREFIX}${randomUUID()}`)
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
      creatorSessionId: request.callerSessionId,
      promptAttempted: false,
      creatorTurn: turn,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      createdAt: now,
      updatedAt: now,
    }
    try {
      await tasks.put(taskId, record)
    } catch (error: unknown) {
      this.ctx.logger.warn(`assistant task storage ${taskId}: ${String(error)}`)
      throw new AssistantTaskError('task_store_failed', 'The task record could not be saved.', { taskId })
    }
    this.executionTasks.set(reservedSessionId, taskId)
    return this.startWorker(record, request)
  }

  private async retryExisting(
    record: AssistantTaskRecord, request: AssistantTaskCreateRequest,
  ): Promise<{ done: Promise<AssistantTaskCreateValue> }> {
    const existing = this.starts.get(record.id)
    if (existing !== undefined) return existing
    const retryable = record.status === 'failed' && record.promptDelivered !== true
      && (record.failure?.code === 'not_started' || record.failure?.code === 'worker_preset_unavailable'
        || record.failure?.code === 'session_create_failed' && record.promptAttempted === false && !await this.sessionExists(record.sessionId))
    if (!retryable) return { done: Promise.resolve({ taskId: record.id, sessionId: record.sessionId }) }
    const attempt = { ...record, status: 'created' as const, failure: undefined, resultSummary: undefined }
    await this.putTask(record.id, attempt)
    return this.startWorker(attempt, request)
  }

  private startWorker(record: AssistantTaskRecord, request: AssistantTaskCreateRequest) {
    const stop = new AbortController()
    const signal = request.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, request.signal])
    const done = this.deliverFirstPrompt(record, signal).finally(() => this.starts.delete(record.id))
    const start = { stop, done }
    this.starts.set(record.id, start)
    return start
  }

  private async deliverFirstPrompt(record: AssistantTaskRecord, signal: AbortSignal): Promise<AssistantTaskCreateValue> {
    const controller = this.requireSessionController()
    let sessionId = record.sessionId
    let attempted = false
    try {
      if (!await this.sessionExists(sessionId)) {
        const created = await controller.create({
          sessionId, cwd: record.cwd, agentPreset: this.config.workerPreset ?? DEFAULT_WORKER_PRESET,
        })
        if (created.sessionId !== sessionId) {
          this.executionTasks.delete(sessionId)
          sessionId = created.sessionId
          this.executionTasks.set(sessionId, record.id)
          await this.serialize(() => this.putTask(record.id, {
            ...this.requireRecord(record.id), sessionId, updatedAt: new Date().toISOString(),
          }))
        }
      }
      signal.throwIfAborted()
      await this.serialize(() => this.putTask(record.id, {
        ...this.requireRecord(record.id), sessionId, promptAttempted: true, updatedAt: new Date().toISOString(),
      }))
      signal.throwIfAborted()
      attempted = true
      await controller.prompt({
        requestId: brandString<SessionRequestId>(`assistant-task-${record.id}`),
        sessionId, mode: 'queue', content: [{ type: 'text', text: record.prompt }],
      }, signal)
    } catch (error: unknown) {
      let failure = this.failureOf(error)
      if (attempted && failure.code !== 'prompt_rejected') {
        failure = publicFailure('prompt_outcome_unknown')
      }
      if (!attempted && !await this.sessionExists(sessionId)) this.missingSessions.add(sessionId)
      await this.serialize(() => this.failTask(record.id, failure))
      throw new AssistantTaskError(this.createErrorCode(failure.code), failure.message, { taskId: record.id, sessionId })
    }
    await this.serialize(async () => {
      const current = this.requireRecord(record.id)
      await this.putTask(record.id, {
        ...current, sessionId, status: current.status === 'created' ? 'running' : current.status,
        promptAttempted: true, promptDelivered: true, updatedAt: new Date().toISOString(),
      })
    })
    this.missingSessions.delete(sessionId)
    this.ctx.emit('assistant-task/changed', record.id)
    return { taskId: record.id, sessionId }
  }

  private createErrorCode(code: string): 'prompt_outcome_unknown' | 'worker_preset_unavailable' | 'prompt_rejected' | 'session_create_failed' {
    switch (code) {
      case 'worker_preset_unavailable': return 'worker_preset_unavailable'
      case 'prompt_outcome_unknown': return 'prompt_outcome_unknown'
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
    if (error instanceof AssistantTaskError) return publicFailure(error.code)
    if (error instanceof RemoteError) {
      if (error.code === 'agent-preset/not-found' || error.code === 'agent-preset/invalid') {
        return publicFailure('worker_preset_unavailable')
      }
      if (error.code === 'workspace/not-found') {
        return publicFailure('workspace_not_registered')
      }
      if (error.code === 'session/not-found' || error.code === 'session/attachment-invalid' || error.code === 'gateway/bad-request') {
        return publicFailure('prompt_rejected')
      }
    }
    return publicFailure('session_create_failed')
  }

  private mapAssistantCreateError(error: unknown): AssistantTaskError {
    if (error instanceof RemoteError && (error.code === 'agent-preset/not-found' || error.code === 'agent-preset/invalid')) {
      return new AssistantTaskError('worker_preset_unavailable', publicFailure('worker_preset_unavailable').message)
    }
    return new AssistantTaskError('assistant_session_unavailable', 'The assistant Session could not be created.')
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
        const observed = this.outcomes.stateOf(session)
        const outcome = observed.phase === 'done' || observed.phase === 'cancelled' || observed.phase === 'failed'
          ? observed : turnOutcome(event.data.reason, '')
        if (outcome.phase === 'cancelled') {
          void this.cancelTask({ id: taskId }).catch((error: unknown) => {
            this.ctx.logger.warn(`assistant task cancellation ${taskId}: ${String(error)}`)
          })
        } else if (outcome.phase === 'done') {
          this.queueStatus(taskId, 'done', undefined, outcome.text)
        } else if (outcome.phase === 'failed') {
          this.queueStatus(taskId, 'failed', publicFailure(outcome.code))
        }
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

  private queueStatus(taskId: AssistantTaskId, status: AssistantTaskStatus, failure?: AssistantTaskFailure, text?: string): void {
    void this.serialize(async () => {
      await this.writeStatus(taskId, status, failure, false, text)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`assistant task transition ${taskId}: ${String(error)}`)
    })
  }

  private boundedResult(text: string): string {
    return text.slice(0, this.config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS).replace(/[\uD800-\uDBFF]$/, '')
  }

  private async writeStatus(
    taskId: AssistantTaskId, status: AssistantTaskStatus, failure?: AssistantTaskFailure, drained = false, text?: string,
  ): Promise<void> {
    const tasks = this.domain?.table('tasks')
    if (tasks === undefined) return
    const current = tasks.get(taskId)
    if (current === undefined || isTerminalTaskStatus(current.status)
      || current.status === 'cancelling' && status !== 'cancelling' && !drained
      || current.status === status && current.failure?.code === failure?.code) return
    const publicText = status === 'failed' && failure !== undefined ? failure.message : text
    const resultSummary = publicText === undefined ? current.resultSummary : this.boundedResult(publicText)
    const next: AssistantTaskRecord = {
      ...current,
      status,
      resultSummary,
      ...(current.creatorSessionId !== undefined && (status === 'done' || status === 'failed') ? {
        outbox: [...current.outbox ?? [], {
          id: randomUUID(), state: 'pending', status, resultSummary, failureCode: failure?.code,
        }],
      } : {}),
      updatedAt: new Date().toISOString(),
      ...(failure === undefined ? { failure: undefined } : { failure }),
    }
    await tasks.put(taskId, next)
    this.scheduleNotices(next)
    this.ctx.emit('assistant-task/changed', taskId)
  }

  private scheduleNotices(record: AssistantTaskRecord): void {
    if (this.phase !== 'ready' || this.ctx.get('sessionController') === undefined || record.creatorSessionId === undefined) return
    for (const notice of record.outbox ?? []) {
      if (this.deliveries.has(notice.id)) continue
      const delivery = this.deliverNotice(record, record.creatorSessionId, notice).catch((error: unknown) => {
        this.ctx.logger.warn(`assistant task notice ${record.id}: ${String(error)}`)
      }).finally(() => this.deliveries.delete(notice.id))
      this.deliveries.set(notice.id, delivery)
    }
  }

  private async deliverNotice(record: AssistantTaskRecord, creator: SessionId, notice: NonNullable<AssistantTaskRecord['outbox']>[number]): Promise<void> {
    const resolved = await this.requireSessionController().resolveAgent(creator)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    if (!this.receipts.stateOf(agent.session).includes(notice.id)) {
      if (notice.state === 'sending') throw new Error('Previous notice admission is unknown; the notice was not resent.')
      await this.setNoticeState(record.id, notice.id, 'sending')
      const publicNotice = notice.status === 'failed' ? publicFailure(notice.failureCode ?? 'execution_failed') : undefined
      agent.followup(resultNotice(record, publicNotice === undefined ? notice : {
        ...notice, failureCode: publicNotice.code, resultSummary: this.boundedResult(publicNotice.message),
      }))
    }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Session persistence did not acknowledge the task notice.')
    await this.setNoticeState(record.id, notice.id, 'delivered')
  }

  private setNoticeState(id: AssistantTaskId, noticeId: string, state: 'sending' | 'delivered'): Promise<void> {
    return this.serialize(async () => {
      const record = this.requireRecord(id)
      const outbox = (record.outbox ?? []).flatMap((item) => {
        if (item.id !== noticeId) return [item]
        return state === 'delivered' ? [] : [{ ...item, state }]
      })
      await this.putTask(id, { ...record, outbox })
    })
  }

  private async failTask(taskId: AssistantTaskId, failure: AssistantTaskFailure): Promise<void> {
    await this.writeStatus(taskId, 'failed', failure)
  }

  private async putTask(taskId: AssistantTaskId, record: AssistantTaskRecord): Promise<void> {
    await this.requireTasks().put(taskId, record)
  }

  private async reconcile(): Promise<void> {
    if (this.phase === 'stopping') return
    const tasks = this.requireTasks()
    for (const [id, record] of tasks.entries()) {
      if (isTerminalTaskStatus(record.status) || record.status === 'cancelling') continue
      const resident = this.ctx.agents.get(record.sessionId)
      const exists = resident !== undefined || await this.sessionExists(record.sessionId)
      if (resident !== undefined || exists && (record.promptAttempted !== false || record.promptDelivered === true)) {
        const outcome = resident === undefined ? await this.readWorkerOutcome(record.sessionId) : this.outcomes.stateOf(resident.session)
        if (outcome.phase === 'done') { await this.writeStatus(id, 'done', undefined, false, outcome.text); continue }
        if (outcome.phase === 'failed') { await this.writeStatus(id, 'failed', publicFailure(outcome.code)); continue }
        if (outcome.phase === 'cancelled') {
          await this.writeStatus(id, this.ctx.agents.get(record.sessionId) === undefined ? 'cancelled' : 'cancelling')
          continue
        }
      }
      if (this.ctx.agents.get(record.sessionId) !== undefined) continue
      const failure = record.promptDelivered !== true && record.promptAttempted !== false
        ? publicFailure('prompt_outcome_unknown')
        : publicFailure(exists || record.promptDelivered === true ? 'interrupted' : 'not_started')
      if (!exists) this.missingSessions.add(record.sessionId)
      await this.writeStatus(id, 'failed', failure)
    }
  }

  private async readWorkerOutcome(id: SessionId): Promise<WorkerOutcome> {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return this.outcomes.stateOf(live)
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new AssistantTaskError('assistant_session_unavailable', 'Session persistence is unavailable.')
    const log = await readColdSessionLog(persistence, id)
    const attached = this.ctx.sessions.get(id)
    if (attached !== undefined) return this.outcomes.stateOf(attached)
    const prepared = this.ctx.sessions.prepare(id, {
      seed: log.events, meta: log.header, eventState: log.eventState, inheritedEventCount: log.inheritedEventCount,
    })
    this.ctx.sessionProjections.hydrate(prepared, {}, log.events, SessionLogOffset(0))
    return this.outcomes.stateOf(prepared)
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    if (this.ctx.agents.get(sessionId) !== undefined) return true
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new AssistantTaskError('assistant_session_unavailable', 'Session persistence is unavailable; cannot determine whether the assistant Session exists')
    }
    return await persistence.stat(sessionId) !== undefined
  }

  private async sessionAvailable(sessionId: SessionId): Promise<boolean> {
    if (this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId)) return false
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
      retiredSessionIds: record.retiredSessionIds.filter(id => this.entityVisible(id, record.workspaceId)),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private taskViewOf(record: AssistantTaskRecord): AssistantTaskView {
    const failure = record.failure === undefined ? undefined : publicFailure(record.failure.code)
    const summary = record.status === 'failed' && failure !== undefined ? this.boundedResult(failure.message) : record.resultSummary
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
      ...(summary && (record.status === 'done' || record.status === 'failed') ? { resultSummary: summary } : {}),
      ...(failure === undefined ? {} : { failure }),
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

  private requireRecord(id: AssistantTaskId): AssistantTaskRecord {
    const record = this.requireTasks().get(id)
    if (record === undefined) throw new AssistantTaskError('task_not_found', 'Assistant task not found.')
    return record
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
