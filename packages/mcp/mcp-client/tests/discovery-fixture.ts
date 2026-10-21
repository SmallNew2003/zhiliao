/** MCP unit compositions and durable request-snapshot owners. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import McpDiscovery from '@deepseek-ai/dsh-mcp-discovery'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { LlmAttemptId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { startConnection } from '../src/connection.ts'

export async function mountDiscovery(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(McpDiscovery)
}

let nextOwner = 0

/** Real Session owner for bridge unit tests that deliberately omit model services. */
export async function boundAgent(ctx: Context, options: AgentOptions & { provider: string; model: string } = { provider: 'visual', model: 'vision' }): Promise<Agent> {
  const session = Session.create(SessionId(`mcp-unit-${++nextOwner}`))
  const agent = { id: session.id, session, options } as Agent
  const scoped = createScope(ctx, agent)
  Object.assign(agent, { ctx: scoped.ctx })
  const names = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('mcp__'))
  const servers = [...new Set(names.map(name => name.split('__')[1]!))]
  const catalog = ctx.mcpDiscovery.search(agent)
  for (const server of servers) {
    if (!catalog.items.some(item => item.server === server)) {
      ctx.mcpDiscovery.registerServer(server, { connected: () => true, instructions: () => '' })
    }
  }
  const loaded = ctx.mcpDiscovery.load(agent, names, servers)
  if (!loaded.ok) throw new Error(loaded.reason)
  const assembled = await ctx.systemPrompt.assemble({ scope: agent, agent, stepInput: { turn: 1, step: 1, messages: [] } })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(renderPrompt(assembled), 'fixture') }, { surfaceOp: 'append' })
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: options.provider, model: options.model }, tools: assembled.tools }),
    reason: 'initial',
  })
  ctx.emit(scopeTarget(agent, agent), 'agent/assistant-stream', { agent, frame: {
    type: 'start', attemptId: LlmAttemptId(`mcp-unit-attempt-${nextOwner}`), revision: 1, turn: 1, step: 1,
  } })
  return agent
}

/** Match a supervisor-only fixture to the connection-owned discovery source. */
export function startCatalogConnection(...args: Parameters<typeof startConnection>): ReturnType<typeof startConnection> {
  const [ctx, config] = args
  const handle = startConnection(...args)
  const remove = ctx.mcpDiscovery.registerServer(config.serverName, {
    connected: () => handle.connected(),
    instructions: () => handle.instructions(),
  })
  return { ...handle, async dispose() { await handle.dispose(); remove() } }
}
