/**
 * Local project service inventory, authorization, operation ownership and persistence.
 * @module
 */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ProjectServiceRuntime } from '@deepseek-ai/dsh-project-services'
import type { ProjectServiceProvider, ServiceAccess, ServiceAssociation, ServiceControlRequest, ServiceControlResult, ServiceCheckoutId, ServiceDefinition, ServiceFeedFrame, ServiceInventory, ServiceListRequest, ServiceLogPage, ServiceLogsRequest, ServiceOperation, ServiceProviderContext, ServiceProviderId, ServiceProviderSnapshot, ServiceReadable, ServiceRevision, ServiceOperationId, ServiceTargetId } from '@deepseek-ai/dsh-project-services'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ProjectResolver } from './projects.ts'
import { projectServicesDomain } from './storage.ts'
import { immutableFacts, ServiceTargetLocks } from './operations.ts'
export { RetainedServiceLog } from './logs.ts'

/** Deployment bounds shared with the provider plugins and their consumers. */
export interface Config {
  discoveryIntervalMs: number
  freshnessMaxMs: number
  pageMaxItems: number
  retainedOutputBytes: number
  agentLogMaxBytes: number
  terminationGraceMs: number
  operationWaitMs: number
  scanTimeoutMs: number
  scanMaxBytes: number
  operationMaxRecords: number
}
const positive = () => z.number().min(1).max(2147483647).step(1)
/** Validated local runtime bounds. */
export const Config: z<Config> = z.object({
  discoveryIntervalMs: positive().default(2000), freshnessMaxMs: positive().default(10000),
  pageMaxItems: positive().default(200), retainedOutputBytes: positive().default(1048576),
  agentLogMaxBytes: positive().default(16384), terminationGraceMs: positive().default(5000),
  operationWaitMs: positive().default(30000), scanTimeoutMs: positive().default(10000),
  scanMaxBytes: positive().default(1048576), operationMaxRecords: positive().default(200),
})
interface Published { operation: ServiceOperation; done: Promise<void> }
interface RequestEntry { fingerprint: string; published: Promise<Published>; settled: boolean }

/** Shared runtime; initiator cancellation cannot terminate published services. */
export class LocalProjectServiceRuntime extends ProjectServiceRuntime {
  static inject = ['subprocess', 'storageDomain']
  static Config = Config
  private readonly providers = new Map<ServiceProviderId, ProjectServiceProvider>()
  private readonly listeners = new Set<() => void>()
  private readonly locks = new ServiceTargetLocks()
  private readonly requests = new Map<string, RequestEntry>()
  private readonly operations = new Map<string, ServiceOperation>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly host = new AbortController()
  private domain!: Domain<typeof projectServicesDomain>
  private resolver!: ProjectResolver
  private revision = 0
  private inventoryFingerprint = ''
  private readonly providerSubscriptions = new Map<ServiceProviderId, Set<() => void>>()

  constructor(ctx: Context, private readonly config: Config) { super(ctx) }

  protected async [Service.init](): Promise<void> {
    this.resolver = new ProjectResolver(this.ctx.subprocess, this.config)
    this.domain = await this.ctx.storageDomain.open(projectServicesDomain)
    this.ctx.effect(() => async () => {
      this.listeners.clear()
      this.host.abort(new Error('Project service Host disposed'))
      await Promise.allSettled([...this.active])
      await this.domain.close()
    })
  }

  registerProvider(provider: ProjectServiceProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate project service provider: ${provider.id}`)
    return this.ctx.effect(() => {
      this.providers.set(provider.id, provider)
      this.changed()
      return () => {
        this.providers.delete(provider.id)
        for (const unsubscribe of this.providerSubscriptions.get(provider.id) ?? []) unsubscribe()
        this.providerSubscriptions.delete(provider.id)
        this.changed()
      }
    })
  }

  async list(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): Promise<ServiceInventory> {
    const context = await this.resolve(access, signal)
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, signal)))
    const checkouts = await this.filter(context.checkouts, access, signal)
    const checkoutIds = new Set(checkouts.map(item => item.id))
    const eligible = <T extends { projectId: string; checkoutId: ServiceCheckoutId }>(items: readonly T[]) =>
      items.filter(item => item.projectId === context.project.id && checkoutIds.has(item.checkoutId))
    const items = await this.filter(eligible(scans.flatMap(scan => [...scan.items])), access, signal)
    const definitions = await this.filter(eligible(context.definitions), access, signal)
    const readableIds = new Set([...items, ...definitions].map(item => item.id))
    const groups = await this.filter(
      eligible(scans.flatMap(scan => [...scan.groups])).filter(group => group.targetIds.every(id => readableIds.has(id))),
      access, signal,
    )
    const operations = await this.filter(
      eligible([...this.operations.values()]).filter(operation => operation.targetIds.every(id => readableIds.has(id))),
      access, signal,
    )
    const providers = await this.filter(scans.map(scan => scan.status), access, signal)
    const limit = request.limit ?? this.config.pageMaxItems
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.pageMaxItems) throw new Error('Invalid service page limit')
    const fingerprint = createHash('sha256').update(JSON.stringify([context.project, checkouts, items, definitions, groups, operations, scans.map(scan => [scan.status.id, scan.status.state])])).digest('hex')
    if (this.inventoryFingerprint !== fingerprint) { this.inventoryFingerprint = fingerprint; this.revision++ }
    const revision = brandString<ServiceRevision>(String(this.revision))
    let offset = 0
    if (request.cursor !== undefined) {
      const [cursorRevision, cursorOffset] = request.cursor.split(':')
      if (cursorRevision !== revision || !/^\d+$/.test(cursorOffset ?? '')) throw new Error('Service cursor expired; request a fresh baseline')
      offset = Number(cursorOffset)
    }
    await access.revalidate(signal)
    if (!(await access.canRead(context.project, signal))) throw new Error('Project read denied')
    signal.throwIfAborted()
    return immutableFacts({
      project: context.project, checkouts, items: items.slice(offset, offset + limit), definitions, groups, operations,
      providers, revision,
      ...(offset + limit < items.length ? { nextCursor: brandString(`${revision}:${offset + limit}`) } : {}),
    }) as ServiceInventory
  }

  async logs(access: ServiceAccess, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage> {
    const context = await this.resolve(access, signal)
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, signal)))
    const target = scans.flatMap(scan => [...scan.items]).find(item =>
      item.id === request.targetId && item.projectId === context.project.id)
    const checkout = context.checkouts.find(item => item.id === target?.checkoutId)
    if (target === undefined || checkout === undefined
      || !(await access.canRead(checkout, signal)) || !(await access.canRead(target, signal))) {
      throw new Error('Service unavailable for read')
    }
    const provider = this.providers.get(target.providerId)
    if (provider === undefined) throw new Error('Service provider unavailable')
    const maxBytes = request.maxBytes ?? this.config.agentLogMaxBytes
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.config.agentLogMaxBytes) throw new Error('Invalid service log limit')
    const page = await provider.logs(target, { ...request, maxBytes }, signal)
    await access.revalidate(signal)
    if (!(await access.canRead(context.project, signal)) || !(await access.canRead(checkout, signal))
      || !(await access.canRead(target, signal))) throw new Error('Service read denied')
    signal.throwIfAborted()
    if (page.chunks.some(chunk => chunk.targetId !== target.id)) throw new Error('Provider returned another service log')
    if (Buffer.byteLength(JSON.stringify(page)) > maxBytes) throw new Error('Provider log page exceeded the complete response limit')
    return immutableFacts(page)
  }

  async control(access: ServiceAccess, request: ServiceControlRequest, signal: AbortSignal): Promise<ServiceControlResult> {
    request = immutableFacts(request)
    const context = await this.resolve(access, signal)
    const key = JSON.stringify([access.actorId, context.project.id, request.requestId])
    const fingerprint = JSON.stringify(request)
    let entry = this.requests.get(key)
    if (entry !== undefined && entry.fingerprint !== fingerprint) throw new Error('Service request id already used for another operation')
    if (entry === undefined) {
      this.pruneRequests()
      if (this.requests.size >= this.config.operationMaxRecords) throw new Error('Project service operation capacity reached')
      const published = this.publish(access, context, request, signal)
      entry = { fingerprint, published, settled: false }
      this.requests.set(key, entry)
      const current = entry
      void published.then(result => result.done, () => {}).then(() => { current.settled = true })
    }
    const published = await entry.published
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([published.done, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.config.operationWaitMs)
      })])
    }
    finally { clearTimeout(timer) }
    // Published work owns its signal; read policy still belongs to the current caller.
    const readSignal = this.host.signal
    const inventory = await this.list(access, {}, readSignal)
    const operation = inventory.operations.find(item => item.id === published.operation.id)
    return { ...(operation === undefined ? {} : { operation }), pending: published.operation.state === 'running' }
  }

  async *follow(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): AsyncIterable<ServiceFeedFrame> {
    let wake: (() => void) | undefined
    let dirty = false
    const changed = () => { dirty = true; wake?.() }
    this.listeners.add(changed)
    const unsubscribers = [...this.providers.values()].flatMap((provider) => {
      if (provider.subscribe === undefined) return []
      const remove = provider.subscribe(changed)
      let subscribed = true
      const unsubscribe = () => {
        if (!subscribed) return
        subscribed = false
        remove()
        this.providerSubscriptions.get(provider.id)?.delete(unsubscribe)
      }
      const subscriptions = this.providerSubscriptions.get(provider.id) ?? new Set<() => void>()
      subscriptions.add(unsubscribe)
      this.providerSubscriptions.set(provider.id, subscriptions)
      return [unsubscribe]
    })
    const interval = setInterval(changed, this.config.discoveryIntervalMs)
    const cleanup = () => {
      clearInterval(interval)
      this.listeners.delete(changed)
      for (const unsubscribe of unsubscribers) unsubscribe()
      wake?.()
    }
    signal.addEventListener('abort', cleanup, { once: true })
    this.host.signal.addEventListener('abort', cleanup, { once: true })
    try {
      yield { kind: 'baseline', snapshot: await this.list(access, request, signal) }
      while (!signal.aborted && !this.host.signal.aborted) {
        if (!dirty) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        if (signal.aborted || this.host.signal.aborted) break
        dirty = false
        yield { kind: 'updated', snapshot: await this.list(access, request, signal) }
      }
    } finally {
      signal.removeEventListener('abort', cleanup)
      this.host.signal.removeEventListener('abort', cleanup)
      cleanup()
    }
  }

  private async resolve(access: ServiceAccess, signal: AbortSignal): Promise<ServiceProviderContext> {
    this.host.signal.throwIfAborted()
    signal.throwIfAborted()
    await access.revalidate(signal)
    const resolved = await this.resolver.resolve(access, signal)
    if (!(await access.canRead(resolved.project, signal))) throw new Error('Project read denied')
    return { ...resolved,
      definitions: [...this.domain.table('definitions').entries()]
        .map(([, value]) => value).filter(item => item.projectId === resolved.project.id),
      associations: [...this.domain.table('associations').entries()]
        .map(([, value]) => value).filter(item => item.projectId === resolved.project.id),
    }
  }

  private async inspect(
    provider: ProjectServiceProvider, context: ServiceProviderContext, signal: AbortSignal,
  ): Promise<ServiceProviderSnapshot> {
    try {
      const scanSignal = AbortSignal.any([signal, this.host.signal, AbortSignal.timeout(this.config.scanTimeoutMs)])
      const snapshot = await provider.inspect(context, scanSignal)
      scanSignal.throwIfAborted()
      signal.throwIfAborted()
      if (Date.now() - snapshot.status.observedAt > this.config.freshnessMaxMs) return { items: [], groups: [], status: { ...snapshot.status, state: 'stale', reason: 'Provider observation expired' } }
      return snapshot
    } catch (error) {
      signal.throwIfAborted()
      this.ctx.logger.warn(`Project service provider ${provider.id} inspection failed: ${String(error)}`)
      return { items: [], groups: [], status: { id: provider.id, kind: provider.kind, state: 'stale', observedAt: Date.now(), reason: 'Provider inspection failed' } }
    }
  }

  private async filter<T extends ServiceReadable>(items: readonly T[], access: ServiceAccess, signal: AbortSignal): Promise<T[]> {
    const result: T[] = []
    for (const item of items) if (await access.canRead(item, signal)) result.push(item)
    return result
  }

  private async publish(
    access: ServiceAccess, context: ServiceProviderContext, request: ServiceControlRequest, signal: AbortSignal,
  ): Promise<Published> {
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, signal)))
    const items = scans.flatMap(scan => [...scan.items])
    const groups = scans.flatMap(scan => [...scan.groups])
    const target = 'targetId' in request ? items.find(item => item.id === request.targetId) ?? groups.find(item => item.id === request.targetId) ?? context.definitions.find(item => item.id === request.targetId) : undefined
    if ('targetId' in request && target === undefined) throw new Error('Service target unavailable')
    const provider = target !== undefined && 'providerId' in target ? this.providers.get(target.providerId) : [...this.providers.values()].find(provider => provider.kind === 'native')
    if (provider === undefined) throw new Error('Service provider unavailable')
    const checkoutId = 'definition' in request ? request.definition.checkoutId : target?.checkoutId
    const checkout = context.checkouts.find(checkout => checkout.id === checkoutId)
    if (checkout === undefined || !(await access.canRead(checkout, signal))) throw new Error('Service checkout unavailable for read')
    if (target !== undefined && !(await access.canRead(target, signal))) throw new Error('Service target unavailable for read')
    const targetIds = target !== undefined && 'targetIds' in target ? target.targetIds : target === undefined ? [] : [target.id]
    const lockKeys = targetIds.length === 0 ? [`definition:${context.project.id}:${checkoutId}:${'definition' in request ? request.definition.name : ''}`] : targetIds
    let publish!: (value: Published) => void
    let reject!: (reason: unknown) => void
    const result = new Promise<Published>((resolve, fail) => { publish = resolve; reject = fail })
    const work = this.locks.run(lockKeys, async () => {
      const preparationSignal = AbortSignal.any([signal, this.host.signal])
      preparationSignal.throwIfAborted()
      const fresh = await this.resolve(access, preparationSignal)
      if (fresh.project.id !== context.project.id || !fresh.checkouts.some(item => item.id === checkoutId)) throw new Error('Project checkout changed')
      const freshScan = await this.inspect(provider, fresh, preparationSignal)
      if ('targetId' in request) {
        const current = [...freshScan.items, ...freshScan.groups, ...fresh.definitions].find(item => item.id === request.targetId)
        if (current?.revision !== request.expectedRevision) throw new Error('Service target revision changed')
        if ('targetIds' in current && JSON.stringify(current.targetIds) !== JSON.stringify(targetIds)) throw new Error('Service group membership changed')
      }
      const pendingDefinition: ServiceDefinition | undefined = 'definition' in request
        ? { ...request.definition, id: brandString<ServiceTargetId>(`${provider.id}:definition:${randomUUID()}`),
          projectId: context.project.id, revision: brandString<ServiceRevision>(randomUUID()) }
        : undefined
      const providerContext = pendingDefinition === undefined ? fresh : { ...fresh, pendingDefinition }
      const prepared = await provider.prepare(providerContext, request, access, preparationSignal)
      const description = immutableFacts(prepared.description)
      if (description.project.id !== context.project.id || description.checkout.id !== checkoutId || description.action !== request.action) throw new Error('Provider resolved a different service operation')
      if (targetIds.length > 0 && JSON.stringify(description.targets.map(item => item.id).sort()) !== JSON.stringify([...targetIds].sort())) throw new Error('Provider resolved different service targets')
      await access.authorize(description, preparationSignal)
      preparationSignal.throwIfAborted()
      await access.revalidate(preparationSignal)
      const approvedProject = await this.resolver.resolve(access, preparationSignal)
      if (approvedProject.project.id !== description.project.id || !approvedProject.checkouts.some(item => item.id === description.checkout.id)) throw new Error('Project checkout changed during approval')
      if (this.providers.get(provider.id) !== provider) throw new Error('Service provider was removed during approval')
      await prepared.validate(preparationSignal)
      if (JSON.stringify(prepared.description) !== JSON.stringify(description)) throw new Error('Resolved service operation changed during approval')
      if ('targetId' in request) {
        const afterApproval = await this.inspect(provider, fresh, preparationSignal)
        const currentTargets = [...afterApproval.items, ...fresh.definitions]
        for (const approved of description.targets) {
          if (currentTargets.find(item => item.id === approved.id)?.revision !== approved.revision) throw new Error('Service target revision changed during approval')
        }
        const group = afterApproval.groups.find(item => item.id === request.targetId)
        if (target !== undefined && 'targetIds' in target && (group?.revision !== request.expectedRevision || JSON.stringify(group.targetIds) !== JSON.stringify(targetIds))) throw new Error('Service group revision changed during approval')
      }
      preparationSignal.throwIfAborted()
      if (pendingDefinition !== undefined) {
        await this.domain.table('definitions').put(pendingDefinition.id, pendingDefinition)
      }
      preparationSignal.throwIfAborted()
      const operation: ServiceOperation = { id: brandString<ServiceOperationId>(randomUUID()), requestId: request.requestId, actorId: access.actorId, projectId: context.project.id, checkoutId: checkout.id, action: request.action, targetIds: description.targets.map(item => item.id), state: 'running', outcomes: [] }
      const controller = new AbortController()
      const abort = () => controller.abort(this.host.signal.reason)
      this.host.signal.addEventListener('abort', abort, { once: true })
      this.operations.set(operation.id, operation)
      this.changed()
      let complete!: () => void
      const done = new Promise<void>((resolve) => { complete = resolve })
      publish({ operation, done })
      try {
        const output = await prepared.execute(controller.signal)
        for (const association of output.associations ?? []) await this.saveAssociation(association, context)
        operation.outcomes = output.outcomes
        operation.targetIds = [...new Set([...operation.targetIds, ...output.outcomes.map(item => item.targetId)])]
        operation.state = output.outcomes.every(item => item.state === 'succeeded') ? 'succeeded' : 'failed'
      } catch (error) {
        operation.state = 'failed'
        operation.outcomes = operation.targetIds.map(targetId => ({ targetId, state: 'failed', message: String(error) }))
      } finally {
        this.host.signal.removeEventListener('abort', abort)
        this.changed()
        complete()
      }
    })
    this.active.add(work)
    void work.then(() => { this.active.delete(work) }, (error) => { this.active.delete(work); reject(error) })
    return result
  }

  private async saveAssociation(association: ServiceAssociation, context: ServiceProviderContext): Promise<void> {
    if (association.projectId !== context.project.id || !context.checkouts.some(item => item.id === association.checkoutId)) throw new Error('Provider association names another project')
    await this.domain.table('associations').put(association.id, association)
  }

  private pruneRequests(): void {
    for (const [key, entry] of this.requests) {
      if (this.requests.size < this.config.operationMaxRecords) break
      if (entry.settled) this.requests.delete(key)
    }
    for (const [key, operation] of this.operations) {
      if (this.operations.size < this.config.operationMaxRecords) break
      if (operation.state !== 'running') this.operations.delete(key)
    }
  }

  private changed(): void {
    this.revision++
    for (const listener of this.listeners) {
      try { listener() }
      catch (error) { this.ctx.logger.warn(`Project service subscriber failed: ${String(error)}`) }
    }
  }
}
export default LocalProjectServiceRuntime
