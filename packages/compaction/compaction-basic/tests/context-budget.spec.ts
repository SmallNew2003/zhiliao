/** Explicit context admission through the real loop, compaction engine, and meter. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  readonly order: string[] = []
  readonly summary = { run: async () => 'short checkpoint' }
  beforeFinish: (() => Promise<void>) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 5000 } })
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const trailing = request.messages.at(-1)?.content
      .map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(request)
      this.order.push('summary')
      const text = await this.summary.run()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(request)
    this.order.push('conversation')
    await this.beforeFinish?.()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(options: {
  auto?: boolean
  history?: boolean
  window?: number
  maxTokens?: number
  anchorUsage?: number
} = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new BudgetAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['budget'], adapter))
  const summary = adapter.summary
  await ctx.plugin(BasicCompactionEngine, {
    auto: options.auto ?? true, thresholdRatio: 0.8, retainTokens: 0, maxTokens: 100, compactionRetries: 1,
  })
  const seed = Session.create(SessionId('budget-seed'))
  if (options.anchorUsage !== undefined) {
    seed.append('request/header', { reason: 'initial', header: { config: { provider: 'budget', model: 'model', contextWindow: 5000 } } })
  }
  if (options.history !== false) {
    for (let turn = 1; turn <= 2; turn += 1) {
      seed.append('turn/start', { turn })
      seed.append('step/start', { turn, step: 1 })
      if (turn === 1) seed.append('system/message', { turn, step: 1, message: createSystemMessage('You are an AI agent powered by DeepSeek Harness.', '@deepseek-ai/dsh-system-prompt') }, { surfaceOp: 'append' })
      seed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old history '.repeat(180) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      seed.append('assistant/message', {
        turn, step: 1, stream: [],
        message: createAssistantMessage({ content: [{ type: 'text', text: 'old response '.repeat(180) }], source: { provider: 'budget', model: 'model' } }),
        ...turn !== 2 || options.anchorUsage === undefined ? {} : { usage: { inputTokens: options.anchorUsage, outputTokens: 0 } },
      }, { surfaceOp: 'append' })
      seed.append('step/end', { turn, step: 1 })
      seed.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('budget-agent'), seed: seed.snapshotEvents(),
    agentOptions: { provider: 'budget', model: 'model', ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens } },
  })
  const selection: ModelSelectionRef = {
    current: { provider: 'budget', model: 'model', ...options.window === undefined ? {} : { contextWindow: options.window } }, assembled: undefined,
  }
  ctx.effect(() => installModelSelection(agent.ctx, selection))
  return { ctx, agent, adapter, selection, summary }
}

async function send(agent: Agent, text = 'current input'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function expectBlocked(agent: Agent): void {
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_BUDGET_EXCEEDED' } } },
  })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toEqual([])
}

describe('explicit context budgets', () => {
  it('compresses old history before the first ordinary request and rebuilds without duplicating input', async () => {
    const { ctx, agent, adapter } = await harness({ window: 900, maxTokens: 100 })
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(900)
    await send(agent)
    expect(adapter.order).toEqual(['summary', 'conversation'])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.contextWindow).toBe(900)
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('old history')
    expect(adapter.requests[0]?.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === 'current input'))).toHaveLength(1)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(640)
  })

  it.each([false, true])('blocks oversized newest input with prior history=%s', async (history) => {
    const { agent, adapter } = await harness({ window: 900, history })
    await send(agent, 'newest unit '.repeat(900))
    expect(adapter.requests).toEqual([])
    expectBlocked(agent)
  })

  it('blocks failed summaries and can continue after a larger selection', async () => {
    const { agent, adapter, summary, selection } = await harness({ window: 900 })
    summary.run = async () => { throw new Error('summary unavailable') }
    await send(agent)
    expect(adapter.requests).toEqual([])
    expectBlocked(agent)
    selection.current = { provider: 'budget', model: 'model', contextWindow: 5000 }
    await send(agent, 'continue')
    expect(adapter.requests).toHaveLength(1)
  })

  it('blocks insufficient reduction', async () => {
    const { agent, adapter, summary } = await harness({ window: 900 })
    summary.run = async () => 'still too large '.repeat(1000)
    await send(agent)
    expect(adapter.requests).toEqual([])
    expectBlocked(agent)
  })

  it('keeps provider usage after a budget-only shrink and blocks optimistic heuristic admission', async () => {
    const { ctx, agent, adapter } = await harness({ window: 900, anchorUsage: 500000 })
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThanOrEqual(500000)
    await send(agent)
    expect(adapter.requests).toEqual([])
    expect(adapter.summaryRequests.length).toBeGreaterThan(0)
    expect(ctx.tokenMeter.measure(agent.session).baseline.kind).toBe('usage')
    expectBlocked(agent)
  })

  it.each(['system', 'tools'] as const)('blocks oversized unsummarizable %s text', async (kind) => {
    const { ctx, agent, adapter } = await harness({ window: 900, history: false })
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return kind === 'system'
        ? { ...assembly, sections: [{ name: 'large-system', text: 'mandatory guidance '.repeat(1000) }] }
        : { ...assembly, tools: [{ name: 'large-tool', description: 'tool description '.repeat(1000), parameters: { type: 'object' } }] }
    })
    await send(agent)
    expect(adapter.requests).toEqual([])
    expectBlocked(agent)
  })

  it('reserves output headroom even when input alone fits the window', async () => {
    const { agent, adapter } = await harness({ window: 3000, maxTokens: 2100 })
    await send(agent)
    expect(adapter.order).toEqual(['summary', 'conversation'])
  })

  it('blocks a window at the output reserve', async () => {
    const { agent, adapter } = await harness({ window: 900, maxTokens: 900, history: false })
    await send(agent)
    expect(adapter.order).toEqual([])
    expectBlocked(agent)
  })

  it('blocks an oversized budget without automatic summarization when auto is disabled', async () => {
    const { agent, adapter } = await harness({ auto: false, window: 900 })
    await send(agent)
    expect(adapter.order).toEqual([])
    expectBlocked(agent)
  })

  it.each([undefined, 5000])('keeps under-budget request behavior for window=%s', async (window) => {
    const { agent, adapter } = await harness(window === undefined ? {} : { window })
    await send(agent)
    expect(adapter.order).toEqual(['conversation'])
  })

  it('holds the assembled selection across deferred compression', async () => {
    const { agent, adapter, summary, selection } = await harness({ window: 900 })
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    summary.run = async () => { entered.resolve(undefined); await released.promise; return 'short checkpoint' }
    const running = send(agent)
    try {
      await entered.promise
      selection.current = { provider: 'budget', model: 'model', contextWindow: 5000 }
      released.resolve(undefined)
      await running
      expect(adapter.requests[0]?.contextWindow).toBe(900)
      await send(agent, 'next turn')
      expect(adapter.requests[1]?.contextWindow).toBe(5000)
    } finally {
      released.resolve(undefined)
      await running
    }
  })

  it('leaves an active stream on its admitted budget', async () => {
    const { agent, adapter, selection } = await harness({ window: 5000 })
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    adapter.beforeFinish = async () => { entered.resolve(undefined); await released.promise }
    const running = send(agent)
    try {
      await entered.promise
      selection.current = { provider: 'budget', model: 'model', contextWindow: 900 }
      expect(adapter.requests[0]?.contextWindow).toBe(5000)
      expect(adapter.order).toEqual(['conversation'])
    } finally {
      released.resolve(undefined)
      await running
    }
    await send(agent, 'later input')
    expect(adapter.order).toEqual(['conversation', 'summary', 'conversation'])
    expect(adapter.requests[1]?.contextWindow).toBe(900)
  })

  it('cancels deferred compression without ordinary dispatch', async () => {
    const { agent, adapter, summary } = await harness({ window: 900 })
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    summary.run = async () => { entered.resolve(undefined); await released.promise; return 'short checkpoint' }
    const running = send(agent)
    try {
      await entered.promise
      agent.cancel({ kind: 'user' })
    } finally {
      released.resolve(undefined)
      await running
    }
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })
})
