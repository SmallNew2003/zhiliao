import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type Config as ToolConfig } from '@deepseek-ai/dsh-tools'
import { ToolCallId, LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import McpDiscovery from '@deepseek-ai/dsh-mcp-discovery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import McpResources, { type McpResourceProvider } from '../src/index.ts'

const resourceToolNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

class BindingProbe extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'in-process-test'
  behavior: (spec: PtcRunSpec) => Promise<PtcRunResult> = async spec => ({
    logs: [], value: Object.keys(spec.bindings[0]!.functions).sort(),
  })

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 60_000 }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> {
    return this.behavior(spec)
  }
}

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(mode: ToolConfig['mode'] = 'native') {
  const ctx = new Context()
  roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode } })
  if (mode !== 'native') await ctx.plugin(BindingProbe)
  await ctx.plugin(McpDiscovery)
  await ctx.plugin(McpResources)
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['resource-fixture'], new ResourceAdapter())
  return ctx
}

class ResourceAdapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let agentSeq = 0
async function mintAgent(ctx: Context, parentAgent?: Agent): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(`resource-agent-${++agentSeq}`),
    agentOptions: { provider: 'resource-fixture', model: 'fixture' },
    ...parentAgent === undefined ? {} : { parentAgent },
  })
  return handle.agent
}

/** Match standalone provider ownership to the connection-owned discovery registration. */
function registerProvider(ctx: Context, server: string, provider: McpResourceProvider): () => void {
  const removeResource = ctx.mcpResources.register(server, provider)
  let removeServer: () => void
  try {
    removeServer = ctx.mcpDiscovery.registerServer(server, { connected: () => true, instructions: () => '' })
  } catch (error) {
    removeResource()
    throw error
  }
  return () => { removeServer(); removeResource() }
}

async function activate(ctx: Context, agent: Agent, server: string): Promise<void> {
  const loaded = ctx.mcpDiscovery.load(agent, [], [server])
  if (!loaded.ok) throw new Error(loaded.reason)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect resource availability.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function resourceScope(ctx: Context, owner: Agent): Promise<Scope> {
  let scoped!: Scope
  await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery', 'tools'], apply(inner: Context) {
    scoped = createScope(inner, owner)
  } })
  return scoped
}

function visibleResourceTools(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(tool => tool.name).filter(name => resourceToolNames.includes(name)).sort()
}

function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    name, arguments: args, callId: ToolCallId('resource-test'),
    signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

describe('MCP resource tools', () => {
  it.each(['native', 'ptc', 'both'] as const)('omits every MCP contribution with no servers in %s mode', async (mode) => {
    const ctx = await setup(mode)
    expect(visibleResourceTools(ctx)).toEqual([])
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).not.toContain('mcp')
    expect(assembly.tools.map(tool => tool.name).filter(name => resourceToolNames.includes(name))).toEqual([])
    for (const name of resourceToolNames) {
      expect(ctx.tools.get(name)).toBeUndefined()
      expect(await call(ctx, name, { server: 'missing', uri: 'docs://text' }))
        .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    }
    if (mode !== 'native') {
      expect(await call(ctx, 'run_code', { code: 'inspect bindings', description: 'Inspect bindings' }))
        .toMatchObject({ isError: false, value: { result: [] } })
    }
  })

  it('keeps shared tools until the last provider unloads and accepts a replacement', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const first = await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery'], apply(inner: Context) {
      registerProvider(inner, 'first', { request })
    } })
    const second = await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery'], apply(inner: Context) {
      registerProvider(inner, 'second', { request })
    } })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    await first.dispose()
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect((await call(ctx, 'list_mcp_resources', { server: 'second' })).isError).toBe(false)
    await second.dispose()
    expect(visibleResourceTools(ctx)).toEqual([])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP capabilities')

    const remove = registerProvider(ctx, 'second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    const replace = registerProvider(ctx, 'second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    replace()
    expect(visibleResourceTools(ctx)).toEqual([])
  })

  it.each([false, true])('shares scoped tools across independent provider owners (reverse disposal: %s)', async (reverse) => {
    const ctx = await setup()
    const owner = await mintAgent(ctx)
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const providers = await Promise.all(['first', 'second'].map(async server => ({
      server,
      fiber: await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery'], apply(inner: Context) {
        registerProvider(createScope(inner, owner).ctx, server, { request })
      } }),
    })))
    if (reverse) providers.reverse()
    await providers[0]!.fiber.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
    await activate(ctx, owner, providers[1]!.server)
    expect((await call(ctx, 'list_mcp_resources', { server: providers[1]!.server }, owner)).isError).toBe(false)
    await providers[1]!.fiber.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
  })

  it('awaits scoped tool teardown before its provider owner finishes unloading', async () => {
    const ctx = await setup()
    const owner = await mintAgent(ctx)
    const scoped = await resourceScope(ctx, owner)
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const disposalOrder: string[] = []
    const stopObserving = ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'scope') return
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve(undefined)
        await cleanupGate.promise
        disposalOrder.push('tools disposed')
      }, 'resource-scope-cleanup')
    })
    scoped.ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) })
    stopObserving()
    try {
      const disposed = scoped.dispose().then(() => { disposalOrder.push('provider disposed') })
      await cleanupStarted.promise
      expect(visibleResourceTools(ctx, owner)).toEqual([])
      // Drain unblocked teardown promise chains before releasing the only asynchronous cleanup.
      await nextEventLoopTurn()
      expect(disposalOrder).toEqual([])
      cleanupGate.resolve(undefined)
      await disposed
      expect(disposalOrder).toEqual(['tools disposed', 'provider disposed'])
    } finally {
      cleanupGate.resolve(undefined)
    }
  })

  it('exposes a scoped server only to its owner and descendants and falls back to inherited providers', async () => {
    const ctx = await setup()
    const owner = await mintAgent(ctx)
    const child = await mintAgent(ctx, owner)
    bindScopeParent(child, owner)
    const sibling = await mintAgent(ctx)
    const scoped = await resourceScope(ctx, owner)
    const localRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const globalRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const removeLocal = registerProvider(scoped.ctx, 'docs', { request: localRequest })
    for (const agent of [owner, child]) {
      await activate(ctx, agent, 'docs')
      expect(visibleResourceTools(ctx, agent)).toEqual([...resourceToolNames].sort())
      expect((await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent)).isError).toBe(false)
    }
    for (const agent of [undefined, sibling]) {
      expect(visibleResourceTools(ctx, agent)).toEqual([])
      expect(renderPrompt(await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })))
        .not.toContain('MCP capabilities')
      expect(await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent))
        .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    }
    const removeGlobal = registerProvider(ctx, 'docs', { request: globalRequest })
    removeLocal()
    expect(visibleResourceTools(ctx, child)).toEqual([...resourceToolNames].sort())
    await activate(ctx, child, 'docs')
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, child)
    expect(localRequest).toHaveBeenCalledTimes(2)
    expect(globalRequest).toHaveBeenCalledOnce()
    removeGlobal()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
    expect(visibleResourceTools(ctx, child)).toEqual([])
    registerProvider(scoped.ctx, 'docs', { request: localRequest })
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
    await scoped.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
  })

  it('removes PTC declarations and bindings and rejects a previously materialized call after disposal', async () => {
    const ctx = await setup('ptc')
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const remove = registerProvider(ctx, 'docs', { request })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('list_mcp_resources:')
    const runtime = ctx.ptcRuntime as BindingProbe
    runtime.behavior = async (spec) => {
      const binding = spec.bindings[0]!.functions['list_mcp_resources']!
      expect(await binding({ server: 'docs' })).toEqual({ resources: [] })
      remove()
      await expect(binding({ server: 'docs' })).rejects.toThrow('unknown tool')
      return { logs: [] }
    }
    const result = await call(ctx, 'run_code', { code: 'invoke and remove provider', description: 'Use resource binding' })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledOnce()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('mcp')
    runtime.behavior = async spec => ({ logs: [], value: Object.keys(spec.bindings[0]!.functions) })
    expect(await call(ctx, 'run_code', { code: 'inspect bindings', description: 'Inspect bindings' }))
      .toMatchObject({ isError: false, value: { result: [] } })
  })

  it('retains tools for a configured provider while its requests fail', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockRejectedValue(new Error('MCP server disconnected'))
    registerProvider(ctx, 'docs', { request })
    expect((await call(ctx, 'list_mcp_resources', { server: 'docs' })).isError).toBe(true)
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('"server":"docs"')
  })

  it.each([false, true])('rolls back a partial shared-tool registration (scoped: %s)', async (scoped) => {
    const ctx = await setup()
    const owner = await mintAgent(ctx)
    const registrationCtx = scoped ? (await resourceScope(ctx, owner)).ctx : ctx
    const removeConflict = registrationCtx.tools.register(defineTool({
      name: 'list_mcp_resource_templates', description: 'Conflicting tool.', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    }))
    expect(() => registerProvider(registrationCtx, 'docs', { request: async () => ({ resources: [] }) }))
      .toThrow('already registered')
    expect(ctx.tools.get('list_mcp_resources', scoped ? owner : undefined)).toBeUndefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble(scoped ? { scope: owner } : {})))
      .not.toContain('MCP capabilities')
    removeConflict()
    registerProvider(registrationCtx, 'docs', { request: async () => ({ resources: [] }) })
    expect(visibleResourceTools(ctx, scoped ? owner : undefined)).toEqual([...resourceToolNames].sort())
  })

  it('publishes explicit server names without requiring server tools or instructions', async () => {
    const ctx = await setup()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP capabilities')
    registerProvider(ctx, 'docs{{literal}}', { request: async () => ({ resources: [] }) })

    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('MCP capabilities')
    expect(prompt).toContain('"server":"docs{{literal}}"')
  })

  it('lists only caller-visible names and withdraws disposed providers from the prompt', async () => {
    const ctx = await setup()
    const owner = await mintAgent(ctx)
    const other = await mintAgent(ctx)
    const provider = { request: async () => ({ resources: [] }) }
    const disposeGlobal = registerProvider(ctx, 'docs', provider)
    const fiber = await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery'], apply(inner: Context) {
      const scope = createScope(inner, owner)
      registerProvider(scope.ctx, 'docs', provider)
      registerProvider(scope.ctx, 'private', provider)
    } })

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: owner })))
      .toContain('"server":"private"')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: other })))
      .toContain('"server":"docs"')
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: owner })))
      .toContain('"server":"docs"')
    disposeGlobal()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP capabilities')
  })

  it('withdraws all shared tools while standalone discovery ownership remains when its plugin unloads', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(McpDiscovery)
    const fiber = await ctx.plugin(McpResources)
    registerProvider(ctx, 'docs', { request: async () => ({ resources: [] }) })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('MCP capabilities')

    await fiber.dispose()
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(ctx.tools.get(name)).toBeUndefined()
    }
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('MCP capabilities')
  })

  it('routes all three operations with the explicit server and opaque parameters', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [], nextCursor: 'next-page' })
    registerProvider(ctx, 'docs', { request })

    expect((await call(ctx, 'list_mcp_resources', { server: 'docs', cursor: 'page-2' })).isError).toBe(false)
    expect(request.mock.calls[0]?.[0]).toEqual({ method: 'resources/list', cursor: 'page-2' })
    expect((await call(ctx, 'list_mcp_resource_templates', { server: 'docs' })).isError).toBe(false)
    expect(request.mock.calls[1]?.[0]).toEqual({ method: 'resources/templates/list' })
    expect((await call(ctx, 'read_mcp_resource', { server: 'docs', uri: 'docs://guide' })).isError).toBe(false)
    expect(request.mock.calls[2]?.[0]).toEqual({ method: 'resources/read', uri: 'docs://guide' })
    expect(request.mock.calls[2]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect((await call(ctx, 'list_mcp_resource_templates', { server: 'docs', cursor: 'template-page' })).isError)
      .toBe(false)
    expect(request.mock.calls[3]?.[0]).toEqual({ method: 'resources/templates/list', cursor: 'template-page' })
  })

  it('keeps binary bytes programmatic while projecting text, URI and server attribution', async () => {
    const ctx = await setup()
    const value = { contents: [
      { uri: 'docs://text', mimeType: 'text/plain', text: 'Read this guide.' },
      { uri: 'docs://binary', mimeType: 'application/octet-stream', blob: 'AQIDBA==' },
    ] }
    registerProvider(ctx, 'docs', { request: async () => value })
    const result = await call(ctx, 'read_mcp_resource', { server: 'docs', uri: 'docs://text' })
    expect(result.isError).toBe(false)
    expect('value' in result && result.value).toEqual(value)
    expect(result.content).toEqual([{ type: 'text', text: 'MCP server: docs\n'
      + '{"contents":[{"uri":"docs://text","mimeType":"text/plain","text":"Read this guide."},'
      + '{"uri":"docs://binary","mimeType":"application/octet-stream","blob":'
      + '"[binary resource: 8 base64 characters; available to programmatic callers]"}]}' }])
    expect(JSON.stringify(result.content)).not.toContain('AQIDBA==')
  })

  it('rejects missing parameters and unavailable servers before dispatch', async () => {
    const ctx = await setup()
    registerProvider(ctx, 'docs', { request: async () => ({ resources: [] }) })
    expect((await call(ctx, 'read_mcp_resource', { uri: 'docs://text' })).isError).toBe(true)
    const result = await call(ctx, 'read_mcp_resource', { server: 'missing', uri: 'docs://text' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('unavailable in this agent')
  })

  it('resolves scoped providers and removes only the disposed registration', async () => {
    const ctx = await setup()
    const globalRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ contents: [] })
    const localRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ contents: [] })
    const other = await mintAgent(ctx)
    const owner = await mintAgent(ctx)
    registerProvider(ctx, 'docs', { request: globalRequest })
    let dispose = () => {}
    await ctx.plugin({ inject: ['mcpResources', 'mcpDiscovery'], apply(inner: Context) {
      const scope = createScope(inner, owner)
      dispose = registerProvider(scope.ctx, 'docs', { request: localRequest })
      expect(() => registerProvider(scope.ctx, 'docs', { request: localRequest })).toThrow('already registered')
    } })
    await activate(ctx, owner, 'docs')
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, owner)
    expect(localRequest).toHaveBeenCalledOnce()
    await activate(ctx, other, 'docs')
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, other)
    expect(globalRequest).toHaveBeenCalledOnce()
    dispose()
    await activate(ctx, owner, 'docs')
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, owner)
    expect(globalRequest).toHaveBeenCalledTimes(2)
  })
})
