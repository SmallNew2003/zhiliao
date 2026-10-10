import type * as ServiceTypes from '@deepseek-ai/dsh-project-services'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, ServiceControlRequest, ServiceItem, ServiceProviderContext, ResolvedServiceOperation } from '@deepseek-ai/dsh-project-services'
import { accessFor, harness, signal } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-runtime-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness()
  cleanup.push(h.dispose)
  const access = accessFor(root)
  const baseline = await h.runtime.list(access, {}, signal())
  let revision = '1', running = false, executionCount = 0, scanError = false
  let executeGate: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const item = (): ServiceItem => ({ id: brandString<ServiceTypes.ServiceTargetId>('native:test'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: baseline.project.id, checkoutId: baseline.checkouts[0]!.id, revision: brandString<ServiceTypes.ServiceRevision>(revision), name: 'test service', kind: 'native', state: running ? 'running' : 'stopped', ownership: 'managed', actions: ['start', 'stop', 'restart'] })
  const started = deferred()
  const provider: ProjectServiceProvider = {
    id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native',
    inspect: async () => { if (scanError) throw new Error('scan unavailable'); return { items: [item()], groups: [], status: { id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native', state: 'ready', observedAt: Date.now() } } },
    prepare: async (context: ServiceProviderContext, request) => {
      const captured = revision
      const description: ResolvedServiceOperation = { action: request.action, project: context.project, checkout: context.checkouts[0]!, targets: [{ id: item().id, revision: brandString<ServiceTypes.ServiceRevision>(captured) }], ...('definition' in request ? { nativeLaunch: { command: request.definition.command, cwd: root, executionIdentity: access.executionIdentity } } : {}) }
      return { description,
        validate: async () => { if (revision !== captured) throw new Error('revision changed') },
        execute: async (operationSignal) => { operationSignal.throwIfAborted(); executionCount++; started.resolve(); await executeGate; operationSignal.throwIfAborted(); running = request.action !== 'stop'; revision = String(Number(revision) + 1); return { outcomes: [{ targetId: item().id, state: 'succeeded' as const }] } },
      }
    },
    logs: async () => ({ chunks: [{ targetId: item().id, stream: 'stdout', text: 'private output' }], truncated: false, gap: false }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const fiber = await h.ctx.plugin({ name: 'fixture-provider', inject: ['projectServices'], apply(ctx) { ctx.effect(() => ctx.projectServices.registerProvider(provider)) } })
  cleanup.push(() => fiber.dispose())
  const request = (id: string, action: 'start' | 'stop' | 'restart' = 'start'): ServiceControlRequest => ({ requestId: brandString<ServiceTypes.ServiceRequestId>(id), action, targetId: item().id, expectedRevision: brandString<ServiceTypes.ServiceRevision>(revision) })
  return { ...h, root, access, baseline, request, item, provider, started, listeners, fiber,
    get running() { return running }, get executionCount() { return executionCount },
    changeRevision: () => { revision = String(Number(revision) + 1) },
    blockExecution: (gate: Promise<void>) => { executeGate = gate },
    failScan: () => { scanError = true },
  }
}
it('denial leaves the target stopped and creates no operation', async () => {
  const h = await fixture()
  h.access.authorize = async () => { throw new Error('denied') }
  await expect(h.runtime.control(h.access, h.request('deny'), signal())).rejects.toThrow('denied')
  expect(h.running).toBe(false)
  expect((await h.runtime.list(h.access, {}, signal())).operations).toEqual([])
})
it('authorizes deeply immutable resolved facts and rejects a revision changed during approval', async () => {
  const h = await fixture()
  h.access.authorize = async (description) => { expect(Object.isFrozen(description.targets[0])).toBe(true); h.changeRevision() }
  await expect(h.runtime.control(h.access, h.request('changed'), signal())).rejects.toThrow(/revision/)
  expect(h.executionCount).toBe(0)
})
it('rechecks policy after approval before executing', async () => {
  const h = await fixture()
  let approved = false
  h.access.authorize = async () => { approved = true }
  h.access.revalidate = async () => { if (approved) throw new Error('policy revoked') }
  await expect(h.runtime.control(h.access, h.request('policy'), signal())).rejects.toThrow('policy revoked')
  expect(h.executionCount).toBe(0)
})
it('deduplicates concurrent requests and keeps published work alive after initiator cancellation', async () => {
  const h = await fixture(), gate = deferred(), initiator = new AbortController()
  h.blockExecution(gate.promise)
  const request = h.request('same')
  const first = h.runtime.control(h.access, request, initiator.signal)
  await h.started.promise
  const second = h.runtime.control(h.access, request, signal())
  initiator.abort()
  gate.resolve()
  const results = await Promise.all([first, second])
  expect(h.executionCount).toBe(1)
  expect(results[0].operation?.id).toBe(results[1].operation?.id)
  expect(h.running).toBe(true)
})
it('serializes overlapping targets and rejects stale queued revisions', async () => {
  const h = await fixture(), gate = deferred()
  h.blockExecution(gate.promise)
  const first = h.runtime.control(h.access, h.request('first'), signal())
  await h.started.promise
  const second = h.runtime.control(h.access, h.request('second', 'stop'), signal())
  const rejected = expect(second).rejects.toThrow(/revision/)
  gate.resolve()
  await first
  await rejected
  expect(h.executionCount).toBe(1)
  expect(h.running).toBe(true)
})
it('filters control results, operation status, snapshots and logs through current read authority', async () => {
  const h = await fixture()
  h.access.authorize = async () => { h.access.canRead = async resource => !('targetIds' in resource) && !('providerId' in resource) }
  const result = await h.runtime.control(h.access, h.request('hidden'), signal())
  expect(result.operation).toBeUndefined()
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.items).toEqual([])
  expect(inventory.operations).toEqual([])
  await expect(h.runtime.logs(h.access, { targetId: h.item().id }, signal())).rejects.toThrow(/read|unavailable/)
})
it('persists authorized native definitions without auto-starting them on reopen', async () => {
  const h = await fixture()
  const request: ServiceControlRequest = { requestId: brandString<ServiceTypes.ServiceRequestId>('definition'), action: 'start', definition: { name: 'server', checkoutId: h.baseline.checkouts[0]!.id, command: { argv: ['node', 'server.js'] } } }
  await h.runtime.control(h.access, request, signal())
  await h.dispose()
  const next = await harness(h.pool)
  cleanup.push(next.dispose)
  const inventory = await next.runtime.list(h.access, {}, signal())
  expect(inventory.definitions.map(d => d.command.argv)).toEqual([['node', 'server.js']])
  expect(inventory.items).toEqual([])
  expect(inventory.operations).toEqual([])
})
it('reports stale scans explicitly and removes provider registrations with their owning fiber', async () => {
  const h = await fixture()
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(1)
  h.failScan()
  expect((await h.runtime.list(h.access, {}, signal())).providers[0]?.state).toBe('stale')
  await h.fiber.dispose()
  expect((await h.runtime.list(h.access, {}, signal())).providers).toEqual([])
  expect(h.listeners.size).toBe(0)
})
it('starts feeds with a baseline and disposes provider subscriptions on abort', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.kind).toBe('baseline')
  const next = iterator.next()
  for (const listener of h.listeners) listener()
  expect((await next).value?.kind).toBe('updated')
  controller.abort()
  await iterator.return?.()
  await h.fiber.dispose()
  expect(h.listeners.size).toBe(0)
})
it('detaches an active feed subscription immediately when its provider fiber is removed', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]()
  try {
    await iterator.next()
    expect(h.listeners.size).toBe(1)
    await h.fiber.dispose()
    expect(h.listeners.size).toBe(0)
  } finally { controller.abort(); await iterator.return?.() }
})
it('rejects a revision changed during approval even when provider validation is passive', async () => {
  const h = await fixture(), prepare = h.provider.prepare
  h.provider.prepare = async (...args) => ({ ...await prepare(...args), validate: async () => {} })
  h.access.authorize = async () => { h.changeRevision() }
  await expect(h.runtime.control(h.access, h.request('runtime-revision'), signal())).rejects.toThrow(/revision/)
  expect(h.executionCount).toBe(0)
})
it('rechecks project read permission after a provider scan', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  let readable = true
  h.access.canRead = async resource => !('executionIdentity' in resource) || readable
  h.provider.inspect = async (...args) => { const result = await inspect(...args); readable = false; return result }
  await expect(h.runtime.list(h.access, {}, signal())).rejects.toThrow(/read/)
})
it('expires paging cursors when a provider changes without emitting a notification', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  h.provider.inspect = async (...args) => { const result = await inspect(...args); return { ...result, items: [...result.items, { ...h.item(), id: brandString<ServiceTypes.ServiceTargetId>('native:second') }] } }
  const first = await h.runtime.list(h.access, { limit: 1 }, signal())
  expect(first.nextCursor).toBeDefined()
  h.changeRevision()
  await expect(h.runtime.list(h.access, { cursor: first.nextCursor!, limit: 1 }, signal())).rejects.toThrow(/cursor/)
})
it('detaches feed listeners on cancellation while the reader is paused at a yielded frame', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort()
  try { expect(h.listeners.size).toBe(0) }
  finally { await iterator.return?.() }
})
it('filters provider capability and error status through read authority', async () => {
  const h = await fixture()
  h.access.canRead = async resource => !('observedAt' in resource)
  h.failScan()
  expect((await h.runtime.list(h.access, {}, signal())).providers).toEqual([])
})
it('gives native preparation the durable definition identity before launch', async () => {
  const h = await fixture(), prepare = h.provider.prepare
  let definitionId: ServiceTypes.ServiceTargetId | undefined
  h.provider.prepare = async (...args) => { definitionId = args[0].pendingDefinition?.id; return await prepare(...args) }
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('named'), action: 'start', definition: { name: 'named', checkoutId: h.item().checkoutId, command: { argv: ['node', 'server.js'] } } }, signal())
  expect(definitionId).toBeDefined()
  expect((await h.runtime.list(h.access, {}, signal())).definitions[0]?.id).toBe(definitionId)
})

it('reads an authorized target outside the first inventory page', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  h.provider.inspect = async (...args) => {
    const result = await inspect(...args)
    return { ...result, items: Array.from({ length: 201 }, (_, index) => ({ ...h.item(), id: brandString<ServiceTypes.ServiceTargetId>(`native:${index}`) })) }
  }
  h.provider.logs = async target => ({ chunks: [{ targetId: target.id, stream: 'stdout', text: 'last service' }], gap: false, truncated: false })
  const page = await h.runtime.logs(h.access, { targetId: brandString<ServiceTypes.ServiceTargetId>('native:200') }, signal())
  expect(page.chunks[0]?.text).toBe('last service')
})
