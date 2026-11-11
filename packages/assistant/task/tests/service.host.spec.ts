import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { AssistantTaskError } from '../src/index.ts'
import { assistantRecord, assistantTaskRecord } from '../src/storage.ts'
import { harness, storedSession } from './harness.ts'

const workspaceId = brandString<WorkspaceId>('workspace-1')

/** Await a creation that must fail with a structured task error. */
async function rejectedTask(promise: Promise<unknown>): Promise<AssistantTaskError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof AssistantTaskError) return error
    throw error
  }
  throw new Error('expected the task creation to fail')
}

describe('assistant storage', () => {
  it('accepts a global assistant record', () => {
    expect(assistantRecord.parse({
      id: 'assistant-global-1',
      kind: 'global',
      name: '助理',
      sessionId: 'session-1',
      retiredSessionIds: [],
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    })).toMatchObject({ kind: 'global' })
  })

  it('rejects an unknown task status', () => {
    expect(() => assistantTaskRecord.parse({
      id: 'task-1',
      assistantId: 'assistant-global-1',
      cwd: '/tmp',
      title: 'Task',
      prompt: 'Do it',
      sessionId: 'session-2',
      status: 'mystery',
      creatorTurn: 0,
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    })).toThrow()
  })
})

describe('assistant task service', () => {
  it('creates the global assistant and an independent task', async () => {
    const { service, create, prompt, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    expect(assistant.kind).toBe('global')
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const result = await service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Check the deployment',
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledTimes(1)
    const task = service.getTask(result.taskId)
    expect(task?.status).toBe('running')
    expect(task?.sessionId).toBe(result.sessionId)
    expect(service.visibility().sessionIds).toContain(result.sessionId)
    expect(service.visibility().sessionIds).toContain(assistant.sessionId)
  })

  it('confines a project assistant to its project', async () => {
    const { service, sessions } = await harness({
      workspaces: new Map([[workspaceId, { id: workspaceId, path: '/tmp/project', title: 'Project' }]]),
    })
    const assistant = await service.ensureAssistant({ kind: 'project', workspaceId })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId, '/tmp/project'))
    const result = await service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Run the tests',
      workspaceId,
    })
    expect(service.getTask(result.taskId)?.workspaceId).toBe(workspaceId)
    await expect(service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Elsewhere',
      workspaceId: brandString<WorkspaceId>('workspace-2'),
    })).rejects.toBeInstanceOf(AssistantTaskError)
  })

  it('rejects a caller that is not a registered assistant', async () => {
    const { service } = await harness()
    await expect(service.createTask({
      callerSessionId: brandString<SessionId>('user-session'),
      prompt: 'Do work',
    })).rejects.toMatchObject({ code: 'not_an_assistant' })
  })

  it('derives done from the execution turn end', async () => {
    const { ctx, service, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const result = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Finish' })
    const session = ctx.sessions.create(result.sessionId)
    ctx.emit('session/event', session, {
      seq: 0, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    await expect.poll(() => service.getTask(result.taskId)?.status).toBe('done')
  })

  it('rejects the assistant preset as the worker preset', async () => {
    await expect(harness({ config: { assistantPreset: 'assistant', workerPreset: 'assistant' } }))
      .rejects.toThrow('workerPreset')
  })

  it('derives waiting states from approvals and answers', async () => {
    const { ctx, service, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const result = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Ask first' })
    const session = ctx.sessions.create(result.sessionId)
    const changed = vi.fn()
    ctx.on('assistant-task/changed', changed)
    const wait = () => service.ensureAssistant({ kind: 'global' })

    ctx.emit('session/event', session, {
      seq: 0, time: 0, type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash' },
    } as never)
    await wait()
    expect(service.getTask(result.taskId)?.status).toBe('waiting-approval')

    ctx.emit('session/event', session, {
      seq: 1, time: 0, type: 'approval/decided', data: { id: 'approval-1', outcome: 'approved' },
    } as never)
    await wait()
    expect(service.getTask(result.taskId)?.status).toBe('running')

    ctx.emit('session/event', session, {
      seq: 2,
      time: 0,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Proceed?"}]}' },
    } as never)
    await wait()
    expect(service.getTask(result.taskId)?.status).toBe('waiting-answer')

    ctx.emit('session/event', session, {
      seq: 3,
      time: 0,
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '{"answers":[]}' }], isError: false } },
    } as never)
    await wait()
    expect(service.getTask(result.taskId)?.status).toBe('running')
    expect(changed).toHaveBeenCalled()
  })

  it('cancels a task and keeps its record', async () => {
    const { service, sessions, cancel } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const result = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Long task' })
    const cancelled = await service.cancelTask({ id: result.taskId })
    expect(cancelled.status).toBe('cancelled')
    expect(cancel).not.toHaveBeenCalled()
    expect(service.getTask(result.taskId)?.status).toBe('cancelled')
  })

  it('reports conversation and execution roles for separated Sessions', async () => {
    const { service, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const result = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Trace' })
    const visibility = service.visibility()
    expect(visibility.conversations).toContainEqual(expect.objectContaining({
      sessionId: assistant.sessionId,
      assistantId: assistant.id,
      retired: false,
    }))
    expect(visibility.executions).toContainEqual(expect.objectContaining({
      sessionId: result.sessionId,
      taskId: result.taskId,
      assistantId: assistant.id,
    }))
  })

  it('marks a task without an execution Session unopenable', async () => {
    const { service, create, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    create.mockRejectedValueOnce(new Error('create failed'))
    const error = await rejectedTask(service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Cannot start',
      requestId: 'request-failed',
    }))
    expect(error.details?.taskId).toBeDefined()
    expect(error.details?.sessionId).toBeDefined()
    const task = service.getTask(error.details!.taskId!)
    expect(task?.status).toBe('failed')
    expect(task?.sessionAvailable).toBe(false)
  })

  it('exposes the Session identity when the first prompt is rejected', async () => {
    const { service, prompt, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    prompt.mockRejectedValueOnce(new RemoteError('session/not-found', 'missing', { sessionId: assistant.sessionId }))
    const error = await rejectedTask(service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Run and fail',
    }))
    expect(error.code).toBe('prompt_rejected')
    expect(error.details?.taskId).toBeDefined()
    expect(error.details?.sessionId).toBeDefined()
    const task = service.getTask(error.details!.taskId!)
    expect(task?.status).toBe('failed')
    expect(task?.sessionAvailable).toBe(true)
  })

  it('retries one creation with the same requestId without duplicating its Session or prompt', async () => {
    const { service, create, prompt, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    create.mockRejectedValueOnce(new Error('create failed'))
    const first = await rejectedTask(service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Retry me',
      requestId: 'request-1',
    }))
    const taskId = first.details!.taskId!
    const sessionId = first.details!.sessionId!

    const retried = await service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Retry me',
      requestId: 'request-1',
    })
    expect(retried.taskId).toBe(taskId)
    expect(retried.sessionId).toBe(sessionId)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(service.getTask(taskId)?.status).toBe('running')
    expect(service.getTask(taskId)?.sessionAvailable).toBe(true)

    const repeated = await service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Retry me',
      requestId: 'request-1',
    })
    expect(repeated.taskId).toBe(taskId)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('retries an identical partial failure without a caller-provided key', async () => {
    const { service, create, prompt, sessions } = await harness()
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    create.mockRejectedValueOnce(new Error('create failed'))
    const first = await rejectedTask(service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Automatic retry',
    }))
    const retried = await service.createTask({
      callerSessionId: assistant.sessionId,
      prompt: 'Automatic retry',
    })
    expect(retried.taskId).toBe(first.details!.taskId)
    expect(retried.sessionId).toBe(first.details!.sessionId)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(service.getTask(retried.taskId)?.status).toBe('running')
  })
})


describe('task cancellation ownership', () => {
  it('discards queued input through the execution Agent and keeps a terminal task terminal', async () => {
    const { ctx, service, sessions, cancel } = await harness()
    try {
      const assistant = await service.ensureAssistant({ kind: 'global' })
      sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
      const task = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Queued task' })
      const session = ctx.sessions.create(task.sessionId)
      const queued = ['queued input']
      const cancelAgent = vi.fn<Agent['cancel']>((_cause, options) => { if (!options?.keepInbox) queued.length = 0 })
      vi.spyOn(ctx.agents, 'get').mockReturnValue({ id: task.sessionId, session, cancel: cancelAgent, whenIdle: async () => {} } as never)
      await service.cancelTask({ id: task.taskId })
      expect(cancelAgent).toHaveBeenCalledWith({ kind: 'user' })
      expect(queued).toEqual([])
      expect(cancel).not.toHaveBeenCalled()
      ctx.emit('session/event', session, { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } } as never)
      await service.ensureAssistant({ kind: 'global' })
      expect(service.getTask(task.taskId)?.status).toBe('cancelled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports cancellation failure without persisting a cancelled status', async () => {
    const { ctx, service, sessions } = await harness()
    try {
      const assistant = await service.ensureAssistant({ kind: 'global' })
      sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
      const task = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Queued task' })
      vi.spyOn(ctx.agents, 'get').mockReturnValue({ cancel: () => { throw new Error('inbox unavailable') } } as never)
      await expect(service.cancelTask({ id: task.taskId })).rejects.toThrow('Task cancellation could not be confirmed')
      expect(service.getTask(task.taskId)).toMatchObject({ status: 'cancelling', failure: { code: 'cancel_failed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


it('preserves the assistant mapping when persistence cannot determine Session existence', async () => {
  const { ctx, service, sessions, create } = await harness()
  try {
    const original = await service.ensureAssistant({ kind: 'global' })
    sessions.set(original.sessionId, storedSession(original.sessionId))
    create.mockClear()
    vi.spyOn(ctx.sessionPersistence, 'stat').mockRejectedValueOnce(new Error('temporary storage outage'))
    await expect(service.ensureAssistant({ kind: 'global' })).rejects.toThrow('temporary storage outage')
    expect(create).not.toHaveBeenCalled()
    expect(service.listAssistants()).toEqual([original])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('preserves the assistant mapping when Session persistence is unavailable', async () => {
  const { ctx, service, sessions, create, disposePersistence } = await harness()
  try {
    const original = await service.ensureAssistant({ kind: 'global' })
    sessions.set(original.sessionId, storedSession(original.sessionId))
    create.mockClear()
    disposePersistence()
    await expect(service.ensureAssistant({ kind: 'global' })).rejects.toThrow('Session persistence is unavailable')
    expect(create).not.toHaveBeenCalled()
    expect(service.listAssistants()).toEqual([original])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('holds cancelling while the Agent drains and lets writes needed by settlement complete', async () => {
  const { ctx, service, sessions } = await harness()
  const idle = Promise.withResolvers<undefined>()
  const children = Promise.withResolvers<undefined>()
  try {
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const task = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Drain' })
    const worker = ctx.sessions.create(task.sessionId)
    const finishing = Promise.withResolvers<undefined>()
    ctx.provide('subagents', { drainDescendants: (parents: readonly Agent[]) => {
      expect(parents[0]?.id).toBe(task.sessionId)
      finishing.resolve(undefined)
      return children.promise
    } } as never)
    const signaled = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.agents, 'get').mockReturnValue({
      id: task.sessionId, cancel: () => { signaled.resolve(undefined) }, whenIdle: () => idle.promise,
    } as never)
    const cancel = service.cancelTask({ id: task.taskId })
    await Promise.all([signaled.promise, finishing.promise])
    const next = vi.fn(async () => ({ kind: 'reject' as const }))
    await ctx.waterfall('agent/pre-step', {
      agent: ctx.agents.get(task.sessionId)!, messages: [], turn: 2, step: 1,
      signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' },
    }, next)
    expect(next).not.toHaveBeenCalled()
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.ensureAssistant({ kind: 'global' })
    expect(service.getTask(task.taskId)?.status).toBe('cancelling')
    idle.resolve(undefined)
    await service.ensureAssistant({ kind: 'global' })
    expect(service.getTask(task.taskId)?.status).toBe('cancelling')
    children.resolve(undefined)
    await expect(cancel).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    children.resolve(undefined)
    idle.resolve(undefined)
    await ctx.fiber.dispose()
  }
})

it('records bounded final text and delivers one attributed notice to the creating conversation', async () => {
  const { ctx, service, sessions, followup, resolveAgent } = await harness({ config: { maxResultChars: 6 } })
  try {
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const creator = ctx.sessions.create(assistant.sessionId)
    const task = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Summarize' })
    const worker = ctx.sessions.create(task.sessionId)
    worker.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Result details' }],
      }),
    }, { surfaceOp: 'append' })
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.ensureAssistant({ kind: 'global' })
    expect(service.getTask(task.taskId)).toMatchObject({ status: 'done', resultSummary: 'Result' })
    await expect.poll(() => followup.mock.calls.length).toBe(1)
    expect(followup.mock.calls[0]?.[1]).toMatchObject({
      source: { kind: 'assistant-task', form: 'notice', taskId: task.taskId, sessionId: worker.id },
    })
    expect(resolveAgent).toHaveBeenCalledWith(creator.id)
  } finally { await ctx.fiber.dispose() }
})

it('never replays a first prompt whose admission outcome is unknown', async () => {
  const { ctx, service, prompt, sessions } = await harness()
  try {
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const request = { callerSessionId: assistant.sessionId, prompt: 'Charge once', requestId: 'once' }
    prompt.mockRejectedValueOnce(new Error('response lost'))
    const error = await rejectedTask(service.createTask(request))
    expect(service.getTask(error.details!.taskId!)).toMatchObject({ status: 'failed', failure: { code: 'prompt_outcome_unknown' } })
    await service.createTask(request)
    expect(prompt).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it('reads only tasks belonging to the calling registered assistant', async () => {
  const { ctx, service, create, sessions } = await harness({
    workspaces: new Map([[workspaceId, { id: workspaceId, path: '/project', title: 'Project' }]]),
  })
  try {
    const global = await service.ensureAssistant({ kind: 'global' })
    sessions.set(global.sessionId, storedSession(global.sessionId))
    const task = await service.createTask({ callerSessionId: global.sessionId, prompt: 'Private' })
    create.mockResolvedValueOnce({ sessionId: brandString<SessionId>('other-assistant'), agentPreset: 'assistant' })
    const other = await service.ensureAssistant({ kind: 'project', workspaceId })
    expect(service.listForAssistant(other.sessionId, {})).toEqual([])
    expect(() => service.taskForAssistant(other.sessionId, task.taskId)).toThrow('not found')
    expect(() => service.listForAssistant(task.sessionId, {})).toThrow('registered assistant')
    expect(service.taskForAssistant(global.sessionId, task.taskId)).toMatchObject({ id: task.taskId })
  } finally { await ctx.fiber.dispose() }
})

it.each([true, false])('reconciles an unacknowledged notice after restart with a persisted receipt: %s', async (persisted) => {
  const first = await harness()
  const assistant = await first.service.ensureAssistant({ kind: 'global' })
  first.sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
  const task = await first.service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Finish once' })
  const flush = Promise.withResolvers<undefined>()
  try {
    first.ctx.on('session/flush', () => { flush.resolve(undefined); throw new Error('acknowledgement lost') }, { global: true })
    const worker = first.ctx.sessions.create(task.sessionId)
    worker.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    await flush.promise
    expect(first.followup).toHaveBeenCalledTimes(1)
  } finally { await first.ctx.fiber.dispose() }
  const message = first.followup.mock.calls[0]![1]
  const stored = first.pool.media.values().next().value!.tables.get('tasks')!
  expect(stored.get(task.taskId)).toMatchObject({ creatorSessionId: assistant.sessionId, outbox: [{ id: message.id, state: 'sending' }] })
  const restarted = await harness({ pool: first.pool, sessions: first.sessions, ...(persisted ? { logs: first.logs } : {}) })
  try {
    await expect.poll(() => restarted.resolveAgent.mock.calls.length).toBe(1)
    if (persisted) {
      await expect.poll(() => assistantTaskRecord.parse(stored.get(task.taskId)).outbox).toEqual([])
      expect(restarted.ctx.logger.buffer.filter(line => line.type === 'warn')).toHaveLength(0)
    }
    expect(restarted.service.getTask(task.taskId)).toMatchObject({
      status: 'failed', resultSummary: 'The turn was interrupted.', failure: { code: 'interrupted' },
    })
  } finally { await restarted.ctx.fiber.dispose() }
  expect(restarted.followup).not.toHaveBeenCalled()
  expect(stored.get(task.taskId)).toMatchObject({ outbox: persisted ? [] : [{ id: message.id, state: 'sending' }] })
})

it('keeps a legacy task without guessing which conversation should receive historical results', async () => {
  const first = await harness()
  const original = await first.service.ensureAssistant({ kind: 'global' })
  first.sessions.set(original.sessionId, storedSession(original.sessionId))
  const task = await first.service.createTask({ callerSessionId: original.sessionId, prompt: 'Legacy' })
  await first.ctx.fiber.dispose()
  const stored = first.pool.media.values().next().value!.tables.get('tasks')!
  const raw = assistantTaskRecord.parse(stored.get(task.taskId))
  const { creatorSessionId, ...legacy } = raw
  expect(creatorSessionId).toBe(original.sessionId)
  stored.set(task.taskId, { ...legacy, status: 'done' })
  for (const key of first.pool.versions.keys()) first.pool.versions.set(key, 1)
  const restarted = await harness({ pool: first.pool, sessions: first.sessions })
  try {
    expect(restarted.service.listTasks()).toEqual([expect.objectContaining({ id: task.taskId, status: 'done' })])
    expect(restarted.resolveAgent).not.toHaveBeenCalled()
  } finally { await restarted.ctx.fiber.dispose() }
})

it('joins a final root wake from descendant teardown before declaring cancellation', async () => {
  const { ctx, service, sessions } = await harness()
  const child = Promise.withResolvers<undefined>()
  const lateIdle = Promise.withResolvers<undefined>()
  const didCancel = Promise.withResolvers<undefined>()
  const didJoinLate = Promise.withResolvers<undefined>()
  let late = false
  try {
    const assistant = await service.ensureAssistant({ kind: 'global' })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const task = await service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Child result' })
    const worker = {
      id: task.sessionId, cancel: () => { didCancel.resolve(undefined) },
      whenIdle: () => {
        if (late) { didJoinLate.resolve(undefined); return lateIdle.promise }
        return Promise.resolve()
      },
    }
    vi.spyOn(ctx.agents, 'get').mockReturnValue(worker as never)
    ctx.provide('subagents', { drainDescendants: () => child.promise } as never)
    const cancelling = service.cancelTask({ id: task.taskId })
    await didCancel.promise
    late = true
    child.resolve(undefined)
    const boundary = await Promise.race([didJoinLate.promise.then(() => 'joining'), cancelling.then(() => 'finished')])
    expect(boundary).toBe('joining')
    expect(service.getTask(task.taskId)?.status).toBe('cancelling')
    lateIdle.resolve(undefined)
    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' })
  } finally { child.resolve(undefined); lateIdle.resolve(undefined); await ctx.fiber.dispose() }
})

it('sends an interrupted result to its retired creator, not the replacement conversation', async () => {
  const first = await harness()
  const creator = await first.service.ensureAssistant({ kind: 'global' })
  first.sessions.set(creator.sessionId, storedSession(creator.sessionId))
  const task = await first.service.createTask({ callerSessionId: creator.sessionId, prompt: 'Persist work' })
  first.sessions.set(task.sessionId, storedSession(task.sessionId))
  first.sessions.delete(creator.sessionId)
  first.create.mockResolvedValueOnce({ sessionId: brandString<SessionId>('replacement'), agentPreset: 'assistant' })
  const replacement = await first.service.ensureAssistant({ kind: 'global' })
  expect(replacement.retiredSessionIds).toContain(creator.sessionId)
  first.sessions.set(creator.sessionId, storedSession(creator.sessionId))
  await first.ctx.fiber.dispose()

  const restarted = await harness({ pool: first.pool, sessions: first.sessions, logs: first.logs })
  try {
    await expect.poll(() => restarted.followup.mock.calls.length).toBe(1)
    const [recipient, notice] = restarted.followup.mock.calls[0]!
    expect(recipient.id).toBe(creator.sessionId)
    expect(notice.source).toMatchObject({ kind: 'assistant-task', taskId: task.taskId, sessionId: task.sessionId })
    expect(restarted.service.getTask(task.taskId)).toMatchObject({ status: 'failed', failure: { code: 'interrupted' } })
    expect(restarted.prompt).not.toHaveBeenCalled()
  } finally { await restarted.ctx.fiber.dispose() }
})

it('records admission intent before the worker prompt, so a missing Session cannot authorize replay', async () => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const accepted = Promise.withResolvers<{ accepted: boolean }>()
  try {
    const assistant = await h.service.ensureAssistant({ kind: 'global' })
    h.sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    h.prompt.mockImplementationOnce(() => { entered.resolve(undefined); return accepted.promise })
    const request = { callerSessionId: assistant.sessionId, prompt: 'Run once', requestId: 'once' }
    const pending = h.service.createTask(request)
    await entered.promise
    const table = h.pool.media.values().next().value!.tables.get('tasks')!
    const raw = [...table.values()][0]
    accepted.resolve({ accepted: true })
    await pending
    expect(raw).toMatchObject({ promptAttempted: true, status: 'created' })
    await h.ctx.fiber.dispose()
    const record = assistantTaskRecord.parse(raw)
    table.set(record.id, record)
    const restarted = await harness({ pool: h.pool, sessions: h.sessions })
    try {
      expect(restarted.service.getTask(record.id)).toMatchObject({ status: 'failed', failure: { code: 'prompt_outcome_unknown' } })
      await restarted.service.createTask(request)
      expect(restarted.prompt).not.toHaveBeenCalled()
    } finally { await restarted.ctx.fiber.dispose() }
  } finally { accepted.resolve({ accepted: true }); await h.ctx.fiber.dispose() }
})
