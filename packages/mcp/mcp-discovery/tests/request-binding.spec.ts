import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import Discovery, { Config } from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

const TOOL_NAME = 'mcp__repo__read'
type Action = { name: string; arguments: object }

class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly actions: (Action | string)[]) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const action = this.actions.shift()
    if (action === undefined) throw new Error('Request binding fixture exhausted')
    if (typeof action === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: action }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: action } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId(`binding-${this.requests.length}`)
    const args = JSON.stringify(action.arguments)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test-binding-dispatch'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: '.', timeoutMs: 1000 } }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const action = JSON.parse(spec.program) as Action
    const fn = spec.bindings[0]!.functions[action.name]!
    return { logs: [], value: await fn(action.arguments) }
  }
}

function definition(name: string, executions: string[]): ToolDefinition {
  return {
    name, description: 'Read a record', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'Record' }] },
    async execute() { executions.push(name); return 'Record' },
  }
}

async function setup(options: {
  mode?: 'native' | 'ptc' | 'both'
  toolOrder?: string[]
  selector?: boolean
} = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const mode = options.mode ?? 'native'
  await mountAgentLoopTestDependencies(ctx, {
    tools: { mode }, systemPrompt: options.toolOrder === undefined ? {} : { toolOrder: options.toolOrder },
  })
  if (mode !== 'native') await ctx.plugin(BindingRuntime)
  if (options.selector) ctx.llm.registerAdapter(['selector'], new ScriptedModel([
    JSON.stringify({ status: 'selected', names: [TOOL_NAME], servers: [] }),
  ]))
  await ctx.plugin(Discovery, Config(options.selector ? {
    selector: { provider: 'selector', model: 'fixture', inputBytes: 8192, outputBytes: 1024, maxTokens: 256, timeoutMs: 1000 },
  } : {}))
  ctx.mcpDiscovery.registerServer('repo', { connected: () => true, instructions: () => 'Read only the requested record.' })
  const executions: string[] = []
  ctx.mcpDiscovery.registerTool('repo', definition(TOOL_NAME, executions))
  return { ctx, executions }
}

async function run(ctx: Context, actions: (Action | string)[], text = `Use ${TOOL_NAME}`) {
  const model = new ScriptedModel([...actions])
  ctx.llm.registerAdapter(['main'], model)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('request-binding'), { provider: 'main', model: 'fixture' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  expect(model.requests).toHaveLength(actions.length)
  return { agent, requests: model.requests }
}

function mcpSchemas(schemas: readonly ToolSchema[] | undefined) {
  return schemas?.filter(schema => schema.name === 'discover_mcp_tools' || schema.name.startsWith('mcp__')) ?? []
}

function expectRecordedRequests(agent: Agent, requests: GenerateOptions[]) {
  const snapshots = agent.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')
  expect(snapshots).toHaveLength(requests.length)
  for (const [index, snapshot] of snapshots.entries()) {
    expect(snapshot.data.schemas).toEqual(mcpSchemas(requests[index]!.tools))
  }
  expect(agent.session.requestHeader()?.tools).toEqual(requests.at(-1)!.tools)
  return snapshots
}

describe('MCP final request admission', () => {
  it.each([
    { change: 'removed', prepend: true },
    { change: 'rewritten', prepend: true },
    { change: 'rewritten', prepend: false },
  ] as const)('keeps a native tool $change by an assembly listener inactive (prepend: $prepend)', async ({ change, prepend }) => {
    const { ctx, executions } = await setup()
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      return { ...result, tools: change === 'removed'
        ? result.tools.filter(schema => schema.name !== TOOL_NAME)
        : result.tools.map(schema => schema.name === TOOL_NAME ? {
          ...schema, parameters: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'] },
        } : schema) }
    }, { prepend })
    const { agent, requests } = await run(ctx, [{ name: TOOL_NAME, arguments: {} }, 'Finished'])
    const visible = requests[0]!.tools?.find(schema => schema.name === TOOL_NAME)
    if (change === 'removed') expect(visible).toBeUndefined()
    else expect(visible?.parameters).toEqual({
      type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'],
    })
    const snapshots = expectRecordedRequests(agent, requests)
    expect(snapshots.every(event => event.data.tools.length === 0)).toBe(true)
    expect(executions).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toMatchObject([
      { data: { message: { content: [{ type: 'tool-result', isError: true }] } } },
    ])
  })

  it.each(['native', 'ptc', 'both'] as const)('retains admitted execution through the %s presentation', async (mode) => {
    const { ctx, executions } = await setup({ mode })
    const action = { name: TOOL_NAME, arguments: {} }
    const requested = mode === 'native' ? action : {
      name: 'run_code', arguments: { code: JSON.stringify(action), description: 'Read the selected record' },
    }
    const { agent, requests } = await run(ctx, [requested, 'Finished'])
    const snapshots = expectRecordedRequests(agent, requests)
    expect(executions).toEqual([TOOL_NAME])
    expect(snapshots.every(event => event.data.tools.some(tool => tool.name === TOOL_NAME))).toBe(true)
    if (mode === 'ptc') expect(requests[0]!.tools?.map(schema => schema.name)).toEqual(['run_code'])
    else expect(requests[0]!.tools?.map(schema => schema.name)).toContain(TOOL_NAME)
    if (mode !== 'native') expect(snapshots[0]!.data.sdk).toContain(TOOL_NAME)
  })
})

describe('MCP tool ordering after admission', () => {
  it('keeps newly loaded MCP definitions in canonical order among ordinary tools', async () => {
    const { ctx, executions } = await setup()
    ctx.tools.register(definition('zulu', executions))
    const { agent, requests } = await run(ctx, ['Finished'])
    expect(requests[0]!.tools?.map(schema => schema.name)).toEqual(['discover_mcp_tools', TOOL_NAME, 'zulu'])
    expectRecordedRequests(agent, requests)
  })

  it.each(['direct', 'selector'] as const)('uses configured toolOrder for new %s selections in the same request', async (admission) => {
    const { ctx, executions } = await setup({
      toolOrder: [TOOL_NAME, 'zulu', TOOL_ORDER_REST, 'discover_mcp_tools'], selector: admission === 'selector',
    })
    ctx.tools.register(definition('alpha', executions))
    ctx.tools.register(definition('zulu', executions))
    const { agent, requests } = await run(ctx, ['Finished'], admission === 'direct' ? `Use ${TOOL_NAME}` : 'Read the requested record')
    expect(requests[0]!.tools?.map(schema => schema.name)).toEqual([TOOL_NAME, 'zulu', 'alpha', 'discover_mcp_tools'])
    expectRecordedRequests(agent, requests)
  })
})
