import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { MemoryError, memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'
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
