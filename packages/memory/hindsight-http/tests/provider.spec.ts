import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { MemoryError, knowledgePageId, memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'
import { HindsightMemoryProvider, HINDSIGHT_PROVIDER_ID } from '../src/provider.ts'
import type { HindsightProviderLimits } from '../src/provider.ts'
import * as plugin from '../src/index.ts'

const bank = memoryBankId('coding-agent::demo')

/** One recorded request, for assertions on path/method/body. */
interface Recorded {
  path: string
  method: string
  body: unknown
}

describe('HindsightMemoryProvider over a scripted daemon', () => {
  let server: Server
  let baseUrl: string
  let recorded: Recorded[]
  let handler: (req: IncomingMessage, res: ServerResponse) => void

  beforeEach(async () => {
    recorded = []
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => raw += chunk)
      req.on('end', () => {
        let body: unknown
        try {
          body = raw.length === 0 ? undefined : JSON.parse(raw)
        } catch {
          body = raw
        }
        recorded.push({ path: req.url ?? '', method: req.method ?? '', body })
        handler(req, res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.restoreAllMocks()
  })

  function makeProvider(overrides: Partial<HindsightProviderLimits> = {}): HindsightMemoryProvider {
    return new HindsightMemoryProvider({
      baseUrl,
      defaultBankSuffix: 'main',
      metadataTimeoutMs: 2000,
      probeTtlMs: 60000,
      recallTimeoutMs: 2000,
      retainTimeoutMs: 2000,
      maxRetainChars: 200000,
      ...overrides,
    })
  }

  function reply(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  it('exposes hindsight as its registry id', () => {
    expect(makeProvider().id).toBe(HINDSIGHT_PROVIDER_ID)
  })

  it('reports available after a healthy probe and memoizes the result', async () => {
    handler = (_req, res) => reply(res, 200, { status: 'healthy' })
    const provider = makeProvider()

    expect(provider.available()).toBe(true)
    await vi.waitFor(() => expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(1))

    // Within the freshness window the answer is reused, so no second probe follows.
    expect(provider.available()).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(1)
  })

  it('reports unavailable once a probe fails', async () => {
    handler = (_req, res) => reply(res, 500, { error: 'down' })
    const provider = makeProvider()

    provider.available()
    await vi.waitFor(() => expect(provider.available()).toBe(false))
  })

  it('re-probes once the freshness window has elapsed, so a restarted daemon is noticed', async () => {
    handler = (_req, res) => reply(res, 200, { status: 'healthy' })
    // A zero window means every call past the first re-probes.
    const provider = makeProvider({ probeTtlMs: 1 })

    provider.available()
    await vi.waitFor(() => expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 5))

    provider.available()
    await vi.waitFor(() => expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(2))
  })

  it('answers optimistically while the very first probe is still in flight', async () => {
    handler = () => { /* never answers */ }
    const provider = makeProvider({ metadataTimeoutMs: 60 })

    // Nothing has been learned yet, so the answer is optimistic rather than false: a cold
    // daemon must not read as "memory disabled" on the first turn.
    expect(provider.available()).toBe(true)
    await vi.waitFor(() => expect(provider.available()).toBe(false), { timeout: 2000 })
  })

  it('reuses an in-flight probe rather than starting a second one', async () => {
    handler = (_req, res) => reply(res, 200, { status: 'healthy' })
    const provider = makeProvider()

    provider.available()
    provider.available()
    provider.available()

    await vi.waitFor(() => expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(1))
    expect(provider.available()).toBe(true)
    expect(recorded.filter(entry => entry.path === '/health')).toHaveLength(1)
  })

  it('returns an existing bank without creating it', async () => {
    handler = (req, res) => {
      if (req.url === '/v1/default/banks') {
        reply(res, 200, { banks: [{ bank_id: bank }, { bank_id: 'coding-agent::other' }] })
        return
      }
      reply(res, 200, {})
    }

    await expect(makeProvider().resolveBank('/repos/demo')).resolves.toBe(bank)
    expect(recorded.map(entry => `${entry.method} ${entry.path}`)).toEqual(['GET /v1/default/banks'])
  })

  it('creates a bank that does not exist yet', async () => {
    handler = (req, res) => {
      if (req.url === '/v1/default/banks') {
        reply(res, 200, { banks: [] })
        return
      }
      reply(res, 200, {})
    }

    await expect(makeProvider().resolveBank('/repos/demo')).resolves.toBe(bank)

    const created = recorded.find(entry => entry.method === 'PUT')
    expect(created?.path).toBe(`/v1/default/banks/${encodeURIComponent(bank)}`)
    expect(created?.body).toEqual({ name: bank })
  })

  it('accepts a bare array bank listing as well as an envelope', async () => {
    handler = (req, res) => {
      if (req.url === '/v1/default/banks') {
        reply(res, 200, [{ bank_id: bank }])
        return
      }
      reply(res, 200, {})
    }

    await expect(makeProvider().resolveBank('/repos/demo')).resolves.toBe(bank)
  })

  it('creates a bank when the listing is not an object at all', async () => {
    handler = (req, res) => {
      if (req.url === '/v1/default/banks') {
        reply(res, 200, 'null')
        return
      }
      reply(res, 200, {})
    }

    await expect(makeProvider().resolveBank('/repos/demo')).resolves.toBe(bank)
    expect(recorded.some(entry => entry.method === 'PUT')).toBe(true)
  })

  it('creates a bank when the listing envelope has no usable banks array', async () => {
    handler = (req, res) => {
      if (req.url === '/v1/default/banks') {
        reply(res, 200, { banks: 'not-an-array' })
        return
      }
      reply(res, 200, {})
    }

    await expect(makeProvider().resolveBank('/repos/demo')).resolves.toBe(bank)
    expect(recorded.some(entry => entry.method === 'PUT')).toBe(true)
  })

  it('classifies a non-Error transport rejection as a backend error', async () => {
    // A hostile or stubbed fetch can reject with anything, including a bare value.
    vi.stubGlobal('fetch', () => Promise.reject('just a string'))
    try {
      await expect(makeProvider().recall({ prompt: 'p' }, bank)).rejects.toThrow(
        expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('encodes the bank id into request paths', async () => {
    handler = (_req, res) => reply(res, 200, { results: [] })

    await makeProvider().search({ query: 'q' }, bank)

    expect(recorded[0]?.path).toBe(`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`)
  })

  it('sends the query and limit on search', async () => {
    handler = (_req, res) => reply(res, 200, { results: [] })

    await makeProvider().search({ query: '审批流程', limit: 5 }, bank)

    expect(recorded[0]?.body).toEqual({ query: '审批流程', limit: 5 })
  })

  it('defaults the search limit when the request omits one', async () => {
    handler = (_req, res) => reply(res, 200, { results: [] })

    await makeProvider().search({ query: 'q' }, bank)

    expect(recorded[0]?.body).toEqual({ query: 'q', limit: 8 })
  })

  it('projects recall rows onto memory units', async () => {
    handler = (_req, res) => reply(res, 200, {
      results: [
        { id: 'm-1', text: 'first' },
        { id: 'm-2', text: 'second' },
      ],
    })

    const result = await makeProvider().recall({ prompt: 'p', limit: 2 }, bank)

    expect(result.units).toEqual([
      { id: memoryId('m-1'), text: 'first' },
      { id: memoryId('m-2'), text: 'second' },
    ])
  })

  it('skips malformed recall rows instead of failing the whole call', async () => {
    handler = (_req, res) => reply(res, 200, {
      results: [{ id: 'ok', text: 'good' }, { id: 'no-text' }, { text: 'no-id' }, null, 42],
    })

    const result = await makeProvider().recall({ prompt: 'p' }, bank)

    expect(result.units).toEqual([{ id: memoryId('ok'), text: 'good' }])
  })

  it('returns no units for a response without a results array', async () => {
    handler = (_req, res) => reply(res, 200, { unexpected: true })

    await expect(makeProvider().recall({ prompt: 'p' }, bank)).resolves.toEqual({ units: [], truncated: false })
  })

  it('sends one retain item per transcript turn', async () => {
    handler = (_req, res) => reply(res, 200, { success: true, operation_id: 'op-1' })

    const result = await makeProvider().retain({
      turns: [
        { turn: 0, prompt: 'first question', response: 'first answer' },
        { turn: 1, prompt: 'second question' },
      ],
    }, bank)

    expect(recorded[0]?.body).toEqual({
      async: true,
      items: [
        { content: 'User asked: first question\nAssistant replied: first answer' },
        { content: 'User asked: second question' },
      ],
    })
    expect(result).toEqual({ retained: true, detail: 'op-1' })
  })

  it('stops adding retain items once the character budget is spent', async () => {
    handler = (_req, res) => reply(res, 200, { success: true })

    await makeProvider({ maxRetainChars: 50 }).retain({
      turns: [
        { turn: 0, prompt: 'a'.repeat(30) },
        { turn: 1, prompt: 'b'.repeat(30) },
        { turn: 2, prompt: 'c'.repeat(30) },
      ],
    }, bank)

    const body = recorded[0]?.body as { items: { content: string }[] }
    expect(body.items).toHaveLength(1)
  })

  it('short-circuits retention of an empty transcript without a request', async () => {
    const provider = makeProvider()

    await expect(provider.retain({ turns: [] }, bank)).resolves.toEqual({ retained: false, detail: 'empty transcript' })
    expect(recorded).toHaveLength(0)
  })

  it('reports retention as refused when the backend answers success: false', async () => {
    handler = (_req, res) => reply(res, 200, { success: false })

    await expect(makeProvider().retain({ turns: [{ turn: 0, prompt: 'q' }] }, bank)).resolves.toMatchObject({ retained: false })
  })

  it('classifies a 404 as a missing bank', async () => {
    handler = (_req, res) => reply(res, 404, { error: 'no such bank' })

    await expect(makeProvider().recall({ prompt: 'p' }, bank)).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BANK_NOT_FOUND' }),
    )
  })

  it('classifies a non-2xx answer as a backend error and quotes the status', async () => {
    handler = (_req, res) => reply(res, 503, 'service unavailable')

    await expect(makeProvider().recall({ prompt: 'p' }, bank)).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
    )
  })

  it('classifies a non-JSON body as a backend error', async () => {
    handler = (_req, res) => reply(res, 200, 'not json at all')

    await expect(makeProvider().recall({ prompt: 'p' }, bank)).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
    )
  })

  it('treats an empty body as an empty result', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.end('')
    }

    await expect(makeProvider().recall({ prompt: 'p' }, bank)).resolves.toEqual({ units: [], truncated: false })
  })

  it('classifies an exceeded timeout as a backend timeout', async () => {
    handler = () => { /* never answers */ }
    const provider = makeProvider({ recallTimeoutMs: 60 })

    await expect(provider.recall({ prompt: 'p' }, bank)).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BACKEND_TIMEOUT' }),
    )
  })

  it('propagates a caller abort instead of waiting for the timeout', async () => {
    handler = () => { /* never answers */ }
    const controller = new AbortController()
    const pending = makeProvider({ recallTimeoutMs: 5000 }).recall({ prompt: 'p' }, bank, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(MemoryError)
  })

  it('reports an unreachable daemon as a backend error', async () => {
    // Port 1 is reserved and refuses connections.
    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:1' })

    await expect(provider.recall({ prompt: 'p' }, bank)).rejects.toThrow(
      expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
    )
  })

  it('falls back to the configured suffix when a path has no usable leaf', async () => {
    handler = (_req, res) => reply(res, 200, { banks: [] })
    const provider = makeProvider({ defaultBankSuffix: 'fallback' })

    await expect(provider.resolveBank('')).resolves.toBe(memoryBankId('coding-agent::fallback'))
  })

  describe('HindsightMemoryProvider browse surface', () => {
    it('exposes itself as the browse surface', () => {
      const provider = makeProvider()
      expect(provider.browse).toBe(provider)
    })

    it('projects the bank listing with counts and last write', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          banks: [
            { bank_id: 'coding-agent::demo', name: 'demo', fact_count: 42, last_write_at: '2026-10-01T00:00:00Z' },
            { bank_id: 'coding-agent::bare' },
            { name: 'no id at all' },
          ],
        })
      }

      await expect(makeProvider().listBanks()).resolves.toEqual([
        { bankId: memoryBankId('coding-agent::demo'), name: 'demo', factCount: 42, lastWriteAt: '2026-10-01T00:00:00Z' },
        { bankId: memoryBankId('coding-agent::bare'), name: 'coding-agent::bare', factCount: 0 },
      ])
      expect(recorded[0]?.path).toBe('/v1/default/banks')
    })

    it('sends pagination, the substring filter, and the fact type on a units listing', async () => {
      handler = (_req, res) => { reply(res, 200, { items: [], total: 0, limit: 20, offset: 40 }) }

      await makeProvider().listUnits({ query: 'web', factType: 'world', limit: 20, offset: 40 }, bank)

      expect(recorded[0]?.path).toBe(
        '/v1/default/banks/coding-agent%3A%3Ademo/memories/list?limit=20&offset=40&q=web&type=world',
      )
    })

    it('omits absent filters from a units listing', async () => {
      handler = (_req, res) => { reply(res, 200, { items: [], total: 0, limit: 20, offset: 0 }) }

      await makeProvider().listUnits({}, bank)

      expect(recorded[0]?.path).toBe('/v1/default/banks/coding-agent%3A%3Ademo/memories/list')
    })

    it('projects a units page with its totals and optional fields', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          items: [
            {
              id: 'u-1', text: 'a fact', fact_type: 'world', context: 'chat', state: 'valid',
              tags: ['source:upload'], mentioned_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
            },
            { id: 'u-2', text: 'bare' },
          ],
          total: 7, limit: 2, offset: 0,
        })
      }

      await expect(makeProvider().listUnits({ limit: 2 }, bank)).resolves.toEqual({
        units: [
          {
            id: memoryId('u-1'), text: 'a fact', factType: 'world', context: 'chat', state: 'valid',
            tags: ['source:upload'], mentionedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
          },
          { id: memoryId('u-2'), text: 'bare' },
        ],
        total: 7, limit: 2, offset: 0,
      })
    })

    it('skips malformed unit rows instead of failing the listing', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          items: [{ id: 'ok', text: 'good' }, { id: 'no-text' }, { text: 'no-id' }, null, 42],
          total: 5, limit: 5, offset: 0,
        })
      }

      const page = await makeProvider().listUnits({}, bank)

      expect(page.units).toEqual([{ id: memoryId('ok'), text: 'good' }])
      expect(page.total).toBe(5)
    })

    it('reads the single-unit endpoints\' type spelling as the fact type', async () => {
      handler = (_req, res) => { reply(res, 200, { id: 'u-1', text: 'curated', type: 'experience' }) }

      await expect(makeProvider().curateUnit({ context: 'ctx' }, bank, memoryId('u-1'))).resolves.toEqual({ curated: true })
    })

    it('sends the finding as one async retain item and reports the operation id', async () => {
      handler = (_req, res) => { reply(res, 200, { success: true, items_count: 1, operation_id: 'op-9' }) }

      await expect(makeProvider().remember({ text: 'keep this', context: 'probe' }, bank)).resolves.toEqual({
        remembered: true, detail: 'op-9',
      })
      expect(recorded[0]).toMatchObject({
        path: '/v1/default/banks/coding-agent%3A%3Ademo/memories',
        method: 'POST',
        body: { items: [{ content: 'keep this', context: 'probe' }], async: true },
      })
    })

    it('omits the context field when a finding carries none', async () => {
      handler = (_req, res) => { reply(res, 200, { success: true, operation_id: 'op-9' }) }

      await makeProvider().remember({ text: 'keep this' }, bank)

      expect(recorded[0]?.body).toEqual({ items: [{ content: 'keep this' }], async: true })
    })

    it('reports a refused write as not remembered', async () => {
      handler = (_req, res) => { reply(res, 200, { success: false }) }

      await expect(makeProvider().remember({ text: 'keep this' }, bank)).resolves.toEqual({ remembered: false })
    })

    it('sends a curation as snake_case fields on PATCH', async () => {
      handler = (_req, res) => { reply(res, 200, { id: 'u-1', text: 'curated', type: 'world' }) }

      await makeProvider().curateUnit({ text: 'curated', context: 'ctx', factType: 'world' }, bank, memoryId('u-1'))

      expect(recorded[0]).toMatchObject({
        path: '/v1/default/banks/coding-agent%3A%3Ademo/memories/u-1',
        method: 'PATCH',
        body: { text: 'curated', context: 'ctx', fact_type: 'world' },
      })
    })

    it('passes a refused curation through with the backend\'s own detail', async () => {
      handler = (_req, res) => { reply(res, 200, { detail: 'only world/experience facts can be curated' }) }

      await expect(makeProvider().curateUnit({ text: 'x' }, bank, memoryId('u-1'))).resolves.toEqual({
        curated: false, detail: 'only world/experience facts can be curated',
      })
    })

    it('refuses a curation that changes nothing, without a request', async () => {
      await expect(makeProvider().curateUnit({}, bank, memoryId('u-1'))).rejects.toThrow(
        expect.objectContaining({ code: 'MEMORY_BACKEND_ERROR' }),
      )
      expect(recorded).toHaveLength(0)
    })

    it('projects bank statistics with distributions ranked largest first', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          total_nodes: 522, total_links: 9963, total_documents: 16,
          nodes_by_fact_type: { observation: 192, experience: 202, world: 128 },
          links_by_link_type: { semantic: 4460, temporal: 4925 },
          pending_operations: 2, failed_operations: 1,
        })
      }

      await expect(makeProvider().bankStats(bank)).resolves.toEqual({
        bankId: bank,
        totalNodes: 522, totalLinks: 9963, totalDocuments: 16,
        nodesByFactType: [
          { label: 'experience', count: 202 },
          { label: 'observation', count: 192 },
          { label: 'world', count: 128 },
        ],
        linksByLinkType: [
          { label: 'temporal', count: 4925 },
          { label: 'semantic', count: 4460 },
        ],
        pendingOperations: 2, failedOperations: 1,
      })
    })

    it('flattens the knowledge-page tree depth-first and skips id-less nodes', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          roots: [
            {
              id: 'p-1', name: 'One', timestamp: '2026-10-01T00:00:00Z', is_stale: true,
              children: [{ id: 'p-1-1', name: 'Child' }],
            },
            { name: 'no id', children: [{ id: 'p-2', name: 'Two' }] },
          ],
        })
      }

      await expect(makeProvider().listPages(bank)).resolves.toEqual([
        { pageId: knowledgePageId('p-1'), name: 'One', stale: true, updatedAt: '2026-10-01T00:00:00Z' },
        { pageId: knowledgePageId('p-1-1'), name: 'Child', stale: false },
        { pageId: knowledgePageId('p-2'), name: 'Two', stale: false },
      ])
    })

    it('searches the knowledge index with the query and limit', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          results: [{ id: 'p-1', name: 'One', snippet: 'matched', score: 0.5 }, { id: 'no-snippet', name: 'X' }],
          total: 9,
        })
      }

      await expect(makeProvider().searchPages({ query: 'web', limit: 5 }, bank)).resolves.toEqual({
        hits: [{ pageId: knowledgePageId('p-1'), name: 'One', snippet: 'matched', score: 0.5 }],
        total: 9,
      })
      expect(recorded[0]?.path).toBe(
        '/v1/default/banks/coding-agent%3A%3Ademo/knowledge-base/search?q=web&limit=5',
      )
    })

    it('reports at least the hit count when the backend names no total', async () => {
      handler = (_req, res) => { reply(res, 200, { results: [{ id: 'p-1', name: 'One', snippet: 's' }] }) }

      const result = await makeProvider().searchPages({ query: 'web' }, bank)

      expect(result.total).toBe(1)
      expect(recorded[0]?.path).toBe('/v1/default/banks/coding-agent%3A%3Ademo/knowledge-base/search?q=web')
    })

    it('accepts a bare array bank listing as well as an envelope', async () => {
      handler = (_req, res) => {
        reply(res, 200, [
          { bank_id: 'coding-agent::demo', name: 'demo', fact_count: 1 },
        ])
      }

      await expect(makeProvider().listBanks()).resolves.toEqual([
        { bankId: memoryBankId('coding-agent::demo'), name: 'demo', factCount: 1 },
      ])
    })

    it('orders equal-count distribution entries by label', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          total_nodes: 2,
          nodes_by_fact_type: { world: 1, observation: 1 },
        })
      }

      const stats = await makeProvider().bankStats(bank)

      expect(stats.nodesByFactType.map(entry => entry.label)).toEqual(['observation', 'world'])
    })

    it('keeps a page node\'s description when the backend reports one', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          roots: [{
            id: 'p-1', name: 'One', description: 'what it covers',
            timestamp: '2026-10-01T00:00:00Z',
          }],
        })
      }

      await expect(makeProvider().listPages(bank)).resolves.toEqual([
        {
          pageId: knowledgePageId('p-1'), name: 'One', stale: false,
          description: 'what it covers', updatedAt: '2026-10-01T00:00:00Z',
        },
      ])
    })

    it('falls back to the id for a search hit without a name', async () => {
      handler = (_req, res) => {
        reply(res, 200, { results: [{ id: 'p-1', snippet: 's' }], total: 1 })
      }

      await expect(makeProvider().searchPages({ query: 'web' }, bank)).resolves.toEqual({
        hits: [{ pageId: knowledgePageId('p-1'), name: 'p-1', snippet: 's' }],
        total: 1,
      })
    })

    it('falls back to the id for a page body without a name', async () => {
      handler = (_req, res) => { reply(res, 200, { id: 'p-1', body: '# One' }) }

      await expect(makeProvider().pageBody(bank, knowledgePageId('p-1'))).resolves.toEqual({
        pageId: knowledgePageId('p-1'), name: 'p-1', body: '# One',
      })
    })

    it('skips a search hit without an id', async () => {
      handler = (_req, res) => {
        reply(res, 200, {
          results: [{ name: 'no id', snippet: 's' }, { id: 'p-1', name: 'One', snippet: 't' }],
          total: 2,
        })
      }

      const result = await makeProvider().searchPages({ query: 'web' }, bank)

      expect(result.hits.map(hit => hit.pageId)).toEqual([knowledgePageId('p-1')])
      expect(result.total).toBe(2)
    })

    it('reads a units listing without an items array as an empty page', async () => {
      handler = (_req, res) => { reply(res, 200, { total: 3, limit: 20, offset: 0 }) }

      await expect(makeProvider().listUnits({}, bank)).resolves.toEqual({
        units: [], total: 3, limit: 20, offset: 0,
      })
    })

    it('reads a statistics body that is not an object as zeroed totals', async () => {
    // A valid JSON body that is not an object: the daemon answered, oddly.
      handler = (_req, res) => { reply(res, 200, '42') }

      await expect(makeProvider().bankStats(bank)).resolves.toEqual({
        bankId: bank,
        totalNodes: 0, totalLinks: 0, totalDocuments: 0,
        nodesByFactType: [], linksByLinkType: [], pendingOperations: 0, failedOperations: 0,
      })
    })

    it('reads a distribution the backend did not report as empty rather than failing', async () => {
      handler = (_req, res) => { reply(res, 200, { total_nodes: 1, nodes_by_fact_type: 'nope' }) }

      const stats = await makeProvider().bankStats(bank)

      expect(stats.totalNodes).toBe(1)
      expect(stats.nodesByFactType).toEqual([])
    })

    it('reads a knowledge tree without a roots array as no pages', async () => {
      handler = (_req, res) => { reply(res, 200, {}) }

      await expect(makeProvider().listPages(bank)).resolves.toEqual([])
    })

    it('falls back to the id for a page node without a name', async () => {
      handler = (_req, res) => { reply(res, 200, { roots: [{ id: 'p-1' }] }) }

      await expect(makeProvider().listPages(bank)).resolves.toEqual([
        { pageId: knowledgePageId('p-1'), name: 'p-1', stale: false },
      ])
    })

    it('reads a search without a results array as no hits', async () => {
      handler = (_req, res) => { reply(res, 200, { total: 4 }) }

      await expect(makeProvider().searchPages({ query: 'web' }, bank)).resolves.toEqual({ hits: [], total: 4 })
    })

    it('reports a curation refusal that carries no detail as an empty one', async () => {
      handler = (_req, res) => { reply(res, 200, { success: true }) }

      await expect(makeProvider().curateUnit({ text: 'x' }, bank, memoryId('u-1'))).resolves.toEqual({
        curated: false, detail: '',
      })
    })

    it('reads a knowledge page body, or undefined when the backend holds none', async () => {
      handler = (_req, res) => { reply(res, 200, { id: 'p-1', name: 'One', body: '# One' }) }
      await expect(makeProvider().pageBody(bank, knowledgePageId('p-1'))).resolves.toEqual({
        pageId: knowledgePageId('p-1'), name: 'One', body: '# One',
      })

      handler = (_req, res) => { reply(res, 200, {}) }
      await expect(makeProvider().pageBody(bank, knowledgePageId('gone'))).resolves.toBeUndefined()
    })
  })
})

describe('memory-hindsight-http plugin', () => {
  const config = {
    baseUrl: 'http://127.0.0.1:9077/',
    defaultBankSuffix: 'main',
    metadataTimeoutMs: 1000,
    probeTtlMs: 1000,
    recallTimeoutMs: 1000,
    retainTimeoutMs: 1000,
    maxRetainChars: 1000,
  }

  it('declares its plugin metadata', () => {
    expect(plugin.name).toBe('memory-hindsight-http')
    expect(plugin.inject).toEqual(['memory'])
  })

  it('defaults every configurable field', () => {
    const parsed = plugin.Config({})
    expect(parsed.baseUrl).toBe(plugin.DEFAULT_HINDSIGHT_BASE_URL)
    expect(parsed.defaultBankSuffix).toBe(plugin.DEFAULT_BANK_SUFFIX)
    expect(parsed.metadataTimeoutMs).toBeGreaterThan(0)
    expect(parsed.recallTimeoutMs).toBeGreaterThan(0)
    expect(parsed.retainTimeoutMs).toBeGreaterThan(0)
    expect(parsed.maxRetainChars).toBeGreaterThan(0)
  })

  it('registers a provider whose id is hindsight, stripping a trailing slash', async () => {
    const registered: string[] = []
    const ctx = { memory: { registerProvider: (p: { id: string }) => { registered.push(p.id) } } } as never

    plugin.apply(ctx, config)

    expect(registered).toEqual([HINDSIGHT_PROVIDER_ID])
  })

  it.each([
    ['metadataTimeoutMs', { ...config, metadataTimeoutMs: 0 }],
    ['recallTimeoutMs', { ...config, recallTimeoutMs: Number.NaN }],
    ['retainTimeoutMs', { ...config, retainTimeoutMs: -1 }],
    ['maxRetainChars', { ...config, maxRetainChars: Number.POSITIVE_INFINITY }],
  ])('rejects a non-positive %s at configuration time', (_field, bad) => {
    const ctx = { memory: { registerProvider: () => undefined } } as never

    expect(() => plugin.apply(ctx, bad)).toThrow(/must be a positive finite number/)
  })
})
