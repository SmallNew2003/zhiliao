/**
 * Bounded auxiliary MCP selection; failures retain discovery access.
 * @module @deepseek-ai/dsh-mcp-discovery
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DiscoveryItem, SelectorConfig } from './index.ts'
import type { SelectorResult } from './types.ts'

const SYSTEM = 'Select MCP capabilities for the task. Return JSON {"status":"selected"|"none"|"uncertain","names":[],"servers":[]}. Select only catalog names. Do not execute tools. Server selection narrows discovery; it does not load every tool.'
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/**
 * Ask only the explicit auxiliary route using bounded recent task context and short descriptors.
 * @param ctx - services.
 * @param config - independent route and budgets.
 * @param agent - durable owner.
 * @param demand - direct human input.
 * @param catalog - permission-filtered descriptors.
 * @param loaded - valid names.
 * @param targets - direct server constraints.
 * @param signal - caller cancellation.
 * @returns distinct selection, none, uncertainty, or failure.
 */
export async function selectTools(ctx: Context, config: SelectorConfig, agent: Agent, demand: string,
  catalog: DiscoveryItem[], loaded: string[], targets: string[], signal?: AbortSignal): Promise<SelectorResult> {
  const optionalConnection = ctx.get('llm')
  if (!optionalConnection) throw new Error('mcp-discovery: enabled selector requires llm')
  const connection = optionalConnection
  const controller = new AbortController()
  const abort = () => { controller.abort(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('MCP selector timeout')) }, config.timeoutMs)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let result: SelectorResult
  const recent = agent.session.deriveMessages().filter(message => message.role === 'assistant' || message.role === 'user' && message.source.kind === 'user')
    .map(message => ({ role: message.role, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }))
  const selectedCatalog = targets.length ? catalog.filter(item => targets.includes(item.server)) : catalog
  const makeInput = (items: DiscoveryItem[], history: typeof recent, omitted: number) =>
    JSON.stringify({ demand, loaded, recent: history, omittedRecentRecords: omitted, catalog: items })
  const boundedInput = (descriptors: DiscoveryItem[]) => {
    const history = [...recent]
    let input = makeInput(descriptors, history, 0)
    let omitted = 0
    while (history.length && bytes(SYSTEM) + bytes(input) > config.inputBytes) {
      history.shift(); omitted++; input = makeInput(descriptors, history, omitted)
    }
    return { input, history, omitted }
  }
  let input = boundedInput(selectedCatalog).input
  try {
    signal?.throwIfAborted()
    let descriptors = selectedCatalog
    if (bytes(SYSTEM) + bytes(input) > config.inputBytes) {
      descriptors = selectedCatalog.filter(item => item.name === undefined).map((server) => {
        const summaries = [...new Set(selectedCatalog.filter(item => item.server === server.server && item.name !== undefined)
          .map(item => item.description).filter(Boolean))]
        return { ...server, description: summaries.length ? summaries.join('; ') : server.description }
      })
      const summaries = descriptors.map(item => ({ item, characters: Array.from(item.description) }))
      const previews = (length: number) => summaries.map(({ item, characters }) => ({
        ...item, description: characters.slice(0, length).join(''),
      }))
      const baseline = boundedInput(previews(1))
      let low = 1
      let high = Math.max(...summaries.map(value => value.characters.length), 1)
      input = baseline.input
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const proposed = makeInput(previews(middle), baseline.history, baseline.omitted)
        if (bytes(SYSTEM) + bytes(proposed) <= config.inputBytes) { low = middle; input = proposed }
        else high = middle - 1
      }
      descriptors = previews(low)
      input = makeInput(descriptors, baseline.history, baseline.omitted)
      if (bytes(SYSTEM) + bytes(input) > config.inputBytes) throw new Error('selector inputBytes cannot fit current demand, loaded names, and server catalog')
      const shortlist = await request('servers', input, descriptors)
      if (shortlist.status !== 'selected' || !shortlist.servers.length) return shortlist
      descriptors = selectedCatalog.filter(item => shortlist.servers.includes(item.server))
      input = boundedInput(descriptors).input
      if (bytes(SYSTEM) + bytes(input) > config.inputBytes) throw new Error('selector inputBytes cannot fit shortlisted tool descriptors')
    }
    result = await request('tools', input, descriptors)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof LlmError && (error.code === 'UNKNOWN_MODEL' || error.code === 'NO_ADAPTER')) {
      throw new Error(`mcp-discovery: invalid selector provider/model ${config.provider}/${config.model}: ${error.message}`, { cause: error })
    }
    result = { status: 'failed', names: [], servers: [], detail: error instanceof Error ? error.message : String(error) }
    agent.session.append('mcp/selector-result', result)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  return result

  async function request(phase: 'tools' | 'servers', input: string, descriptors: DiscoveryItem[]): Promise<SelectorResult> {
    agent.session.append('mcp/selector-request', { provider: config.provider, model: config.model, maxTokens: config.maxTokens, system: SYSTEM, input, phase })
    let output = ''
    for await (const chunk of connection.stream({ provider: config.provider, model: config.model,
      system: SYSTEM, messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'mcp-discovery' }, content: [{ type: 'text', text: input }] })],
      maxTokens: config.maxTokens, signal: combined, sessionId: agent.session.id, purpose: 'mcp-selector' })) {
      combined.throwIfAborted()
      if (chunk.type === 'text-delta') { output += chunk.text; if (bytes(output) > config.outputBytes) throw new Error('selector outputBytes exceeded') }
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code)
      }
    }
    combined.throwIfAborted()
    const decoded: unknown = JSON.parse(output)
    if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid MCP selector JSON')
    const value = decoded as Record<string, unknown>
    if (!['selected', 'none', 'uncertain'].includes(String(value.status)) || !Array.isArray(value.names) || !Array.isArray(value.servers)
      || !value.names.every(name => typeof name === 'string' && descriptors.some(item => item.name === name))
      || !value.servers.every(server => typeof server === 'string' && descriptors.some(item => item.server === server))) throw new Error('Invalid or unavailable MCP selector names')
    const result: SelectorResult = { status: value.status as SelectorResult['status'], names: value.names as string[], servers: value.servers as string[] }
    if (result.status !== 'selected' && (result.names.length || result.servers.length)) throw new Error('MCP selector none/uncertain must not select names')
    agent.session.append('mcp/selector-result', result)
    return result
  }
}
