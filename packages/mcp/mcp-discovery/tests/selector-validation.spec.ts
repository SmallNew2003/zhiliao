import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { selectTools } from '../src/selector.ts'

class JsonSelector extends LlmAdapter {
  constructor(private readonly output: string) { super() }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.output }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.output } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function select(output: string) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['aux'], new JsonSelector(output))
  const session = Session.create(SessionId('selector-validation'))
  const agent = { id: session.id, session } as Agent
  const result = await selectTools(ctx, {
    provider: 'aux', model: 'selector', inputBytes: 8192, outputBytes: 1024, maxTokens: 256, timeoutMs: 10_000,
  }, agent, 'Read the issue', [{ server: 'repo', name: 'mcp__repo__issues', description: 'Read issue records', connected: true }], [], [])
  const recorded = session.snapshotEvents().flatMap(event => event.type === 'mcp/selector-result' ? [event.data] : [])
  return { result, recorded }
}

describe('MCP selector JSON status validation', () => {
  it.each(['selected', 'none', 'uncertain'] as const)('records the string status %s', async (status) => {
    const expected = { status, names: status === 'selected' ? ['mcp__repo__issues'] : [], servers: [] }
    const { result, recorded } = await select(JSON.stringify(expected))
    expect(result).toEqual(expected)
    expect(recorded).toEqual([expected])
  })

  it.each([
    { label: 'selected array', status: ['selected'] },
    { label: 'none array', status: ['none'] },
    { label: 'uncertain array', status: ['uncertain'] },
    { label: 'null', status: null },
    { label: 'boolean', status: true },
    { label: 'number', status: 1 },
    { label: 'object', status: {} },
  ])('records a $label status as failed', async ({ status }) => {
    const { result, recorded } = await select(JSON.stringify({ status, names: [], servers: [] }))
    expect(result).toMatchObject({ status: 'failed', names: [], servers: [] })
    expect(recorded).toEqual([result])
  })
})
