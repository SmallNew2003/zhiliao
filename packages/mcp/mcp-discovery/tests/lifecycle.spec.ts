import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { LlmAttemptId, ToolCallId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import Discovery, { Config, type ServerSource } from '../src/index.ts'

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
function agent(ctx: Context, id = 'owner'): Agent {
  const session = Session.create(SessionId(id))
  const owner = { id: session.id, session } as Agent
  Object.assign(owner, { ctx: createScope(ctx, owner).ctx })
  return owner
}
function tool(name: string, description = '读取记录'): ToolDefinition {
  return {
    name, description, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute() { return description },
  }
}
function server(ctx: Context, name: string, instructions = '') {
  return ctx.get('mcpDiscovery')!.registerServer(name, { connected: () => true, instructions: () => instructions })
}
async function request(ctx: Context, owner: Agent, step = 1) {
  const assembly = await ctx.systemPrompt.assemble({ scope: owner, agent: owner, stepInput: { turn: 1, step, messages: [] } })
  owner.session.append('system/message', {
    turn: 1, step, message: createSystemMessage(renderPrompt(assembly), 'lifecycle-fixture'),
  }, { surfaceOp: 'append' })
  owner.session.append('request/header', {
    header: { config: { provider: 'fixture', model: 'fixture' }, ...assembly.tools.length ? { tools: assembly.tools } : {} },
    reason: owner.session.requestHeader() === undefined ? 'initial' : 'change',
  })
  ctx.emit(scopeTarget(owner, owner), 'agent/assistant-stream', { agent: owner, frame: {
    type: 'start', attemptId: LlmAttemptId(`attempt-${step}`), revision: 1, turn: 1, step,
  } })
  return assembly
}
function call(ctx: Context, owner: Agent, name: string) {
  return ctx.tools.execute({ agent: owner, callId: ToolCallId('lifecycle-call'), name,
    arguments: {}, signal: new AbortController().signal })
}
function selectionEvents(owner: Agent) {
  return owner.session.snapshotEvents().filter(event => event.type === 'mcp/selection')
}
async function checkResources(ctx: Context, owner?: Agent) {
  const remove = ctx.tools.register({ ...tool('resource_guard_probe'), async execute(_args, exec) {
    ctx.mcpDiscovery.assertServer('repo', exec)
    return 'Resource activation accepted'
  } })
  try {
    return await ctx.tools.execute({ ...(owner ? { agent: owner } : {}), name: 'resource_guard_probe',
      callId: ToolCallId('resource-call'), arguments: {}, signal: new AbortController().signal })
  } finally { remove() }
}

describe('MCP registration lifetime', () => {
  it('rejects a tool whose server has not registered', async () => {
    const ctx = await setup()
    expect(() => ctx.mcpDiscovery.registerTool('missing', tool('mcp__missing__read'))).toThrow(/registered before its tools/)
    expect(ctx.tools.get('mcp__missing__read')).toBeUndefined()
    expect(ctx.mcpDiscovery.search().items).toEqual([])
  })

  it('keeps a server named discovery separate from the capability catalog', async () => {
    const ctx = await setup()
    server(ctx, 'discovery', 'Literal {{server}} instructions.')
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, [], ['discovery']).ok).toBe(true)
    const assembly = await request(ctx, owner)
    const names = assembly.sections.map(section => section.name)
    expect(new Set(names).size).toBe(names.length)
    expect(assembly.sections.find(section => section.name === 'mcp:discovery')?.text).toBe('Literal {{server}} instructions.')
    expect(renderPrompt(assembly)).toContain('Literal {{server}} instructions.')
  })
  it('withdraws only the disposed server and removes discovery when the last owner unloads', async () => {
    const ctx = await setup()
    const first = await ctx.plugin({ inject: ['mcpDiscovery'], apply(inner: Context) {
      server(inner, 'first', 'First instructions')
      inner.mcpDiscovery.registerTool('first', tool('mcp__first__read', 'First record'))
    } })
    const second = await ctx.plugin({ inject: ['mcpDiscovery'], apply(inner: Context) {
      server(inner, 'second', 'Second instructions')
      inner.mcpDiscovery.registerTool('second', tool('mcp__second__read', 'Second record'))
    } })
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, ['mcp__first__read', 'mcp__second__read']).ok).toBe(true)
    await request(ctx, owner)
    await first.dispose()
    expect(ctx.mcpDiscovery.search(owner).items.map(item => item.server)).toEqual(['second', 'second'])
    expect(await call(ctx, owner, 'mcp__first__read')).toMatchObject({ isError: true })
    expect(await call(ctx, owner, 'mcp__second__read')).toMatchObject({ isError: false, value: 'Second record' })
    const remaining = await request(ctx, owner, 2)
    expect(remaining.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools', 'mcp__second__read'])
    expect(renderPrompt(remaining)).not.toContain('First instructions')
    await second.dispose()
    expect(ctx.tools.get('discover_mcp_tools', owner)).toBeUndefined()
    expect(renderPrompt(await request(ctx, owner, 3))).not.toContain('MCP capabilities')
    expect(selectionEvents(owner).at(-1)?.data).toMatchObject({ reason: 'invalidate', tools: [], servers: [] })
  })

  it('rejects a still-registered tool from a removed server before executing its old request', async () => {
    const ctx = await setup()
    const removeServer = server(ctx, 'repo', 'Repo instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    await request(ctx, owner)
    removeServer()
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
    expect(await checkResources(ctx, owner)).toMatchObject({ isError: true, error: { info: { code: 'MCP_SERVER_INACTIVE' } } })
    expect((await request(ctx, owner, 2)).tools).toEqual([])
    expect(selectionEvents(owner).at(-1)?.data).toMatchObject({ reason: 'invalidate', tools: [], servers: [] })
  })

  it('rolls back a first server when the discovery transport name conflicts', async () => {
    const ctx = await setup()
    const removeConflict = ctx.tools.register(tool('discover_mcp_tools', 'Ordinary conflict'))
    expect(() => server(ctx, 'repo')).toThrow(/already registered/)
    expect(ctx.mcpDiscovery.search().items).toEqual([])
    removeConflict()
    const removeServer = server(ctx, 'repo')
    expect(ctx.mcpDiscovery.search().items).toEqual([{ server: 'repo', description: 'MCP server; activate for resource access.', connected: true }])
    removeServer()
    expect(ctx.tools.get('discover_mcp_tools')).toBeUndefined()
  })

  it('keeps the original server and tool after duplicate registration fails', async () => {
    const ctx = await setup()
    server(ctx, 'repo', 'Original instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read', 'Original record'))
    expect(() => server(ctx, 'repo', 'Rejected instructions')).toThrow(/already registered/)
    expect(() => ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read', 'Rejected record'))).toThrow(/already registered/)
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.search(owner, { names: ['mcp__repo__read'] }).items).toEqual([
      { server: 'repo', name: 'mcp__repo__read', description: 'Original record', connected: true },
    ])
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(true)
    const assembly = await request(ctx, owner)
    expect(renderPrompt(assembly)).toContain('Original instructions')
    expect(renderPrompt(assembly)).not.toContain('Rejected instructions')
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: false, value: 'Original record' })
  })

  it('refuses new selections after service disposal without appending a selection', async () => {
    const ctx = await setup()
    server(ctx, 'repo')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    const discovery = ctx.mcpDiscovery
    await ctx.fiber.dispose()
    expect(discovery.load(owner, ['mcp__repo__read'])).toMatchObject({ ok: false, reason: 'MCP discovery is disposed.' })
    expect(selectionEvents(owner)).toEqual([])
  })
})

describe('MCP request identities and scopes', () => {
  it.each(['parameters', 'instructions'] as const)('retains identical reconnects but invalidates changed %s', async (changed) => {
    const ctx = await setup()
    let removeServer = server(ctx, 'repo', 'Stable instructions')
    let removeTool = ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    await request(ctx, owner)
    removeTool(); removeServer()
    removeServer = server(ctx, 'repo', 'Stable instructions')
    removeTool = ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: false, value: '读取记录' })
    expect((await request(ctx, owner, 2)).tools.map(schema => schema.name)).toContain('mcp__repo__read')
    expect(selectionEvents(owner)).toHaveLength(1)
    removeTool(); removeServer()
    server(ctx, 'repo', changed === 'instructions' ? 'Changed instructions' : 'Stable instructions')
    ctx.mcpDiscovery.registerTool('repo', { ...tool('mcp__repo__read'),
      parameters: changed === 'parameters' ? { type: 'object', properties: { id: { type: 'string' } } } : { type: 'object', properties: {} },
    })
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
    expect((await request(ctx, owner, 3)).tools.map(schema => schema.name)).not.toContain('mcp__repo__read')
    expect(selectionEvents(owner).at(-1)?.data).toMatchObject({ reason: 'invalidate', tools: [] })
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(true)
    await request(ctx, owner, 4)
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: false, value: '读取记录' })
  })

  it('keeps a loaded request through temporary disconnection without accepting new loads', async () => {
    const ctx = await setup()
    let connected = true
    const source: ServerSource = { connected: () => connected, instructions: () => 'Stable instructions' }
    ctx.mcpDiscovery.registerServer('repo', source)
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    await request(ctx, owner)
    connected = false
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])).toMatchObject({ ok: false })
    expect(ctx.mcpDiscovery.load(owner, [], ['repo'])).toMatchObject({ ok: false })
    expect(selectionEvents(owner)).toHaveLength(1)
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: true, error: { info: { code: 'MCP_DISCONNECTED' } } })
    expect(await checkResources(ctx)).toMatchObject({ isError: false, value: 'Resource activation accepted' })
    connected = true
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: false, value: '读取记录' })
    expect(selectionEvents(owner)).toHaveLength(1)
  })

  it('requires a new started request after resource-only instructions change', async () => {
    const ctx = await setup()
    let instructions = ''
    ctx.mcpDiscovery.registerServer('repo', { connected: () => true, instructions: () => instructions })
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, [], ['repo']).ok).toBe(true)
    await request(ctx, owner)
    expect(await checkResources(ctx, owner)).toMatchObject({ isError: false })
    instructions = 'Use the current resource revision.'
    expect(await checkResources(ctx, owner)).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
    expect(ctx.mcpDiscovery.load(owner, [], ['repo']).ok).toBe(true)
    expect(await checkResources(ctx, owner)).toMatchObject({ isError: true, error: { info: { code: 'MCP_STALE_DEFINITION' } } })
    const assembly = await request(ctx, owner, 2)
    expect(renderPrompt(assembly)).toContain('Use the current resource revision.')
    expect(await checkResources(ctx, owner)).toMatchObject({ isError: false })
  })

  it('hides inherited tools when a scope shadows their server source', async () => {
    const ctx = await setup()
    server(ctx, 'repo', 'Parent instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read', 'Parent record'))
    const parent = agent(ctx, 'parent')
    const child = agent(ctx, 'child')
    server(child.ctx, 'repo', 'Child instructions')
    expect(ctx.mcpDiscovery.search(child, { names: ['mcp__repo__read'] }).items).toEqual([])
    expect(ctx.mcpDiscovery.load(child, ['mcp__repo__read']).ok).toBe(false)
    child.ctx.get('mcpDiscovery')!.registerTool('repo', tool('mcp__repo__read', 'Child record'))
    expect(ctx.mcpDiscovery.load(child, ['mcp__repo__read']).ok).toBe(true)
    expect(ctx.mcpDiscovery.load(parent, ['mcp__repo__read']).ok).toBe(true)
    expect(renderPrompt(await request(ctx, child))).not.toContain('Parent instructions')
    await request(ctx, parent)
    expect(await call(ctx, child, 'mcp__repo__read')).toMatchObject({ isError: false, value: 'Child record' })
    expect(await call(ctx, parent, 'mcp__repo__read')).toMatchObject({ isError: false, value: 'Parent record' })
  })

  it('invalidates a selected inherited tool when the caller denies it', async () => {
    const ctx = await setup()
    server(ctx, 'repo')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    await request(ctx, owner)
    owner.ctx.get('tools')!.restrict({ deny: ['mcp__repo__read'] })
    expect(ctx.mcpDiscovery.search(owner, { names: ['mcp__repo__read'] }).items).toEqual([])
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(false)
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: true })
    expect((await request(ctx, owner, 2)).tools.map(schema => schema.name)).not.toContain('mcp__repo__read')
    expect(selectionEvents(owner).at(-1)?.data).toMatchObject({ reason: 'invalidate', tools: [] })
  })

  it.each(['native', 'ptc'] as const)('continues %s assembly after all global tools are denied', async (mode) => {
    const ctx = await setup({}, mode)
    server(ctx, 'repo', 'Repo instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(true)
    await request(ctx, owner)
    owner.ctx.get('tools')!.restrict({ allow: [] })
    const assembly = await request(ctx, owner, 2)
    expect(assembly.tools.map(schema => schema.name)).toEqual(mode === 'ptc' ? ['run_code'] : [])
    expect(selectionEvents(owner).at(-1)?.data.tools).toEqual([])
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: true })
  })

  it('keeps an explicitly allowed MCP tool usable when discovery is denied', async () => {
    const ctx = await setup()
    server(ctx, 'repo', 'Repo instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    owner.ctx.get('tools')!.restrict({ allow: ['mcp__repo__read'] })
    expect(ctx.mcpDiscovery.load(owner, ['mcp__repo__read']).ok).toBe(true)
    const assembly = await request(ctx, owner)
    expect(assembly.tools.map(schema => schema.name)).toEqual(['mcp__repo__read'])
    expect(await call(ctx, owner, 'mcp__repo__read')).toMatchObject({ isError: false })
  })

  it('keeps selected definitions out of diagnostic scopes without an Agent', async () => {
    const ctx = await setup()
    server(ctx, 'repo', 'Repo instructions')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    const assembly = await ctx.systemPrompt.assemble({ scope: { name: 'diagnostic' } })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['discover_mcp_tools'])
    expect(renderPrompt(assembly)).not.toContain('Repo instructions')
  })

  it('retains a valid selection when a resource activation names an unknown server', async () => {
    const ctx = await setup()
    server(ctx, 'repo')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__read'])
    const retained = ctx.sessionProjections.stateOf(owner.session, 'mcpDiscovery')?.selection
    const refusal = ctx.mcpDiscovery.load(owner, [], ['missing'])
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.reason).toContain('missing')
    expect(ctx.sessionProjections.stateOf(owner.session, 'mcpDiscovery')?.selection).toEqual(retained)
  })

  it('allows programmatic execution without a model request owner', async () => {
    const ctx = await setup()
    server(ctx, 'repo')
    ctx.mcpDiscovery.registerTool('repo', tool('mcp__repo__read', 'Programmatic record'))
    expect(await ctx.tools.execute({ name: 'mcp__repo__read', arguments: {},
      callId: ToolCallId('programmatic'), signal: new AbortController().signal,
    })).toMatchObject({ isError: false, value: 'Programmatic record' })
  })

  it('applies subset and server release only to subsequent requests', async () => {
    const ctx = await setup()
    server(ctx, 'repo', 'Repo instructions'); server(ctx, 'other', 'Other instructions')
    for (const name of ['mcp__repo__first', 'mcp__repo__second']) ctx.mcpDiscovery.registerTool('repo', tool(name))
    ctx.mcpDiscovery.registerTool('other', tool('mcp__other__read'))
    const owner = agent(ctx)
    ctx.mcpDiscovery.load(owner, ['mcp__repo__first', 'mcp__repo__second', 'mcp__other__read'])
    await request(ctx, owner)
    expect(ctx.mcpDiscovery.release(owner, ['mcp__repo__first'])).toEqual({
      ok: true, names: ['mcp__other__read', 'mcp__repo__second'], servers: ['other', 'repo'],
    })
    expect(await call(ctx, owner, 'mcp__repo__first')).toMatchObject({ isError: false })
    const subset = await request(ctx, owner, 2)
    expect(subset.tools.map(schema => schema.name).sort()).toEqual(['discover_mcp_tools', 'mcp__other__read', 'mcp__repo__second'])
    expect(renderPrompt(subset)).toContain('Repo instructions')
    expect(await call(ctx, owner, 'mcp__repo__first')).toMatchObject({ isError: true })
    expect(ctx.mcpDiscovery.release(owner, undefined, ['repo'])).toEqual({ ok: true, names: ['mcp__other__read'], servers: ['other'] })
    const released = await request(ctx, owner, 3)
    expect(renderPrompt(released)).not.toContain('Repo instructions')
    expect(renderPrompt(released)).toContain('Other instructions')
    expect(selectionEvents(owner).at(-1)?.data).toMatchObject({ reason: 'release', tools: [{ name: 'mcp__other__read' }], servers: [{ server: 'other' }] })
    expect(ctx.mcpDiscovery.release(owner)).toEqual({ ok: true, names: [], servers: [] })
    expect((await request(ctx, owner, 4)).tools.map(schema => schema.name)).toEqual(['discover_mcp_tools'])
  })
})

describe('MCP complete UTF-8 admission', () => {
  it('admits exact instruction bytes and preserves the first activation on cumulative overflow', async () => {
    const ctx = await setup({ instructionBytes: 6 })
    server(ctx, 'first', '中文'); server(ctx, 'second', '语句')
    const owner = agent(ctx)
    expect(ctx.mcpDiscovery.load(owner, [], ['first'])).toEqual({ ok: true, names: [], servers: ['first'] })
    const before = selectionEvents(owner)
    const refused = ctx.mcpDiscovery.load(owner, [], ['second'])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('instructionBytes')
    expect(selectionEvents(owner)).toEqual(before)
    const accepted = await request(ctx, owner)
    expect(renderPrompt(accepted)).toContain('中文')
    expect(renderPrompt(accepted)).not.toContain('语句')
    expect(ctx.mcpDiscovery.release(owner, undefined, ['first']).ok).toBe(true)
    expect(ctx.mcpDiscovery.load(owner, [], ['second']).ok).toBe(true)
    expect(renderPrompt(await request(ctx, owner, 2))).toContain('语句')
  })

  it.each(['nativeBytes', 'sdkBytes'] as const)('refuses one byte below a complete two-tool %s representation', async (budget) => {
    const mode = budget === 'sdkBytes' ? 'ptc' : 'native'
    const names = ['mcp__repo__first', 'mcp__repo__second']
    const reference = await setup({}, mode)
    server(reference, 'repo')
    for (const name of names) reference.mcpDiscovery.registerTool('repo', tool(name, '读取中文记录'))
    const referenceOwner = agent(reference)
    reference.mcpDiscovery.load(referenceOwner, names)
    const assembly = await request(reference, referenceOwner)
    const contribution = budget === 'sdkBytes'
      ? assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      : JSON.stringify(assembly.tools)
    const completeBytes = Buffer.byteLength(contribution, 'utf8')
    expect(completeBytes).toBeGreaterThan(contribution.length)
    for (const difference of [0, 1]) {
      const ctx = await setup({ [budget]: completeBytes - difference }, mode)
      server(ctx, 'repo')
      for (const name of names) ctx.mcpDiscovery.registerTool('repo', tool(name, '读取中文记录'))
      const owner = agent(ctx)
      expect(ctx.mcpDiscovery.load(owner, [names[0]!]).ok).toBe(true)
      const before = selectionEvents(owner)
      const proposal = ctx.mcpDiscovery.load(owner, [names[1]!])
      expect(proposal.ok).toBe(difference === 0)
      const next = await request(ctx, owner)
      const rendered = budget === 'sdkBytes' ? next.sections.find(section => section.name === 'tools:sdk')?.text ?? '' : JSON.stringify(next.tools)
      expect(rendered).toContain(names[0])
      if (difference === 0) expect(rendered).toContain(names[1])
      else {
        expect(rendered).not.toContain(names[1])
        expect(selectionEvents(owner)).toEqual(before)
        if (!proposal.ok) expect(proposal.reason).toContain(budget)
      }
    }
  })

  it('returns complete bounded pages for multibyte descriptors without skipping the next item', async () => {
    const ctx = await setup({ resultBytes: 260, resultLimit: 20 })
    server(ctx, 'repo')
    const names = ['mcp__repo__a中文', 'mcp__repo__b中文', 'mcp__repo__c中文']
    for (const name of names) ctx.mcpDiscovery.registerTool('repo', tool(name, '中文描述'.repeat(15)))
    const owner = agent(ctx)
    const seen: string[] = []
    let offset = 0
    while (seen.length < names.length) {
      const page = ctx.mcpDiscovery.search(owner, { names, offset })
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(260)
      expect(page.items).toHaveLength(1)
      const item = page.items[0]!
      expect(item.description).toBe('')
      seen.push(item.name!)
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBe(offset + 1)
      offset = page.nextOffset
    }
    expect(seen).toEqual(names)
    expect(ctx.mcpDiscovery.search(owner, { names, offset }).nextOffset).toBeNull()
  })
})
