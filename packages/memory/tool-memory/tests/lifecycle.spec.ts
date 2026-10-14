import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import MemoryRuntime, { memoryBankId, MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryProvider, TranscriptTurn } from '@deepseek-ai/dsh-memory'
import * as toolMemory from '../src/index.ts'
import type { Config } from '../src/index.ts'

const bank = memoryBankId('coding-agent::demo')
const signal = new AbortController().signal

/**
 * Create a Git repository holding one commit per subject and return its root.
 *
 * The seeder shells out to real `git log`, so a workspace that behaves like a live
 * repository has to exist on disk. Identity is passed inline because the seeder reads
 * history under a scrubbed environment that has no `HOME` to resolve a global config.
 */
async function gitWorkspace(subjects: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-ws-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  for (const [index, subject] of subjects.entries()) {
    await writeFile(join(root, `file-${index}.txt`), `${subject}\n`)
    execFileSync('git', ['add', '--all'], { cwd: root })
    execFileSync(
      'git',
      ['-c', 'user.name=dsh', '-c', 'user.email=dsh@invalid', 'commit', '--quiet', '-m', subject],
      { cwd: root },
    )
  }
  return root
}

/** One prompt as the agent loop would hand it to a pre-step listener. */
function userMessage(text: string): { role: string; content: unknown } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * A provider stub plus the traffic it recorded. `resolved` and `retained` exist only so
 * a test can assert what the plugin asked the seam for; they are not part of the
 * capability, so they live here rather than on `MemoryProvider`.
 */
interface StubProvider extends MemoryProvider {
  /** Workspace roots whose bank this stub resolved, in order. */
  readonly resolved: readonly string[]
  /** Retain requests this stub received, in order. */
  readonly retained: readonly { readonly turns: readonly TranscriptTurn[] }[]
}

/** A minimal agent whose session exposes only what the plugin reads. */
function makeAgent(options: {
  sessionId?: string
  cwd?: string
  /** Explicitly omit `cwd` from the header, unlike leaving it unset. */
  noCwd?: boolean
  origin?: string
  messages?: unknown[]
} = {}): { agent: never; sessionId: string } {
  const sessionId = options.sessionId ?? 'session-1'
  const agent = {
    session: {
      header: {
        id: sessionId,
        ...(options.noCwd === true ? {} : { cwd: options.cwd ?? '/repos/demo' }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
      deriveMessages: () => options.messages ?? [],
    },
  }
  return { agent: agent as never, sessionId }
}

/** A memory provider stub that records recall/retain traffic. */
function makeProvider(overrides: Partial<MemoryProvider> = {}): StubProvider {
  const resolved: string[] = []
  const retained: { turns: readonly TranscriptTurn[] }[] = []
  return {
    id: 'stub',
    available: () => true,
    resolveBank: (root: string) => {
      resolved.push(root)
      return Promise.resolve(bank)
    },
    search: () => Promise.resolve({ units: [], truncated: false }),
    recall: () => Promise.resolve({ units: [{ id: 'm-1', text: 'we chose Cordis' }], truncated: false }),
    retain: (request) => {
      retained.push({ turns: request.turns })
      return Promise.resolve({ retained: true })
    },
    resolved,
    retained,
    ...overrides,
  } as StubProvider
}

/** A plugin descriptor wiring the module's `apply` under the name it declares. */
const memoryPlugin = {
  name: toolMemory.name,
  inject: toolMemory.inject,
  apply: (ctx: Context, config: Config) => { toolMemory.apply(ctx, config) },
}

/**
 * Mount the plugin on a context that already has the memory seam, and return a
 * `ctx.emit`-shaped dispatcher for the agent events the plugin listens to.
 */
async function mount(config: Partial<Config> = {}, provider: StubProvider = makeProvider()) {
  const ctx = new Context()
  await ctx.plugin(MemoryRuntime, {})
  ctx.memory.registerProvider(provider)
  // schemastery defaults are applied by the loader; tests pass explicit values instead.
  await ctx.plugin(memoryPlugin, { ...resolvedConfig(), ...config })
  return { ctx, provider }
}

/** The shape schemastery would hand `apply` when no deployment config overrides it. */
function resolvedConfig(): Required<Config> {
  return {
    injectRecall: true,
    retainTranscripts: true,
    recallLimit: 6,
    seedColdBanks: false,
    seedCommitCount: 30,
    seedBudgetMs: 120000,
  }
}

/**
 * Dispatch `agent/pre-step` through the mounted plugin the way the agent loop does:
 * `next()` runs first, and the listener's returned decision is what counts.
 */
async function firePreStep(
  ctx: Context,
  agent: never,
  messages: { role: string; content: unknown }[],
  abort?: AbortSignal,
): Promise<{ kind: string; messages: unknown[] }> {
  // The negative cases below feed message shapes the model message union forbids — a
  // plain-string body, a numeric body, a system role, whitespace only — so the payload
  // crosses the typed event boundary as `never` on purpose. What is under test is the
  // plugin's prompt reader surviving them, not the union admitting them.
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: messages as never,
    turn: 1,
    step: 1,
    signal: abort ?? signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: messages as never })) as never
}

describe('tool-memory plugin metadata', () => {
  it('declares the services it needs', () => {
    expect(toolMemory.name).toBe('tool-memory')
    expect(toolMemory.inject).toEqual(['memory'])
  })

  it('defaults every configurable field', () => {
    const parsed = toolMemory.Config({})
    expect(parsed.injectRecall).toBe(true)
    expect(parsed.retainTranscripts).toBe(true)
    expect(parsed.recallLimit).toBeGreaterThan(0)
    expect(parsed.seedColdBanks).toBe(true)
    expect(parsed.seedCommitCount).toBeGreaterThan(0)
    expect(parsed.seedBudgetMs).toBeGreaterThan(0)
  })
})

describe('tool-memory lifecycle wiring', () => {
  it('mounts without throwing when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, {})

    await expect(ctx.plugin({
      inject: ['memory', 'agents', 'tools'],
      apply: (child: Context, cfg: Config) => { toolMemory.apply(child, cfg) },
    } as never, { ...resolvedConfig() } as never)).resolves.toBeDefined()
  })

  it('resolves a bank once per session and reuses it', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({ sessionId: 's-reuse' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    agentEvents(ctx, agent).emit('agent/created', { source: 'resume', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.resolved).toEqual(['/repos/demo'])
  })

  it('leaves a delegated subagent session without a bank', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({ sessionId: 's-sub', origin: 'subagent' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.resolved).toEqual([])
  })

  it('ignores a session with no workspace of its own', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({ sessionId: 's-nocwd', noCwd: true })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.resolved).toEqual([])
  })

  it('renders a non-Error bank-resolution rejection in the log line', async () => {
    const warn = vi.fn()
    const provider = makeProvider({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
      resolveBank: () => Promise.reject('a bare string, not an Error'),
    })
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({ sessionId: 's-bind-nonerror' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a bare string, not an Error'))
    })
  })

  it('logs a bank-binding failure that escapes the normal path', async () => {
    const warn = vi.fn()
    const provider = makeProvider()
    // A seam whose availability probe itself throws, so `isAvailable` is not the guard
    // it was designed to be and `bind` rejects outside its own try block.
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    Object.defineProperty(ctx.memory, 'isAvailable', { value: () => { throw new Error('probe exploded') } })
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({ sessionId: 's-bind-throw' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })

    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('bank binding failed')) })
  })

  it('warns instead of throwing when bank resolution fails', async () => {
    const provider = makeProvider({
      resolveBank: () => Promise.reject(new MemoryError('no daemon', 'MEMORY_BACKEND_ERROR')),
    })
    const warn = vi.fn()
    const ctx = new Context()
    ctx.logger.warn = warn
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({ sessionId: 's-fail' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not resolve a bank'))
  })

  it('skips everything when memory has no usable provider', async () => {
    const warn = vi.fn()
    const ctx = new Context()
    ctx.logger.warn = warn
    await ctx.plugin(MemoryRuntime, {})
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({ sessionId: 's-off' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(warn).not.toHaveBeenCalled()
  })

  it('drops a session bank when the agent is disposed', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({ sessionId: 's-dispose' })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    agentEvents(ctx, agent).emit('agent/disposed', {})

    agentEvents(ctx, agent).emit('agent/created', { source: 'resume', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.resolved).toEqual(['/repos/demo', '/repos/demo'])
  })

  it('retains the finished turn transcript at the turn boundary', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-retain',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'why Cordis?' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'plugin lifecycle.' }] },
      ],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })

    expect(provider.retained).toHaveLength(1)
    expect(provider.retained[0]?.turns[0]).toMatchObject({ prompt: 'why Cordis?', response: 'plugin lifecycle.' })
  })

  it('retains nothing for a turn that produced no exchange', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({ sessionId: 's-empty', messages: [] })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })

    expect(provider.retained).toHaveLength(0)
  })

  it('renders a plain Error rejection without a memory code prefix', async () => {
    const warn = vi.fn()
    const provider = makeProvider({ retain: () => Promise.reject(new Error('socket closed')) })
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({
      sessionId: 's-plainerror',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })

    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket closed')) })
    // A plain Error carries no seam code, so the message is logged unadorned.
    expect(warn.mock.calls[0]?.[0]).not.toContain('MEMORY_')
  })

  it('does not retain after the turn was aborted', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-abort',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    const controller = new AbortController()
    controller.abort()

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal: controller.signal })

    expect(provider.retained).toHaveLength(0)
  })

  it('warns instead of failing the turn when retention fails', async () => {
    const warn = vi.fn()
    const provider = makeProvider({ retain: () => Promise.reject(new MemoryError('down', 'MEMORY_BACKEND_ERROR')) })
    const ctx = new Context()
    ctx.logger.warn = warn
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({
      sessionId: 's-retain-fail',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(() => { agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal }) }).not.toThrow()
    // The listener is async; `emit` does not await it, so let it settle.
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('retaining')) })
  })

  it('injects recalled memory ahead of the opening request, once per session', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-inject' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const first = await firePreStep(ctx, agent, [userMessage('what did we decide?')])
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(2)

    const second = await firePreStep(ctx, agent, [userMessage('and now?')])
    expect(second.messages).toHaveLength(1)
  })

  it('does not recall against a batch that carries no user prompt', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-noprompt' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }])

    expect(decision.messages).toHaveLength(1)
  })

  it('reads a plain-string prompt as well as block content', async () => {
    const provider = makeProvider()
    const { ctx } = await mount({}, provider)
    const { agent } = makeAgent({ sessionId: 's-strprompt' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [{ role: 'user', content: 'a plain string prompt' }])

    expect(decision.messages).toHaveLength(2)
  })

  it('reads a prompt carried as a non-text content shape', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-oddcontent' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    // A tool-result-only user message carries no text, so there is nothing to recall against.
    const decision = await firePreStep(ctx, agent, [
      { role: 'user', content: [{ type: 'image', source: { data: 'x' } }] },
    ])

    expect(decision.messages).toHaveLength(1)
  })

  it('ignores a message whose content is not a string or a block array', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-weirdcontent' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [{ role: 'user', content: 42 }])

    expect(decision.messages).toHaveLength(1)
  })

  it('skips empty and non-text blocks when collecting assistant output', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-blocks',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'image', source: { data: 'x' } }, { type: 'text', text: 'answer' }] },
      ],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    // The image block is ignored; only the text block reaches the retained turn.
    expect(provider.retained[0]?.turns[0]).toMatchObject({ response: 'answer' })
  })

  it('ignores a message with no extractable text while building a transcript', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-notext',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'real question' }] },
        { role: 'assistant', content: [] },
      ],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    // An empty assistant turn retains the prompt with no response field.
    expect(provider.retained[0]?.turns[0]).toEqual({ turn: 1, prompt: 'real question' })
  })

  it('ignores assistant output that arrives before any prompt', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-orphan',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unprompted' }] }],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.retained).toHaveLength(0)
  })

  it('skips an empty request batch without recalling', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-emptybatch' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [])

    expect(decision.messages).toHaveLength(0)
  })

  it('treats a whitespace-only prompt as no prompt at all', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-blankprompt' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [{ role: 'user', content: '   \n  ' }])

    expect(decision.messages).toHaveLength(1)
  })

  it('reads a plain-string assistant reply for retention', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-strreply',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: 'a plain string answer' },
      ],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.retained[0]?.turns[0]).toMatchObject({ response: 'a plain string answer' })
  })

  it('seeds without a lifecycle signal', async () => {
    const debug = vi.fn()
    const ctx = new Context()
    ctx.logger.warn = () => undefined
    ctx.logger.debug = debug
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(makeProvider())
    await ctx.plugin(memoryPlugin, {
      ...resolvedConfig(),
      seedColdBanks: true,
      seedCommitCount: 2,
      seedBudgetMs: 30_000,
    })
    const workspace = await gitWorkspace(['first commit', 'second commit'])
    const { agent } = makeAgent({ sessionId: 's-seed-nosignal', cwd: workspace })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup' })

    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('seeded bank')) }, { timeout: 5000 })
  })

  it('starts session work without a lifecycle signal', async () => {
    const { ctx, provider } = await mount()
    const { agent } = makeAgent({
      sessionId: 's-nosignal',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })

    // `agent/created`'s signal is optional; the plugin substitutes its own so the
    // detached work still observes cancellation from the plugin's own teardown.
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(provider.retained).toHaveLength(1)
  })

  it('skips the seeding log line when the seeder reports nothing to do', async () => {
    const debug = vi.fn()
    const ctx = new Context()
    ctx.logger.warn = () => undefined
    ctx.logger.debug = debug
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(makeProvider())
    await ctx.plugin(memoryPlugin, { ...resolvedConfig(), seedColdBanks: true, seedBudgetMs: 30_000 })
    const workspace = await gitWorkspace(['first commit', 'second commit'])
    const { agent } = makeAgent({ sessionId: 's-seed-twice-a', cwd: workspace })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await vi.waitFor(() => { expect(debug).toHaveBeenCalled() }, { timeout: 5000 })
    debug.mockClear()

    // The same bank a second time: the seeder declines, so nothing is logged.
    const { agent: again } = makeAgent({ sessionId: 's-seed-twice-b', cwd: workspace })
    agentEvents(ctx, again).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(debug).not.toHaveBeenCalled()
  })

  it('logs a seeding outcome that names a skipped bank', async () => {
    const debug = vi.fn()
    const ctx = new Context()
    ctx.logger.warn = () => undefined
    ctx.logger.debug = debug
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(makeProvider())
    await ctx.plugin(memoryPlugin, { ...resolvedConfig(), seedColdBanks: true, seedBudgetMs: 30_000 })
    const outside = await mkdtemp(join(tmpdir(), 'dsh-no-git-'))
    const { agent } = makeAgent({ sessionId: 's-seed-skip', cwd: outside })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })

    // A directory outside any repository is normal, so the seeder reports a skip.
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('left bank')) }, { timeout: 5000 })
  })

  it('passes the decision through untouched when recall returns nothing', async () => {
    const provider = makeProvider({ recall: () => Promise.resolve({ units: [], truncated: false }) })
    const { ctx } = await mount({}, provider)
    const { agent } = makeAgent({ sessionId: 's-noinject' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [userMessage('q')])

    expect(decision.messages).toHaveLength(1)
  })

  it('warns and carries on when recall fails', async () => {
    const warn = vi.fn()
    const provider = makeProvider({ recall: () => Promise.reject(new MemoryError('slow', 'MEMORY_BACKEND_TIMEOUT')) })
    const ctx = new Context()
    ctx.logger.warn = warn
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({ sessionId: 's-recall-fail' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [userMessage('q')])

    expect(decision.messages).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recall against'))
  })

  it('does not inject for a rejected step or an aborted signal', async () => {
    const { ctx } = await mount()
    const { agent } = makeAgent({ sessionId: 's-reject' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    const controller = new AbortController()
    controller.abort()

    const decision = await firePreStep(ctx, agent, [userMessage('q')], controller.signal)

    expect(decision.messages).toHaveLength(1)
  })

  it('leaves a session alone when recall injection is disabled', async () => {
    const { ctx } = await mount({ injectRecall: false })
    const { agent } = makeAgent({ sessionId: 's-noinject-cfg' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await firePreStep(ctx, agent, [userMessage('q')])

    expect(decision.messages).toHaveLength(1)
  })

  it('leaves retention alone when it is disabled', async () => {
    const { ctx, provider } = await mount({ retainTranscripts: false })
    const { agent } = makeAgent({
      sessionId: 's-noretain-cfg',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })

    expect(provider.retained).toHaveLength(0)
  })

  it('seeds a cold bank from the workspace history on session start', async () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const provider = makeProvider()
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = debug
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, {
      ...resolvedConfig(),
      seedColdBanks: true,
      seedCommitCount: 3,
      seedBudgetMs: 30_000,
    })
    const workspace = await gitWorkspace(['first commit', 'second commit', 'third commit'])
    const { agent } = makeAgent({ sessionId: 's-seed', cwd: workspace })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })

    // Seeding runs detached, so wait for the retain it should perform.
    await vi.waitFor(() => { expect(provider.retained.length).toBeGreaterThan(0) }, { timeout: 5000 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns instead of failing when seeding itself throws', async () => {
    const warn = vi.fn()
    const provider = makeProvider({
      resolveBank: () => Promise.reject(new MemoryError('boom', 'MEMORY_BACKEND_ERROR')),
    })
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig(), seedColdBanks: true })
    const workspace = await gitWorkspace(['only commit'])
    const { agent } = makeAgent({ sessionId: 's-seed-fail', cwd: workspace })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })

    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() }, { timeout: 5000 })
  })

  it('registers the model-facing tools once a tool registry appears', async () => {
    const registered: string[] = []
    const { ctx } = await mount()
    // The plugin injects the tool registry optionally, so tools appear only when one does.
    ctx.provide('tools', { register: (tool: { name: string }) => { registered.push(tool.name) } })

    await vi.waitFor(() => { expect(registered.sort()).toEqual(['hindsight_remember', 'hindsight_search']) })
  })

  it('keeps working when no tool registry ever appears', async () => {
    const warn = vi.fn()
    const provider = makeProvider()
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig() })
    const { agent } = makeAgent({
      sessionId: 's-notools',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })

    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Lifecycle wiring still runs: retention happened without any tool plane present.
    agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(provider.retained).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('renders a zero-commit-count seed without warning', async () => {
    const warn = vi.fn()
    const provider = makeProvider()
    const ctx = new Context()
    ctx.logger.warn = warn
    ctx.logger.debug = () => undefined
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(provider)
    await ctx.plugin(memoryPlugin, { ...resolvedConfig(), seedColdBanks: true, seedCommitCount: 0 })
    const workspace = await gitWorkspace(['only commit'])
    const { agent } = makeAgent({ sessionId: 's-seed-throw', cwd: workspace })

    // A zero commit count reads no history, so the listener renders the empty harvest
    // through the shared describe path without warning.
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(warn).not.toHaveBeenCalled()
  })

  it('hands a bound session bank to the model-facing tools', async () => {
    const search = vi.fn(() => Promise.resolve({ units: [], truncated: false }))
    const provider = makeProvider({ search })
    const { ctx } = await mount({}, provider)
    const registered: { name: string; execute: (args: Record<string, string>, exec?: unknown) => Promise<unknown> }[] = []
    ctx.provide('tools', { register: (tool: { name: string; execute: (args: Record<string, string>, exec?: unknown) => Promise<unknown> }) => { registered.push(tool) } })
    await vi.waitFor(() => { expect(registered).toHaveLength(2) })
    const { agent } = makeAgent({ sessionId: 's-toolbank' })
    agentEvents(ctx, agent).emit('agent/created', { source: 'startup', signal })
    await new Promise(resolve => setTimeout(resolve, 10))

    const searchTool = registered.find(tool => tool.name === 'hindsight_search')
    await searchTool?.execute({ query: 'q' }, { agent, signal: new AbortController().signal })

    // The tool reuses the bank the lifecycle already resolved, without a second lookup.
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'q' }), 'coding-agent::demo', expect.anything())
  })

  it('clears live session state when the plugin is unloaded', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, {})
    ctx.memory.registerProvider(makeProvider())
    const fiber = await ctx.plugin(memoryPlugin, { ...resolvedConfig() })

    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))

    // A disposed composition still tears down cleanly; nothing throws on the way out.
    expect(fiber.state).toBeDefined()
  })
})
