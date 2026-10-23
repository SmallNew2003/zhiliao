import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import McpDiscovery from '@deepseek-ai/dsh-mcp-discovery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import { registerServerContext } from '../src/server-context.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(McpDiscovery)
  await ctx.plugin(McpResources)
  await mountAgentLoopTestHarness(ctx)
  return ctx
}

describe('MCP server context', () => {
  it('keeps connected server instructions out of the initial model prompt', async () => {
    const ctx = await setup()
    await ctx.plugin({ inject: ['mcpDiscovery', 'mcpResources'], apply(inner: Context) {
      registerServerContext(inner, 'unused', {
        connected: () => true,
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'Instructions from an unused server.',
      })
    } })
    const agent = await ctx.agentLoop.create(SessionId('unused-server-agent'), {})
    expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)))).not.toContain('Instructions from an unused server.')
  })

  it('loads literal instructions explicitly and withdraws stale instructions and disposed resources', async () => {
    const ctx = await setup()
    let instructions = 'MCP server: docs\nKeep {{server.template}} literal.'
    const fiber = await ctx.plugin({ inject: ['mcpDiscovery', 'mcpResources'], apply(inner: Context) {
      registerServerContext(inner, 'docs', {
        connected: () => true,
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => instructions,
      })
    } })
    const agent = await ctx.agentLoop.create(SessionId('docs-agent'), {})
    const assemble = () => ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(renderPrompt(await assemble())).not.toContain(instructions)
    expect(ctx.mcpDiscovery.load(agent, [], ['docs']).ok).toBe(true)
    expect(renderPrompt(await assemble())).toContain(instructions)
    instructions = 'MCP server: docs\nUpdated instructions.'
    expect(renderPrompt(await assemble())).not.toContain(instructions)
    expect(ctx.mcpDiscovery.load(agent, [], ['docs']).ok).toBe(true)
    expect(renderPrompt(await assemble())).toContain(instructions)
    await fiber.dispose()
    expect(renderPrompt(await assemble())).not.toContain('MCP server: docs')
    const result = await ctx.tools.execute({
      name: 'list_mcp_resources', arguments: { server: 'docs' },
      callId: ToolCallId('disposed-resource'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
  })

  it('shows scoped server instructions only to the owning scope', async () => {
    const ctx = await setup()
    const owner = await ctx.agentLoop.create(SessionId('private-owner'), {})
    const other = await ctx.agentLoop.create(SessionId('private-other'), {})
    await ctx.plugin({ inject: ['mcpDiscovery', 'mcpResources'], apply(inner: Context) {
      const scoped = createScope(inner, owner)
      registerServerContext(scoped.ctx, 'private', {
        connected: () => true,
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'Private server instructions.',
      })
    } })
    expect(ctx.mcpDiscovery.load(owner, [], ['private']).ok).toBe(true)
    expect(ctx.mcpDiscovery.load(other, [], ['private']).ok).toBe(false)
    expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(owner)))).toContain('Private server instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(other)))).not.toContain('Private server instructions.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Private server instructions.')
  })
})
