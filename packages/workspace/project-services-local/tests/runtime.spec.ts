import type * as ServiceTypes from '@deepseek-ai/dsh-project-services'
import { afterEach, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, ServiceControlRequest, ServiceFeedFrame, ServiceItem, ServiceProviderContext, ResolvedServiceOperation } from '@deepseek-ai/dsh-project-services'
import { accessFor, git, harness, signal } from './helpers.ts'
import type { ServiceTargetLocks } from '../src/operations.ts'
import type { Config as RuntimeConfig } from '../src/index.ts'
import { projectServicesDomain } from '../src/storage.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
async function fixture(config?: Partial<RuntimeConfig>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-runtime-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness(undefined, config)
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
it('a failure before publication leaves the request id free to retry', async () => {
  const h = await fixture()
  h.access.authorize = async () => { throw new Error('denied') }
  await expect(h.runtime.control(h.access, h.request('retry'), signal())).rejects.toThrow('denied')
  expect((await h.runtime.list(h.access, {}, signal())).operations).toEqual([])
  h.access.authorize = async () => {}
  await h.runtime.control(h.access, h.request('retry'), signal())
  expect(h.running).toBe(true)
  expect(h.executionCount).toBe(1)
})
it('a published operation keeps its request id idempotent', async () => {
  const h = await fixture()
  // Idempotency binds the exact request bytes: the fingerprint covers
  // expectedRevision, so a retry that restates a stale revision is a different
  // operation rather than a replay of this one.
  const request = h.request('idem')
  await h.runtime.control(h.access, request, signal())
  await h.runtime.control(h.access, request, signal())
  expect(h.executionCount).toBe(1)
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
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
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
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  try {
    await iterator.next()
    expect(h.listeners.size).toBe(1)
    await h.fiber.dispose()
    expect(h.listeners.size).toBe(0)
  } finally { controller.abort(); await iterator.return?.() }
})
it('rejects a revision changed during approval even when provider validation is passive', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => ({ ...await prepare(...args), validate: async () => {} })
  h.access.authorize = async () => { h.changeRevision() }
  await expect(h.runtime.control(h.access, h.request('runtime-revision'), signal())).rejects.toThrow(/revision/)
  expect(h.executionCount).toBe(0)
})
it('rechecks project read permission after a provider scan', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  let readable = true
  h.access.canRead = async resource => !('executionIdentity' in resource) || readable
  h.provider.inspect = async (...args) => { const result = await inspect(...args); readable = false; return result }
  await expect(h.runtime.list(h.access, {}, signal())).rejects.toThrow(/read/)
})
it('expires paging cursors when a provider changes without emitting a notification', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => { const result = await inspect(...args); return { ...result, items: [...result.items, { ...h.item(), id: brandString<ServiceTypes.ServiceTargetId>('native:second') }] } }
  const first = await h.runtime.list(h.access, { limit: 1 }, signal())
  expect(first.nextCursor).toBeDefined()
  h.changeRevision()
  await expect(h.runtime.list(h.access, { cursor: first.nextCursor!, limit: 1 }, signal())).rejects.toThrow(/cursor/)
})
it('detaches feed listeners on cancellation while the reader is paused at a yielded frame', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
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
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  let definitionId: ServiceTypes.ServiceTargetId | undefined
  h.provider.prepare = async (...args) => { definitionId = args[0].pendingDefinition?.id; return await prepare(...args) }
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('named'), action: 'start', definition: { name: 'named', checkoutId: h.item().checkoutId, command: { argv: ['node', 'server.js'] } } }, signal())
  expect(definitionId).toBeDefined()
  expect((await h.runtime.list(h.access, {}, signal())).definitions[0]?.id).toBe(definitionId)
})

it('reads an authorized target outside the first inventory page', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
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
  const prepare = h.provider.prepare.bind(h.provider)
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
  const preparedFactory = h.provider.prepare.bind(h.provider)
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
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
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
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
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
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  await iterator.next()
  controller.abort()
  try {
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(host.signal, 'abort')).toHaveLength(baseline)
  } finally { await iterator.return?.() }
})
it('rejects the original requested revision if it changes while prepare is suspended', async () => {
  const h = await fixture(), entered = deferred(), resume = deferred(), prepare = h.provider.prepare.bind(h.provider)
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
  const prepare = h.provider.prepare.bind(h.provider)
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
  const stop = h.runtime.control(h.access, h.request('stop-reservation', 'stop'), signal()).catch((error: unknown) => error as Error)
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
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('alias-create'), action: 'start', definition: { name: 'alias', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  const definition = (await h.runtime.list(h.access, {}, signal())).definitions[0]!
  const inspect = h.provider.inspect.bind(h.provider)
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
  const h = await fixture(), release = deferred(), prepare = h.provider.prepare.bind(h.provider)
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
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description, targets: [] } }
  }
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('no-target'), action: 'start', definition: { name: 'unresolved', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())).rejects.toThrow(/resolved.*target|target.*resolved/)
  expect(h.executionCount).toBe(0)
})

it('authorizes and reserves both the old range and the replacement launch identity', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider), release = deferred()
  cleanup.push(async () => { release.resolve() })
  const replacement = brandString<ServiceTypes.ServiceTargetId>('native:replacement')
  let executing = false, overlap = false
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description,
      targets: [...prepared.description.targets, { id: replacement, revision: brandString<ServiceTypes.ServiceRevision>('reserved') }],
      nativeLaunch: { targetId: replacement, command: { argv: ['node'] }, cwd: h.root, executionIdentity: h.access.executionIdentity },
    }, execute: async (opSignal) => {
      executing = true; h.started.resolve(); await release.promise
      const result = await prepared.execute(opSignal); executing = false
      return result
    } }
  }
  h.access.authorize = async (operation) => { expect(operation.targets.map(target => target.id)).toEqual([h.item().id, replacement]) }
  const restarted = h.runtime.control(h.access, h.request('replace-range', 'restart'), signal())
  await h.started.promise
  const locks = Reflect.get(h.runtime, 'locks') as ServiceTargetLocks
  const contender = locks.run([replacement], async () => { overlap = executing })
  await new Promise<void>(resolve => setImmediate(resolve))
  release.resolve(); await Promise.all([restarted, contender])
  expect(overlap).toBe(false)
})

it('rejects a replacement identity already claimed before asking for approval', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  const claimed = brandString<ServiceTypes.ServiceTargetId>('native:claimed')
  const inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: [...snapshot.items, { ...h.item(), id: claimed }] }
  }
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description,
      targets: [...prepared.description.targets, { id: claimed, revision: h.item().revision }],
      nativeLaunch: { targetId: claimed, command: { argv: ['node'] }, cwd: h.root, executionIdentity: h.access.executionIdentity },
    } }
  }
  let asked = false
  h.access.authorize = async () => { asked = true }
  await expect(h.runtime.control(h.access, h.request('claimed-replacement', 'restart'), signal())).rejects.toThrow('already claimed')
  expect(asked).toBe(false)
  expect(h.executionCount).toBe(0)
})
it('keeps prior identities when an unavailable observation has no replacement rows', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
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
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, stale: true })) }
  }
  expect((await h.runtime.list(h.access, {}, signal())).items[0]?.actions).toEqual([])
  await expect(h.runtime.control(h.access, h.request('one-stale', 'stop'), signal())).rejects.toThrow(/stale/)
  expect(h.executionCount).toBe(0)
})

it('拒绝重复注册同一服务提供者', async () => {
  const h = await fixture()
  expect(() => h.runtime.registerProvider(h.provider)).toThrow('Duplicate project service provider')
})

it('拒绝非法或超限的分页大小', async () => {
  const h = await fixture()
  for (const limit of [0, 1.5, 201]) {
    await expect(h.runtime.list(h.access, { limit }, signal())).rejects.toThrow('Invalid service page limit')
  }
})

it('拒绝格式非法与偏移不可表示的分页游标', async () => {
  const h = await fixture()
  const first = await h.runtime.list(h.access, {}, signal())
  const revision: string = first.revision
  await expect(h.runtime.list(h.access, { cursor: brandString<ServiceTypes.ServiceCursor>(`${first.revision}:0:extra`) }, signal())).rejects.toThrow('cursor expired')
  await expect(h.runtime.list(h.access, { cursor: brandString<ServiceTypes.ServiceCursor>(`${first.revision}:abc`) }, signal())).rejects.toThrow('cursor expired')
  await expect(h.runtime.list(h.access, { cursor: brandString<ServiceTypes.ServiceCursor>(revision) }, signal())).rejects.toThrow('cursor expired')
  await expect(h.runtime.list(h.access, { cursor: brandString<ServiceTypes.ServiceCursor>(`${first.revision}:99999999999999999999`) }, signal())).rejects.toThrow('Invalid service cursor offset')
})

it('在项目解析后立即拒绝无读取权限的调用', async () => {
  const h = await fixture()
  h.access.canRead = async resource => !('executionIdentity' in resource)
  await expect(h.runtime.list(h.access, {}, signal())).rejects.toThrow('Project read denied')
})

it('在首次观测即不可用时返回空的过期清单', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: [], groups: [], status: { ...snapshot.status, state: 'unavailable' } }
  }
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.items).toEqual([])
  expect(inventory.providers[0]?.state).toBe('stale')
})

it('按可读目标过滤服务分组并在控制时按项目筛选', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  const groupId = brandString<ServiceTypes.ServiceTargetId>('native:group')
  const groups = [
    { id: groupId, providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'group', revision: brandString<ServiceTypes.ServiceRevision>('1'), targetIds: [h.item().id] },
    { id: brandString<ServiceTypes.ServiceTargetId>('native:hidden-group'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'hidden', revision: brandString<ServiceTypes.ServiceRevision>('1'), targetIds: [brandString<ServiceTypes.ServiceTargetId>('native:unreadable')] },
  ]
  h.provider.inspect = async (...args) => ({ ...await inspect(...args), groups })
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.groups.map(group => group.name)).toEqual(['group'])
  await h.runtime.control(h.access, h.request('with-groups', 'stop'), signal())
  expect(h.executionCount).toBe(1)
})

it('在观测过期时保留分组事实并清空其可执行动作', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, groups: [{ id: brandString<ServiceTypes.ServiceTargetId>('native:expired-group'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'group', revision: brandString<ServiceTypes.ServiceRevision>('1'), targetIds: [h.item().id] }], status: { ...snapshot.status, state: 'unavailable' } }
  }
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.groups[0]?.stale).toBe(true)
  expect(inventory.groups[0]?.name).toBe('group')
})

it('拒绝未知提供者的日志读取', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, providerId: brandString<ServiceTypes.ServiceProviderId>('ghost') })) }
  }
  await expect(h.runtime.logs(h.access, { targetId: h.item().id }, signal())).rejects.toThrow('Service provider unavailable')
})

it('拒绝越界的日志响应上限', async () => {
  const h = await fixture()
  for (const maxBytes of [0, 1.5, 20000]) {
    await expect(h.runtime.logs(h.access, { targetId: h.item().id, maxBytes }, signal())).rejects.toThrow('Invalid service log limit')
  }
})

it('在日志读取后权限被撤销时拒绝返回', async () => {
  const h = await fixture()
  let calls = 0
  h.access.canRead = async () => ++calls <= 3
  await expect(h.runtime.logs(h.access, { targetId: h.item().id }, signal())).rejects.toThrow('Service read denied')
})

it('拒绝返回其他服务或超限的日志页', async () => {
  const h = await fixture()
  h.provider.logs = async () => ({ chunks: [{ targetId: brandString<ServiceTypes.ServiceTargetId>('native:other'), stream: 'stdout', text: 'x' }], gap: false, truncated: false })
  await expect(h.runtime.logs(h.access, { targetId: h.item().id }, signal())).rejects.toThrow('another service log')
  h.provider.logs = async () => ({ chunks: [{ targetId: h.item().id, stream: 'stdout', text: 'x'.repeat(1000) }], gap: false, truncated: false })
  await expect(h.runtime.logs(h.access, { targetId: h.item().id, maxBytes: 200 }, signal())).rejects.toThrow('exceeded the complete response limit')
})

it('拒绝用同一请求身份提交不同操作', async () => {
  const h = await fixture()
  await h.runtime.control(h.access, h.request('reuse'), signal())
  await expect(h.runtime.control(h.access, h.request('reuse', 'stop'), signal())).rejects.toThrow('already used for another operation')
})

it('在操作记录容量达到上限时驱逐已 settle 的记录', async () => {
  const h = await fixture({ operationMaxRecords: 1 })
  await h.runtime.control(h.access, h.request('first'), signal())
  const second = await h.runtime.control(h.access, h.request('second'), signal())
  expect(second.operation?.state).toBe('succeeded')
  const operations = (await h.runtime.list(h.access, {}, signal())).operations
  expect(operations.map(operation => operation.requestId)).toEqual(['second'])
})

it('在未 settle 的请求占满容量时拒绝新的控制请求', async () => {
  const h = await fixture({ operationMaxRecords: 1 }), gate = deferred()
  h.blockExecution(gate.promise)
  const first = h.runtime.control(h.access, h.request('busy'), signal())
  await h.started.promise
  await expect(h.runtime.control(h.access, h.request('other'), signal())).rejects.toThrow('operation capacity reached')
  gate.resolve()
  await first
})

it('为没有订阅能力的提供者启动 feed', async () => {
  const h = await fixture()
  delete h.provider.subscribe
  const controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  expect((await iterator.next()).value?.kind).toBe('baseline')
  controller.abort()
  await iterator.return?.()
})

it('在读取前收到变更时立即推送更新帧', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  await iterator.next()
  for (const listener of h.listeners) listener()
  expect((await iterator.next()).value?.kind).toBe('updated')
  controller.abort()
  await iterator.return?.()
})

it('在等待期间调用方取消时结束 feed', async () => {
  const h = await fixture(), controller = new AbortController()
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  await iterator.next()
  const next = iterator.next()
  controller.abort()
  expect((await next).done).toBe(true)
})

it('在 Host 处置时结束等待中的 feed 读取', async () => {
  const h = await fixture(), controller = new AbortController()
  const host = Reflect.get(h.runtime, 'host') as AbortController
  const iterator = h.runtime.follow(h.access, {}, controller.signal)[Symbol.asyncIterator]() as AsyncIterator<ServiceFeedFrame, void>
  await iterator.next()
  const next = iterator.next()
  host.abort(new Error('feed host closed'))
  expect((await next).done).toBe(true)
  controller.abort()
})

it('拒绝指向未注册提供者的控制请求', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, providerId: brandString<ServiceTypes.ServiceProviderId>('ghost') })) }
  }
  await expect(h.runtime.control(h.access, h.request('ghost', 'stop'), signal())).rejects.toThrow('Service provider unavailable')
})

it('在提供者观测过期时拒绝按定义启动', async () => {
  const h = await fixture()
  h.failScan()
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('stale-definition'), action: 'start', definition: { name: 'stale', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal()))
    .rejects.toThrow('stale')
})

it('在检出目录不可读时拒绝控制请求', async () => {
  const h = await fixture()
  h.access.canRead = async resource => !('availability' in resource)
  await expect(h.runtime.control(h.access, h.request('hidden-checkout', 'stop'), signal())).rejects.toThrow('checkout unavailable for read')
})

it('在目标不可读时拒绝控制请求', async () => {
  const h = await fixture()
  h.access.canRead = async resource => !('providerId' in resource)
  await expect(h.runtime.control(h.access, h.request('hidden-target', 'stop'), signal())).rejects.toThrow('target unavailable for read')
})

it('拒绝解析出不同操作的提供者', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description, action: 'stop' } }
  }
  await expect(h.runtime.control(h.access, h.request('wrong-action'), signal())).rejects.toThrow('different service operation')
  expect(h.executionCount).toBe(0)
})

it('拒绝提供重复目标的提供者', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: {
      ...prepared.description, targets: [...prepared.description.targets, prepared.description.targets[0]!],
    } }
  }
  await expect(h.runtime.control(h.access, h.request('duplicate'), signal())).rejects.toThrow('duplicate service targets')
  expect(h.executionCount).toBe(0)
})

it('拒绝解析出不同目标集合的提供者', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description, targets: [...prepared.description.targets, { id: brandString<ServiceTypes.ServiceTargetId>('native:extra'), revision: brandString<ServiceTypes.ServiceRevision>('1') }] } }
  }
  await expect(h.runtime.control(h.access, h.request('extra-target', 'stop'), signal())).rejects.toThrow('different service targets')
  expect(h.executionCount).toBe(0)
})

it('拒绝解析出无关实例的定义操作', async () => {
  const h = await fixture()
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('alias-create'), action: 'start', definition: { name: 'alias', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  const definition = (await h.runtime.list(h.access, {}, signal())).definitions[0]!
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('alias-stop'), action: 'stop', targetId: definition.id, expectedRevision: definition.revision }, signal()))
    .rejects.toThrow('unrelated instance')
  expect(h.executionCount).toBe(1)
})

it('拒绝解析出不同成员集合的分组操作', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  const groupId = brandString<ServiceTypes.ServiceTargetId>('native:group')
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, groups: [{ id: groupId, providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'group', revision: brandString<ServiceTypes.ServiceRevision>('1'), targetIds: [brandString<ServiceTypes.ServiceTargetId>('native:member')] }] }
  }
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('group-stop'), action: 'stop', targetId: groupId, expectedRevision: brandString<ServiceTypes.ServiceRevision>('1') }, signal()))
    .rejects.toThrow('different service targets')
  expect(h.executionCount).toBe(0)
})

it('在授权期间提供者被移除时中止操作', async () => {
  const h = await fixture(), entered = deferred(), gate = deferred()
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('removed-provider'), signal())
  await entered.promise
  await h.fiber.dispose()
  gate.resolve()
  await expect(control).rejects.toThrow('provider was removed')
})

it('在授权期间项目发生变化时中止操作', async () => {
  const h = await fixture(), entered = deferred(), gate = deferred()
  const other = await realpath(await mkdtemp(join(tmpdir(), 'service-other-project-')))
  cleanup.push(() => rm(other, { recursive: true, force: true }))
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('moved-project'), signal())
  await entered.promise
  h.access.cwd = other
  gate.resolve()
  await expect(control).rejects.toThrow('Project changed during operation')
})

it('在授权期间观测过期时中止操作', async () => {
  const h = await fixture(), entered = deferred(), gate = deferred()
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('stale-approval'), signal())
  await entered.promise
  h.failScan()
  gate.resolve()
  await expect(control).rejects.toThrow('stale')
})

it('在授权期间启动身份被占用时中止操作', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider), entered = deferred(), gate = deferred()
  const claimed = brandString<ServiceTypes.ServiceTargetId>('native:claimed-launch')
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description,
      targets: [...prepared.description.targets, { id: claimed, revision: brandString<ServiceTypes.ServiceRevision>('reserved') }],
      nativeLaunch: { targetId: claimed, command: { argv: ['node'] }, cwd: h.root, executionIdentity: h.access.executionIdentity } } }
  }
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('claimed-launch', 'restart'), signal())
  await entered.promise
  const inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: [...snapshot.items, { ...h.item(), id: claimed }] }
  }
  gate.resolve()
  await expect(control).rejects.toThrow('claimed during preparation')
})

it('在授权期间目标被标记过期时中止操作', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider), entered = deferred(), gate = deferred()
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('stale-target'), signal())
  await entered.promise
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, stale: true })) }
  }
  gate.resolve()
  await expect(control).rejects.toThrow('stale')
})

it('在授权期间解析目标被标记过期时中止操作', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, stale: true })) }
  }
  await expect(h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('stale-approved'), action: 'start', definition: { name: 'stale-approved', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal()))
    .rejects.toThrow('Resolved service observation is stale')
  expect(h.executionCount).toBe(0)
})

it('在授权期间解析目标版本变化时中止操作', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider), entered = deferred(), gate = deferred()
  h.provider.prepare = async (...args) => ({ ...await prepare(...args), validate: async () => {} })
  h.access.authorize = async () => { entered.resolve(); h.changeRevision(); await gate.promise }
  const control = h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('changed-approved'), action: 'start', definition: { name: 'changed', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  await entered.promise
  gate.resolve()
  await expect(control).rejects.toThrow('Resolved service target revision changed')
  expect(h.executionCount).toBe(0)
})

it('在授权期间定义关联变化时中止操作', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider), entered = deferred(), gate = deferred()
  await h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('assoc-create'), action: 'start', definition: { name: 'assoc', checkoutId: h.item().checkoutId, command: { argv: ['node'] } } }, signal())
  const definition = (await h.runtime.list(h.access, {}, signal())).definitions[0]!
  const inspect = h.provider.inspect.bind(h.provider)
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, definitionId: definition.id })) }
  }
  h.provider.prepare = prepare
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('assoc-stop'), action: 'stop', targetId: definition.id, expectedRevision: definition.revision }, signal())
  await entered.promise
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: snapshot.items.map(item => ({ ...item, definitionId: brandString<ServiceTypes.ServiceTargetId>('native:other-definition') })) }
  }
  gate.resolve()
  await expect(control).rejects.toThrow('definition association changed')
})

it('在授权期间解析事实被篡改时中止操作', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider), entered = deferred(), gate = deferred()
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, validate: async () => { prepared.description.targets[0]!.revision = brandString<ServiceTypes.ServiceRevision>('tampered') } }
  }
  h.access.authorize = async () => { entered.resolve(); await gate.promise }
  const control = h.runtime.control(h.access, h.request('tampered'), signal())
  await entered.promise
  gate.resolve()
  await expect(control).rejects.toThrow('changed during approval')
  expect(h.executionCount).toBe(0)
})

it('在 Host 处置时中止已发布操作的执行', async () => {
  const h = await fixture(), gate = deferred()
  h.blockExecution(gate.promise)
  const control = h.runtime.control(h.access, h.request('host-abort'), signal())
  await h.started.promise
  const host = Reflect.get(h.runtime, 'host') as AbortController
  host.abort(new Error('Host closed'))
  gate.resolve()
  await expect(control).rejects.toThrow('Host closed')
  const operations = Reflect.get(h.runtime, 'operations') as Map<string, ServiceTypes.ServiceOperation>
  expect([...operations.values()][0]?.state).toBe('failed')
})

it('拒绝属于其他项目或未知检出目录的提供者关联', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  const associations = [
    { id: brandString<ServiceTypes.ServiceTargetId>('native:foreign-assoc'), projectId: brandString<ServiceTypes.ServiceProjectId>('other'), checkoutId: h.baseline.checkouts[0]!.id, providerId: brandString<ServiceTypes.ServiceProviderId>('native'), revision: brandString<ServiceTypes.ServiceRevision>('1') },
    { id: brandString<ServiceTypes.ServiceTargetId>('native:orphan-assoc'), projectId: h.baseline.project.id, checkoutId: brandString<ServiceTypes.ServiceCheckoutId>('absent'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), revision: brandString<ServiceTypes.ServiceRevision>('1') },
  ]
  for (const [index, association] of associations.entries()) {
    h.provider.prepare = async (...args) => {
      const prepared = await prepare(...args)
      return { ...prepared, execute: async opSignal => ({ ...await prepared.execute(opSignal), associations: [association] }) }
    }
    const result = await h.runtime.control(h.access, h.request(`assoc-${index}`), signal())
    expect(result.operation?.state).toBe('failed')
    expect(result.operation?.outcomes[0]?.message).toContain('names another project')
  }
})

it('持久化提供者声明的关联并在重开后按项目过滤', async () => {
  const h = await fixture(), prepare = h.provider.prepare.bind(h.provider)
  const association = { id: brandString<ServiceTypes.ServiceTargetId>('native:association'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, providerId: brandString<ServiceTypes.ServiceProviderId>('native'), revision: brandString<ServiceTypes.ServiceRevision>('1') }
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, execute: async opSignal => ({ ...await prepared.execute(opSignal), associations: [association] }) }
  }
  await h.runtime.control(h.access, h.request('associated'), signal())
  await h.dispose()
  const next = await harness(h.pool)
  cleanup.push(next.dispose)
  const other = await realpath(await mkdtemp(join(tmpdir(), 'service-assoc-other-')))
  cleanup.push(() => rm(other, { recursive: true, force: true }))
  expect((await next.runtime.list(accessFor(other), {}, signal())).items).toEqual([])
  const domain = Reflect.get(next.runtime, 'domain') as { table: (name: 'associations') => { entries: () => Iterable<[string, { id: string }]> } }
  expect([...domain.table('associations').entries()].map(([, value]) => value.id)).toEqual([association.id])
})

it('在订阅者抛出异常时记录警告并继续发布变更', async () => {
  const h = await fixture()
  const warn = vi.spyOn(h.ctx.logger, 'warn')
  cleanup.push(async () => { warn.mockRestore() })
  const listeners = Reflect.get(h.runtime, 'listeners') as Set<() => void>
  const notified: string[] = []
  listeners.add(() => { throw new Error('listener failed') })
  listeners.add(() => { notified.push('notified') })
  await h.runtime.control(h.access, h.request('warn-listener'), signal())
  expect(notified).toContain('notified')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Project service subscriber failed'))
})

it('发布前失败的请求清理不会驱逐后来复用同一身份的新条目', async () => {
  const h = await fixture()
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  h.access.authorize = async () => { entered.resolve(undefined); await gate.promise }
  const request = h.request('reclaimed')
  const control = h.runtime.control(h.access, request, signal())
  await entered.promise
  const requests = Reflect.get(h.runtime, 'requests') as Map<string, { fingerprint: string; published: Promise<unknown>; settled: boolean }>
  const key = JSON.stringify([h.access.actorId, h.baseline.project.id, request.requestId])
  const reclaimed = { fingerprint: 'reclaimed', published: Promise.resolve(), settled: false }
  requests.set(key, reclaimed)
  gate.reject(new Error('denied'))
  await expect(control).rejects.toThrow('denied')
  expect(requests.get(key)).toBe(reclaimed)
})

it('对同一扫描中重复捕获的检出目录去重', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  const captured = [brandString<ServiceTypes.ServiceCheckoutId>('native:captured-one'), brandString<ServiceTypes.ServiceCheckoutId>('native:captured-two')]
  const missing = captured.map(id => ({ ...h.baseline.checkouts[0]!, id, availability: 'missing' as const }))
  const unowned = { ...h.baseline.checkouts[0]!, id: brandString<ServiceTypes.ServiceCheckoutId>('native:captured-unowned') }
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot,
      items: [...snapshot.items, ...captured.map((id, index) => ({ ...h.item(), id: brandString<ServiceTypes.ServiceTargetId>(`native:captured-item-${index}`), checkoutId: id }))],
      capturedCheckouts: [...missing, unowned] }
  }
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.checkouts.filter(item => item.availability === 'missing').map(item => item.id).sort())
    .toEqual([...captured].sort())
  expect(inventory.checkouts.map(item => item.id)).not.toContain(unowned.id)
})

it('在授权期间检出目录消失时中止操作', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-checkout-gone-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'main'), linked = join(root, 'linked')
  await mkdir(main)
  const h = await harness()
  cleanup.push(h.dispose)
  await git(h.ctx, main, 'init')
  await git(h.ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  await git(h.ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  const access = accessFor(main)
  const baseline = await h.runtime.list(access, {}, signal())
  const checkout = baseline.checkouts.find(item => item.path === linked)!
  const item: ServiceItem = { id: brandString<ServiceTypes.ServiceTargetId>('native:linked'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: baseline.project.id, checkoutId: checkout.id, revision: brandString<ServiceTypes.ServiceRevision>('1'), name: 'linked service', kind: 'native', state: 'running', ownership: 'managed', actions: ['stop', 'restart'] }
  const provider: ProjectServiceProvider = {
    id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native',
    inspect: async () => ({ items: [item], groups: [], status: { id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native', state: 'ready', observedAt: Date.now() } }),
    prepare: async (context: ServiceProviderContext, request) => ({
      description: {
        action: request.action, project: context.project,
        checkout: context.checkouts.find(value => value.id === checkout.id)!,
        targets: [{ id: item.id, revision: item.revision }],
      },
      validate: async () => {},
      execute: async () => ({ outcomes: [{ targetId: item.id, state: 'succeeded' as const }] }),
    }),
    logs: async () => ({ chunks: [], gap: false, truncated: false }),
  }
  const fiber = await h.ctx.plugin({ name: 'linked-provider', inject: ['projectServices'], apply(ctx) { ctx.effect(() => ctx.projectServices.registerProvider(provider)) } })
  cleanup.push(() => fiber.dispose())
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  access.authorize = async () => { entered.resolve(undefined); await gate.promise }
  const control = h.runtime.control(access, { requestId: brandString<ServiceTypes.ServiceRequestId>('linked-stop'), action: 'stop', targetId: item.id, expectedRevision: item.revision }, signal())
  await entered.promise
  await rm(linked, { recursive: true, force: true })
  gate.resolve(undefined)
  await expect(control).rejects.toThrow('checkout changed or is missing')
})

it('在授权期间捕获的归属证据消失时拒绝停止', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-checkout-missing-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'main'), linked = join(root, 'linked')
  await mkdir(main)
  const h = await harness()
  cleanup.push(h.dispose)
  await git(h.ctx, main, 'init')
  await git(h.ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  await git(h.ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  const access = accessFor(main)
  const baseline = await h.runtime.list(access, {}, signal())
  const linkedCheckout = baseline.checkouts.find(item => item.path === linked)!
  await rm(linked, { recursive: true, force: true })
  const stopped: ServiceItem = { id: brandString<ServiceTypes.ServiceTargetId>('native:captured'), providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: baseline.project.id, checkoutId: linkedCheckout.id, revision: brandString<ServiceTypes.ServiceRevision>('1'), name: 'captured service', kind: 'native', state: 'running', ownership: 'managed', actions: ['stop'] }
  const survivor: ServiceItem = { ...stopped, id: brandString<ServiceTypes.ServiceTargetId>('native:captured-survivor'), name: 'surviving service' }
  let owned = true
  const provider: ProjectServiceProvider = {
    id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native',
    inspect: async () => ({ items: owned ? [stopped, survivor] : [survivor], groups: [], capturedCheckouts: [linkedCheckout], status: { id: brandString<ServiceTypes.ServiceProviderId>('native'), kind: 'native', state: 'ready', observedAt: Date.now() } }),
    prepare: async (context: ServiceProviderContext, request) => ({
      description: {
        action: request.action, project: context.project,
        checkout: context.checkouts.find(value => value.id === linkedCheckout.id)!,
        targets: [{ id: stopped.id, revision: stopped.revision }],
      },
      validate: async () => {},
      execute: async () => ({ outcomes: [{ targetId: stopped.id, state: 'succeeded' as const }] }),
    }),
    logs: async () => ({ chunks: [], gap: false, truncated: false }),
  }
  const fiber = await h.ctx.plugin({ name: 'captured-provider', inject: ['projectServices'], apply(ctx) { ctx.effect(() => ctx.projectServices.registerProvider(provider)) } })
  cleanup.push(() => fiber.dispose())
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  access.authorize = async () => { entered.resolve(undefined); await gate.promise }
  const control = h.runtime.control(access, { requestId: brandString<ServiceTypes.ServiceRequestId>('captured-stop'), action: 'stop', targetId: stopped.id, expectedRevision: stopped.revision }, signal())
  await entered.promise
  owned = false
  gate.resolve(undefined)
  await expect(control).rejects.toThrow('no captured managed ownership')
})

it('在授权期间分组成员变化时中止操作', async () => {
  const h = await fixture(), inspect = h.provider.inspect.bind(h.provider)
  const member = brandString<ServiceTypes.ServiceTargetId>('native:member')
  const groupId = brandString<ServiceTypes.ServiceTargetId>('native:group')
  let members = [member]
  h.provider.inspect = async (...args) => {
    const snapshot = await inspect(...args)
    return { ...snapshot, items: [...snapshot.items, { ...h.item(), id: member }],
      groups: [{ id: groupId, providerId: brandString<ServiceTypes.ServiceProviderId>('native'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'group', revision: brandString<ServiceTypes.ServiceRevision>('1'), targetIds: members }] }
  }
  const prepare = h.provider.prepare.bind(h.provider)
  h.provider.prepare = async (...args) => {
    const prepared = await prepare(...args)
    return { ...prepared, description: { ...prepared.description, targets: [{ id: member, revision: brandString<ServiceTypes.ServiceRevision>('1') }] } }
  }
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  h.access.authorize = async () => { entered.resolve(undefined); await gate.promise }
  const control = h.runtime.control(h.access, { requestId: brandString<ServiceTypes.ServiceRequestId>('group-members'), action: 'stop', targetId: groupId, expectedRevision: brandString<ServiceTypes.ServiceRevision>('1') }, signal())
  await entered.promise
  members = [...members, brandString<ServiceTypes.ServiceTargetId>('native:late')]
  gate.resolve(undefined)
  await expect(control).rejects.toThrow('group membership changed')
})
