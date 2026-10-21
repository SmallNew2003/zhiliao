import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import LlmRuntime, { LlmAdapter, ToolCallId, LlmAttemptId, createUserMessage, createSystemMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import Discovery, { Config } from '../src/index.ts'
import { selectTools } from '../src/selector.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
async function setup(config: Partial<Config> = {}, adapter?: LlmAdapter, mode: 'native' | 'ptc' | 'both' = 'native') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode })
  if (mode !== 'native') await ctx.plugin(PtcProbe)
  await ctx.plugin(Projections)
  if (adapter) { await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter(['aux'], adapter) }
  await ctx.plugin(Discovery, Config(config))
  return ctx
}
function agent(ctx: Context, id = 'a', seed?: Parameters<typeof Session.create>[1]): Agent {
  const session = Session.create(SessionId(id), seed)
  const owner = { id: session.id, session } as Agent
  const scope = createScope(ctx, owner)
  Object.assign(owner, { ctx: scope.ctx })
  return owner
}
function tool(name = 'mcp__repo__issues', description = 'Search issues'): ToolDefinition {
  return {
    name, description, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute() { return description },
  }
}
function server(ctx: Context, name = 'repo', instructions = 'Use issue IDs literally.') {
  return ctx.mcpDiscovery.registerServer(name, { instructions: () => instructions, connected: () => true })
}
async function assemble(ctx: Context, owner: Agent, text?: string, source: 'user' | 'plugin' = 'user') {
  const assembled = await ctx.systemPrompt.assemble({ scope: owner, agent: owner,
    stepInput: { turn: 1, step: 1, messages: text === undefined ? [] : [createUserMessage({
      content: [{ type: 'text', text }], source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture' },
    })] },
  })
  owner.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(renderPrompt(assembled), 'fixture') }, { surfaceOp: 'append' })
  owner.session.append('request/header', {
    header: { config: { provider: 'fixture', model: 'fixture' }, ...assembled.tools.length ? { tools: assembled.tools } : {} },
    reason: owner.session.requestHeader() === undefined ? 'initial' : 'change',
  })
  return assembled
}
function bind(ctx: Context, owner: Agent) {
  ctx.emit(scopeTarget(owner, owner), 'agent/assistant-stream', { agent: owner, frame: {
    type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1,
  } })
}
function call(ctx: Context, owner: Agent, name = 'mcp__repo__issues') {
  return ctx.tools.execute({ agent: owner, callId: ToolCallId('call'), name,
    arguments: {}, signal: new AbortController().signal })
}

describe('MCP discovery', () => {
  it('contributes nothing without visible servers', async () => {
    const ctx = await setup()
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner)
    expect(assembly.tools.map(x => x.name)).not.toContain('discover_mcp_tools')
    expect(renderPrompt(assembly)).not.toContain('MCP')
  })
  it('keeps unselected definitions callable in the registry but absent from requests', async () => {
    const ctx = await setup(); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner)
    expect(ctx.tools.get('mcp__repo__issues', owner)).toBeDefined()
    expect(assembly.tools.map(x => x.name)).toEqual(['discover_mcp_tools'])
    expect(renderPrompt(assembly)).not.toContain('Use issue IDs literally.')
    expect(renderPrompt(assembly)).toContain('mcp__repo__issues')
  })
  it('loads a direct human public name before the first request and keeps plugin text inert', async () => {
    const ctx = await setup(); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    expect((await assemble(ctx, owner, 'Use mcp__repo__issues')).tools.map(x => x.name)).toContain('mcp__repo__issues')
    expect(renderPrompt(await assemble(ctx, owner))).toContain('Use issue IDs literally.')
    expect((await assemble(ctx, agent(ctx, 'b'), 'mcp__repo__issues', 'plugin')).tools.map(x => x.name)).not.toContain('mcp__repo__issues')
    expect((await assemble(ctx, agent(ctx, 'c'), 'mcp__repo__issues_suffix')).tools.map(x => x.name)).not.toContain('mcp__repo__issues')
  })
  it('searches by server and query without loading every tool and preserves pagination', async () => {
    const ctx = await setup({ resultLimit: 1 }); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__pulls', 'Search pull requests'))
    const owner = agent(ctx)
    const page = ctx.mcpDiscovery.search(owner, { server: 'repo' })
    expect(page.items).toHaveLength(1)
    expect(page.nextOffset).toBe(1)
    expect(ctx.mcpDiscovery.search(owner, { server: 'repo', query: 'pull' }).items[0]?.name).toBe('mcp__repo__pulls')
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).toEqual(['discover_mcp_tools'])
  })
  it('rejects cumulative UTF8 instruction overflow atomically and supports explicit release', async () => {
    const ctx = await setup({ instructionBytes: 90 }); server(ctx, 'repo', '中文'.repeat(8)); server(ctx, 'other', '中文'.repeat(8))
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('other', tool('mcp__other__issues'))
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__issues']).ok).toBe(true)
    const refused = ctx.mcpDiscovery.load(owner, ['mcp__other__issues'])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('instructionBytes')
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).toEqual(['discover_mcp_tools', 'mcp__repo__issues'])
    ctx.mcpDiscovery.release(owner, ['mcp__repo__issues'])
    expect(ctx.mcpDiscovery.load(owner, ['mcp__other__issues']).ok).toBe(true)
  })
  it('filters hidden servers and tools and isolates loaded state per Agent', async () => {
    const ctx = await setup(); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx); const other = agent(ctx, 'b')
    other.ctx.get('tools')!.restrict({ allow: [] })
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__issues']).ok).toBe(true)
    expect(ctx.mcpDiscovery.search(other).items).not.toContainEqual(expect.objectContaining({ name: 'mcp__repo__issues' }))
    expect(ctx.mcpDiscovery.load(other, ['mcp__repo__issues']).ok).toBe(false)
    expect((await assemble(ctx, other)).tools.map(x => x.name)).not.toContain('mcp__repo__issues')
  })
  it('activates resource-only instructions for the next request and guards earlier calls', async () => {
    const ctx = await setup(); server(ctx)
    const owner = agent(ctx)
    const execution = { agent: owner } as Parameters<typeof ctx.mcpDiscovery.assertServer>[1]
    expect(() =>{  ctx.mcpDiscovery.assertServer('repo', execution) }).toThrow(/activate/i)
    expect(ctx.mcpDiscovery.load(owner, [], ['repo']).ok).toBe(true)
    expect(() =>{  ctx.mcpDiscovery.assertServer('repo', execution) }).toThrow(/activate/i)
    expect(renderPrompt(await assemble(ctx, owner))).toContain('Use issue IDs literally.')
    bind(ctx, owner)
    expect(() =>{  ctx.mcpDiscovery.assertServer('repo', execution) }).not.toThrow()
  })
  it('binds stale-definition checks to the request rather than the latest loaded selection', async () => {
    const ctx = await setup(); server(ctx)
    const remove = ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    await assemble(ctx, owner); bind(ctx, owner)
    remove(); ctx.mcpDiscovery.registerTool('repo', tool(undefined, 'Updated schema description'))
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const result = await call(ctx, owner)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
    await assemble(ctx, owner); bind(ctx, owner)
    expect(await call(ctx, owner)).toMatchObject({ isError: false, value: 'Updated schema description' })
  })
  it('preserves same-content reconnections but invalidates changed metadata', async () => {
    const ctx = await setup(); const removeServer = server(ctx)
    const remove = ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    remove(); removeServer(); server(ctx); ctx.mcpDiscovery.registerTool('repo', tool())
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).toContain('mcp__repo__issues')
    removeServer()
    const dispose = ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__new'))
    dispose()
    expect(ctx.mcpDiscovery.search(owner).items.map(x => x.name)).not.toContain('mcp__repo__new')
  })
  it('replays only the selection retained at a fork point', async () => {
    const ctx = await setup(); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const seed = owner.session.snapshotEvents()
    ctx.mcpDiscovery.release(owner)
    const restored = agent(ctx, 'restored', seed)
    expect((await assemble(ctx, restored)).tools.map(x => x.name)).toContain('mcp__repo__issues')
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).not.toContain('mcp__repo__issues')
  })
  it('refuses insufficient fixed representations and non-positive configuration', async () => {
    await expect(setup({ catalogBytes: 1 })).rejects.toThrow(/catalogBytes/)
    await expect(setup({ nativeBytes: 1 })).rejects.toThrow(/nativeBytes/)
    await expect(setup({ resultLimit: 0 })).rejects.toThrow(/resultLimit/)
  })
})

class SelectorAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private responses: string[]) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: this.responses.shift() ?? '{}' }
  }
}
const selector = { provider: 'aux', model: 'cheap', inputBytes: 8192, outputBytes: 1024, maxTokens: 256, timeoutMs: 1000 }
const selected = (names: string[]) => JSON.stringify({ status: 'selected', names, servers: [] })
describe('MCP auxiliary selector', () => {
  it('passes current demand, bounded actual recent context, and loaded names without schemas', async () => {
    const adapter = new SelectorAdapter([selected(['mcp__repo__issues'])])
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '处理 GitHub Issue #42' }] }), { surfaceOp: 'append' })
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const assembly = await assemble(ctx, owner, '继续')
    expect(assembly.tools.map(x => x.name)).toContain('mcp__repo__issues')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'aux', model: 'cheap', purpose: 'mcp-selector' })
    const input = adapter.requests[0]!.messages[0]!.content
    expect(JSON.stringify(input)).toContain('继续')
    expect(JSON.stringify(input)).toContain('Issue #42')
    expect(JSON.stringify(input)).toContain('mcp__repo__issues')
    expect(JSON.stringify(input)).not.toContain('parameters')
    await assemble(ctx, owner)
    expect(adapter.requests).toHaveLength(1)
  })
  it.each(['none', 'uncertain', 'failed'])('preserves direct targeting when auxiliary status is %s', async (status) => {
    const adapter = new SelectorAdapter([status === 'failed' ? '{}' : JSON.stringify({ status, names: [], servers: [] })])
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    expect((await assemble(ctx, owner, '使用 mcp__repo__issues')).tools.map(x => x.name)).toContain('mcp__repo__issues')
    const events = owner.session.snapshotEvents().filter(x => x.type === 'mcp/selector-result')
    expect(events.at(-1)?.data).toMatchObject({ status })
  })
  it('replaces prior automatic selection rather than accumulating new-demand tools', async () => {
    const adapter = new SelectorAdapter([selected(['mcp__repo__issues']), selected(['mcp__repo__pulls'])])
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__pulls', 'Read pull requests'))
    const owner = agent(ctx)
    await assemble(ctx, owner, '查 Issue')
    const second = await assemble(ctx, owner, '现在查 Pull request')
    expect(second.tools.map(x => x.name)).toContain('mcp__repo__pulls')
    expect(second.tools.map(x => x.name)).not.toContain('mcp__repo__issues')
  })
  it('keeps exact direct server targets in the main discovery prompt while selector is off', async () => {
    const ctx = await setup(); server(ctx)
    const owner = agent(ctx)
    expect(renderPrompt(await assemble(ctx, owner, '请使用 mcp:repo'))).toContain('Requested MCP servers: repo')
  })
  it('enforces final UTF8 search result limits even when one public name cannot fit', async () => {
    const ctx = await setup({ resultBytes: 150 }); server(ctx, 'x'.repeat(200))
    expect(Buffer.byteLength(JSON.stringify(ctx.mcpDiscovery.search()), 'utf8')).toBeLessThanOrEqual(150)
  })
})

describe('MCP request ownership', () => {
  it('preserves downstream custom providers and snapshots the transformed MCP subset', async () => {
    const ctx = await setup(); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'custom-provider', description: 'Custom contribution', parameters: {} }] }))
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      return { ...result, tools: result.tools.filter(schema => schema.name !== 'mcp__repo__issues') }
    })
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner, 'mcp__repo__issues')
    expect(assembly.tools.map(x => x.name)).toContain('custom-provider')
    expect(assembly.tools.map(x => x.name)).not.toContain('mcp__repo__issues')
    bind(ctx, owner)
    expect(await call(ctx, owner)).toMatchObject({ isError: true })
  })
  it('adds no empty MCP request events to sessions without a catalog', async () => {
    const ctx = await setup(); const owner = agent(ctx)
    await assemble(ctx, owner); bind(ctx, owner)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')).toHaveLength(0)
  })
  it('rejects a single oversized native schema without releasing an admitted selection', async () => {
    const ctx = await setup({ nativeBytes: 2000 }); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('repo', { ...tool('mcp__repo__large'), parameters: { type: 'object', properties: { text: { type: 'string', description: '中文'.repeat(1000) } } } })
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__issues']).ok).toBe(true)
    const refused = ctx.mcpDiscovery.load(owner, ['mcp__repo__large'])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('nativeBytes')
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).toEqual(['discover_mcp_tools', 'mcp__repo__issues'])
  })
  it('keeps disconnected catalogs and reuses selections when the same connection returns', async () => {
    const ctx = await setup(); let connected = true
    ctx.mcpDiscovery.registerServer('repo', { instructions: () => 'Instruction', connected: () => connected })
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues']); await assemble(ctx, owner); bind(ctx, owner)
    connected = false
    expect(ctx.mcpDiscovery.search(owner).items.every(item => !item.connected)).toBe(true)
    expect(await call(ctx, owner)).toMatchObject({ isError: true, error: { info: { code: 'MCP_DISCONNECTED' } } })
    connected = true
    expect(await call(ctx, owner)).toMatchObject({ isError: false })
  })
  it('keeps scope-owned server catalogs and discovery registrations isolated', async () => {
    const ctx = await setup()
    const owner = agent(ctx); const other = agent(ctx, 'b')
    const scoped = owner.ctx.get('mcpDiscovery')!
    scoped.registerServer('private', { instructions: () => 'Private instructions', connected: () => true })
    owner.ctx.get('mcpDiscovery')!.registerTool('private', tool('mcp__private__read'))
    expect(ctx.mcpDiscovery.search(other).items).toEqual([])
    expect((await assemble(ctx, other)).tools.map(x => x.name)).not.toContain('discover_mcp_tools')
    expect(ctx.mcpDiscovery.load(owner, ['mcp__private__read']).ok).toBe(true)
    expect(renderPrompt(await assemble(ctx, owner))).toContain('Private instructions')
    await owner.ctx.fiber.dispose()
    expect(ctx.mcpDiscovery.search(owner).items).toEqual([])
  })
})

class PtcProbe extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'in-process-test'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: '.', timeoutMs: 1000 } }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const fn = spec.bindings[0]!.functions.mcp__repo__issues!
    return { logs: [], value: await fn({}) }
  }
}
class WaitingSelector extends LlmAdapter {
  started: Promise<void>
  private start!: () => void
  constructor() { super(); this.started = new Promise((resolve) => { this.start = resolve }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.start()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () =>{  resolve() }, { once: true })
    })
    yield { type: 'text-delta', index: 0, text: selected(['mcp__repo__issues']) }
  }
}
describe('MCP PTC and cancellation', () => {
  it.each(['ptc', 'both'] as const)('defers complete interfaces and keeps original execution through %s transport', async (mode) => {
    const ctx = await setup({}, undefined, mode); server(ctx)
    ctx.tools.register(tool('first_party'))
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const initial = await assemble(ctx, owner)
    expect(initial.sections.find(section => section.name === 'tools:sdk')?.text).not.toContain('mcp__repo__issues')
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const loaded = await assemble(ctx, owner)
    expect(loaded.sections.find(section => section.name === 'tools:sdk')?.text).toContain('mcp__repo__issues')
    if (mode === 'ptc') expect(loaded.tools.map(x => x.name)).toEqual(['run_code'])
    bind(ctx, owner)
    expect(await ctx.tools.execute({ agent: owner, callId: ToolCallId('ptc-call'), name: 'run_code', arguments: { code: 'call loaded tool', description: 'Read issues' }, signal: new AbortController().signal })).toMatchObject({ isError: false, value: { result: 'Search issues' } })
  })
  it('rejects an SDK budget smaller than the complete discovery transport', async () => {
    const ctx = await setup({ sdkBytes: 1 }, undefined, 'ptc'); server(ctx)
    await expect(assemble(ctx, agent(ctx))).rejects.toThrow(/sdkBytes/)
  })
  it('observes cancellation, waits for the auxiliary adapter, and retains prior state', async () => {
    const adapter = new WaitingSelector()
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const controller = new AbortController()
    const assembly = ctx.systemPrompt.assemble({ agent: owner, scope: owner, signal: controller.signal, stepInput: { turn: 1, step: 1, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Get issues' }] })] } })
    const settled = assembly.then(() => 'resolved', () => 'aborted')
    await adapter.started
    controller.abort(new Error('Cancelled'))
    expect(await settled).toBe('aborted')
    expect((await assemble(ctx, owner)).tools.map(x => x.name)).not.toContain('mcp__repo__issues')
  })
  it('aborts selection on Agent unload without publishing a late selection', async () => {
    const adapter = new WaitingSelector()
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const assembly = assemble(ctx, owner, 'Get issues')
    const settled = assembly.then(() => 'resolved', () => 'aborted')
    await adapter.started
    await owner.ctx.fiber.dispose()
    expect(await settled).toBe('aborted')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selection')).toHaveLength(0)
  })
})

describe('MCP committed system instructions', () => {
  it('denies resource activation and PTC execution when a complete prompt suppresses MCP contributions', async () => {
    const ctx = await setup({}, undefined, 'ptc'); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.systemPrompt.section({ name: 'complete', order: 1, text: 'Only this complete prompt.', complete: true })
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const assembly = await assemble(ctx, owner)
    expect(renderPrompt(assembly)).toBe('Only this complete prompt.')
    bind(ctx, owner)
    expect(() => { ctx.mcpDiscovery.assertServer('repo', { agent: owner } as Parameters<typeof ctx.mcpDiscovery.assertServer>[1]) }).toThrow(/activate/i)
    expect(await ctx.tools.execute({ agent: owner, callId: ToolCallId('complete-ptc-call'), name: 'run_code', arguments: { code: 'call loaded tool', description: 'Read issues' }, signal: new AbortController().signal })).toMatchObject({ isError: true })
  })
})

describe('MCP selector routing and bounds', () => {
  it('fails explicitly for missing selector runtime at load and unknown provider at request', async () => {
    await expect(setup({ selector })).rejects.toThrow(/requires llm/)
    const ctx = await setup({ selector: { ...selector, provider: 'unregistered' } }, new SelectorAdapter([])); server(ctx)
    await expect(assemble(ctx, agent(ctx), 'Get issues')).rejects.toThrow(/provider\/model/)
  })
  it('rejects unknown returned names while retaining a previously loaded tool', async () => {
    const adapter = new SelectorAdapter([selected(['mcp__hidden__secret'])])
    const ctx = await setup({ selector }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    expect((await assemble(ctx, owner, 'continue')).tools.map(x => x.name)).toContain('mcp__repo__issues')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it('retains the prior selection when a valid auxiliary proposal exceeds complete instruction limits', async () => {
    const adapter = new SelectorAdapter([selected(['mcp__other__issues'])])
    const ctx = await setup({ selector, instructionBytes: 90 }, adapter); server(ctx); server(ctx, 'other', '中'.repeat(40))
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('other', tool('mcp__other__issues'))
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    const assembly = await assemble(ctx, owner, 'Find an issue')
    expect(assembly.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools', 'mcp__repo__issues'])
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data.status).toBe('selected')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/diagnostic').at(-1)?.data.reason).toContain('instructionBytes')
    expect(ctx.sessionProjections.stateOf(owner.session, 'mcpDiscovery')?.selection.tools.map(item => item.name)).toEqual(['mcp__repo__issues'])
  })
  it('bounds exact selector text and records deterministic older-record omission', async () => {
    const adapter = new SelectorAdapter([JSON.stringify({ status: 'uncertain', names: [], servers: [] })])
    const ctx = await setup({ selector: { ...selector, inputBytes: 1024 } }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier task '.repeat(300) }] }), { surfaceOp: 'append' })
    await assemble(ctx, owner, '继续')
    const request = adapter.requests[0]!
    const text = request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('')
    expect(Buffer.byteLength((request.system ?? '') + text, 'utf8')).toBeLessThanOrEqual(1024)
    expect(text).toContain('omittedRecentRecords":1')
    expect(text).toContain('继续')
  })
  it('shortlists servers before bounded descriptors for a large directory', async () => {
    const adapter = new SelectorAdapter([JSON.stringify({ status: 'selected', names: [], servers: ['repo'] }), selected(['mcp__repo__issues'])])
    const ctx = await setup({ selector: { ...selector, inputBytes: 1100 } }, adapter); server(ctx); server(ctx, 'other')
    ctx.mcpDiscovery.registerTool('repo', tool())
    for (let index = 0; index < 15; index++) ctx.mcpDiscovery.registerTool('other', tool(`mcp__other__tool_${index}`, 'Other unrelated capability '.repeat(5)))
    const owner = agent(ctx)
    expect((await assemble(ctx, owner, 'Find an issue')).tools.map(x => x.name)).toContain('mcp__repo__issues')
    expect(adapter.requests).toHaveLength(2)
    const phases = owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-request').map(event => event.data.phase)
    expect(phases).toEqual(['servers', 'tools'])
  })
})

function discover(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({ ...owner === undefined ? {} : { agent: owner }, callId: ToolCallId('discovery-call'), name: 'discover_mcp_tools', arguments: args, signal: new AbortController().signal })
}
describe('MCP discovery tool actions', () => {
  it('searches, loads, activates and releases through the ordinary execution pipeline', async () => {
    const ctx = await setup(); server(ctx); server(ctx, 'other')
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('other', tool('mcp__other__issues'))
    const owner = agent(ctx)
    expect(await discover(ctx, owner, { action: 'search', names: ['mcp__repo__issues'] })).toMatchObject({ isError: false, value: { items: [{ name: 'mcp__repo__issues' }] } })
    expect(await discover(ctx, owner, { action: 'load', names: ['mcp__repo__issues', 'mcp__other__issues'] })).toMatchObject({ isError: false, value: { ok: true } })
    expect(await discover(ctx, owner, { action: 'release', server: 'repo' })).toMatchObject({ isError: false, value: { names: ['mcp__other__issues'] } })
    expect(await discover(ctx, owner, { action: 'load', server: 'repo' })).toMatchObject({ isError: false, value: { ok: true, servers: ['other', 'repo'] } })
    expect(await discover(ctx, owner, { action: 'release' })).toMatchObject({ isError: false, value: { names: [], servers: [] } })
  })
  it('requires an Agent for mutation, validates search offsets, and supports programmatic search', async () => {
    const ctx = await setup(); server(ctx)
    expect(await discover(ctx, undefined, { action: 'load', server: 'repo' })).toMatchObject({ isError: true })
    expect(await discover(ctx, undefined, { action: 'search' })).toMatchObject({ isError: false })
    const owner = agent(ctx)
    expect(await discover(ctx, owner, { action: 'search', offset: -1 })).toMatchObject({ isError: true })
    expect(ctx.mcpDiscovery.search(owner, { offset: 99 }).items).toEqual([])
  })
  it('bounds final load results when a large valid selection cannot fit the result page', async () => {
    const ctx = await setup({ resultBytes: 150 }); server(ctx)
    for (let index = 0; index < 12; index++) ctx.mcpDiscovery.registerTool('repo', tool(`mcp__repo__tool_${index}`))
    const owner = agent(ctx)
    const names = Array.from({ length: 12 }, (_, index) => `mcp__repo__tool_${index}`)
    const result = await discover(ctx, owner, { action: 'load', names })
    expect(result).toMatchObject({ isError: false, value: { ok: true, hint: 'Selection recorded; narrow search to inspect names.' } })
    if (!result.isError) expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThanOrEqual(150)
  })
  it('reports explicit invisible markers and budget refusals without pretending an auxiliary call happened', async () => {
    const ctx = await setup({ instructionBytes: 1 }); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner, 'mcp__missing__read mcp:missing mcp__repo__issues')
    expect(renderPrompt(assembly)).toContain('unknown or unavailable')
    expect(owner.session.snapshotEvents().some(event => event.type === 'mcp/diagnostic')).toBe(true)
    expect(owner.session.snapshotEvents().some(event => event.type === 'mcp/selector-result')).toBe(false)
    expect(await discover(ctx, owner, { action: 'load', names: ['mcp__repo__issues'] })).toMatchObject({ isError: false, value: { ok: false } })
  })
})

class ChunkSelector extends LlmAdapter {
  constructor(private chunks: StreamChunk[]) { super() }
  async *stream(): AsyncIterable<StreamChunk> { yield* this.chunks }
}
describe('MCP selector failures', () => {
  it.each(['null', '{', '{"status":"bad","names":[],"servers":[]}', '{"status":"none","names":["mcp__repo__issues"],"servers":[]}'])('records invalid JSON or inconsistent selections as failure: %s', async (output) => {
    const ctx = await setup({ selector }, new SelectorAdapter([output])); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner, 'Get issues')
    expect(assembly.tools.map(x => x.name)).not.toContain('mcp__repo__issues')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it.each(['error', 'aborted'] as const)('records adapter terminal %s as failure', async (kind) => {
    const adapter = new ChunkSelector([{ type: 'finish', reason: { kind, failure: { code: 'REMOTE', message: 'Remote unavailable' } } }])
    const ctx = await setup({ selector }, adapter); server(ctx)
    const owner = agent(ctx)
    await assemble(ctx, owner, 'Get issues')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it('bounds multibyte auxiliary output while retaining a discovery path', async () => {
    const ctx = await setup({ selector: { ...selector, outputBytes: 2 } }, new SelectorAdapter(['中'])); server(ctx)
    const owner = agent(ctx)
    expect((await assemble(ctx, owner, 'Get issues')).tools.map(x => x.name)).toContain('discover_mcp_tools')
    const outcome = owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data
    expect(outcome?.status).toBe('failed')
    expect(outcome?.detail).toContain('outputBytes')
  })
  it('records auxiliary timeout as failure and waits for the cooperative adapter', async () => {
    const ctx = await setup({ selector: { ...selector, timeoutMs: 1 } }, new WaitingSelector()); server(ctx)
    const owner = agent(ctx)
    await assemble(ctx, owner, 'Get issues')
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it('keeps excessive current demand as a failed selection without making a paid call', async () => {
    const adapter = new SelectorAdapter([])
    const ctx = await setup({ selector: { ...selector, inputBytes: 500 } }, adapter); server(ctx)
    const owner = agent(ctx)
    await assemble(ctx, owner, '当前需求'.repeat(1000))
    expect(adapter.requests).toHaveLength(0)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it('retains current context for each bounded phase and diagnoses oversized shortlisted tools', async () => {
    const adapter = new SelectorAdapter([JSON.stringify({ status: 'selected', names: [], servers: ['repo'] })])
    const ctx = await setup({ selector: { ...selector, inputBytes: 900 } }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool(undefined, 'Large descriptor '.repeat(100)))
    const owner = agent(ctx)
    await assemble(ctx, owner, 'Get issues')
    expect(adapter.requests).toHaveLength(1)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status: 'failed' })
  })
  it.each(['none', 'uncertain'] as const)('keeps %s server-shortlist outcomes distinct without a tool phase', async (status) => {
    const adapter = new SelectorAdapter([JSON.stringify({ status, names: [], servers: [] })])
    const ctx = await setup({ selector: { ...selector, inputBytes: 900 } }, adapter); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool(undefined, 'Large descriptor '.repeat(100)))
    const owner = agent(ctx)
    await assemble(ctx, owner, 'Get issues')
    expect(adapter.requests).toHaveLength(1)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selector-result').at(-1)?.data).toMatchObject({ status })
  })
  it('constrains auxiliary candidates to direct server markers', async () => {
    const adapter = new SelectorAdapter([selected(['mcp__repo__issues'])])
    const ctx = await setup({ selector }, adapter); server(ctx); server(ctx, 'other')
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.mcpDiscovery.registerTool('other', tool('mcp__other__issues'))
    const owner = agent(ctx)
    await assemble(ctx, owner, 'Get issues using mcp:repo')
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).not.toContain('mcp__other__issues')
    expect(request).toContain('mcp__repo__issues')
  })
})

describe('MCP request series', () => {
  it('starts a new series when a previously bound PTC selection is released', async () => {
    const ctx = await setup({}, undefined, 'ptc'); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    await assemble(ctx, owner); bind(ctx, owner)
    ctx.mcpDiscovery.release(owner)
    await assemble(ctx, owner)
    const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue without MCP' }] })]
    const decision = await ctx.waterfall(scopeTarget(owner, owner), 'agent/pre-step', { agent: owner, messages, turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages }))
    expect(decision).toEqual({ kind: 'enter', messages, startsRequestSeries: true })
  })
  it('records one clearing snapshot after the last server unloads and none on fresh empty scopes', async () => {
    const ctx = await setup({}, undefined, 'ptc'); const remove = server(ctx)
    const owner = agent(ctx)
    await assemble(ctx, owner); bind(ctx, owner)
    remove()
    await assemble(ctx, owner); bind(ctx, owner)
    const snapshots = owner.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.data).toMatchObject({ tools: [], servers: [], schemas: [], sdk: '', instructions: '' })
    await assemble(ctx, owner); bind(ctx, owner)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')).toHaveLength(2)
  })
})

it('fails loudly for an invalid auxiliary provider/model pairing when the adapter resolves it', async () => {
  const adapter = new ChunkSelector([{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN_MODEL', message: 'Model is not configured for this provider' } } }])
  const ctx = await setup({ selector }, adapter); server(ctx)
  await expect(assemble(ctx, agent(ctx), 'Get issues')).rejects.toThrow(/provider\/model/)
})

it('describes capabilities of opaque server names in the bounded server-shortlist request', async () => {
  const adapter = new SelectorAdapter([JSON.stringify({ status: 'selected', names: [], servers: ['z9'] }), selected(['mcp__z9__calendar'])])
  const ctx = await setup({ selector: { ...selector, inputBytes: 1300 } }, adapter); server(ctx, 'z9'); server(ctx, 'q7')
  ctx.mcpDiscovery.registerTool('z9', tool('mcp__z9__calendar', 'Read calendar appointments'))
  for (let index = 0; index < 15; index++) ctx.mcpDiscovery.registerTool('q7', tool(`mcp__q7__file_${index}`, 'Read filesystem folders and documents'))
  const owner = agent(ctx)
  owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing task: meeting tomorrow.' }] }), { surfaceOp: 'append' })
  await assemble(ctx, owner, 'Find tomorrow meeting')
  expect(adapter.requests).toHaveLength(2)
  const request = adapter.requests[0]!
  const text = request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('')
  expect(text).toContain('calendar appointments')
  expect(text).toContain('filesystem folders')
  expect(text).toContain('Existing task: meeting tomorrow.')
  expect(text).not.toContain('mcp__q7__file_')
  expect(Buffer.byteLength((request.system ?? '') + text, 'utf8')).toBeLessThanOrEqual(1300)
})

describe('MCP selection checkpoint and result limits', () => {
  it.each(['nativeBytes', 'sdkBytes', 'instructionBytes'] as const)('rechecks restored selections under a lower %s budget', async (field) => {
    const mode = field === 'sdkBytes' ? 'ptc' : 'native'
    const original = await setup({}, undefined, mode); server(original)
    const definition = tool(undefined, 'Complete tool documentation '.repeat(200))
    original.mcpDiscovery.registerTool('repo', definition)
    const owner = agent(original)
    expect(original.mcpDiscovery.load(owner, [definition.name]).ok).toBe(true)
    await assemble(original, owner); bind(original, owner)
    const historical = original.sessionProjections.stateOf(owner.session, 'mcpDiscovery')?.request
    const minimum = field === 'sdkBytes'
      ? Buffer.byteLength(original.tools.renderSdk(['discover_mcp_tools'], owner), 'utf8')
      : field === 'nativeBytes'
        ? Buffer.byteLength(JSON.stringify(original.tools.schemas(owner).filter(schema => schema.name === 'discover_mcp_tools')), 'utf8')
        : 0
    const restored = await setup({ [field]: minimum + 1 }, undefined, mode); server(restored)
    restored.mcpDiscovery.registerTool('repo', definition)
    const resumed = agent(restored, 'resumed', owner.session.snapshotEvents())
    const assembly = await assemble(restored, resumed)
    expect(assembly.tools.map(schema => schema.name)).not.toContain(definition.name)
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? '').not.toContain(definition.name)
    expect(restored.sessionProjections.stateOf(resumed.session, 'mcpDiscovery')?.selection).toEqual({ tools: [], servers: [] })
    expect(restored.sessionProjections.stateOf(resumed.session, 'mcpDiscovery')?.request).toEqual(historical)
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'mcp/diagnostic').at(-1)?.data.reason).toContain(field)
    bind(restored, resumed)
    expect(restored.sessionProjections.stateOf(resumed.session, 'mcpDiscovery')?.request?.tools).toEqual([])
  })
  it('restores validated projection checkpoints containing exact request definitions', async () => {
    const ctx = await setup(); server(ctx); ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    await assemble(ctx, owner); bind(ctx, owner)
    const rows = ctx.sessionProjections.checkpoint(owner.session)
    const restored = ctx.sessionProjections.restore(
      rows, owner.session.snapshotEvents(), SessionLogOffset(0), owner.session.header, owner.session.inheritedEventCount,
    )
    expect(restored).toBeDefined()
  })
  it('returns bounded refusal diagnostics instead of reporting a refused selection as recorded', async () => {
    const ctx = await setup({ resultBytes: 150, nativeBytes: 2000 }); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', { ...tool('mcp__repo__large'), parameters: { type: 'object', properties: { query: { type: 'string', description: '中'.repeat(1000) } } } })
    const owner = agent(ctx)
    const refusal = await discover(ctx, owner, { action: 'load', names: ['mcp__repo__large'] })
    expect(refusal).toMatchObject({ isError: false, value: { ok: false } })
    if (!refusal.isError) {
      expect(JSON.stringify(refusal.value)).toContain('nativeBytes')
      expect(JSON.stringify(refusal.value)).not.toContain('Selection recorded')
      expect(Buffer.byteLength(JSON.stringify(refusal.value), 'utf8')).toBeLessThanOrEqual(150)
    }
    const unknown = await discover(ctx, owner, { action: 'load', names: [`mcp__missing__${'name'.repeat(100)}`] })
    expect(unknown).toMatchObject({ isError: false, value: { ok: false } })
    if (!unknown.isError) expect(JSON.stringify(unknown.value)).toContain('unavailable')
  })
  it('keeps partial request SDK rewrites inactive and retains literal resource instructions independently', async () => {
    const ctx = await setup({}, undefined, 'ptc'); server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, sections: assembly.sections.map(section => section.name === 'tools:sdk' ? { ...section, text: 'Custom SDK without MCP declarations.' } : section) }
    })
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    await assemble(ctx, owner); bind(ctx, owner)
    const request = ctx.sessionProjections.stateOf(owner.session, 'mcpDiscovery')?.request
    expect(request?.sdk).toBe('')
    expect(request?.tools).toEqual([])
    expect(() => { ctx.mcpDiscovery.assertServer('repo', { agent: owner } as Parameters<typeof ctx.mcpDiscovery.assertServer>[1]) }).not.toThrow()
  })
})

describe('MCP standalone selector and delayed tool dispatch', () => {
  it('requires its explicit optional LLM service and can run without a caller signal', async () => {
    const absent = await setup()
    await expect(selectTools(absent, selector, agent(absent), 'Task', [], [], [])).rejects.toThrow(/requires llm/)
    const ctx = await setup({}, new SelectorAdapter([JSON.stringify({ status: 'none', names: [], servers: [] })]))
    expect(await selectTools(ctx, selector, agent(ctx), 'Task', [], [], [])).toMatchObject({ status: 'none' })
  })
  it('records an unexpected non-Error middleware rejection as an auxiliary failure', async () => {
    const ctx = await setup({}, new SelectorAdapter([]))
    ctx.on('llm/stream', () => { throw 'middleware failed' })
    const result = await selectTools(ctx, selector, agent(ctx), 'Task', [], [], [])
    expect(result).toMatchObject({ status: 'failed', detail: 'middleware failed' })
  })
  it('rejects a same-name schema change while pre-execution waits without running either body', async () => {
    const ctx = await setup(); server(ctx)
    const executions: string[] = []
    const remove = ctx.mcpDiscovery.registerTool('repo', { ...tool(), async execute() { executions.push('old'); return 'old' } })
    const owner = agent(ctx); ctx.mcpDiscovery.load(owner, ['mcp__repo__issues'])
    await assemble(ctx, owner); bind(ctx, owner)
    let entered!: () => void; let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'mcp__repo__issues') { entered(); await barrier }
      return next()
    })
    const pending = call(ctx, owner)
    try {
      await started
      remove()
      ctx.mcpDiscovery.registerTool('repo', { ...tool(undefined, 'Changed declaration'), async execute() { executions.push('new'); return 'new' } })
      release()
      expect(await pending).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
      expect(executions).toEqual([])
    } finally { release() }
  })
  it('rolls back tool registration if its caller unloads in the registry change callback', async () => {
    const ctx = await setup(); const owner = agent(ctx)
    const scoped = owner.ctx.get('mcpDiscovery')!
    scoped.registerServer('repo', { instructions: () => '', connected: () => true })
    const stop = ctx.on('tools/change', () => { void owner.ctx.fiber.dispose() })
    expect(() => scoped.registerTool('repo', tool())).toThrow()
    stop()
    await owner.ctx.fiber.dispose()
    while (owner.ctx.fiber.inertia !== undefined) await owner.ctx.fiber.inertia
    expect(ctx.tools.get('mcp__repo__issues', owner)).toBeUndefined()
    expect(ctx.mcpDiscovery.search(owner).items).toEqual([])
  })
})
