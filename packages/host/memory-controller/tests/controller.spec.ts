import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  MemoryError,
  MemoryRuntime,
  knowledgePageId,
  memoryBankId,
  memoryId,
} from '@deepseek-ai/dsh-memory'
import type {
  MemoryBrowseProvider,
  MemoryKnowledgePageBody,
  MemoryProvider,
} from '@deepseek-ai/dsh-memory'
import MemoryController from '../src/index.ts'

const contexts: Context[] = []
const bank = memoryBankId('coding-agent::demo')

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A scripted browse provider: every capability is a spy answering a fixed value. */
function browsableProvider(overrides: Partial<MemoryBrowseProvider> = {}): MemoryProvider {
  const browse: MemoryBrowseProvider = {
    id: 'scripted',
    listBanks: () => Promise.resolve([]),
    listUnits: () => Promise.resolve({ units: [], total: 0, limit: 20, offset: 0 }),
    remember: () => Promise.resolve({ remembered: true }),
    curateUnit: () => Promise.resolve({ curated: true }),
    ...overrides,
  }
  return {
    id: 'scripted',
    available: () => true,
    resolveBank: () => Promise.resolve(bank),
    search: () => Promise.resolve({ units: [], truncated: false }),
    recall: () => Promise.resolve({ units: [], truncated: false }),
    retain: () => Promise.resolve({ retained: true }),
    browse,
  }
}

/** Mount the controller over a seam carrying `providers`. */
async function harness(
  providers: readonly MemoryProvider[] = [browsableProvider()],
): Promise<{ ctx: Context; controller: MemoryController }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryRuntime)
  for (const provider of providers) ctx.memory.registerProvider(provider)
  await ctx.plugin(MemoryController)
  return { ctx, controller: ctx.get('memoryController') as MemoryController }
}

/** The agent-path-only provider: no browse surface at all. */
function agentOnlyProvider(): MemoryProvider {
  const provider = browsableProvider()
  const { browse: _browse, ...withoutBrowse } = provider
  return withoutBrowse
}

describe('MemoryController', () => {
  it('publishes its eight methods under the memoryController namespace', async () => {
    const { controller } = await harness()
    expect(controller.typertRemote).toMatchObject({
      serviceKey: 'memoryController',
      namespace: 'memoryController',
    })
    expect(remoteMethods(controller).map(entry => entry.method).sort()).toEqual(
      ['curate', 'list', 'page', 'pages', 'remember', 'search', 'stats', 'units'],
    )
  })

  it('answers list with the banks the surface reports', async () => {
    const banks = [{ bankId: bank, name: 'demo', factCount: 3 }]
    const { controller } = await harness([browsableProvider({ listBanks: () => Promise.resolve(banks) })])

    expect(await controller.list()).toEqual({ available: true, banks })
  })

  it('answers stats with the surface statistics', async () => {
    const stats = {
      bankId: bank, totalNodes: 2, totalLinks: 5, totalDocuments: 1,
      nodesByFactType: [], linksByLinkType: [], pendingOperations: 0, failedOperations: 0,
    }
    const { controller } = await harness([browsableProvider({ bankStats: () => Promise.resolve(stats) })])

    expect(await controller.stats('coding-agent::demo')).toEqual({ available: true, stats })
  })

  it('reports unsupported when the provider measures no statistics', async () => {
    const stats = {
      bankId: bank, totalNodes: 1, totalLinks: 0, totalDocuments: 0,
      nodesByFactType: [], linksByLinkType: [], pendingOperations: 0, failedOperations: 0,
    }
    const { controller: measuring } = await harness([browsableProvider({ bankStats: () => Promise.resolve(stats) })])
    const { controller: silent } = await harness([browsableProvider({})])

    await expect(measuring.stats('coding-agent::demo')).resolves.toEqual({ available: true, stats })
    await expect(silent.stats('coding-agent::demo')).resolves.toMatchObject({
      available: false, reason: 'unsupported',
    })
  })

  it('answers pages with the surface page list', async () => {
    const pages = [{ pageId: knowledgePageId('p-1'), name: 'One', stale: false }]
    const { controller } = await harness([browsableProvider({ listPages: () => Promise.resolve(pages) })])

    expect(await controller.pages('coding-agent::demo')).toEqual({ available: true, pages })
  })

  it('clamps the search limit into range and forwards the query', async () => {
    const searchPages = vi.fn(() => Promise.resolve({
      hits: [{ pageId: knowledgePageId('p-1'), name: 'One', snippet: 's' }],
      total: 4,
    }))
    const { controller } = await harness([browsableProvider({ searchPages })])

    expect(await controller.search('coding-agent::demo', 'web', 999)).toEqual({
      available: true,
      hits: [{ pageId: knowledgePageId('p-1'), name: 'One', snippet: 's' }],
      total: 4,
    })
    expect(searchPages).toHaveBeenCalledWith({ query: 'web', limit: 100 }, bank)
  })

  it('answers page with the body, or without one when the backend holds none', async () => {
    const pageBody = vi.fn((): Promise<MemoryKnowledgePageBody | undefined> =>
      Promise.resolve({ pageId: knowledgePageId('p-1'), name: 'One', body: '# One' }))
    const { controller } = await harness([browsableProvider({ pageBody })])
    expect(await controller.page('coding-agent::demo', 'p-1')).toEqual({
      available: true,
      page: { pageId: knowledgePageId('p-1'), name: 'One', body: '# One' },
    })

    pageBody.mockResolvedValue(undefined)
    expect(await controller.page('coding-agent::demo', 'gone')).toEqual({ available: true })
  })

  it('answers units with one page and drops empty filters', async () => {
    const listUnits = vi.fn(() => Promise.resolve({
      units: [{ id: memoryId('u-1'), text: 'a fact' }],
      total: 42, limit: 20, offset: 20,
    }))
    const { controller } = await harness([browsableProvider({ listUnits })])

    expect(await controller.units('coding-agent::demo', '', '', undefined, -5)).toEqual({
      available: true,
      units: [{ id: memoryId('u-1'), text: 'a fact' }],
      total: 42, limit: 20, offset: 20,
    })
    expect(listUnits).toHaveBeenCalledWith({ limit: 20, offset: 0 }, bank)
  })

  it('forwards the units filters and clamps the page size', async () => {
    const listUnits = vi.fn(() => Promise.resolve({ units: [], total: 0, limit: 100, offset: 0 }))
    const { controller } = await harness([browsableProvider({ listUnits })])

    await controller.units('coding-agent::demo', 'web', 'world', 999, 10)

    expect(listUnits).toHaveBeenCalledWith({ query: 'web', factType: 'world', limit: 100, offset: 10 }, bank)
  })

  it('answers remember with acceptance and the backend detail', async () => {
    const remember = vi.fn(() => Promise.resolve({ remembered: true, detail: 'op-7' }))
    const { controller } = await harness([browsableProvider({ remember })])

    expect(await controller.remember('coding-agent::demo', 'keep this', 'ctx')).toEqual({
      available: true, remembered: true, detail: 'op-7',
    })
    expect(remember).toHaveBeenCalledWith({ text: 'keep this', context: 'ctx' }, bank)
  })

  it('omits the context when a finding carries none', async () => {
    const remember = vi.fn(() => Promise.resolve({ remembered: true }))
    const { controller } = await harness([browsableProvider({ remember })])

    await controller.remember('coding-agent::demo', 'keep this', undefined)

    expect(remember).toHaveBeenCalledWith({ text: 'keep this' }, bank)
  })

  it('refuses an empty finding without calling the provider', async () => {
    const remember = vi.fn(() => Promise.resolve({ remembered: true }))
    const { controller } = await harness([browsableProvider({ remember })])

    expect(await controller.remember('coding-agent::demo', '   ', undefined)).toEqual({
      available: true, remembered: false, detail: 'a remembered finding needs text',
    })
    expect(remember).not.toHaveBeenCalled()
  })

  it('answers curate with acceptance and passes only the changed fields', async () => {
    const curateUnit = vi.fn(() => Promise.resolve({ curated: true }))
    const { controller } = await harness([browsableProvider({ curateUnit })])

    expect(await controller.curate('coding-agent::demo', 'u-1', 'new text', undefined, 'world')).toEqual({
      available: true, curated: true,
    })
    expect(curateUnit).toHaveBeenCalledWith({ text: 'new text', factType: 'world' }, bank, memoryId('u-1'))
  })

  it('refuses a curation that changes nothing, and one that empties the text', async () => {
    const curateUnit = vi.fn(() => Promise.resolve({ curated: true }))
    const { controller } = await harness([browsableProvider({ curateUnit })])

    expect(await controller.curate('coding-agent::demo', 'u-1', undefined, undefined, undefined)).toEqual({
      available: true, curated: false, detail: 'a curation must change at least one field',
    })
    expect(await controller.curate('coding-agent::demo', 'u-1', '  ', undefined, undefined)).toEqual({
      available: true, curated: false, detail: 'a curated memory needs text',
    })
    expect(curateUnit).not.toHaveBeenCalled()
  })

  it('passes a refused curation through with the backend detail', async () => {
    const { controller } = await harness([browsableProvider({
      curateUnit: () => Promise.resolve({ curated: false, detail: 'only world/experience facts can be curated' }),
    })])

    expect(await controller.curate('coding-agent::demo', 'u-1', 'x', undefined, undefined)).toEqual({
      available: true, curated: false, detail: 'only world/experience facts can be curated',
    })
  })
})

describe('MemoryController unavailability', () => {
  it('reports unavailable when no provider is registered', async () => {
    const { controller } = await harness([])

    expect(await controller.list()).toEqual({
      available: false, reason: 'unavailable', detail: 'no usable memory provider is registered',
    })
  })

  it('reports unsupported when the selected provider offers no browse surface', async () => {
    const { controller } = await harness([agentOnlyProvider()])

    expect(await controller.list()).toMatchObject({ available: false, reason: 'unsupported' })
  })

  it('reports unsupported when the provider omits an optional section', async () => {
    const provider = browsableProvider({})
    delete provider.browse?.listPages
    const { controller } = await harness([provider])

    expect(await controller.pages('coding-agent::demo')).toMatchObject({ available: false, reason: 'unsupported' })
  })

  it('reports unsupported when the provider curates no knowledge pages or search', async () => {
    const noSearch = browsableProvider({})
    delete noSearch.browse?.searchPages
    const noBody = browsableProvider({})
    delete noBody.browse?.pageBody
    const { controller: searching } = await harness([noSearch])
    const { controller: reading } = await harness([noBody])

    await expect(searching.search('coding-agent::demo', 'web', undefined)).resolves.toMatchObject({
      available: false, reason: 'unsupported',
    })
    await expect(reading.page('coding-agent::demo', 'p-1')).resolves.toMatchObject({
      available: false, reason: 'unsupported',
    })
  })

  it('forwards either units filter alone', async () => {
    const listUnits = vi.fn(() => Promise.resolve({ units: [], total: 0, limit: 20, offset: 0 }))
    const { controller } = await harness([browsableProvider({ listUnits })])

    await controller.units('coding-agent::demo', 'web', undefined, undefined, undefined)
    await controller.units('coding-agent::demo', undefined, 'world', undefined, undefined)

    expect(listUnits).toHaveBeenCalledWith({ query: 'web', limit: 20, offset: 0 }, bank)
    expect(listUnits).toHaveBeenCalledWith({ factType: 'world', limit: 20, offset: 0 }, bank)
  })

  it('curates with the context alone when the text stays', async () => {
    const curateUnit = vi.fn(() => Promise.resolve({ curated: true }))
    const { controller } = await harness([browsableProvider({ curateUnit })])

    await controller.curate('coding-agent::demo', 'u-1', undefined, 'renamed', undefined)

    expect(curateUnit).toHaveBeenCalledWith({ context: 'renamed' }, bank, memoryId('u-1'))
  })

  it('reports an unclassified non-Error throw with its string form', async () => {
    const { controller } = await harness([browsableProvider({
      listBanks: () => Promise.reject('daemon exploded'),
    })])

    expect(await controller.list()).toEqual({ available: false, reason: 'failed', detail: 'daemon exploded' })
  })

  it('reports a backend failure with the provider message', async () => {
    const { controller } = await harness([browsableProvider({
      listBanks: () => Promise.reject(new MemoryError('hindsight is unreachable', 'MEMORY_BACKEND_ERROR')),
    })])

    expect(await controller.list()).toEqual({
      available: false, reason: 'failed', detail: 'hindsight is unreachable',
    })
  })

  it('reports an unclassified throw as a failure with its message', async () => {
    const { controller } = await harness([browsableProvider({
      listBanks: () => Promise.reject(new Error('socket closed')),
    })])

    expect(await controller.list()).toEqual({ available: false, reason: 'failed', detail: 'socket closed' })
  })
})
