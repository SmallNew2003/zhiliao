/** Production preparation, step admission, and executor entry paths for MCP tests. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { DiscoveryState } from '../src/types.ts'
import type { ResolvedToolSet, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'

const admissions = new WeakMap<Agent, ResolvedToolSet>()

export async function mountExecutor(ctx: Context, mode: 'native' | 'ptc'): Promise<void> {
  await ctx.plugin(mode === 'native' ? NativeExecutor : PtcExecutor)
}

export async function assemblePrompt(ctx: Context, context: AssembleContext = {}) {
  const agent = context.agent
  if (agent === undefined) return ctx.systemPrompt.assemble(context)
  const modelSelection = context.modelSelection ?? { provider: 'fixture', model: 'fixture' }
  const signal = context.signal ?? new AbortController().signal
  if (context.stepInput !== undefined) {
    await agentEvents(ctx, agent).serial('agent/prepare-step', { ...context.stepInput, signal, modelSelection })
  }
  const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
  admissions.get(agent)?.dispose()
  admissions.set(agent, toolSet)
  return ctx.systemPrompt.assemble({ ...context, toolSet })
}

export function callTool(ctx: Context, input: ToolExecutionInput) {
  const toolSet = input.agent === undefined || input.name.endsWith('_probe') ? undefined : admissions.get(input.agent)
  const execute = input.name === 'run_code' ? executeModelToolFixture : executeToolFixture
  return execute(ctx, { ...input, ...toolSet === undefined ? {} : { toolSet } })
}

/** Read the private ready handle without adding a test-only production method. */
export function discoveryState(ctx: Context, owner: Agent): DiscoveryState {
  const service = ctx.mcpDiscovery as never as { projection: ProjectionHandle<DiscoveryState> }
  return service.projection.stateOf(owner.session)
}
