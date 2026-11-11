/** Cancellation admission and durable worker outcomes cross independent Session and domain commits. */
import { expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AssistantTaskService from '../src/index.ts'
import { noticeReceipts } from '../src/notices.ts'
import { assistantDomain } from '../src/storage.ts'
import { workerOutcome } from '../src/outcome.ts'
import { harness, storedSession } from './harness.ts'

async function taskFixture(title = 'Task', options?: Parameters<typeof harness>[0]) {
  const h = await harness(options)
  const assistant = await h.service.ensureAssistant({ kind: 'global' })
  h.sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
  const task = await h.service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Do work', title })
  h.sessions.set(task.sessionId, storedSession(task.sessionId))
  const worker = h.ctx.sessions.create(task.sessionId)
  const records = h.pool.media.values().next().value!.tables.get('tasks')!
  return { h, assistant, task, worker, records }
}

function step(h: Awaited<ReturnType<typeof harness>>, agent: Agent) {
  return h.ctx.waterfall('agent/pre-step', {
    agent, messages: [], turn: 2, step: 1,
    signal: new AbortController().signal, modelSelection: { provider: 'fixture', model: 'fixture' },
  }, async () => ({ kind: 'enter', messages: [] }))
}

it('immediately fences and cancels another worker while first prompt admission is pending', async () => {
  const { h, assistant, task, worker } = await taskFixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<{ accepted: boolean }>()
  try {
    h.prompt.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    const creation = h.service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Independent' })
    await entered.promise
    const agent = { id: task.sessionId, session: worker, cancel: vi.fn(), whenIdle: vi.fn(async () => {}) } as never
    vi.spyOn(h.ctx.agents, 'get').mockReturnValue(agent)
    const cancelling = h.service.cancelTask({ id: task.taskId })
    expect((await step(h, agent)).kind).toBe('reject')
    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' })
    release.resolve({ accepted: true })
    await creation
  } finally { release.resolve({ accepted: true }); await h.ctx.fiber.dispose() }
})

it('holds the step fence through service unloading and commits the accepted cancellation before closing storage', async () => {
  const { h, task, worker, records } = await taskFixture()
  const signaled = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  try {
    const agent = {
      id: task.sessionId, session: worker, cancel: () => { signaled.resolve(undefined) }, whenIdle: () => release.promise,
    } as never
    vi.spyOn(h.ctx.agents, 'get').mockReturnValue(agent)
    const stop = h.service.cancelTask({ id: task.taskId })
    await signaled.promise
    const fiber = [...h.ctx.registry.get(AssistantTaskService)!.fibers][0]!
    const unloading = Promise.resolve(fiber.dispose())
    await expect.poll(() => Reflect.get(h.service, 'phase') === 'stopping').toBe(true)
    expect((await step(h, agent)).kind).toBe('reject')
    release.resolve(undefined)
    expect(await stop).toMatchObject({ status: 'cancelled' })
    await unloading
    expect(records.get(task.taskId)).toMatchObject({ status: 'cancelled' })
  } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
})

it('recovers a committed first turn and its public result while leaving the worker inactive', async () => {
  const { h, task, worker, records } = await taskFixture()
  const running = records.get(task.taskId)
  worker.append('turn/start', { turn: 1 })
  worker.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { model: 'fixture', provider: 'fixture' }, content: [{ type: 'text', text: 'Worker result' }],
  }) }, { surfaceOp: 'append' })
  worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  worker.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
  await h.service.ensureAssistant({ kind: 'global' })
  await h.ctx.fiber.dispose()
  records.set(task.taskId, running)
  const restarted = await harness({ pool: h.pool, sessions: h.sessions, logs: h.logs, config: { maxResultChars: 6 } })
  try {
    await expect.poll(() => restarted.followup.mock.calls.length).toBe(1)
    expect(restarted.service.getTask(task.taskId)).toMatchObject({ status: 'done', resultSummary: 'Worker' })
    const content = restarted.followup.mock.calls[0]?.[1].content
    expect(content).toHaveLength(1)
    const block = content?.[0]
    expect(block?.type === 'text' ? block.text : undefined).toContain('"resultSummary":"Worker"')
    expect(restarted.resolveAgent).not.toHaveBeenCalledWith(task.sessionId)
    expect(restarted.ctx.sessions.get(task.sessionId)).toBeUndefined()
    expect(restarted.prompt).not.toHaveBeenCalled()
  } finally { await restarted.ctx.fiber.dispose() }
})

it('keeps the running record when the stored worker log could not be read', async () => {
  const { h, task, records } = await taskFixture()
  await h.ctx.fiber.dispose()
  await expect(harness({ pool: h.pool, sessions: h.sessions, logs: h.logs, configure(ctx) {
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValue(new Error('temporarily unreadable'))
  } })).rejects.toThrow('temporarily unreadable')
  expect(records.get(task.taskId)).toMatchObject({ status: 'running' })
  expect(records.get(task.taskId)).not.toHaveProperty('outbox')
})

it('exposes safe failure explanations to list, detail and notice readers', async () => {
  const { h, task, assistant, worker } = await taskFixture()
  try {
    const diagnostic = 'SYNTHETIC provider diagnostic /private/fixture'
    worker.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'HTTP_400', message: diagnostic } } })
    await expect.poll(() => h.followup.mock.calls.length).toBe(1)
    for (const value of [h.service.listForAssistant(assistant.sessionId, {}), h.service.taskForAssistant(assistant.sessionId, task.taskId),
      h.service.task({ id: task.taskId }), h.followup.mock.calls[0]?.[1].content]) {
      expect(JSON.stringify(value)).not.toContain(diagnostic)
    }
    expect(h.service.getTask(task.taskId)).toMatchObject({ status: 'failed', failure: { code: 'turn_error' } })
  } finally { await h.ctx.fiber.dispose() }
})

it('bounds the entire one-line inbox notice summary even for a multiline title', async () => {
  const { h, worker } = await taskFixture('x'.repeat(90) + '\n' + 'y'.repeat(29))
  try {
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => h.followup.mock.calls.length).toBe(1)
    const source = h.followup.mock.calls[0]![1].source
    expect(source.kind).toBe('assistant-task')
    if (source.kind === 'assistant-task') {
      expect(source.summary).not.toMatch(/\s*[\n\r]/)
      expect(source.summary.length).toBeLessThanOrEqual(120)
    }
  } finally { await h.ctx.fiber.dispose() }
})

it('coalesces a retried admission and joins that same admission before committing cancellation', async () => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<{ accepted: boolean }>()
  try {
    const assistant = await h.service.ensureAssistant({ kind: 'global' })
    h.sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    h.prompt.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    const request = { callerSessionId: assistant.sessionId, prompt: 'One admission', requestId: 'shared' }
    const first = h.service.createTask(request)
    await entered.promise
    const duplicate = h.service.createTask(request)
    const [task] = h.service.listTasks()
    const cancelling = h.service.cancelTask({ id: task!.id })
    await expect.poll(() => h.service.getTask(task!.id)?.status).toBe('cancelling')
    release.resolve({ accepted: true })
    expect(await duplicate).toEqual(await first)
    expect(await cancelling).toMatchObject({ status: 'cancelled' })
    expect(h.prompt).toHaveBeenCalledTimes(1)
  } finally { release.resolve({ accepted: true }); await h.ctx.fiber.dispose() }
})

it('preserves a fast committed worker result when the prompt acknowledgement arrives later', async () => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<{ accepted: boolean }>()
  try {
    const assistant = await h.service.ensureAssistant({ kind: 'global' })
    h.sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    h.prompt.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    const admission = h.service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Finish before admission returns' })
    await entered.promise
    const task = h.service.listTasks()[0]!
    h.ctx.sessions.create(task.sessionId).append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => h.service.getTask(task.id)?.status).toBe('done')
    release.resolve({ accepted: true })
    await admission
    expect(h.service.getTask(task.id)).toMatchObject({ status: 'done' })
  } finally { release.resolve({ accepted: true }); await h.ctx.fiber.dispose() }
})

it('recovers an open worker turn as interrupted without publishing partial output as a finished result', async () => {
  const { h, task, worker } = await taskFixture()
  worker.append('turn/start', { turn: 1 })
  worker.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { model: 'fixture', provider: 'fixture' }, content: [{ type: 'text', text: 'Partial worker output' }],
    }),
  }, { surfaceOp: 'append' })
  await h.service.ensureAssistant({ kind: 'global' })
  await h.ctx.fiber.dispose()
  const restarted = await harness({ pool: h.pool, sessions: h.sessions, logs: h.logs })
  try {
    await expect.poll(() => restarted.followup.mock.calls.length).toBe(1)
    expect(restarted.service.getTask(task.taskId)).toMatchObject({ status: 'failed', failure: { code: 'interrupted' } })
    expect(JSON.stringify(restarted.followup.mock.calls[0]?.[1].content)).not.toContain('Partial worker output')
    expect(restarted.resolveAgent).not.toHaveBeenCalledWith(task.sessionId)
  } finally { await restarted.ctx.fiber.dispose() }
})

it('remounts on the same Host after a projection conflict and retains the stored task', async () => {
  const { h, task, worker } = await taskFixture()
  try {
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => h.followup.mock.calls.length).toBe(1)
    const original = h.service.getTask(task.taskId)
    expect(original?.status).toBe('done')
    await [...h.ctx.registry.get(AssistantTaskService)!.fibers][0]!.dispose()
    const listeners = () => [
      h.ctx.events.dispatch('waterfall', ['agent/pre-step']).length,
      h.ctx.events.dispatch('emit', ['session/event']).length,
      h.ctx.events.dispatch('emit', ['agent/status']).length,
    ]
    const baseline = listeners()
    const conflict = await h.ctx.sessionProjections.register({ ...workerOutcome, stateVersion: 2 })
    const failed = h.ctx.plugin(AssistantTaskService, {})
    try {
      await expect(Promise.resolve(failed)).rejects.toThrow('refusing to share')
    } finally {
      await failed.dispose()
      await conflict.dispose()
    }
    expect.soft(listeners()).toEqual(baseline)
    const replacement = await h.ctx.sessionProjections.register({ ...noticeReceipts, stateVersion: 2 })
    await replacement.dispose()
    await h.ctx.plugin(AssistantTaskService, {})
    expect(h.ctx.assistantTasks.getTask(task.taskId)).toEqual(original)
  } finally { await h.ctx.fiber.dispose() }
})

it('leaves recovered notices pending without opening the creator when a later recovery read fails', async () => {
  const { h, assistant, task, worker, records } = await taskFixture()
  const release = Promise.withResolvers<undefined>()
  try {
    const second = await h.service.createTask({ callerSessionId: assistant.sessionId, prompt: 'Next task' })
    h.sessions.set(second.sessionId, storedSession(second.sessionId))
    await [...h.ctx.registry.get(AssistantTaskService)!.fibers][0]!.dispose()
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const open = vi.spyOn(h.ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('unreadable second log'))
    const resolve = h.resolveAgent.getMockImplementation()!
    h.resolveAgent.mockImplementation(async (id) => { await release.promise; return resolve(id) })
    const failed = h.ctx.plugin(AssistantTaskService, {})
    await expect(Promise.resolve(failed)).rejects.toThrow('unreadable second log')
    expect(open).toHaveBeenCalledWith(second.sessionId, 'read', undefined)
    expect(h.resolveAgent).not.toHaveBeenCalled()
    await failed.dispose()
    const reopened = await h.ctx.storageDomain.open(assistantDomain)
    await reopened.close()
    expect(records.get(task.taskId)).toMatchObject({ status: 'done', outbox: [{ state: 'pending' }] })
    expect(h.ctx.sessions.get(assistant.sessionId)).toBeUndefined()
    expect(h.followup).not.toHaveBeenCalled()

    release.resolve(undefined)
    await h.ctx.plugin(AssistantTaskService, {})
    await expect.poll(() => records.get(task.taskId)).toMatchObject({ outbox: [] })
    expect(h.followup.mock.calls.filter(([, message]) =>
      message.source.kind === 'assistant-task' && message.source.taskId === task.taskId)).toHaveLength(1)
  } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
})

it('recovers a resident result once and observes turns ending during or after the recovery scan', async () => {
  const { h, assistant, task, worker } = await taskFixture('Task', { config: { maxTasksPerTurn: 4 } })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const detach = [h.ctx.agents.enter({ id: worker.id, session: worker } as never, undefined)]
  try {
    const newWorker = async (prompt: string) => {
      const item = await h.service.createTask({ callerSessionId: assistant.sessionId, prompt })
      h.sessions.set(item.sessionId, storedSession(item.sessionId))
      return { item, session: h.ctx.sessions.create(item.sessionId) }
    }
    const mid = await newWorker('Finishes during recovery')
    const active = await newWorker('Still running')
    const gate = await newWorker('Cold record')
    for (const { session } of [mid, active]) {
      detach.push(h.ctx.agents.enter({ id: session.id, session } as never, undefined))
    }
    await [...h.ctx.registry.get(AssistantTaskService)!.fibers][0]!.dispose()
    worker.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { model: 'fixture', provider: 'fixture' }, content: [{ type: 'text', text: 'Result while offline' }],
    }) }, { surfaceOp: 'append' })
    worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    gate.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    vi.spyOn(h.ctx.sessionPersistence, 'stat').mockImplementation(async (id) => {
      if (id === gate.item.sessionId) { entered.resolve(undefined); await release.promise }
      return h.sessions.get(id)
    })
    const mounted = h.ctx.plugin(AssistantTaskService, {})
    await entered.promise
    mid.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    release.resolve(undefined)
    await mounted
    expect(h.ctx.assistantTasks.taskForAssistant(assistant.sessionId, task.taskId))
      .toMatchObject({ status: 'done', resultSummary: 'Result while offline' })
    await expect.poll(() => h.ctx.assistantTasks.getTask(mid.item.taskId)).toMatchObject({ status: 'done' })
    expect(h.ctx.assistantTasks.getTask(active.item.taskId)).toMatchObject({ status: 'running' })
    active.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => h.followup.mock.calls.length).toBe(3)
    await mounted.dispose()
    expect(h.followup.mock.calls.map(([, message]) => message.source.kind === 'assistant-task' && message.source.taskId).sort())
      .toEqual([task.taskId, mid.item.taskId, active.item.taskId].sort())
    expect(h.prompt).toHaveBeenCalledTimes(4)
    expect(h.resolveAgent.mock.calls.map(([id]) => id)).toEqual(Array(3).fill(assistant.sessionId))
  } finally { release.resolve(undefined); for (const leave of detach) leave(); await h.ctx.fiber.dispose() }
})
