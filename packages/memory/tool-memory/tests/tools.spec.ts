import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'
import type { MemoryProvider } from '@deepseek-ai/dsh-memory'
import { applyMemoryTools } from '../src/tools.ts'
import type { BankResolver } from '../src/tools.ts'

const bank = memoryBankId('coding-agent::demo')
const signal = new AbortController().signal

/** A registered tool, captured so its schema and execution can be driven directly. */
interface Captured {
  name: string
  description: string
  /** Compiled JSON Schema: `{ type: 'object', properties, required: string[] }`. */
  parameters: {
    type: string
    properties?: Record<string, { type: string; description?: string }>
    required?: readonly string[]
  }
  execute: (args: Record<string, string>, exec?: unknown) => Promise<unknown>
  output?: {
    render?: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
  }
}

/** Mount the tools against a scripted memory seam and return the registered tools. */
async function mountTools(
  provider: MemoryProvider,
  resolveBank: BankResolver = () => bank,
): Promise<{ ctx: Context; tools: Map<string, Captured>; provider: MemoryProvider }> {
  const ctx = new Context()
  await ctx.plugin(MemoryRuntime, {})
  ctx.memory.registerProvider(provider)
  const tools = new Map<string, Captured>()
  // The tools read the memory seam off their own context, so the stub must carry it —
  // registering them against a bare registry object would not exercise the real path.
  const toolsCtx = {
    memory: ctx.memory,
    tools: {
      register: (tool: Captured) => { tools.set(tool.name, tool) },
    },
  } as unknown as Context
  applyMemoryTools(toolsCtx, resolveBank)
  return { ctx, tools, provider }
}

/** A provider stub with the given search/retain behaviour. */
function makeProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    id: 'stub',
    available: () => true,
    resolveBank: () => Promise.resolve(bank),
    search: () => Promise.resolve({ units: [], truncated: false }),
    recall: () => Promise.resolve({ units: [], truncated: false }),
    retain: () => Promise.resolve({ retained: true }),
    ...overrides,
  }
}

/** An agent stub carrying only what the tool reads. */
function agentStub(options: { cwd?: string; origin?: string; sessionId?: string } = {}): unknown {
  return {
    session: {
      header: {
        id: options.sessionId ?? 's-tools',
        cwd: options.cwd ?? '/repos/demo',
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
    },
  }
}

describe('memory tools registration', () => {
  it('registers hindsight_search and hindsight_remember', async () => {
    const { tools } = await mountTools(makeProvider())

    expect([...tools.keys()].sort()).toEqual(['hindsight_remember', 'hindsight_search'])
  })

  it('describes search as a lookup and remember as an explicit act', async () => {
    const { tools } = await mountTools(makeProvider())

    expect(tools.get('hindsight_search')?.description).toContain('may be stale')
    expect(tools.get('hindsight_search')?.description).toContain('earlier decisions')
    expect(tools.get('hindsight_remember')?.description).toContain('rationale')
    expect(tools.get('hindsight_remember')?.description).toContain('captured automatically')
  })

  it('compiles each tool to a JSON Schema whose primary parameter is required', async () => {
    const { tools } = await mountTools(makeProvider())
    const search = tools.get('hindsight_search')
    const remember = tools.get('hindsight_remember')

    expect(search?.parameters.type).toBe('object')
    expect(search?.parameters.required).toEqual(['query'])
    expect(search?.parameters.properties?.query?.type).toBe('string')
    expect(remember?.parameters.required).toEqual(['content'])
  })

  it('carries a timeout and concurrency-safety flag on the tool surface', async () => {
    const { tools } = await mountTools(makeProvider())
    const surface = tools.get('hindsight_search') as unknown as {
      timeoutMs?: number
      isConcurrencySafe?: (args: unknown) => boolean
    }

    expect(surface.timeoutMs).toBeGreaterThan(0)
    // Recall can be slow, but two lookups at once are safe. The predicate receives the
    // validated arguments, so it is called with them here.
    expect(surface.isConcurrencySafe?.({ query: 'q' })).toBe(true)
  })
})

describe('hindsight_search', () => {
  it('returns the units the seam found', async () => {
    const provider = makeProvider({
      search: () => Promise.resolve({
        units: [{ id: memoryId('m-1'), text: 'we chose Cordis for plugins' }],
        truncated: false,
      }),
    })
    const { tools } = await mountTools(provider)

    const result = await tools.get('hindsight_search')?.execute({ query: 'q' }, { agent: agentStub(), signal })

    expect(result).toEqual({
      memories: [{ id: 'm-1', text: 'we chose Cordis for plugins' }],
      truncated: false,
    })
  })

  it('forwards the query and a bounded limit to the seam', async () => {
    const search = vi.fn(() => Promise.resolve({ units: [], truncated: false }))
    const { tools } = await mountTools(makeProvider({ search }))

    await tools.get('hindsight_search')?.execute({ query: '审批流程' }, { agent: agentStub(), signal })

    expect(search).toHaveBeenCalledWith({ query: '审批流程', limit: 12 }, bank, signal)
  })

  it('renders a no-match result as prose rather than an empty payload', async () => {
    const { tools } = await mountTools(makeProvider())
    const tool = tools.get('hindsight_search')

    const value = await tool?.execute({ query: 'q' }, { agent: agentStub(), signal })
    const rendered = tool?.output?.render?.({}, value)

    expect(rendered?.[0]?.text).toBe('No matching long-term memory for this workspace.')
  })

  it('renders found memories as a numbered list', async () => {
    const provider = makeProvider({
      search: () => Promise.resolve({
        units: [
          { id: memoryId('m-1'), text: 'first\n  memory' },
          { id: memoryId('m-2'), text: 'second memory' },
        ],
        truncated: false,
      }),
    })
    const { tools } = await mountTools(provider)
    const tool = tools.get('hindsight_search')

    const value = await tool?.execute({ query: 'q' }, { agent: agentStub(), signal })
    const rendered = tool?.output?.render?.({}, value)

    expect(rendered?.[0]?.text).toContain('1. first memory')
    expect(rendered?.[0]?.text).toContain('2. second memory')
  })

  it('says so when the seam truncated the result', async () => {
    const provider = makeProvider({
      search: () => Promise.resolve({ units: [{ id: memoryId('m-1'), text: 'only' }], truncated: true }),
    })
    const { tools } = await mountTools(provider)
    const tool = tools.get('hindsight_search')

    const value = await tool?.execute({ query: 'q' }, { agent: agentStub(), signal })

    expect(tool?.output?.render?.({}, value)?.[0]?.text).toContain('results truncated')
  })

  it('returns nothing rather than failing when the session has no bank yet', async () => {
    const search = vi.fn()
    const { tools } = await mountTools(makeProvider({ search }), () => undefined)

    const result = await tools.get('hindsight_search')?.execute({ query: 'q' }, { agent: agentStub(), signal })

    expect(result).toEqual({ memories: [], truncated: false })
    expect(search).not.toHaveBeenCalled()
  })

  it('declines for a delegated subagent so it never reads the parent bank', async () => {
    const search = vi.fn()
    const { tools } = await mountTools(makeProvider({ search }))

    const result = await tools.get('hindsight_search')?.execute(
      { query: 'q' },
      { agent: agentStub({ origin: 'subagent' }), signal },
    )

    expect(result).toEqual({ memories: [], truncated: false })
    expect(search).not.toHaveBeenCalled()
  })

  it('declines for a call with no agent at all', async () => {
    const search = vi.fn()
    const { tools } = await mountTools(makeProvider({ search }))

    await expect(tools.get('hindsight_search')?.execute({ query: 'q' }, { signal })).resolves.toEqual({
      memories: [],
      truncated: false,
    })
    expect(search).not.toHaveBeenCalled()
  })

  it('declines when the session has no workspace of its own', async () => {
    const search = vi.fn()
    const { tools } = await mountTools(makeProvider({ search }))
    const agent = { session: { header: { id: 's', cwd: undefined } } }

    await tools.get('hindsight_search')?.execute({ query: 'q' }, { agent, signal })

    expect(search).not.toHaveBeenCalled()
  })

  it('declines when memory has no usable provider', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, {})
    const tools = new Map<string, Captured>()
    applyMemoryTools(
      { memory: ctx.memory, tools: { register: (t: Captured) => { tools.set(t.name, t) } } } as unknown as Context,
      () => bank,
    )

    // No provider registered: the seam reports unavailable, so the tool declines.
    const result = await tools.get('hindsight_search')?.execute({ query: 'q' }, { agent: agentStub(), signal })

    expect(result).toEqual({ memories: [], truncated: false })
  })
})

describe('hindsight_remember', () => {
  it('retains the finding and reports success', async () => {
    const retain = vi.fn(() => Promise.resolve({ retained: true, detail: 'op-1' }))
    const { tools } = await mountTools(makeProvider({ retain }))

    const result = await tools.get('hindsight_remember')?.execute(
      { content: 'we chose Cordis because plugins need lifecycle hooks' },
      { agent: agentStub(), signal },
    )

    expect(retain).toHaveBeenCalledWith(
      {
        turns: [{
          turn: 0,
          prompt: 'we chose Cordis because plugins need lifecycle hooks',
          response: 'Recorded as a durable finding.',
        }],
      },
      bank,
      signal,
    )
    expect(result).toEqual({ remembered: true, detail: 'op-1' })
  })

  it('reports refusal with the backend detail', async () => {
    const { tools } = await mountTools(makeProvider({
      retain: () => Promise.resolve({ retained: false, detail: 'quota exceeded' }),
    }))

    const result = await tools.get('hindsight_remember')?.execute({ content: 'x' }, { agent: agentStub(), signal })

    expect(result).toEqual({ remembered: false, detail: 'quota exceeded' })
  })

  it('renders success and refusal differently for the model', async () => {
    const { tools } = await mountTools(makeProvider())
    const tool = tools.get('hindsight_remember')

    expect(tool?.output?.render?.({}, { remembered: true, detail: '' })?.[0]?.text).toBe('Recorded in long-term memory.')
    expect(tool?.output?.render?.({}, { remembered: false, detail: 'quota' })?.[0]?.text).toBe('Not recorded: quota')
  })

  it('reports an empty detail when the backend names no operation', async () => {
    const { tools } = await mountTools(makeProvider({ retain: () => Promise.resolve({ retained: true }) }))

    const result = await tools.get('hindsight_remember')?.execute({ content: 'x' }, { agent: agentStub(), signal })

    expect(result).toEqual({ remembered: true, detail: '' })
  })

  it('declines without a bank instead of writing somewhere unintended', async () => {
    const retain = vi.fn()
    const { tools } = await mountTools(makeProvider({ retain }), () => undefined)

    const result = await tools.get('hindsight_remember')?.execute({ content: 'x' }, { agent: agentStub(), signal })

    expect(result).toEqual({ remembered: false, detail: 'no memory bank for this workspace' })
    expect(retain).not.toHaveBeenCalled()
  })

  it('declines for a delegated subagent', async () => {
    const retain = vi.fn()
    const { tools } = await mountTools(makeProvider({ retain }))

    const result = await tools.get('hindsight_remember')?.execute(
      { content: 'x' },
      { agent: agentStub({ origin: 'subagent' }), signal },
    )

    expect(result).toMatchObject({ remembered: false })
    expect(retain).not.toHaveBeenCalled()
  })
})
