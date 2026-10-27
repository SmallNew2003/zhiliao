/** Durable preflight repairs and cancellation before assistant-attempt creation. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('done')])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const agent = await ctx.agentLoop.create(SessionId('preflight'), { provider: 'mock', model: 'model' })
  // The loop dispatches preflight only for an explicit context budget.
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), contextWindow: 640_000 }))
  return { ctx, agent, adapter }
}

describe('request preflight', () => {
  it('rebuilds after a durable replacement without resampling request config or duplicating current input', async () => {
    const { ctx, agent, adapter } = await harness()
    const historical = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old history' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    let selections = 0
    ctx.on('agent/request', async (_payload, next) => { selections += 1; return next() })
    const observed: GenerateOptions[] = []
    agent.ctx.on('agent/request-preflight', async ({ request }) => {
      observed.push(request)
      expect(Object.isFrozen(request)).toBe(true)
      if (observed.length !== 1) return
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'repaired history' }], source: { kind: 'user' },
      }), { surfaceOp: { op: 'replace', startSeq: historical.seq, endSeq: historical.seq }, sourceEventSeqs: [historical.seq] })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'current input' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(selections).toBe(1)
    expect(observed).toHaveLength(2)
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(observed[0]?.messages)).toContain('old history')
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('old history')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('repaired history')
    expect(adapter.requests[0]?.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === 'current input'))).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1)?.data.reason).toBe('series')
  })

  it('normalizes a system prompt a preflight repair rewrote before rebuilding', async () => {
    const { agent, adapter } = await harness()
    const observed: GenerateOptions[] = []
    agent.ctx.on('agent/request-preflight', async ({ request, turn, step }) => {
      observed.push(request)
      if (observed.length !== 1) return
      // A durable repair rewrites the system head; the rebuild re-projects the
      // rendered prompt over it instead of streaming the repaired text.
      const head = agent.session.snapshotEvents().find(event => event.type === 'system/message')
      if (head === undefined) throw new Error('the first projection left no system node')
      agent.session.append('system/message', {
        turn, step, message: createSystemMessage('repaired prompt', '@deepseek-ai/dsh-system-prompt'),
      }, { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'current input' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(observed).toHaveLength(2)
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('repaired prompt')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('You are an AI agent powered by DeepSeek Harness.')
  })

  it('cancels awaited preflight without an assistant attempt', async () => {
    const { agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    agent.ctx.on('agent/request-preflight', async () => { entered.resolve(undefined); await released.promise })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'current input' }], source: { kind: 'user' } }))
    try {
      await entered.promise
      agent.cancel({ kind: 'user' })
    } finally {
      released.resolve(undefined)
      await agent.whenIdle()
    }
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toEqual([])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })
})
