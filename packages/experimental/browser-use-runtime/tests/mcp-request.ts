/** Request admission for direct MCP calls in browser consumer fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const steps = new WeakMap<Agent, number>()

/**
 * Load selected definitions and commit the prompt and request header before direct execution.
 * @param ctx - composition with discovery and prompt services.
 * @param agent - durable request owner.
 * @param names - exact MCP definitions to load.
 * @param servers - resource-only activation targets.
 * @param signal - request cancellation.
 * @returns assembled model presentation.
 */
export async function bindMcpRequest(
  ctx: Context, agent: Agent, names: readonly string[], servers: readonly string[] = [],
  signal = new AbortController().signal,
) {
  await agent.whenIdle()
  if (names.length || servers.length) {
    const loaded = ctx.mcpDiscovery.load(agent, names, servers, signal)
    if (!loaded.ok) throw new Error(loaded.reason)
  }
  const step = (steps.get(agent) ?? 0) + 1
  steps.set(agent, step)
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal, stepInput: { turn: 1, step, messages: [] } })
  agent.session.append('system/message', {
    turn: 1, step, message: createSystemMessage(renderPrompt(assembly), 'fixture'),
  }, { surfaceOp: 'append' })
  agent.session.append('request/header', {
    header: canonicalHeader({ config: { provider: 'fixture', model: 'fixture' }, tools: assembly.tools }),
    reason: agent.session.requestHeader() === undefined ? 'initial' : 'change',
  })
  ctx.emit(scopeTarget(agent, agent), 'agent/assistant-stream', { agent, frame: {
    type: 'start', attemptId: LlmAttemptId(`browser-fixture-${step}`), revision: 1, turn: 1, step,
  } })
  return assembly
}
