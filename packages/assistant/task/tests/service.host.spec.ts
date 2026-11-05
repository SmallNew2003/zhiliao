import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
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
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.getTask(result.taskId)?.status).toBe('done')
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
    const wait = () => new Promise(resolve => setTimeout(resolve, 20))

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
    prompt.mockRejectedValueOnce(new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }))
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
