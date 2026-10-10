/**
 * Scoped MCP discovery, atomic context admission, and request-bound execution.
 * @module @deepseek-ai/dsh-mcp-discovery
 */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import { createScope, NamedEntries, ScopedLayers, scopeOf, type ScopeKey, type ScopeLayer } from '@deepseek-ai/dsh-scope'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { HarnessError, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { DiscoveryState, McpDefinitionId, RequestSnapshot, Selection, SelectedTool } from './types.ts'
import { selectTools } from './selector.ts'
export type * from './types.ts'

/** Independent auxiliary route; omission disables all selector calls. */
export interface SelectorConfig {
  /** Explicit registered auxiliary provider route; never inherited from the conversation. */
  provider: string
  /** Auxiliary model id resolved by that provider. */
  model: string
  /** Maximum UTF-8 bytes of exact auxiliary system and message text. */
  inputBytes: number
  /** Maximum UTF-8 bytes accepted from the auxiliary reply. */
  outputBytes: number
  /** Explicit auxiliary generation token limit, independent of reply byte admission. */
  maxTokens: number
  /** Cooperative auxiliary deadline in milliseconds; cancellation awaits owned work. */
  timeoutMs: number
}
/** UTF-8 limits cover complete emitted MCP representations. */
export interface Config {
  /** Maximum UTF-8 bytes of complete directory text, including wrappers and continuation guidance. */
  catalogBytes: number
  /** Maximum UTF-8 bytes of serialized complete MCP schemas, including discovery. */
  nativeBytes: number
  /** Maximum UTF-8 bytes of the complete generated MCP SDK, including discovery. */
  sdkBytes: number
  /** Maximum UTF-8 bytes of activated literal server instructions, including attribution. */
  instructionBytes: number
  /** Maximum UTF-8 bytes of complete serialized discovery results. */
  resultBytes: number
  /** Maximum descriptors per search page; byte admission may return fewer. */
  resultLimit: number
  /** Independent auxiliary configuration; omission disables auxiliary requests. */
  selector?: SelectorConfig | undefined
}
/** Configuration input; omitted limits receive the documented defaults. */
export type ConfigInput = Partial<Config>
/** Resolved defaults and strict positive byte/count bounds. */
export const Config: z<ConfigInput, Config> = z.object({
  catalogBytes: z.number().step(1).min(1).max(16_777_216).default(8192),
  nativeBytes: z.number().step(1).min(1).max(16_777_216).default(32768),
  sdkBytes: z.number().step(1).min(1).max(16_777_216).default(32768),
  instructionBytes: z.number().step(1).min(1).max(16_777_216).default(16384),
  resultBytes: z.number().step(1).min(1).max(16_777_216).default(8192),
  resultLimit: z.number().step(1).min(1).max(1000).default(20),
  selector: z.union([z.const(undefined), z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    inputBytes: z.number().step(1).min(1).max(16_777_216).required(),
    outputBytes: z.number().step(1).min(1).max(16_777_216).required(),
    maxTokens: z.number().step(1).min(1).max(1_000_000).required(),
    timeoutMs: z.number().step(1).min(1).max(2_147_483_647).required(),
  })]),
})

declare module '@deepseek-ai/cordis' { interface Context { mcpDiscovery: McpDiscovery } }

/** Live connection facts owned by the configured server plugin. */
export interface ServerSource {
  /**
   * Read complete literal, attributed instructions from the last successful handshake.
   * @returns server prompt text.
   */
  instructions(): string
  /**
   * Report whether resource and tool requests currently have a live connection.
   * @returns connection readiness.
   */
  connected(): boolean
}
/** Short discovery item; schemas remain deferred. */
export interface DiscoveryItem { server: string; name?: string; description: string; connected: boolean }
/** Caller filters; offset is an index in the current filtered catalog. */
export interface SearchRequest { query?: string; server?: string; names?: readonly string[]; offset?: number }
/** Bounded search page with a continuation offset when items remain. */
export interface DiscoveryPage { items: DiscoveryItem[]; nextOffset: number | null; hint: string }
/** Atomic admission outcome; a refused proposal retains the previous selection. */
export type LoadResult = { ok: true; names: string[]; servers: string[] } | { ok: false; reason: string }
interface ToolEntry { source: ServerSource; server: string; definition: ToolDefinition; wrapper: ToolDefinition }
const duplicateError = (kind: 'server' | 'tool') => (name: string): Error =>
  new Error(`MCP ${kind} "${name}" already registered in this scope`)
class Layer implements ScopeLayer {
  readonly servers = new NamedEntries<ServerSource>(duplicateError('server'))
  readonly tools = new NamedEntries<ToolEntry>(duplicateError('tool'))
  disposeTool: (() => void | Promise<void>) | undefined
  isEmpty(): boolean { return this.servers.isEmpty() && this.tools.isEmpty() }
}
const CATALOG_HEADER = '## MCP capabilities\n\nUse discover_mcp_tools to search, load specific tools, activate resource servers, or release selections.\n'
const CATALOG_OPEN = '\n```jsonl\n'
const CATALOG_CLOSE = '```\n\n'
const PAGE_HINT = 'Use nextOffset or narrow query/server; load specific names or activate a server before resource use.'
const DISCOVERY_NAME = 'discover_mcp_tools'
const emptySelection = (): Selection => ({ tools: [], servers: [] })
const identity = (value: unknown): McpDefinitionId => createHash('sha256').update(JSON.stringify(value)).digest('hex') as McpDefinitionId
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const schemaOf = ({ name, description, parameters }: ToolDefinition): ToolSchema => ({ name, description, parameters })
const serverIdentity = (source: ServerSource): McpDefinitionId => identity(source.instructions())
const toolIdentity = (entry: ToolEntry, source: ServerSource): McpDefinitionId => identity({
  schema: schemaOf(entry.definition), output: entry.definition.output.schema, instructions: source.instructions(),
})
const identitySchema = zod.string().regex(/^[a-f0-9]{64}$/).transform(value => value as McpDefinitionId)
const selectionSchema = zod.object({
  tools: zod.array(zod.object({ name: zod.string(), server: zod.string(), identity: identitySchema })),
  servers: zod.array(zod.object({ server: zod.string(), identity: identitySchema })),
})

/** Deferred MCP definitions share permission filtering and execution with ordinary tools. */
export class McpDiscovery extends Service {
  /** Required presentation and durable projection services. */
  static inject = ['tools', 'systemPrompt', 'sessionProjections']
  /** Deployment schema; selector omission prevents auxiliary calls. */
  static Config = Config
  private readonly layers = new ScopedLayers(() => new Layer(), () => undefined)
  private readonly selfCtx: Context
  private readonly staged = new WeakMap<Agent, {
    snapshot: RequestSnapshot
    fullSdk: string
    sdkMatches: boolean
    instructions: Map<string, string>
  }>()
  private readonly owners = new WeakMap<ScopeKey, Agent>()
  private readonly diagnostics = new WeakMap<Agent, string[]>()
  private readonly config: Config
  private active = true
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpDiscovery')
    this.selfCtx = ctx
    this.config = config
    const definition = this.discoveryTool()
    this.minimum('catalogBytes', bytes(CATALOG_HEADER + CATALOG_OPEN + CATALOG_CLOSE + PAGE_HINT))
    this.minimum('resultBytes', bytes(JSON.stringify({ items: [], nextOffset: null, hint: PAGE_HINT })))
    this.minimum('nativeBytes', bytes(JSON.stringify([schemaOf(definition)])))
    if (config.selector) {
      const llm = ctx.get('llm')
      if (!llm) throw new Error('mcp-discovery: selector requires llm with its explicit provider/model')
    }
    ctx.effect(() => async () => {
      this.active = false
      this.lifetime.abort(new Error('MCP discovery disposed'))
      await Promise.allSettled(this.pending)
    }, 'mcpDiscovery.active')
    ctx.sessionProjections.register<'mcpDiscovery', DiscoveryState>({
      key: 'mcpDiscovery', stateVersion: 1,
      stateSchema: zod.object({ selection: selectionSchema, request: selectionSchema.extend({
        turn: zod.number().int().nonnegative(), step: zod.number().int().nonnegative(),
        schemas: zod.array(zod.object({
          name: zod.string(), description: zod.string(),
          parameters: zod.record(zod.string(), zod.json()).transform((value): Record<string, unknown> => value),
        })),
        sdk: zod.string(), instructions: zod.string(),
      }).nullable() }),
      init: (): DiscoveryState => ({ selection: emptySelection(), request: null }),
      apply: (state, event): DiscoveryState => {
        switch (event.type) {
          case 'mcp/selection': return { ...state, selection: { tools: event.data.tools, servers: event.data.servers } }
          case 'mcp/request-snapshot': return { ...state, request: event.data }
          default: return state
        }
      },
    })
    ctx.systemPrompt.section({ name: 'mcp:discovery', order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false, text: '' })
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      await this.prepare(context)
      const projected = this.project(assembly, context)
      Object.assign(assembly, projected)
      const result = await next()
      this.stage(result, context)
      return result
    })
    ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const staged = this.staged.get(agent)?.snapshot
      if (!staged || staged.turn !== turn || staged.step !== step) return decision
      const previous = this.state(agent).request
      const changed = previous
        ? previous.sdk !== staged.sdk || previous.instructions !== staged.instructions
        : agent.session.requestHeader() !== undefined && (staged.sdk !== '' || staged.instructions !== '')
      return changed ? { ...decision, startsRequestSeries: true } : decision
    })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type !== 'start') return
      const staged = this.staged.get(agent)
      if (staged && staged.snapshot.turn === frame.turn && staged.snapshot.step === frame.step) {
        const actualSystem = agent.session.deriveMessages().filter(message => message.role === 'system')
          .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n\n')
        const servers = staged.snapshot.servers.filter((item) => {
          const text = staged.instructions.get(item.server) as string
          return !text.trim() || actualSystem.includes(text)
        })
        const sdkVisible = staged.sdkMatches && (!staged.fullSdk || actualSystem.includes(staged.fullSdk))
        const mode = this.selfCtx.tools.modeFor(agent)
        const tools = staged.snapshot.tools.filter(tool => servers.some(item => item.server === tool.server)
          && (mode !== 'ptc' || sdkVisible))
        const instructions = servers.map(item => staged.instructions.get(item.server) as string).filter(text => text.trim()).join('\n\n')
        agent.session.append('mcp/request-snapshot', {
          ...staged.snapshot, tools, servers, instructions, sdk: sdkVisible ? staged.snapshot.sdk : '',
        })
      }
    })
  }

  /**
   * Register a configured server in the caller's scope.
   * @param server - namespace.
   * @param source - connection facts.
   * @returns effect disposer.
   */
  registerServer(server: string, source: ServerSource): () => void {
    const scope = scopeOf(this.ctx)
    const ctx = this.ctx
    const dispose = ctx.effect(function* (this: McpDiscovery) {
      let disposal: void | Promise<void>
      yield () => disposal
      yield this.layers.effect(ctx, (layer) => {
        const first = layer.servers.isEmpty()
        const remove = layer.servers.insert(server, source)
        try { if (first) layer.disposeTool = this.registerDiscovery(scope) } catch (error) { remove(); throw error }
        return () => { remove(); if (layer.servers.isEmpty()) disposal = layer.disposeTool?.() }
      }, { label: `mcpDiscovery.server(${server})` })
    }.bind(this), `mcpDiscovery.registerServer(${server})`)
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous registry cleanup retains Cordis disposal identity
    return dispose
  }

  /**
   * Register one deferred MCP definition without changing authorization.
   * @param server - owning namespace.
   * @param definition - original tool.
   * @returns effect disposer.
   */
  registerTool(server: string, definition: ToolDefinition): () => void {
    const source = this.servers(scopeOf(this.ctx)).get(server)
    if (!source) throw new Error(`MCP server ${server} must be registered before its tools`)
    const entry: ToolEntry = { source, server, definition, wrapper: {
      ...definition,
      isPresented: (scope) => {
        if (!scope) return false
        const agent = this.owners.get(scope)
        if (agent === undefined) return false
        const selected = this.state(agent).selection.tools.find(tool => tool.name === definition.name)
        if (selected === undefined || this.selfCtx.tools.get(definition.name, scope) !== entry.wrapper) return false
        const current = this.servers(scope).get(server)
        return current === source && selected.identity === toolIdentity(entry, current)
      },
      execute: async (args, exec) => {
        this.assertTool(entry, exec)
        return definition.execute(args, exec)
      },
    } }
    const registered = this.ctx.tools.register(entry.wrapper)
    try {
      const remove = this.layers.effect(this.ctx, layer => layer.tools.insert(definition.name, entry), { label: `mcpDiscovery.tool(${definition.name})` })
      return () => { remove(); registered() }
    } catch (error) { registered(); throw error }
  }

  /**
   * Search the permission-filtered catalog without loading schemas.
   * @param scope - caller identity.
   * @param request - bounded filters and pagination.
   * @returns complete byte-limited page.
   */
  search(scope?: ScopeKey, request: SearchRequest = {}): DiscoveryPage {
    const items = this.catalog(scope).filter(item =>
      (request.server === undefined || item.server === request.server)
      && (request.names === undefined || item.name !== undefined && request.names.includes(item.name))
      && (request.query === undefined || `${item.server} ${item.name ?? ''} ${item.description}`.toLowerCase().includes(request.query.toLowerCase())))
    const offset = request.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('mcp-discovery: offset must be a non-negative integer')
    const page: DiscoveryPage = { items: [], nextOffset: null, hint: PAGE_HINT }
    for (const item of items.slice(offset, offset + this.config.resultLimit)) {
      const proposal: DiscoveryPage = {
        ...page, items: [...page.items, item],
        nextOffset: offset + page.items.length + 1 < items.length ? offset + page.items.length + 1 : null,
      }
      if (bytes(JSON.stringify(proposal)) > this.config.resultBytes) break
      Object.assign(page, proposal)
    }
    if (offset + page.items.length < items.length) page.nextOffset = offset + page.items.length
    // Oversized single rows stay discoverable by an exact filter and a short identity.
    if (!page.items.length && items[offset]) {
      const item = items[offset]
      const short = { server: item.server, ...item.name === undefined ? {} : { name: item.name }, description: '', connected: item.connected }
      const proposal = { ...page, items: [short], nextOffset: offset + 1 < items.length ? offset + 1 : null }
      if (bytes(JSON.stringify(proposal)) <= this.config.resultBytes) return proposal
      return { items: [], nextOffset: null, hint: 'Catalog item exceeds resultBytes; increase resultBytes.' }
    }
    return page
  }

  /**
   * Atomically add tool definitions and complete server instructions.
   * @param agent - durable owner.
   * @param names - exact public tool names.
   * @param servers - resource-only activation targets.
   * @param signal - cancellation before commit.
   * @returns admission or refusal.
   */
  load(agent: Agent, names: readonly string[], servers: readonly string[] = [], signal?: AbortSignal): LoadResult {
    return this.change(agent, names, servers, signal, false)
  }

  private change(
    agent: Agent, names: readonly string[], servers: readonly string[], signal: AbortSignal | undefined, replace: boolean,
  ): LoadResult {
    signal?.throwIfAborted()
    if (!this.active) return { ok: false, reason: 'MCP discovery is disposed.' }
    this.owners.set(agent, agent)
    const proposal = replace ? emptySelection() : this.valid(agent)
    const visibleServers = this.servers(agent)
    const tools = this.tools(agent)
    for (const name of names) {
      const entry = tools.get(name)
      const source = entry && visibleServers.get(entry.server)
      if (!entry || !source) return { ok: false, reason: `MCP tool ${name} is unknown or unavailable in this scope.` }
      if (!source.connected()) return { ok: false, reason: `MCP server ${entry.server} is disconnected.` }
      const selected: SelectedTool = { name, server: entry.server, identity: toolIdentity(entry, source) }
      proposal.tools = [...proposal.tools.filter(tool => tool.name !== name), selected]
    }
    for (const server of new Set([...servers, ...proposal.tools.map(tool => tool.server)])) {
      const source = visibleServers.get(server)
      if (!source) return { ok: false, reason: `MCP server ${server} is unknown or unavailable in this scope.` }
      if (!source.connected()) return { ok: false, reason: `MCP server ${server} is disconnected.` }
      proposal.servers = [...proposal.servers.filter(item => item.server !== server), { server, identity: serverIdentity(source) }]
    }
    proposal.tools.sort((a, b) => a.name.localeCompare(b.name))
    proposal.servers.sort((a, b) => a.server.localeCompare(b.server))
    const refusal = this.admit(agent, proposal)
    if (refusal) return { ok: false, reason: refusal }
    signal?.throwIfAborted()
    agent.session.append('mcp/selection', { ...proposal, reason: replace ? 'replace' : 'load' })
    return { ok: true, names: proposal.tools.map(tool => tool.name), servers: proposal.servers.map(item => item.server) }
  }

  /**
   * Release selections for future requests; started snapshots stay fixed.
   * @param agent - owner.
   * @param names - names, or omission to release all.
   * @param servers - activated server names to release.
   * @returns remaining selection.
   */
  release(agent: Agent, names?: readonly string[], servers: readonly string[] = []): LoadResult {
    const selection = this.valid(agent)
    const all = names === undefined && !servers.length
    selection.tools = all ? [] : selection.tools.filter(tool =>
      !names?.includes(tool.name) && !servers.includes(tool.server))
    selection.servers = all ? [] : selection.servers.filter(item => !servers.includes(item.server)
      && (selection.tools.some(tool => tool.server === item.server)
        || !names?.some(name => this.tools(agent).get(name)?.server === item.server)))
    agent.session.append('mcp/selection', { ...selection, reason: 'release' })
    return { ok: true, names: selection.tools.map(tool => tool.name), servers: selection.servers.map(item => item.server) }
  }

  /**
   * Guard model resource calls before network access. Programmatic calls without an Agent bypass activation only.
   * @param server - resource namespace.
   * @param exec - execution owner.
   */
  assertServer(server: string, exec: ToolExecution): void {
    if (!exec.agent) return
    const source = this.servers(exec.agent).get(server)
    const snapshot = this.state(exec.agent).request
    const selected = snapshot?.servers.find(item => item.server === server)
    if (!source || !selected) throw new HarnessError(`Activate MCP server ${server} using discover_mcp_tools, then retry after the next request.`, 'MCP_SERVER_INACTIVE')
    if (selected.identity !== serverIdentity(source)) throw new HarnessError(`MCP server ${server} instructions changed; discover and activate it again.`, 'MCP_STALE_DEFINITION')
    if (!source.connected()) throw new HarnessError(`MCP server ${server} is disconnected.`, 'MCP_DISCONNECTED')
  }

  private state(agent: Agent): DiscoveryState {
    const state = this.selfCtx.sessionProjections.stateOf(agent.session, 'mcpDiscovery')
    /* v8 ignore next -- the required projection is registered before the service becomes available */
    if (!state) throw new Error('mcp-discovery: durable projection is unavailable')
    return state
  }
  private servers(scope?: ScopeKey): Map<string, ServerSource> { return this.layers.merge(scope, layer => layer.servers) }
  private tools(scope?: ScopeKey): Map<string, ToolEntry> {
    return new Map([...this.layers.merge(scope, layer => layer.tools)].filter(([name, entry]) =>
      this.selfCtx.tools.get(name, scope) === entry.wrapper && this.servers(scope).get(entry.server) === entry.source))
  }
  private valid(agent: Agent): Selection {
    const recorded = this.state(agent).selection
    const servers = this.servers(agent)
    const tools = this.tools(agent)
    return {
      tools: recorded.tools.filter((tool) => {
        const entry = tools.get(tool.name); const source = servers.get(tool.server)
        return entry !== undefined && source !== undefined && tool.identity === toolIdentity(entry, source)
      }),
      servers: recorded.servers.filter((item) => {
        const source = servers.get(item.server)
        return source !== undefined && item.identity === serverIdentity(source)
      }),
    }
  }
  private catalog(scope?: ScopeKey): DiscoveryItem[] {
    if (!this.selfCtx.tools.get(DISCOVERY_NAME, scope)) return []
    const servers = this.servers(scope)
    const items: DiscoveryItem[] = [...servers].map(([server, source]) => ({ server, description: 'MCP server; activate for resource access.', connected: source.connected() }))
    for (const [name, entry] of this.tools(scope)) {
      const source = servers.get(entry.server) as ServerSource
      items.push({ name, server: entry.server, description: entry.definition.description.split('\n', 1).join(''), connected: source.connected() })
    }
    return items.sort((a, b) => `${a.server}:${a.name ?? ''}`.localeCompare(`${b.server}:${b.name ?? ''}`))
  }
  private instructions(scope: ScopeKey, selection: Selection): string {
    const servers = this.servers(scope)
    return selection.servers.map(item => (servers.get(item.server) as ServerSource).instructions()).filter(text => text.trim()).join('\n\n')
  }
  private admit(agent: Agent, selection: Selection): string | undefined {
    const tools = this.tools(agent)
    const schemas = [
      schemaOf(this.discoveryTool()), ...selection.tools.map(tool => schemaOf(this.requiredTool(tools, tool.name).definition)),
    ]
    const sdk = this.selfCtx.tools.renderSdk([DISCOVERY_NAME, ...selection.tools.map(tool => tool.name)], agent)
    const totals = {
      nativeBytes: bytes(JSON.stringify(schemas)), sdkBytes: bytes(sdk),
      instructionBytes: bytes(this.instructions(agent, selection)),
    }
    for (const field of ['nativeBytes', 'sdkBytes', 'instructionBytes'] as const) {
      if (totals[field] > this.config[field]) return `MCP proposal exceeds ${field} (${totals[field]} > ${this.config[field]}); release old selections or select fewer tools.`
    }
    return undefined
  }
  private requiredTool(tools: Map<string, ToolEntry>, name: string): ToolEntry {
    const entry = tools.get(name)
    /* v8 ignore next -- admission receives a synchronously validated selection from this registry */
    if (!entry) throw new Error(`MCP tool ${name} disappeared during admission`)
    return entry
  }
  private minimum(field: 'catalogBytes' | 'nativeBytes' | 'sdkBytes' | 'resultBytes', minimum: number): void {
    if (this.config[field] < minimum) throw new Error(`mcp-discovery: ${field} must fit the complete discovery entry (${minimum} UTF-8 bytes)`)
  }
  private assertTool(entry: ToolEntry, exec: ToolExecution): void {
    if (!exec.agent) return
    const selected = this.state(exec.agent).request?.tools.find(tool => tool.name === entry.definition.name)
    const source = this.servers(exec.agent).get(entry.server)
    if (!selected || !source || selected.identity !== toolIdentity(entry, source)) {
      throw new HarnessError(`MCP stale-definition for ${entry.definition.name}; discover and load it again before a new request.`, 'MCP_STALE_DEFINITION')
    }
    this.assertServer(entry.server, exec)
  }
  private async prepare(context: AssembleContext): Promise<void> {
    const agent = context.agent
    if (!agent) return
    this.owners.set(agent, agent)
    this.diagnostics.set(agent, [])
    let valid = this.valid(agent)
    if (valid.tools.length || valid.servers.length) {
      const refusal = this.admit(agent, valid)
      if (refusal) { valid = emptySelection(); this.diagnostic(agent, refusal) }
    }
    if (JSON.stringify(valid) !== JSON.stringify(this.state(agent).selection)) agent.session.append('mcp/selection', { ...valid, reason: 'invalidate' })
    const humans = context.stepInput?.messages.filter(message => message.source.kind === 'user') ?? []
    if (!humans.length || !this.servers(agent).size) return
    const text = humans.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    const names = [...text.matchAll(/(?<![\w])mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+(?![\w])/g)].map(match => match[0])
    const targets = [...text.matchAll(/(?<![\w])mcp:([a-zA-Z0-9_-]+)(?![\w])/g)].map(match => match[1] as string)
    if (names.length) {
      const result = this.load(agent, names, [], context.signal)
      if (!result.ok) this.diagnostic(agent, result.reason)
    }
    for (const server of targets) if (!this.servers(agent).has(server)) this.diagnostic(agent, `MCP server ${server} is unknown or unavailable in this scope.`)
    if (this.config.selector) {
      const operationController = new AbortController()
      // oxlint-disable-next-line prefer-const -- the teardown callback is installed before the operation starts
      let operation: Promise<unknown> | undefined
      const dispose = agent.ctx.effect(() => () => {
        operationController.abort(new Error('MCP selector Agent disposed'))
        return operation?.then(() => undefined, () => undefined)
      }, 'mcpDiscovery.selector')
      const signal = AbortSignal.any([this.lifetime.signal, operationController.signal, ...context.signal ? [context.signal] : []])
      const selecting = selectTools(
        this.selfCtx, this.config.selector, agent, text, this.catalog(agent), valid.tools.map(tool => tool.name), targets, signal,
      )
      operation = selecting
      this.pending.add(selecting)
      let selection
      try { selection = await selecting } finally { this.pending.delete(selecting); await dispose() }
      context.signal?.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      if (selection.status === 'selected') {
        const result = this.change(agent, [...new Set([...names, ...selection.names])], selection.servers, context.signal, true)
        if (!result.ok) this.diagnostic(agent, result.reason)
      }
    }
  }
  private diagnostic(agent: Agent, reason: string): void {
    (this.diagnostics.get(agent) as string[]).push(reason)
    agent.session.append('mcp/diagnostic', { reason })
  }
  private project(assembly: PromptAssembly, context: AssembleContext): PromptAssembly {
    const scope = context.scope
    const catalog = this.catalog(scope)
    const agent = context.agent
    const selection = agent ? this.valid(agent) : emptySelection()
    let catalogText = ''
    if (catalog.length) {
      this.minimum('sdkBytes', bytes(this.selfCtx.tools.renderSdk([DISCOVERY_NAME], scope)))
      catalogText = CATALOG_HEADER
      const humanText = context.stepInput?.messages.filter(message => message.source.kind === 'user').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n') ?? ''
      const targets = [...humanText.matchAll(/(?<![\w])mcp:([a-zA-Z0-9_-]+)(?![\w])/g)]
        .map(match => match[1] as string).filter(server => this.servers(scope).has(server))
      const notices = [...(targets.length ? [`Requested MCP servers: ${targets.join(', ')}`] : []), ...agent ? this.diagnostics.get(agent) as string[] : []]
      for (const notice of notices) {
        if (bytes(catalogText + '\n' + notice + '\n' + CATALOG_OPEN + CATALOG_CLOSE + PAGE_HINT) <= this.config.catalogBytes) {
          catalogText += '\n' + notice + '\n'
        }
      }
      catalogText += CATALOG_OPEN
      for (const item of catalog) {
        const row = JSON.stringify(item) + '\n'
        if (bytes(catalogText + row + CATALOG_CLOSE + PAGE_HINT) > this.config.catalogBytes) break
        catalogText += row
      }
      catalogText += CATALOG_CLOSE + PAGE_HINT
    }
    const instructions = scope ? this.instructions(scope, selection) : ''
    const mode = this.selfCtx.tools.modeFor(scope)
    const visibleSchemas = this.selfCtx.tools.schemas(scope)
      .filter(schema => this.selfCtx.tools.get(schema.name, scope)?.isPresented?.(scope) !== false)
    const mcpSchemas = visibleSchemas.filter(schema => (schema.name.startsWith('mcp__') || schema.name === DISCOVERY_NAME) && mode !== 'ptc')
    const schemas = [...assembly.tools.filter(schema => !schema.name.startsWith('mcp__') && schema.name !== DISCOVERY_NAME), ...mcpSchemas]
    const sdk = this.selfCtx.tools.renderSdk(visibleSchemas.map(schema => schema.name), scope)
    const sections = assembly.sections.map(section => section.name === 'mcp:discovery'
      ? { ...section, text: [catalogText, instructions].filter(Boolean).join('\n\n') }
      : section.name === 'tools:sdk' ? { ...section, text: sdk } : section)
    return { ...assembly, tools: schemas, sections }
  }
  private stage(assembly: PromptAssembly, context: AssembleContext): void {
    const agent = context.agent
    if (!agent || !context.stepInput) return
    if (!this.catalog(agent).length) {
      const previous = this.state(agent).request
      if (previous && (previous.schemas.length || previous.sdk || previous.instructions
        || previous.servers.length || previous.tools.length)) {
        this.staged.set(agent, {
          snapshot: {
            ...emptySelection(), turn: context.stepInput.turn, step: context.stepInput.step, schemas: [], sdk: '', instructions: '',
          },
          fullSdk: '', sdkMatches: true, instructions: new Map(),
        })
      } else this.staged.delete(agent)
      return
    }
    const selected = this.valid(agent)
    const mode = this.selfCtx.tools.modeFor(agent)
    const schemas = assembly.tools.filter(schema => schema.name.startsWith('mcp__') || schema.name === DISCOVERY_NAME)
    const fullSdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    const presented = this.selfCtx.tools.schemas(agent)
      .filter(schema => this.selfCtx.tools.get(schema.name, agent)?.isPresented?.(agent) !== false)
    const expectedSdk = this.selfCtx.tools.renderSdk(presented.map(schema => schema.name), agent)
    const sdkMatches = fullSdk === expectedSdk
    const tools = selected.tools.filter(tool => mode === 'ptc' ? sdkMatches : schemas.some(schema => schema.name === tool.name))
    const sdk = this.selfCtx.tools.renderSdk([DISCOVERY_NAME, ...tools.map(tool => tool.name)], agent)
    const instructions = this.instructions(agent, selected)
    const request: RequestSnapshot = structuredClone({
      ...selected, tools, turn: context.stepInput.turn, step: context.stepInput.step, schemas, sdk, instructions,
    })
    this.staged.set(agent, {
      snapshot: request, fullSdk, sdkMatches,
      instructions: new Map(selected.servers.map(item => [
        item.server, (this.servers(agent).get(item.server) as ServerSource).instructions(),
      ])),
    })
  }
  private registerDiscovery(scope?: ScopeKey): () => void | Promise<void> {
    const ctx = this.selfCtx
    return ctx.effect(function* (this: McpDiscovery) {
      let inner = ctx
      if (scope) { const owned = createScope(ctx, scope); yield owned.rawDispose; inner = owned.ctx }
      yield inner.tools.register(this.discoveryTool())
    }.bind(this), 'mcpDiscovery.discovery-tool')
  }
  private discoveryTool(): ToolDefinition {
    return defineTool({
      name: DISCOVERY_NAME,
      description: 'Search and load specific MCP tools, activate resource servers, or release loaded selections. Definitions and instructions enter the next request.',
      parameters: {
        action: { type: 'string', enum: ['search', 'load', 'release'], required: true },
        query: { type: 'string' }, server: { type: 'string' },
        names: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => Promise.resolve().then(() => {
        exec.signal.throwIfAborted()
        if (args.action === 'search') {
          const page = this.search(exec.agent, args)
          return { ...page, items: page.items.map(item => ({ ...item })) }
        }
        if (!exec.agent) throw new Error('MCP loading requires an Agent session.')
        const result = args.action === 'release'
          ? this.release(exec.agent, args.names, args.server ? [args.server] : [])
          : this.load(exec.agent, args.names ?? [], args.server ? [args.server] : [], exec.signal)
        if (bytes(JSON.stringify(result)) <= this.config.resultBytes) return result
        if (result.ok) return { ok: true, hint: 'Selection recorded; narrow search to inspect names.' }
        return { ok: false, reason: 'MCP proposal is unavailable; search visible connected capabilities before retrying.' }
      }),
    })
  }
}
export default McpDiscovery
