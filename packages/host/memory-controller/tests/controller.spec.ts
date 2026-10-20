import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryError, MemoryRuntime } from '@deepseek-ai/dsh-memory'
import MemoryController from '../src/index.ts'

const contexts: Context[] = []
const realFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = realFetch
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Answer the next requests with `body`, recording the URLs asked for. */
function serve(body: unknown, init: { readonly status?: number; readonly text?: string } = {}): string[] {
  const urls: string[] = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const text = init.text ?? JSON.stringify(body)
    return new Response(text, { status: init.status ?? 200 })
  })
  return urls
}

/** Mount the controller over a seam carrying `providers`. */
async function harness(
  options: { readonly providers?: number; readonly config?: Record<string, unknown> } = {},
): Promise<{ ctx: Context; controller: MemoryController }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryRuntime)
  for (let index = 0; index < (options.providers ?? 1); index += 1) {
    ctx.memory.registerProvider({
      id: `provider-${index}`,
      available: () => true,
      resolveBank: async () => 'coding-agent::test' as never,
      search: async () => ({ units: [], truncated: false }),
      recall: async () => ({ units: [], truncated: false }),
      retain: async () => ({ retained: true }),
    })
  }
  await ctx.plugin(MemoryController, options.config ?? {})
  return { ctx, controller: ctx.get('memoryController') as MemoryController }
}

describe('MemoryController', () => {
  it('publishes its five read methods under the memoryController namespace', async () => {
    const { controller } = await harness()
    expect(controller.typertRemote).toMatchObject({
      serviceKey: 'memoryController',
      namespace: 'memoryController',
    })
    expect(remoteMethods(controller).map(entry => entry.method).sort()).toEqual(
      ['list', 'page', 'pages', 'search', 'stats'],
    )
  })

  it('projects the daemon banks listing with its counts and last write', async () => {
    const { controller } = await harness()
    const urls = serve({
      banks: [
        { bank_id: 'coding-agent::zhiliao', name: 'zhiliao', fact_count: 522, last_write_at: '2026-10-10T08:08:47Z' },
        { bank_id: 'coding-agent::bare' },
        { name: 'no id at all' },
      ],
    })

    expect(await controller.list()).toEqual({
      available: true,
      banks: [
        { bankId: 'coding-agent::zhiliao', name: 'zhiliao', factCount: 522, lastWriteAt: '2026-10-10T08:08:47Z' },
        { bankId: 'coding-agent::bare', name: 'coding-agent::bare', factCount: 0 },
      ],
    })
    expect(urls).toEqual(['http://127.0.0.1:9077/v1/default/banks'])
  })

  it('reads an empty body as no banks rather than failing the listing', async () => {
    const { controller } = await harness()
    serve({}, { text: '' })
    expect(await controller.list()).toEqual({ available: true, banks: [] })
  })

  it('projects bank statistics with their distributions ranked largest first', async () => {
    const { controller } = await harness()
    const urls = serve({
      bank_id: 'coding-agent::zhiliao',
      total_nodes: 522,
      total_links: 9963,
      total_documents: 16,
      nodes_by_fact_type: { observation: 192, experience: 202, world: 128 },
      links_by_link_type: { semantic: 4460, temporal: 4925, caused_by: 11 },
      pending_operations: 2,
      failed_operations: 1,
    })

    expect(await controller.stats('coding-agent::zhiliao')).toEqual({
      available: true,
      stats: {
        bankId: 'coding-agent::zhiliao',
        totalNodes: 522,
        totalLinks: 9963,
        totalDocuments: 16,
        nodesByFactType: [
          { label: 'experience', count: 202 },
          { label: 'observation', count: 192 },
          { label: 'world', count: 128 },
        ],
        linksByLinkType: [
          { label: 'temporal', count: 4925 },
          { label: 'semantic', count: 4460 },
          { label: 'caused_by', count: 11 },
        ],
        pendingOperations: 2,
        failedOperations: 1,
      },
    })
    // The bank's `::` must be encoded, or the daemon reads a different path.
    expect(urls).toEqual(['http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Azhiliao/stats'])
  })

  it('degrades absent statistics fields to zero instead of failing the read', async () => {
    const { controller } = await harness()
    serve({ nodes_by_fact_type: { experience: 'many', broken: null } })
    expect(await controller.stats('b')).toEqual({
      available: true,
      stats: {
        bankId: '',
        totalNodes: 0,
        totalLinks: 0,
        totalDocuments: 0,
        nodesByFactType: [{ label: 'broken', count: 0 }, { label: 'experience', count: 0 }],
        linksByLinkType: [],
        pendingOperations: 0,
        failedOperations: 0,
      },
    })
  })

  it('flattens the knowledge-page tree depth-first and skips an idless node with its subtree', async () => {
    const { controller } = await harness()
    serve({
      roots: [
        {
          id: 'kp-root',
          children: [
            // A node the backend named nothing still lists under its own id.
            { id: 'kp-nameless', children: [] },
            { id: 'kp-child', name: 'Storage', children: [{ id: 'kp-grandchild', name: 'Index' }] },
          ],
        },
        {
          id: 'kp-described',
          name: 'Component map',
          description: 'what the parts are',
          timestamp: '2026-10-10T07:46:42Z',
          is_stale: true,
          children: [],
        },
        { name: 'orphan', children: [{ id: 'kp-kept', name: 'Still reachable' }] },
        'not a node',
      ],
    })

    expect(await controller.pages('coding-agent::zhiliao')).toEqual({
      available: true,
      pages: [
        { pageId: 'kp-root', name: 'kp-root', stale: false },
        { pageId: 'kp-nameless', name: 'kp-nameless', stale: false },
        { pageId: 'kp-child', name: 'Storage', stale: false },
        { pageId: 'kp-grandchild', name: 'Index', stale: false },
        {
          pageId: 'kp-described',
          name: 'Component map',
          description: 'what the parts are',
          updatedAt: '2026-10-10T07:46:42Z',
          stale: true,
        },
        { pageId: 'kp-kept', name: 'Still reachable', stale: false },
      ],
    })
  })

  it('searches the knowledge index and reports the backend total beside the hits', async () => {
    const { controller } = await harness()
    const urls = serve({
      total: 2,
      results: [
        { id: 'kp-a', name: 'Conventions', snippet: '## Scope note', score: 0.99 },
        { id: 'kp-b', name: 'Initiatives', snippet: 'themes and notable changes' },
        { id: 'kp-c', name: 'no snippet' },
        { snippet: 'no id' },
      ],
    })

    expect(await controller.search('coding-agent::zhiliao', 'memory & cache', undefined)).toEqual({
      available: true,
      hits: [
        { pageId: 'kp-a', name: 'Conventions', snippet: '## Scope note', score: 0.99 },
        { pageId: 'kp-b', name: 'Initiatives', snippet: 'themes and notable changes' },
      ],
      total: 2,
    })
    expect(urls).toEqual([
      'http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Azhiliao/knowledge-base/search?q=memory%20%26%20cache&limit=20',
    ])
  })

  it('clamps a caller-sourced hit limit into the served range', async () => {
    const { controller } = await harness()
    const urls = serve({ results: [], total: 0 })
    await controller.search('b', 'q', 5000)
    await controller.search('b', 'q', 0)
    await controller.search('b', 'q', -3)
    expect(urls.map(url => url.split('&limit=')[1])).toEqual(['100', '1', '1'])
  })

  it('never reports fewer matches than it returned hits', async () => {
    const { controller } = await harness()
    serve({ results: [{ id: 'kp-a', snippet: 'one' }], total: 0 })
    expect(await controller.search('b', 'q', undefined)).toMatchObject({ total: 1 })
  })

  it('reads one page body by its encoded page id', async () => {
    const { controller } = await harness()
    const urls = serve({ id: 'kp-a b', name: 'Conventions', body: '## Scope note' })
    expect(await controller.page('coding-agent::zhiliao', 'kp-a b')).toEqual({
      available: true,
      page: { pageId: 'kp-a b', name: 'Conventions', body: '## Scope note' },
    })
    expect(urls).toEqual([
      'http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Azhiliao/knowledge-base/pages/kp-a%20b',
    ])
  })

  it('answers a page without a body as an available read that carries no page', async () => {
    const { controller } = await harness()
    serve({ id: 'kp-a' })
    expect(await controller.page('b', 'kp-a')).toEqual({ available: true })
  })

  it('reads a page under its id when the backend named it nothing', async () => {
    const { controller } = await harness()
    serve({ id: 'kp-a', body: 'content' })
    expect(await controller.page('b', 'kp-a')).toEqual({
      available: true,
      page: { pageId: 'kp-a', name: 'kp-a', body: 'content' },
    })
  })

  it('answers a page with no id as an available read carrying no page', async () => {
    const { controller } = await harness()
    serve({ body: 'orphaned content' })
    expect(await controller.page('b', 'kp-a')).toEqual({ available: true })
  })

  it('tolerates a bare-array body and a primitive body from the daemon', async () => {
    const { controller } = await harness()
    // A backend that drops the envelope still answers; one that answers a
    // primitive reads as empty rather than throwing on a field access.
    serve([{ bank_id: 'b', name: 'bare', fact_count: 3 }])
    expect(await controller.list()).toEqual({
      available: true,
      banks: [{ bankId: 'b', name: 'bare', factCount: 3 }],
    })
    serve('not an envelope', { text: '"a string"' })
    expect(await controller.stats('b')).toMatchObject({ available: true, stats: { bankId: '' } })
    serve({}, { text: 'null' })
    expect(await controller.pages('b')).toEqual({ available: true, pages: [] })
    // A `null` rows field reads as no rows rather than throwing on iteration.
    serve({ banks: null })
    expect(await controller.list()).toEqual({ available: true, banks: [] })
    serve({ banks: 'not rows' })
    expect(await controller.list()).toEqual({ available: true, banks: [] })
  })
})

describe('MemoryController unavailability', () => {
  it('answers unavailable without a socket when no provider is registered', async () => {
    const { controller } = await harness({ providers: 0 })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof fetch

    expect(await controller.list()).toEqual({
      available: false,
      reason: 'unavailable',
      detail: 'no usable memory provider is registered',
    })
    expect(await controller.stats('b')).toMatchObject({ available: false, reason: 'unavailable' })
    expect(await controller.pages('b')).toMatchObject({ available: false, reason: 'unavailable' })
    expect(await controller.search('b', 'q', undefined)).toMatchObject({ available: false, reason: 'unavailable' })
    expect(await controller.page('b', 'kp')).toMatchObject({ available: false, reason: 'unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('treats several usable providers with none pinned as unavailable', async () => {
    const { controller } = await harness({ providers: 2 })
    expect(await controller.list()).toMatchObject({ available: false, reason: 'unavailable' })
  })

  it('classifies a refused status as a failed read with the daemon excerpt', async () => {
    const { controller } = await harness()
    serve({}, { status: 500, text: 'internal explosion' })
    const answer = await controller.list()
    expect(answer).toMatchObject({
      available: false,
      reason: 'failed',
      detail: expect.stringContaining('internal explosion') as string,
    })
  })

  it('classifies an unknown bank as a failed read, not a missing capability', async () => {
    const { controller } = await harness()
    serve({}, { status: 404, text: 'no such bank' })
    expect(await controller.stats('absent')).toMatchObject({ available: false, reason: 'failed' })
  })

  it('classifies a non-JSON body as a failed read', async () => {
    const { controller } = await harness()
    serve({}, { text: '<html>proxy error</html>' })
    expect(await controller.list()).toMatchObject({ available: false, reason: 'failed' })
  })

  it('classifies an unreachable daemon as an unreachable read', async () => {
    const { controller } = await harness()
    globalThis.fetch = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') })
    const answer = await controller.list()
    expect(answer).toMatchObject({
      available: false,
      reason: 'failed',
      detail: expect.stringContaining('unreachable') as string,
    })
  })

  it('classifies a failure the seam reports as its own MemoryError', async () => {
    const { ctx, controller } = await harness()
    // A seam whose availability check raises a classified error still answers
    // through the same taxonomy rather than propagating.
    const memory = ctx.get('memory') as unknown as { isAvailable: () => boolean }
    memory.isAvailable = () => { throw new MemoryError('configured provider is missing', 'MEMORY_PROVIDER_CONFIGURED_MISSING') }
    expect(await controller.list()).toEqual({
      available: false,
      reason: 'misconfigured',
      detail: 'configured provider is missing',
    })
  })

  it('classifies a thrown non-error as a failed read with its own words', async () => {
    const { ctx, controller } = await harness()
    const memory = ctx.get('memory') as unknown as { isAvailable: () => boolean }
    memory.isAvailable = () => { throw 'the seam exploded' }
    expect(await controller.list()).toEqual({
      available: false,
      reason: 'failed',
      detail: 'the seam exploded',
    })
  })

  it('classifies an exceeded timeout as an unreachable read', async () => {
    const { controller } = await harness({ config: { timeoutMs: 5 } })
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
        })
        setTimeout(resolve, 200)
      })
      return new Response('{}')
    }) as typeof fetch
    expect(await controller.list()).toMatchObject({ available: false, reason: 'unreachable' })
  })

  it('classifies a fetch rejection that is not an Error as a failed read', async () => {
    const { controller } = await harness()
    // Some runtimes reject with a bare reason rather than an Error; the message
    // it reports is still the transport's own words.
    globalThis.fetch = vi.fn<typeof fetch>(async () => { throw 'socket hang up' })
    const answer = await controller.list()
    expect(answer).toMatchObject({
      available: false,
      reason: 'failed',
      detail: expect.stringContaining('socket hang up') as string,
    })
  })

  it('classifies a caller-aborted request as an unreachable read too', async () => {
    const { controller } = await harness()
    // A browser that navigated away mid-read aborts the request; from the panel's
    // side that is the same condition as the daemon going silent.
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    expect(await controller.list()).toMatchObject({ available: false, reason: 'unreachable' })
  })

  it('talks to a configured daemon other than the loopback default', async () => {
    const { controller } = await harness({ config: { baseUrl: 'http://memory.internal:9077/' } })
    const urls = serve({ banks: [] })
    await controller.list()
    expect(urls).toEqual(['http://memory.internal:9077/v1/default/banks'])
  })
})

describe('MemoryController configuration', () => {
  let warn: MockInstance<typeof console.warn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('defaults the daemon URL and timeout when a deployment names neither', async () => {
    const { controller } = await harness()
    const urls = serve({ banks: [] })
    await controller.list()
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:9077\//)
  })
})
