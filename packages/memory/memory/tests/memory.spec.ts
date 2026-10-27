import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// Imported from source (not the package name) so the coverage gate instruments this
// package's own runtime rather than its built lib output.
import MemoryRuntime, {
  knowledgePageId,
  MemoryError,
  memoryBankId,
  memoryId,
} from '../src/index.ts'
import type {
  MemoryBankId,
  MemoryBrowseProvider,
  MemoryProvider,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetainRequest,
  MemoryRetainResult,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryUnit,
} from '../src/index.ts'

const available = true
const unavailable = false

/** A scripted provider: every capability returns a caller-supplied result. */
function makeProvider(
  id: string,
  isAvailable: boolean,
  overrides: Partial<MemoryProvider> = {},
): MemoryProvider {
  const resolve = (units: readonly MemoryUnit[]): MemorySearchResult & MemoryRecallResult => ({ units, truncated: false })
  return {
    id,
    available: () => isAvailable,
    resolveBank: () => Promise.resolve(memoryBankId('bank-from-' + id)),
    search: (_request: MemorySearchRequest) => Promise.resolve(resolve([])),
    recall: (_request: MemoryRecallRequest) => Promise.resolve(resolve([])),
    retain: (_request: MemoryRetainRequest) => Promise.resolve<MemoryRetainResult>({ retained: true }),
    ...overrides,
  }
}

function unit(text: string): MemoryUnit {
  return { id: memoryId(`id-${text}`), text }
}

async function mountMemory(config: ConstructorParameters<typeof MemoryRuntime>[1] = {}): Promise<{ ctx: Context; memory: MemoryRuntime }> {
  const ctx = new Context()
  await ctx.plugin(MemoryRuntime, config)
  return { ctx, memory: ctx.memory }
}

describe('MemoryRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { memory } = await mountMemory()
    const dispose = memory.registerProvider(makeProvider('p1', available))

    await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-p1'))

    dispose()
    // The disposer is fire-and-forget; the effect settles on the microtask queue.
    await Promise.resolve()
    await expect(memory.search({ query: 'q' }, memoryBankId('b'))).rejects.toThrow(MemoryError)
  })

  it('rejects a duplicate provider id', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('dup', available))

    expect(() => memory.registerProvider(makeProvider('dup', available))).toThrow(
      expect.objectContaining({ code: 'MEMORY_DUPLICATE_PROVIDER' }),
    )
  })

  it('unregisters with the calling fiber when it is disposed', async () => {
    const { ctx, memory } = await mountMemory()
    const fiber = ctx.plugin({
      inject: ['memory'],
      apply: (child: Context) => {
        child.memory.registerProvider(makeProvider('scoped', available))
      },
    })
    await fiber

    await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-scoped'))

    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(memory.search({ query: 'q' }, memoryBankId('b'))).rejects.toThrow(MemoryError)
  })
})

describe('MemoryRuntime provider selection', () => {
  it('auto-selects the only registered usable provider', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('only', available))
    await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-only'))
  })

  it('reports unavailable when no provider is registered', () => {
    return expect(mountMemory().then(({ memory }) => memory.isAvailable())).resolves.toBe(false)
  })

  it('ignores an unavailable provider during auto-selection', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('down', unavailable))
    memory.registerProvider(makeProvider('up', available))

    await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-up'))
  })

  it('rejects ambiguity when several usable providers are registered without a configured id', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('a', available))
    memory.registerProvider(makeProvider('b', available))

    await expect(memory.search({ query: 'q' }, memoryBankId('bank'))).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_PROVIDER_AMBIGUOUS' }),
    )
  })

  it('selects the configured provider when several are registered', async () => {
    const { memory } = await mountMemory({ provider: 'picked' })
    memory.registerProvider(makeProvider('other', available))
    memory.registerProvider(makeProvider('picked', available))

    await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-picked'))
  })

  it('raises a distinct error when the configured provider is not registered', async () => {
    const { memory } = await mountMemory({ provider: 'absent' })

    await expect(memory.search({ query: 'q' }, memoryBankId('bank'))).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_PROVIDER_CONFIGURED_MISSING' }),
    )
  })

  it('raises unavailable when the configured provider itself reports unavailable', async () => {
    const { memory } = await mountMemory({ provider: 'down' })
    memory.registerProvider(makeProvider('down', unavailable))

    await expect(memory.search({ query: 'q' }, memoryBankId('bank'))).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('falls back to $DSH_MEMORY_PROVIDER when no provider id is configured', async () => {
    process.env.DSH_MEMORY_PROVIDER = 'from-env'
    try {
      const { memory } = await mountMemory()
      memory.registerProvider(makeProvider('from-env', available))
      memory.registerProvider(makeProvider('other', available))

      await expect(memory.resolveBank('/repo')).resolves.toBe(memoryBankId('bank-from-from-env'))
    } finally {
      delete process.env.DSH_MEMORY_PROVIDER
    }
  })
})

describe('MemoryRuntime limit enforcement', () => {
  it('truncates an over-returning search result and flags it', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('over', available, {
      search: () => Promise.resolve({ units: [unit('a'), unit('b'), unit('c')], truncated: false }),
    }))

    const result = await memory.search({ query: 'q', limit: 2 }, memoryBankId('b'))

    expect(result.units.map(each => each.text)).toEqual(['a', 'b'])
    expect(result.truncated).toBe(true)
  })

  it('truncates an over-returning recall result and flags it', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('over', available, {
      recall: () => Promise.resolve({ units: [unit('a'), unit('b')], truncated: false }),
    }))

    const result = await memory.recall({ prompt: 'p', limit: 1 }, memoryBankId('b'))

    expect(result.units).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('leaves a result untouched when it already fits the limit', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('fits', available, {
      search: () => Promise.resolve({ units: [unit('a')], truncated: false }),
    }))

    await expect(memory.search({ query: 'q', limit: 5 }, memoryBankId('b'))).resolves.toMatchObject({ truncated: false })
  })

  it('leaves a result untouched when no limit was requested', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('nolimit', available, {
      search: () => Promise.resolve({ units: [unit('a'), unit('b')], truncated: false }),
    }))

    const result = await memory.search({ query: 'q' }, memoryBankId('b'))

    expect(result.units).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('MemoryRuntime delegation', () => {
  it('forwards the search request and cancellation signal to the provider', async () => {
    // `signal` mirrors the provider's optional parameter, so the recorder must admit
    // `undefined`; `exactOptionalPropertyTypes` rejects a bare optional field.
    const seen: { request?: MemorySearchRequest; signal?: AbortSignal | undefined } = {}
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('spy', available, {
      search: (request, _bank, signal) => {
        seen.request = request
        seen.signal = signal
        return Promise.resolve({ units: [], truncated: false })
      },
    }))
    const controller = new AbortController()

    await memory.search({ query: 'q', limit: 3 }, memoryBankId('b'), controller.signal)

    expect(seen.request).toEqual({ query: 'q', limit: 3 })
    expect(seen.signal).toBe(controller.signal)
  })

  it('returns the backend retention outcome verbatim', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('keep', available, {
      retain: () => Promise.resolve({ retained: false, detail: 'quota' }),
    }))

    await expect(memory.retain({ turns: [] }, memoryBankId('b'))).resolves.toEqual({ retained: false, detail: 'quota' })
  })

  it('propagates a provider failure rather than swallowing it', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('boom', available, {
      recall: () => Promise.reject(new MemoryError('backend gone', 'MEMORY_BACKEND_ERROR')),
    }))

    await expect(memory.recall({ prompt: 'p' }, memoryBankId('b'))).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
    )
  })
})

describe('MemoryRuntime browse surface', () => {
  /** A minimal browse surface; the tests only assert resolution, not behaviour. */
  function browseSurface(id: string): MemoryBrowseProvider {
    return {
      id,
      listBanks: () => Promise.resolve([]),
      listUnits: () => Promise.resolve({ units: [], total: 0, limit: 0, offset: 0 }),
      remember: () => Promise.resolve({ remembered: true }),
      curateUnit: () => Promise.resolve({ curated: true }),
    }
  }

  it('resolves the selected provider\'s browse surface', async () => {
    const { memory } = await mountMemory()
    const surface = browseSurface('browsable')
    memory.registerProvider(makeProvider('browsable', available, { browse: surface }))

    expect(memory.browse()).toBe(surface)
  })

  it('refuses when the selected provider offers no browse surface', async () => {
    const { memory } = await mountMemory()
    memory.registerProvider(makeProvider('agent-only', available))

    expect(() => memory.browse()).toThrow(
      expect.objectContaining({ code: 'MEMORY_CAPABILITY_UNSUPPORTED' }),
    )
  })

  it('reports selection failures through browse as through the agent path', async () => {
    const { memory } = await mountMemory()

    await expect(Promise.resolve().then(() => memory.browse())).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('honours the configured provider when several are registered', async () => {
    const { memory } = await mountMemory({ provider: 'picked' })
    const surface = browseSurface('picked')
    memory.registerProvider(makeProvider('other', available, { browse: browseSurface('other') }))
    memory.registerProvider(makeProvider('picked', available, { browse: surface }))

    expect(memory.browse()).toBe(surface)
  })
})

describe('memory identifier brands', () => {
  it('produce plain strings that survive a round trip', () => {
    const bank: MemoryBankId = memoryBankId('coding-agent::repo')
    expect(bank).toBe('coding-agent::repo')
    expect(memoryId('m-1')).toBe('m-1')
    expect(knowledgePageId('p-1')).toBe('p-1')
  })
})

describe('MemoryError', () => {
  it('carries a name and a stable code', () => {
    const error = new MemoryError('nope', 'MEMORY_BANK_NOT_FOUND')
    expect(error.name).toBe('MemoryError')
    expect(error.code).toBe('MEMORY_BANK_NOT_FOUND')
    expect(error.message).toBe('nope')
  })
})
