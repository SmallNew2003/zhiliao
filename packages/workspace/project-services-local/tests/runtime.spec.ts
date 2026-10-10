import type * as ServiceTypes from '@deepseek-ai/dsh-project-services'
import { afterEach, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, ServiceControlRequest, ServiceItem, ServiceProviderContext, ResolvedServiceOperation } from '@deepseek-ai/dsh-project-services'
import { accessFor, harness, signal } from './helpers.ts'
import type { ServiceTargetLocks } from '../src/operations.ts'
import { projectServicesDomain } from '../src/storage.ts'

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
  expect(result).not.toHaveProperty('pending')
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

it('filters each immutable collection after a selective authority refresh', async () => {
  const h = await fixture()
  let calls = 0, hide = false
  h.access.revalidate = async () => { if (++calls === 2) hide = true }
  h.access.canRead = async resource => !hide || (!('providerId' in resource) && !('observedAt' in resource))
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.items).toEqual([])
  expect(inventory.providers).toEqual([])
})
it('does not add unreadable completion facts to an operation already being filtered', async () => {
  const h = await fixture(), finish = deferred(), reading = deferred(), resume = deferred()
  const prepare = h.provider.prepare
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, execute: async (opSignal) => {
      await finish.promise
      const result = await prepared.execute(opSignal)
      return { ...result, outcomes: [...result.outcomes, { targetId: brandString<ServiceTypes.ServiceTargetId>('native:hidden'), state: 'failed' as const, message: 'secret result' }] }
    } }
  }
  const request = h.request('completion-read')
  // Preparation is observed through the provider, without a scheduler delay.
  const executing = deferred()
  const preparedFactory = h.provider.prepare
  h.provider.prepare = async (...args) => {
    const prepared = await preparedFactory(...args)
    return { ...prepared, execute: async (opSignal) => { executing.resolve(); return await prepared.execute(opSignal) } }
  }
  const control = h.runtime.control(h.access, request, signal())
  await executing.promise
  const reader = { ...h.access, canRead: async (resource: ServiceTypes.ServiceReadable) => {
    if ('targetIds' in resource) { reading.resolve(); await resume.promise }
    return true
  } }
  const listed = h.runtime.list(reader, {}, signal())
  await reading.promise
  finish.resolve()
  await control
  resume.resolve()
  const operation = (await listed).operations[0]
  expect(operation?.outcomes.some(item => item.targetId === 'native:hidden')).toBe(false)
  expect(operation?.targetIds).not.toContain('native:hidden')
})
it('keeps a paging cursor valid across another project and another authority view', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  h.provider.inspect = async (...args) => {
    const result = await inspect(...args)
    return { ...result, items: [...result.items, { ...h.item(), id: brandString<ServiceTypes.ServiceTargetId>('native:second') }] }
  }
  const first = await h.runtime.list(h.access, { limit: 1 }, signal())
  const otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'service-other-project-')))
  cleanup.push(() => rm(otherRoot, { recursive: true, force: true }))
  await h.runtime.list(accessFor(otherRoot), {}, signal())
  await h.runtime.list({ ...h.access, actorId: brandString<ServiceTypes.ServiceActorId>('other'), canRead: async resource => resource.id !== 'native:second' }, {}, signal())
  const second = await h.runtime.list(h.access, { limit: 1, cursor: first.nextCursor! }, signal())
  expect(second.items.map(item => item.id)).toEqual(['native:second'])
})
it('retains read-filtered stale identities with no available mutation actions', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  await h.runtime.list(h.access, {}, signal())
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, status: { ...snapshot.status, observedAt: 0 } }
  }
  const expired = await h.runtime.list(h.access, {}, signal())
  expect(expired.items.map(item => item.id)).toEqual([h.item().id])
  expect(expired.items[0]?.actions).toEqual([])
  expect(expired.items[0]?.stale).toBe(true)
  h.failScan()
  const failed = await h.runtime.list(h.access, {}, signal())
  expect(failed.items.map(item => item.id)).toEqual([h.item().id])
  await expect(h.runtime.control(h.access, h.request('stale-stop', 'stop'), signal())).rejects.toThrow(/stale/)
  h.access.canRead = async resource => !('providerId' in resource)
  expect((await h.runtime.list(h.access, {}, signal())).items).toEqual([])
  expect(h.executionCount).toBe(0)
})
it('preserves empty arguments after the executable through durable reopen', async () => {
  const h = await fixture()
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('empty-arg'), action: 'start', definition: { name: 'empty', checkoutId: h.item().checkoutId, command: { argv: ['node', '-e', ''] } } }, signal())
  await h.dispose()
  const next = await harness(h.pool)
  cleanup.push(next.dispose)
  expect((await next.runtime.list(h.access, {}, signal())).definitions[0]?.command.argv).toEqual(['node', '-e', ''])
})
it('removes caller and Host abort listeners while a cancelled feed reader stays paused', async () => {
  const h = await fixture(), controller = new AbortController()
  const host = Reflect.get(h.runtime, 'host') as AbortController
  const baseline = getEventListeners(host.signal, 'abort').length
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort()
  try {
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(host.signal, 'abort')).toHaveLength(baseline)
  } finally { await iterator.return?.() }
})
it('rejects the original requested revision if it changes while prepare is suspended', async () => {
  const h = await fixture(), entered = deferred(), resume = deferred(), prepare = h.provider.prepare
  h.provider.prepare = async (...args) => { entered.resolve(); await resume.promise; return await prepare(...args) }
  const control = h.runtime.control(h.access, h.request('prepare-revision'), signal())
  const rejected = expect(control).rejects.toThrow(/revision/)
  await entered.promise
  h.changeRevision()
  resume.resolve()
  await rejected
  expect(h.executionCount).toBe(0)
})
it('holds a new launch instance reservation until execution settles', async () => {
  const h = await fixture(), release = deferred(), readyToStop = deferred()
  let launchActive = false, overlapped = false
  const prepare = h.provider.prepare
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    if (args[1].action === 'stop') readyToStop.resolve()
    return { ...prepared, execute: async (opSignal) => {
      if (args[1].action === 'stop') { overlapped = launchActive; return await prepared.execute(opSignal) }
      launchActive = true
      h.started.resolve()
      await release.promise
      const result = await prepared.execute(opSignal)
      launchActive = false
      return result
    } }
  }
  const launch = h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('launch-reservation'), action: 'start', definition: { name: 'server', checkoutId: h.item().checkoutId, command: { argv: ['node', 'server.js'] } } }, signal())
  await h.started.promise
  const stop = h.runtime.control(h.access, h.request('stop-reservation', 'stop'), signal()).catch(error => error as Error)
  await readyToStop.promise
  // An unrelated complete read gives an unlocked operation a chance to execute;
  // the assertion below observes provider execution facts, not elapsed time.
  await h.runtime.list(h.access, {}, signal())
  release.resolve()
  await launch
  await stop
  expect(overlapped).toBe(false)
})
it('resolves a saved definition alias to its instance and validates both revisions', async () => {
  const h = await fixture(), prepare = h.provider.prepare
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('alias-create'), action: 'start', definition: { name: 'alias', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  const definition = (await h.runtime.list(h.access, {}, signal())).definitions[0]!
  const inspect = h.provider.inspect
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, definitionId: definition.id })) }
  }
  h.provider.prepare = prepare
  const result = await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('alias-stop'), action: 'stop', targetId: definition.id, expectedRevision: definition.revision }, signal())
  expect(result.operation?.state).toBe('succeeded')
  expect(h.running).toBe(false)
})

it('reserves a new launch identity against an independently queued target operation', async () => {
  const h = await fixture(), release = deferred(), prepare = h.provider.prepare
  let launchActive = false, observedOverlap = false
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, execute: async (opSignal) => {
      launchActive = true
      h.started.resolve()
      await release.promise
      const result = await prepared.execute(opSignal)
      launchActive = false
      return result
    } }
  }
  const launch = h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('identity-reservation'), action: 'start', definition: { name: 'reserved', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  await h.started.promise
  // The runtime owns this scheduler. A competing real reservation isolates lock
  // acquisition from filesystem inspection; no provider or lock method is mocked.
  const locks = Reflect.get(h.runtime, 'locks') as ServiceTargetLocks
  const contender = locks.run([h.item().id], async () => { observedOverlap = launchActive })
  // Reservation scheduling uses only promise continuations. An event-loop turn
  // drains those continuations without depending on a filesystem or timer delay.
  await new Promise<void>(resolve => setImmediate(resolve))
  release.resolve()
  await Promise.all([launch, contender])
  expect(observedOverlap).toBe(false)
})
it('rejects a new launch without a resolved instance reservation', async () => {
  const h = await fixture(), prepare = h.provider.prepare
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description, targets: [] } }
  }
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('no-target'), action: 'start', definition: { name: 'unresolved', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())).rejects.toThrow(/resolved.*target|target.*resolved/)
  expect(h.executionCount).toBe(0)
})
it('keeps prior identities when an unavailable observation has no replacement rows', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  await h.runtime.list(h.access, {}, signal())
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: [], status: { ...snapshot.status, state: 'unavailable' } }
  }
  const snapshot = await h.runtime.list(h.access, {}, signal())
  expect(snapshot.items.map(item => item.id)).toEqual([h.item().id])
  expect(snapshot.items[0]?.actions).toEqual([])
})

it('rejects a durable definition without a nonempty executable', () => {
  const record = { id: 'native:definition', projectId: 'project', checkoutId: 'checkout', name: 'command', revision: '1' }
  for (const argv of [[], [''], ['', 'argument']]) {
    expect(projectServicesDomain.tables.definitions.valueSchema.safeParse({ ...record, command: { argv } }).success).toBe(false)
  }
})
it('refuses an individually stale target even when the provider is otherwise ready', async () => {
  const h = await fixture(), inspect = h.provider.inspect
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, stale: true })) }
  }
  expect((await h.runtime.list(h.access, {}, signal())).items[0]?.actions).toEqual([])
  await expect(h.runtime.control(h.access, h.request('one-stale', 'stop'), signal())).rejects.toThrow(/stale/)
  expect(h.executionCount).toBe(0)
})
