import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { LlmAttemptId, ToolCallId, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import Discovery, { Config } from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

class SdkRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'in-process-test'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: '.', timeoutMs: 1000 } }
  async run(): Promise<PtcRunResult> { return { logs: [], value: null } }
}
async function setup(overrides: Partial<Config> = {}, mode: 'native' | 'ptc' = 'native') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode })
  if (mode === 'ptc') await ctx.plugin(SdkRuntime)
  await ctx.plugin(Projections)
  await ctx.plugin(Discovery, Config(overrides))
  return ctx
}
function agent(ctx: Context): Agent {
  const session = Session.create(SessionId('prompt-owner'))
  const owner = { id: session.id, session } as Agent
  Object.assign(owner, { ctx: createScope(ctx, owner).ctx })
  return owner
}
function tool(description = 'Read a record'): ToolDefinition {
  return {
    name: 'mcp__repo__read', description, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute() { return 'Record' },
  }
}
function server(ctx: Context, instructions = 'Complete repo instructions.') {
  ctx.mcpDiscovery.registerServer('repo', { connected: () => true, instructions: () => instructions })
}
async function assemble(ctx: Context, owner: Agent, turn = 1, step = 1, text?: string) {
  return ctx.systemPrompt.assemble({ scope: owner, agent: owner, stepInput: { turn, step,
    messages: text === undefined ? [] : [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })],
  } })
}
function commit(ctx: Context, owner: Agent, assembly: PromptAssembly, turn = 1, step = 1) {
  owner.session.append('system/message', { turn, step, message: createSystemMessage(renderPrompt(assembly), 'prompt-fixture') }, { surfaceOp: 'append' })
  owner.session.append('request/header', {
    header: { config: { provider: 'fixture', model: 'fixture' }, ...assembly.tools.length ? { tools: assembly.tools } : {} },
    reason: owner.session.requestHeader() === undefined ? 'initial' : 'change',
  })
  ctx.emit(scopeTarget(owner, owner), 'agent/assistant-stream', { agent: owner, frame: {
    type: 'start', attemptId: LlmAttemptId(`attempt-${turn}-${step}`), revision: 1, turn, step,
  } })
}
function preStep(ctx: Context, owner: Agent, decision: PreStepDecision, turn = 1, step = 1) {
  return ctx.waterfall(scopeTarget(owner, owner), 'agent/pre-step', {
    agent: owner, turn, step, messages: [], signal: new AbortController().signal,
  }, () => Promise.resolve(decision))
}
function snapshots(owner: Agent) {
  return owner.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')
}
function discoveryText(assembly: PromptAssembly) {
  return assembly.sections.find(section => section.name === 'mcp-discovery')?.text ?? ''
}

async function minimumCatalogBytes() {
  const ctx = await setup()
  server(ctx)
  ctx.mcpDiscovery.registerTool('repo', tool('Large descriptor '.repeat(1000)))
  const text = discoveryText(await ctx.systemPrompt.assemble())
  const wrappers = text.replace(/(```jsonl\n)[\s\S]*?(?=```)/, '$1')
  return Buffer.byteLength(wrappers, 'utf8')
}

describe('MCP request-series admission', () => {
  it('preserves a rejected pre-step after changed instructions were staged', async () => {
    const ctx = await setup()
    server(ctx)
    const owner = agent(ctx)
    commit(ctx, owner, await assemble(ctx, owner))
    ctx.mcpDiscovery.load(owner, [], ['repo'])
    await assemble(ctx, owner, 1, 2)
    const rejected: PreStepDecision = { kind: 'reject' }
    expect(await preStep(ctx, owner, rejected, 1, 2)).toEqual(rejected)
    expect(snapshots(owner)).toHaveLength(1)
    expect(snapshots(owner)[0]?.data.instructions).toBe('')
  })

  it.each([{ turn: 2, step: 1 }, { turn: 1, step: 2 }])('leaves mismatched request coordinates $turn/$step unchanged', async ({ turn, step }) => {
    const ctx = await setup()
    server(ctx)
    const owner = agent(ctx)
    owner.session.append('request/header', { header: { config: { provider: 'fixture', model: 'conversation' } }, reason: 'initial' })
    ctx.mcpDiscovery.load(owner, [], ['repo'])
    const assembly = await assemble(ctx, owner, 1, 1)
    const accepted: PreStepDecision = { kind: 'enter', messages: [] }
    expect(await preStep(ctx, owner, accepted, turn, step)).toEqual(accepted)
    commit(ctx, owner, assembly, turn, step)
    expect(snapshots(owner)).toEqual([])
    expect(await preStep(ctx, owner, accepted, 1, 1)).toEqual({ ...accepted, startsRequestSeries: true })
    commit(ctx, owner, assembly)
    expect(snapshots(owner)).toHaveLength(1)
  })

  it.each(['native', 'ptc'] as const)('starts a new series for first MCP prompt activation over existing %s history', async (mode) => {
    const ctx = await setup({}, mode)
    server(ctx, mode === 'ptc' ? '' : 'Complete repo instructions.')
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    owner.session.append('request/header', { header: { config: { provider: 'fixture', model: 'conversation' } }, reason: 'initial' })
    owner.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier task' }] }), { surfaceOp: 'append' })
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    const assembly = await assemble(ctx, owner)
    expect(await preStep(ctx, owner, { kind: 'enter', messages: [] })).toEqual({ kind: 'enter', messages: [], startsRequestSeries: true })
    expect(snapshots(owner)).toEqual([])
    commit(ctx, owner, assembly)
    expect(snapshots(owner)[0]?.data.tools.map(item => item.name)).toEqual(['mcp__repo__read'])
  })

  it('keeps existing native history in the same series when activation adds no instruction text', async () => {
    const ctx = await setup()
    server(ctx, '')
    const owner = agent(ctx)
    owner.session.append('request/header', { header: { config: { provider: 'fixture', model: 'conversation' } }, reason: 'initial' })
    ctx.mcpDiscovery.load(owner, [], ['repo'])
    const assembly = await assemble(ctx, owner)
    expect(await preStep(ctx, owner, { kind: 'enter', messages: [] })).toEqual({ kind: 'enter', messages: [] })
    commit(ctx, owner, assembly)
    expect(snapshots(owner)[0]?.data).toMatchObject({ instructions: '', sdk: '', servers: [{ server: 'repo' }] })
  })
})

describe('MCP diagnostic assembly and literal instruction admission', () => {
  it('does not stage a model request from Agent assembly without claimed step input', async () => {
    const ctx = await setup()
    server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    const diagnostic = await ctx.systemPrompt.assemble({ scope: owner, agent: owner })
    expect(diagnostic.tools.map(schema => schema.name)).toContain('mcp__repo__read')
    expect(await preStep(ctx, owner, { kind: 'enter', messages: [] })).toEqual({ kind: 'enter', messages: [] })
    commit(ctx, owner, diagnostic)
    expect(snapshots(owner)).toEqual([])
  })

  it('keeps per-Agent loaded definitions and instructions out of global assembly', async () => {
    const ctx = await setup()
    server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool())
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    const global = await ctx.systemPrompt.assemble()
    expect(global.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools'])
    expect(renderPrompt(global)).not.toContain('Complete repo instructions.')
    expect(snapshots(owner)).toEqual([])
    const scoped = await assemble(ctx, owner)
    expect(scoped.tools.map(schema => schema.name)).toContain('mcp__repo__read')
    expect(renderPrompt(scoped)).toContain('Complete repo instructions.')
  })

  it('activates whitespace-only server instructions without adding instruction bytes', async () => {
    const ctx = await setup({ instructionBytes: 1 })
    server(ctx, ' \t\n ')
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, [], ['repo']).ok).toBe(true)
    const assembly = await assemble(ctx, owner)
    commit(ctx, owner, assembly)
    expect(snapshots(owner)[0]?.data).toMatchObject({ instructions: '', servers: [{ server: 'repo' }] })
    ctx.tools.register({ ...tool(), name: 'resource_activation_probe', async execute(_args, exec) {
      ctx.mcpDiscovery.assertServer('repo', exec)
      return 'Resource activated'
    } })
    expect(await ctx.tools.execute({ name: 'resource_activation_probe', agent: owner,
      callId: ToolCallId('resource-probe'), arguments: {}, signal: new AbortController().signal,
    })).toMatchObject({ isError: false, value: 'Resource activated' })
  })
})

describe('MCP mandatory discovery text under tight budgets', () => {
  it('retains usable discovery when the catalog budget fits only its complete wrappers', async () => {
    const limit = await minimumCatalogBytes()
    const ctx = await setup({ catalogBytes: limit })
    server(ctx)
    ctx.mcpDiscovery.registerTool('repo', tool('Large descriptor '.repeat(1000)))
    const owner = agent(ctx)
    const assembly = await assemble(ctx, owner)
    const catalog = discoveryText(assembly)
    expect(Buffer.byteLength(catalog, 'utf8')).toBe(limit)
    expect(catalog).toContain('discover_mcp_tools')
    expect(catalog).toContain('nextOffset')
    expect(catalog).not.toContain('mcp__repo__read')
    expect(assembly.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools'])
    commit(ctx, owner, assembly)
    const searched = await ctx.tools.execute({ name: 'discover_mcp_tools', agent: owner, callId: ToolCallId('catalog-search'),
      arguments: { action: 'search', names: ['mcp__repo__read'] }, signal: new AbortController().signal,
    })
    expect(searched).toMatchObject({ isError: false, value: { items: [{ name: 'mcp__repo__read', server: 'repo' }] } })
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(true)
    expect((await assemble(ctx, owner, 1, 2)).tools.map(schema => schema.name)).toContain('mcp__repo__read')
  })

  it('records an overlong direct-target diagnostic without overflowing the discovery prompt', async () => {
    const limit = await minimumCatalogBytes()
    const ctx = await setup({ catalogBytes: limit })
    server(ctx)
    const owner = agent(ctx)
    const target = `mcp__missing__${'unknown'.repeat(500)}`
    const assembly = await assemble(ctx, owner, 1, 1, `Use ${target}`)
    const catalog = discoveryText(assembly)
    expect(Buffer.byteLength(catalog, 'utf8')).toBeLessThanOrEqual(limit)
    expect(catalog).toContain('discover_mcp_tools')
    expect(catalog).not.toContain(target)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/diagnostic').at(-1)?.data.reason).toContain(target)
    expect(owner.session.snapshotEvents().filter(event => event.type === 'mcp/selection')).toEqual([])
    expect(assembly.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools'])
  })
})
