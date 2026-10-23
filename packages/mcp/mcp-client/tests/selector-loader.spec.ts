/** Enabled auxiliary selection through a declarative Loader tree and production AgentLoop. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import McpDiscovery from '@deepseek-ai/dsh-mcp-discovery'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'

const selectedName = 'mcp__fixture__needed'
const instructions = 'SELECTOR_LOADER_INSTRUCTIONS: preserve {{literal}}.'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reply: string, private readonly label: string, private readonly order: string[]) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.order.push(this.label)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 10_000 }
  }

  run(_spec: PtcRunSpec): Promise<PtcRunResult> {
    throw new Error('The selector Loader case ends after inspecting the first main request.')
  }
}

async function composition(mode: 'native' | 'ptc', delayed: boolean) {
  const ctx = new Context()
  const started = Promise.withResolvers<undefined>()
  const registration = Promise.withResolvers<undefined>()
  const order: string[] = []
  const auxiliary = new ScriptedAdapter(JSON.stringify({ status: 'selected', names: [selectedName], servers: [] }), 'selector', order)
  const main = new ScriptedAdapter('LOADER_SELECTED', 'main', order)
  const errors: string[] = []
  ctx.logger.error = (message: unknown) => { errors.push(String(message)) }
  onTestFinished(async () => {
    registration.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    llm: LlmRuntime,
    sessions: SessionStore,
    projections: SessionProjectionRegistry,
    prompt: SystemPrompt,
    tools: ToolRuntime,
    registry: AgentRegistry,
    loop: AgentLoop,
    discovery: McpDiscovery,
    ptc: PresentationRuntime,
    providers: {
      name: 'selector-loader-providers', inject: ['llm'],
      async apply(inner: Context) {
        started.resolve(undefined)
        if (delayed) await registration.promise
        inner.llm.registerAdapter(['auxiliary'], auxiliary)
        inner.llm.registerAdapter(['conversation'], main)
      },
    },
    catalog: {
      name: 'selector-loader-catalog', inject: ['mcpDiscovery'],
      apply(inner: Context) {
        inner.mcpDiscovery.registerServer('fixture', { connected: () => true, instructions: () => instructions })
        for (const name of [selectedName, 'mcp__fixture__decoy']) {
          inner.mcpDiscovery.registerTool('fixture', {
            name, description: name === selectedName ? 'Read the needed fixture record.' : 'Read an unrelated fixture record.',
            parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
            execute: () => Promise.resolve('fixture record'),
          })
        }
      },
    },
  })
  const rows: EntryOptions[] = [
    { id: 'llm', name: 'cordis:llm' },
    { id: 'providers', name: 'cordis:providers' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools', config: { mode } },
    { id: 'registry', name: 'cordis:registry' },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'discovery', name: 'cordis:discovery', config: { selector: {
      provider: 'auxiliary', model: 'cheap-selector', inputBytes: 8192, outputBytes: 2048, maxTokens: 256, timeoutMs: 10_000,
    } } },
    { id: 'catalog', name: 'cordis:catalog' },
    ...mode === 'ptc' ? [{ id: 'ptc', name: 'cordis:ptc' }] : [],
  ]
  const loading = ctx.loader.root.update(rows)
  await started.promise
  if (delayed) {
    // Keep the adapter pending until the other dependency-satisfied Loader row has initialized.
    await vi.waitFor(() => {
      const discovery = [...ctx.loader.entries()].find(entry => entry.options.id === 'discovery')
      expect([FiberState.ACTIVE, FiberState.FAILED]).toContain(discovery?.fiber?.state)
    })
  }
  registration.resolve(undefined)
  await loading
  await ctx.loader.await()
  return { ctx, errors, main, auxiliary, order }
}

describe('enabled MCP selector Loader composition', () => {
  it.each([
    { mode: 'native', delayed: false },
    { mode: 'ptc', delayed: false },
    { mode: 'native', delayed: true },
    { mode: 'ptc', delayed: true },
  ] as const)('preselects the first $mode request when adapter initialization is delayed=$delayed', async ({ mode, delayed }) => {
    const { ctx, errors, main, auxiliary, order } = await composition(mode, delayed)
    expect(errors).toEqual([])
    expect(ctx.get('mcpDiscovery')).toBeDefined()
    const agent = await ctx.agentLoop.create(SessionId(`selector-loader-${mode}-${delayed}`), {
      provider: 'conversation', model: 'main-model',
    })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the needed fixture record.' }] }))
    await agent.whenIdle()

    expect(order).toEqual(['selector', 'main'])
    expect(auxiliary.requests).toHaveLength(1)
    expect(main.requests).toHaveLength(1)
    expect(auxiliary.requests[0]).toMatchObject({ provider: 'auxiliary', model: 'cheap-selector', maxTokens: 256, purpose: 'mcp-selector' })
    expect(main.requests[0]).toMatchObject({ provider: 'conversation', model: 'main-model' })
    const request = main.requests[0]!
    const prompt = request.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n\n')
    expect(prompt).toContain(instructions)
    if (mode === 'native') {
      expect(request.tools?.map(tool => tool.name)).toEqual(['discover_mcp_tools', selectedName])
      expect(request.tools?.find(tool => tool.name === selectedName)).toEqual({
        name: selectedName, description: 'Read the needed fixture record.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      })
    } else {
      expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
      expect(prompt).toContain(`${selectedName}: {`)
      expect(prompt).toContain('key: string;')
      expect(prompt).not.toContain('mcp__fixture__decoy:')
    }
    expect(agent.session.snapshotEvents().flatMap(event => event.type === 'mcp/request-snapshot'
      ? [event.data.tools.map(tool => tool.name)] : [])).toEqual([[selectedName]])
  })
})
