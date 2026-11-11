/** Assistant tools participate only in the registered assistant's admitted steps. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { harness } from '../../task/tests/harness.ts'
import * as ToolTask from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('excludes create_task from ordinary sessions and dispatch outside an admitted step', async () => {
  const { ctx, service } = await harness()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(ToolTask)
  const assistant = await service.ensureAssistant({ kind: 'global' })
  const ordinary = { id: SessionId('ordinary'), session: { id: SessionId('ordinary') } } as Agent
  const registered = { id: assistant.sessionId, session: { id: assistant.sessionId } } as Agent
  const modelSelection = { provider: 'test', model: 'test' }
  const signal = new AbortController().signal
  const ordinarySet = await ctx.tools.resolve({ agent: ordinary, modelSelection, signal })
  const assistantSet = await ctx.tools.resolve({ agent: registered, modelSelection, signal })
  expect(ctx.tools.schemas(ordinary, ordinarySet).map(tool => tool.name)).not.toContain('create_task')
  expect(ctx.tools.executable('create_task', ordinary, ordinarySet)).toBeUndefined()
  const ordinaryPrompt = await ctx.systemPrompt.assemble({ scope: ordinary, agent: ordinary, toolSet: ordinarySet })
  expect(ordinaryPrompt.sections.find(section => section.name === 'tool:create_task')?.text ?? '').toBe('')
  const assistantPrompt = await ctx.systemPrompt.assemble({ scope: registered, agent: registered, toolSet: assistantSet })
  expect(assistantPrompt.sections.find(section => section.name === 'tool:create_task')?.text).toContain('Create assistant tasks')
  expect(ctx.tools.executable('create_task', registered)).toBeUndefined()
  for (const name of ['create_task', 'list_tasks', 'get_task']) {
    expect(ctx.tools.schemas(registered, assistantSet).map(tool => tool.name)).toContain(name)
    expect(ctx.tools.executable(name, ordinary, ordinarySet)).toBeUndefined()
  }
  assistantSet.dispose()
  expect(ctx.tools.executable('create_task', registered, assistantSet)).toBeUndefined()
})
