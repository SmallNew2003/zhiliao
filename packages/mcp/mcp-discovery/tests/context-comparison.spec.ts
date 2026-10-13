import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import Discovery, { Config } from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
type Strategy = 'eager' | 'search' | 'selector-search'
type Action = { name: string; arguments: object }
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')
function response(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } }]
}
function call(action: Action, id: number): StreamChunk[] {
  const callId = ToolCallId(`comparison-${id}`)
  const args = JSON.stringify(action.arguments)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: action.name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: action.name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly actions: (Action | string)[], private readonly inHistory = false) { super() }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, ...this.inHistory ? { systemPromptUpdate: 'in-history' as const } : {} }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const action = this.actions.shift()
    if (action === undefined) throw new Error('Comparison script exhausted')
    yield* typeof action === 'string' ? response(action) : call(action, this.requests.length)
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
function definition(server: string, index: number, executions: string[]): ToolDefinition {
  const name = `mcp__${server}__tool_${index}`
  return {
    name, description: index === 0 ? server === 'github' ? 'Read GitHub issues' : 'Read Notion documents' : 'Unrelated administrative capability',
    parameters: { type: 'object', properties: { query: { type: 'string', description: `${server} full parameter reference `.repeat(90) } }, required: ['query'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    async execute() { executions.push(name); return `${server} result` },
  }
}
const selection = (names: string[], status = 'selected') => JSON.stringify({ status, names, servers: [] })
const scenarios = [
  { task: 'Read a GitHub issue', names: ['mcp__github__tool_0'], outcome: 'selected' },
  { task: '查 GitHub 的登录失败 Issue', names: ['mcp__github__tool_0'], outcome: 'selected' },
  { task: 'Read the issue and its Notion document', names: ['mcp__github__tool_0', 'mcp__notion__tool_0'], outcome: 'selected' },
  { task: '查 GitHub issue（候选不确定）', names: ['mcp__github__tool_0'], outcome: 'uncertain' },
  { task: 'Read GitHub issue after selector failure', names: ['mcp__github__tool_0'], outcome: 'invalid' },
] as const

async function exercise(strategy: Strategy, scenario: typeof scenarios[number], mode: 'native' | 'ptc') {
  const ctx = new Context(); roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode } })
  if (mode === 'ptc') await ctx.plugin(BindingRuntime)
  const auxiliary = new ScriptedModel([scenario.outcome === 'invalid' ? '{' : selection(scenario.outcome === 'selected' ? [...scenario.names] : [], scenario.outcome)])
  ctx.llm.registerAdapter(['aux'], auxiliary)
  if (strategy !== 'eager') await ctx.plugin(Discovery, Config({
    ...strategy === 'selector-search' ? { selector: { provider: 'aux', model: 'decision-fixture', inputBytes: 16384, outputBytes: 1024, maxTokens: 256, timeoutMs: 1000 } } : {},
  }))
  const executions: string[] = []
  const instructionTexts: string[] = []
  for (const server of ['github', 'notion']) {
    const instructions = `${server} complete instructions: use literal identifiers. `.repeat(30)
    instructionTexts.push(instructions)
    if (strategy === 'eager') ctx.systemPrompt.section({ name: `fixture:${server}`, order: 10, text: instructions })
    else ctx.mcpDiscovery.registerServer(server, { connected: () => true, instructions: () => instructions })
    for (let index = 0; index < 30; index++) {
      const tool = definition(server, index, executions)
      if (strategy === 'eager') ctx.tools.register(tool)
      else ctx.mcpDiscovery.registerTool(server, tool)
    }
  }
  const needsRecovery = strategy === 'search' || strategy === 'selector-search' && scenario.outcome !== 'selected'
  const actions: (Action | string)[] = needsRecovery ? [
    { name: 'discover_mcp_tools', arguments: { action: 'search', names: scenario.names } },
    { name: 'discover_mcp_tools', arguments: { action: 'load', names: scenario.names } },
  ] : []
  actions.push(...scenario.names.map(name => ({ name, arguments: { query: scenario.task } })), 'completed')
  const main = new ScriptedModel(mode === 'native' ? actions : actions.map(action => typeof action === 'string' ? action : {
    name: 'run_code', arguments: { code: JSON.stringify(action), description: 'Execute comparison capability' },
  }))
  ctx.llm.registerAdapter(['main'], main)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`comparison-${strategy}`), { provider: 'main', model: 'main-fixture' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario.task }] }))
  await agent.whenIdle()
  expect(executions).toEqual(scenario.names)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').every(event => !event.data.message.content.some(block => block.type === 'tool-result' && block.isError))).toBe(true)
  const first = main.requests[0]!
  const final = main.requests.at(-1)!
  const snapshots = agent.session.snapshotEvents().filter(event => event.type === 'mcp/request-snapshot')
  if (strategy !== 'eager') {
    const visible = mode === 'native'
      ? first.tools?.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name) ?? []
      : snapshots[0]!.data.tools.map(tool => tool.name)
    expect(visible).toEqual(strategy === 'selector-search' && scenario.outcome === 'selected' ? [...scenario.names] : [])
    if (mode === 'native') expect(final.tools?.filter(tool => tool.name.startsWith('mcp__'))).toHaveLength(scenario.names.length)
    else expect(snapshots.at(-1)!.data.tools).toHaveLength(scenario.names.length)
    expect(JSON.stringify(auxiliary.requests)).not.toContain('full parameter reference')
  }
  const systemText = first.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n\n')
  const sdkStart = systemText.indexOf('## Writing code for run_code')
  return {
    strategy, mode, task: scenario.task, evidence: 'deterministic-production-loop' as const,
    initialDefinitionBytes: byteLength(JSON.stringify(first.tools ?? [])),
    initialSystemBytes: byteLength(first.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('')),
    initialSdkBytes: mode === 'native' ? 0 : byteLength(strategy === 'eager' ? systemText.slice(sdkStart) : snapshots[0]!.data.sdk),
    initialInstructionBytes: strategy === 'eager' ? byteLength(instructionTexts.join('\n\n')) : byteLength(snapshots[0]!.data.instructions),
    mainCalls: main.requests.length, auxiliaryCalls: auxiliary.requests.length,
    auxiliaryInputBytes: auxiliary.requests.reduce((sum, request) => sum + byteLength((request.system ?? '') + request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('')), 0),
    scriptedPreselectionMiss: strategy === 'selector-search' && scenario.outcome !== 'selected',
    recoveredByDiscovery: needsRecovery, completed: executions.length === scenario.names.length,
    realModelRecall: null, realModelLatencyMs: null, realModelCost: null,
  }
}

describe('MCP reproducible context comparison', () => {
  const rows: Awaited<ReturnType<typeof exercise>>[] = []
  afterAll(() => {
    if (rows.length === scenarios.length * 6) console.info(`MCP_CONTEXT_COMPARISON=${JSON.stringify({ catalogTools: 60, rows })}`)
  })
  const cases = scenarios.flatMap(scenario => (['native', 'ptc'] as const).map(mode => ({ scenario, mode, task: scenario.task })))
  it.each(cases)('compares identical large catalogs ($mode): $task', async ({ scenario, mode }) => {
    const eager = await exercise('eager', scenario, mode)
    const search = await exercise('search', scenario, mode)
    const automatic = await exercise('selector-search', scenario, mode)
    if (mode === 'native') {
      expect(search.initialDefinitionBytes).toBeLessThan(eager.initialDefinitionBytes / 10)
      expect(automatic.initialDefinitionBytes).toBeLessThan(eager.initialDefinitionBytes / 5)
    } else {
      expect(search.initialSdkBytes).toBeLessThan(eager.initialSdkBytes / 10)
      expect(automatic.initialSdkBytes).toBeLessThan(eager.initialSdkBytes / 5)
    }
    const eagerBytes = eager.initialSystemBytes + eager.initialDefinitionBytes
    expect(search.initialSystemBytes + search.initialDefinitionBytes).toBeLessThan(eagerBytes / 10)
    rows.push(eager, search, automatic)
  })
  it('reuses selected tools for continuation and supplies recent task context without per-step selection', async () => {
    const ctx = new Context(); roots.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const auxiliary = new ScriptedModel([selection(['mcp__github__tool_0']), selection(['mcp__github__tool_0'])])
    ctx.llm.registerAdapter(['aux'], auxiliary)
    await ctx.plugin(Discovery, Config({ selector: { provider: 'aux', model: 'fixture', inputBytes: 8192, outputBytes: 1024, maxTokens: 256, timeoutMs: 1000 } }))
    ctx.mcpDiscovery.registerServer('github', { connected: () => true, instructions: () => 'Use issue identifiers.' })
    const executions: string[] = []
    ctx.mcpDiscovery.registerTool('github', definition('github', 0, executions))
    const action = { name: 'mcp__github__tool_0', arguments: { query: 'Issue 123' } }
    const main = new ScriptedModel([action, 'Issue 123 requires followup', action, 'continued'])
    ctx.llm.registerAdapter(['main'], main)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('continuation'), { provider: 'main', model: 'fixture' })
    for (const text of ['查 GitHub Issue 123', '继续']) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    }
    expect(main.requests).toHaveLength(4)
    expect(auxiliary.requests).toHaveLength(2)
    expect(JSON.stringify(auxiliary.requests[1]?.messages)).toContain('Issue 123')
    expect(JSON.stringify(auxiliary.requests[1]?.messages)).toContain('继续')
    expect(executions).toHaveLength(2)
  })
  it('removes released PTC interfaces from the next in-history request without changing run_code', async () => {
    const ctx = new Context(); roots.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
    await ctx.plugin(BindingRuntime)
    await ctx.plugin(Discovery, Config({}))
    ctx.mcpDiscovery.registerServer('github', { connected: () => true, instructions: () => 'Full GitHub guidance.' })
    ctx.mcpDiscovery.registerTool('github', definition('github', 0, []))
    const release = { name: 'discover_mcp_tools', arguments: { action: 'release' } }
    const main = new ScriptedModel([{ name: 'run_code', arguments: { code: JSON.stringify(release), description: 'Release selected GitHub tool' } }, 'released'], true)
    ctx.llm.registerAdapter(['main'], main)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('ptc-history'), { provider: 'main', model: 'fixture' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use mcp__github__tool_0 then release it' }] }))
    await agent.whenIdle()
    expect(main.requests).toHaveLength(2)
    expect(main.requests[0]?.tools).toEqual(main.requests[1]?.tools)
    const systems = main.requests.map(request => request.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join(''))
    expect(systems[0]).toContain('full parameter reference')
    expect(systems[1]).not.toContain('full parameter reference')
    expect(systems[1]).not.toContain('Full GitHub guidance.')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(2)
  })
  it('discovers a second server during execution after the selector supplied only the first', async () => {
    const ctx = new Context(); roots.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const auxiliary = new ScriptedModel([selection(['mcp__github__tool_0'])])
    ctx.llm.registerAdapter(['aux'], auxiliary)
    await ctx.plugin(Discovery, Config({ selector: {
      provider: 'aux', model: 'fixture', inputBytes: 8192, outputBytes: 1024, maxTokens: 256, timeoutMs: 1000,
    } }))
    const executions: string[] = []
    for (const server of ['github', 'notion']) {
      ctx.mcpDiscovery.registerServer(server, { connected: () => true, instructions: () => `${server} guidance.` })
      ctx.mcpDiscovery.registerTool(server, definition(server, 0, executions))
    }
    const main = new ScriptedModel([
      { name: 'mcp__github__tool_0', arguments: { query: 'Issue 123' } },
      { name: 'discover_mcp_tools', arguments: { action: 'search', server: 'notion' } },
      { name: 'discover_mcp_tools', arguments: { action: 'load', names: ['mcp__notion__tool_0'] } },
      { name: 'mcp__notion__tool_0', arguments: { query: 'linked document' } }, 'completed',
    ])
    ctx.llm.registerAdapter(['main'], main)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('later-capability'), { provider: 'main', model: 'fixture' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '查 GitHub Issue 123，并查看其关联文档' }] }))
    await agent.whenIdle()
    expect(executions).toEqual(['mcp__github__tool_0', 'mcp__notion__tool_0'])
    expect(main.requests[0]?.tools?.some(tool => tool.name === 'mcp__notion__tool_0')).toBe(false)
    expect(main.requests[3]?.tools?.some(tool => tool.name === 'mcp__notion__tool_0')).toBe(true)
    expect(auxiliary.requests).toHaveLength(1)
  })
})
