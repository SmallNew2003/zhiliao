/**
 * Local project service inventory, authorization, operation ownership and persistence.
 * @module
 */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ProjectServiceRuntime } from '@deepseek-ai/dsh-project-services'
import type { ProjectServiceProvider, ServiceAccess, ServiceAssociation, ServiceControlRequest, ServiceControlResult, ServiceCheckout, ServiceCheckoutId, ServiceDefinition, ServiceFeedFrame, ServiceInventory, ServiceListRequest, ServiceLogPage, ServiceLogsRequest, ServiceOperation, ServiceProviderContext, ServiceProviderId, ServiceProviderSnapshot, ServiceReadable, ServiceRevision, ServiceOperationId, ServiceTargetId } from '@deepseek-ai/dsh-project-services'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ProjectResolver } from './projects.ts'
import { projectServicesDomain } from './storage.ts'
import { immutableFacts, ServiceTargetLocks } from './operations.ts'
export { RetainedServiceLog } from './logs.ts'

/** Deployment bounds shared with the provider plugins and their consumers; every field is settable from cordis.yml. */
export interface Config {
  /** Interval in milliseconds between inventory change notifications while a feed subscription exists. */
  discoveryIntervalMs: number
  /** Age in milliseconds after which a provider observation is reported stale with no actions. */
  freshnessMaxMs: number
  /** Maximum service items in one inventory page; a caller-requested limit above it rejects. */
  pageMaxItems: number
  /**
   * Byte cap on captured stdout and stderr retained per managed service range; the native
   * provider applies the identically named bound from its own configuration.
   */
  retainedOutputBytes: number
  /** Default and maximum byte size of one log page; a caller-requested cap above it rejects. */
  agentLogMaxBytes: number
  /**
   * Grace period in milliseconds a managed process may take to exit before forced termination;
   * the Git resolver applies it as the subprocess grace of each bounded Git call.
   */
  terminationGraceMs: number
  /**
   * Time in milliseconds a control request waits for its published operation to settle before
   * returning the current inventory; the operation continues independently.
   */
  operationWaitMs: number
  /**
   * Deadline in milliseconds for one provider inspection or Git resolver call; expiry fails the
   * scan and retains the previous observation as stale.
   */
  scanTimeoutMs: number
  /** Byte cap on stdout and stderr captured from one Git resolver subprocess call. */
  scanMaxBytes: number
  /**
   * Capacity of retained request and operation records; at capacity new control requests reject
   * and the oldest settled records are evicted.
   */
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
  private readonly observations = new Map<ServiceProviderId, Map<string, ServiceProviderSnapshot>>()
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

  registerProvider(provider: ProjectServiceProvider): () => Promise<void> {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate project service provider: ${provider.id}`)
    return this.ctx.effect(() => {
      this.providers.set(provider.id, provider)
      this.changed()
      return () => {
        this.providers.delete(provider.id)
        this.observations.delete(provider.id)
        for (const unsubscribe of this.providerSubscriptions.get(provider.id) ?? []) unsubscribe()
        this.providerSubscriptions.delete(provider.id)
        this.changed()
      }
    })
  }

  async list(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): Promise<ServiceInventory> {
    const context = await this.resolve(access, signal)
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, signal)))
    const facts = immutableFacts({
      context, scans, checkouts: this.knownCheckouts(context, scans), operations: [...this.operations.values()],
    })
    await access.revalidate(signal)
    if (!(await access.canRead(facts.context.project, signal))) throw new Error('Project read denied')
    const checkouts = await this.filter(facts.checkouts, access, signal)
    const checkoutIds = new Set(checkouts.map(item => item.id))
    const missing = new Set(checkouts.filter(item => item.availability === 'missing').map(item => item.id))
    const eligible = <T extends { projectId: string; checkoutId: ServiceCheckoutId }>(items: readonly T[]) =>
      items.filter(item => item.projectId === context.project.id && checkoutIds.has(item.checkoutId))
    const candidates = eligible(facts.scans.flatMap(scan => [...scan.items])).map(item =>
      missing.has(item.checkoutId) ? { ...item, actions: item.actions.filter(action => action === 'stop') } : item)
    const items = await this.filter(immutableFacts(candidates), access, signal)
    const definitions = await this.filter(eligible(facts.context.definitions), access, signal)
    const readableIds = new Set([...items, ...definitions].map(item => item.id))
    const groups = await this.filter(
      eligible(facts.scans.flatMap(scan => [...scan.groups])).filter(group => group.targetIds.every(id => readableIds.has(id))),
      access, signal,
    )
    const operations = await this.filter(
      eligible(facts.operations).filter(operation => operation.targetIds.every(id => readableIds.has(id))),
      access, signal,
    )
    const providers = await this.filter(facts.scans.map(scan => scan.status), access, signal)
    const limit = request.limit ?? this.config.pageMaxItems
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.pageMaxItems) throw new Error('Invalid service page limit')
    const fingerprint = createHash('sha256').update(JSON.stringify([
      access.actorId, access.kind, context.project, checkouts, items, definitions, groups, operations,
      providers.map(({ observedAt: _observedAt, ...status }) => status),
    ])).digest('hex')
    const revision = brandString<ServiceRevision>(fingerprint)
    let offset = 0
    if (request.cursor !== undefined) {
      const [cursorRevision, cursorOffset, extra] = request.cursor.split(':')
      if (extra !== undefined || cursorRevision !== revision || !/^\d+$/.test(cursorOffset ?? '')) {
        throw new Error('Service cursor expired; request a fresh baseline')
      }
      offset = Number(cursorOffset)
      if (!Number.isSafeInteger(offset)) throw new Error('Invalid service cursor offset')
    }
    signal.throwIfAborted()
    return immutableFacts({
      project: facts.context.project, checkouts, items: items.slice(offset, offset + limit), definitions, groups, operations,
      providers, revision,
      ...(offset + limit < items.length ? { nextCursor: brandString(`${revision}:${offset + limit}`) } : {}),
    }) as ServiceInventory
  }

  async logs(access: ServiceAccess, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage> {
    const context = await this.resolve(access, signal)
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, signal)))
    const target = scans.flatMap(scan => [...scan.items]).find(item =>
      item.id === request.targetId && item.projectId === context.project.id)
    const checkout = this.knownCheckouts(context, scans).find(item => item.id === target?.checkoutId)
    if (target === undefined || checkout === undefined
      || !(await access.canRead(checkout, signal)) || !(await access.canRead(target, signal))) {
      throw new Error('Service unavailable for read')
    }
    const provider = this.providers.get(target.providerId)
    if (provider === undefined) throw new Error('Service provider unavailable')
    const maxBytes = request.maxBytes ?? this.config.agentLogMaxBytes
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.config.agentLogMaxBytes) throw new Error('Invalid service log limit')
    const page = immutableFacts(await provider.logs(target, { ...request, maxBytes }, signal))
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
      this.active.add(published)
      entry = { fingerprint, published, settled: false }
      this.requests.set(key, entry)
      const current = entry
      void published.then(() => this.active.delete(published), () => {
        this.active.delete(published)
        // A failure before publication creates no operation, so the same
        // fingerprint stays free to retry instead of awaiting a promise that is
        // already rejected; only a published operation keeps the key idempotent.
        if (this.requests.get(key) === current) this.requests.delete(key)
      })
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
    return operation === undefined ? {} : { operation, pending: operation.state === 'running' }
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
      signal.removeEventListener('abort', cleanup)
      this.host.signal.removeEventListener('abort', cleanup)
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
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- changed() (a closure) sets it.
        if (!dirty) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the wait is awaited.
        if (signal.aborted || this.host.signal.aborted) break
        dirty = false
        yield { kind: 'updated', snapshot: await this.list(access, request, signal) }
      }
    } finally {
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

  private knownCheckouts(context: ServiceProviderContext, scans: readonly ServiceProviderSnapshot[]): ServiceCheckout[] {
    const known = new Map(context.checkouts.map(checkout => [checkout.id, { ...checkout, availability: 'present' as const }]))
    const captured: ServiceCheckout[] = []
    for (const scan of scans) {
      for (const checkout of scan.capturedCheckouts ?? []) {
        if (checkout.projectId !== context.project.id || known.has(checkout.id)) continue
        const owned = scan.items.some(item => item.checkoutId === checkout.id && item.projectId === checkout.projectId
          && item.providerId === scan.status.id && item.ownership === 'managed')
        if (owned && !captured.some(item => item.id === checkout.id)) captured.push({ ...checkout, availability: 'missing' })
      }
    }
    return [...known.values(), ...captured]
  }

  private async inspect(
    provider: ProjectServiceProvider, context: ServiceProviderContext, signal: AbortSignal,
  ): Promise<ServiceProviderSnapshot> {
    const previous = this.observations.get(provider.id)?.get(context.project.id)
    try {
      const scanSignal = AbortSignal.any([signal, this.host.signal, AbortSignal.timeout(this.config.scanTimeoutMs)])
      const observed = await provider.inspect(context, scanSignal)
      const snapshot = immutableFacts({
        ...observed, items: observed.items.map(item => item.stale === true ? { ...item, actions: [] } : item),
      })
      scanSignal.throwIfAborted()
      signal.throwIfAborted()
      if (snapshot.status.state !== 'ready' || Date.now() - snapshot.status.observedAt > this.config.freshnessMaxMs) {
        const retained = snapshot.items.length === 0 && snapshot.groups.length === 0 ? previous ?? snapshot : snapshot
        return this.staleObservation(retained, snapshot.status.reason ?? 'Provider observation expired')
      }
      const projects = this.observations.get(provider.id) ?? new Map<string, ServiceProviderSnapshot>()
      projects.set(context.project.id, snapshot)
      this.observations.set(provider.id, projects)
      return snapshot
    } catch (error) {
      signal.throwIfAborted()
      this.host.signal.throwIfAborted()
      this.ctx.logger.warn(`Project service provider ${provider.id} inspection failed: ${String(error)}`)
      const snapshot = previous ?? { items: [], groups: [], status: {
        id: provider.id, kind: provider.kind, state: 'stale', observedAt: Date.now(),
      } }
      return this.staleObservation(snapshot, 'Provider inspection failed')
    }
  }

  private staleObservation(snapshot: ServiceProviderSnapshot, reason: string): ServiceProviderSnapshot {
    return immutableFacts({
      ...snapshot,
      items: snapshot.items.map(item => ({ ...item, actions: [], stale: true })),
      groups: snapshot.groups.map(group => ({ ...group, stale: true })),
      status: { ...snapshot.status, state: 'stale', reason },
    })
  }

  private async filter<T extends ServiceReadable>(items: readonly T[], access: ServiceAccess, signal: AbortSignal): Promise<T[]> {
    const result: T[] = []
    for (const item of items) if (await access.canRead(item, signal)) result.push(item)
    return result
  }

  private async publish(
    access: ServiceAccess, context: ServiceProviderContext, request: ServiceControlRequest, signal: AbortSignal,
  ): Promise<Published> {
    const preparationSignal = AbortSignal.any([signal, this.host.signal])
    const scans = await Promise.all([...this.providers.values()].map(provider => this.inspect(provider, context, preparationSignal)))
    const items = scans.flatMap(scan => [...scan.items]).filter(item => item.projectId === context.project.id)
    const groups = scans.flatMap(scan => [...scan.groups]).filter(group => group.projectId === context.project.id)
    const target = 'targetId' in request
      ? [...items, ...groups, ...context.definitions].find(item => item.id === request.targetId)
      : undefined
    if ('targetId' in request && target?.revision !== request.expectedRevision) throw new Error('Service target revision changed')
    if (target !== undefined && 'stale' in target && target.stale) throw new Error('Service observation is stale')
    const definition = target !== undefined && !('providerId' in target) ? target : undefined
    const provider = target !== undefined && 'providerId' in target
      ? this.providers.get(target.providerId)
      : [...this.providers.values()].find(provider => provider.kind === 'native')
    if (provider === undefined) throw new Error('Service provider unavailable')
    if (scans.find(scan => scan.status.id === provider.id)?.status.state !== 'ready') throw new Error('Service observation is stale')
    const checkoutId = 'definition' in request ? request.definition.checkoutId : target?.checkoutId
    const checkouts = this.knownCheckouts(context, scans)
    const checkout = checkouts.find(item => item.id === checkoutId)
    if (checkout === undefined || !(await access.canRead(checkout, preparationSignal))) {
      throw new Error('Service checkout unavailable for read')
    }
    if (checkout.availability === 'missing' && request.action !== 'stop') throw new Error('Service checkout is missing')
    if (target !== undefined && !(await access.canRead(target, preparationSignal))) throw new Error('Service target unavailable for read')
    const pendingDefinition: ServiceDefinition | undefined = 'definition' in request
      ? immutableFacts({ ...request.definition, id: brandString<ServiceTargetId>(`${provider.id}:definition:${randomUUID()}`),
        projectId: context.project.id, revision: brandString<ServiceRevision>(randomUUID()) })
      : undefined
    const providerContext = immutableFacts({ ...context, checkouts,
      ...(pendingDefinition === undefined ? {} : { pendingDefinition }),
    })
    const prepared = await provider.prepare(providerContext, request, access, preparationSignal)
    const description = immutableFacts(prepared.description)
    if (description.project.id !== context.project.id || description.checkout.id !== checkout.id
      || description.checkout.path !== checkout.path || description.action !== request.action) {
      throw new Error('Provider resolved a different service operation')
    }
    const targetIds = description.targets.map(item => item.id)
    if (targetIds.length === 0) throw new Error('Provider supplied no resolved service targets')
    if (new Set(targetIds).size !== targetIds.length) throw new Error('Provider supplied duplicate service targets')
    const launchTargetId = description.nativeLaunch?.targetId
    if (launchTargetId !== undefined && (!targetIds.includes(launchTargetId)
      || [...items, ...groups, ...context.definitions].some(item => item.id === launchTargetId))) {
      throw new Error('Native launch target identity is already claimed or unreserved')
    }
    const existingTargetIds = targetIds.filter(id => id !== launchTargetId)
    const requestedIds = target !== undefined && 'targetIds' in target ? target.targetIds : target === undefined ? [] : [target.id]
    if (definition === undefined && target !== undefined
      && JSON.stringify([...existingTargetIds].sort()) !== JSON.stringify([...requestedIds].sort())) {
      throw new Error('Provider resolved different service targets')
    }
    if (definition !== undefined && request.action !== 'start'
      && existingTargetIds.some(id => !items.some(item => item.id === id && item.definitionId === definition.id))) {
      throw new Error('Definition operation resolved an unrelated instance')
    }
    const lockKeys: string[] = [...targetIds, ...requestedIds]
    for (const item of items) {
      if (targetIds.includes(item.id) && item.definitionId !== undefined) lockKeys.push(item.definitionId)
    }
    if (pendingDefinition !== undefined) {
      lockKeys.push(pendingDefinition.id, `definition:${context.project.id}:${checkout.id}:${pendingDefinition.name}`)
    }
    const observedIds = new Set(items.map(item => item.id))
    const validateCurrent = async (): Promise<ServiceProviderContext> => {
      preparationSignal.throwIfAborted()
      if (this.providers.get(provider.id) !== provider) throw new Error('Service provider was removed during approval')
      const fresh = await this.resolve(access, preparationSignal)
      if (fresh.project.id !== context.project.id) throw new Error('Project changed during operation')
      const scan = await this.inspect(provider, fresh, preparationSignal)
      if (scan.status.state !== 'ready') throw new Error('Service observation is stale')
      if (launchTargetId !== undefined && [...scan.items, ...scan.groups, ...fresh.definitions].some(item => item.id === launchTargetId)) {
        throw new Error('Native launch target identity was claimed during preparation')
      }
      const currentCheckouts = this.knownCheckouts(fresh, [scan])
      const currentCheckout = currentCheckouts.find(item => item.id === checkout.id)
      if (currentCheckout === undefined || currentCheckout.path !== checkout.path
        || (currentCheckout.availability === 'missing' && request.action !== 'stop')) {
        throw new Error('Service checkout changed or is missing')
      }
      if (currentCheckout.availability === 'missing' && targetIds.some(id =>
        !scan.items.some(item => item.id === id && item.ownership === 'managed' && item.checkoutId === checkout.id))) {
        throw new Error('Missing checkout has no captured managed ownership')
      }
      if ('targetId' in request) {
        const current = [...scan.items, ...scan.groups, ...fresh.definitions].find(item => item.id === request.targetId)
        if (current?.revision !== request.expectedRevision) throw new Error('Service target revision changed')
        if ('stale' in current && current.stale) throw new Error('Service observation is stale')
        if ('targetIds' in current && JSON.stringify(current.targetIds) !== JSON.stringify(requestedIds)) {
          throw new Error('Service group membership changed')
        }
      }
      for (const approved of description.targets) {
        const current = scan.items.find(item => item.id === approved.id)
        if (current?.stale === true) throw new Error('Resolved service observation is stale')
        if ((current !== undefined || observedIds.has(approved.id)) && current?.revision !== approved.revision) {
          throw new Error('Resolved service target revision changed')
        }
        if (definition !== undefined && current !== undefined && current.definitionId !== definition.id) {
          throw new Error('Service definition association changed')
        }
      }
      return { ...fresh, checkouts: currentCheckouts }
    }
    let publish!: (value: Published) => void
    let reject!: (reason: unknown) => void
    const result = new Promise<Published>((resolve, fail) => { publish = resolve; reject = fail })
    const work = this.locks.run(lockKeys, async () => {
      await validateCurrent()
      await access.authorize(description, preparationSignal)
      preparationSignal.throwIfAborted()
      await access.revalidate(preparationSignal)
      await prepared.validate(preparationSignal)
      if (JSON.stringify(prepared.description) !== JSON.stringify(description)) {
        throw new Error('Resolved service operation changed during approval')
      }
      const currentContext = await validateCurrent()
      preparationSignal.throwIfAborted()
      if (pendingDefinition !== undefined) await this.domain.table('definitions').put(pendingDefinition.id, pendingDefinition)
      preparationSignal.throwIfAborted()
      const operation: ServiceOperation = {
        id: brandString<ServiceOperationId>(randomUUID()), requestId: request.requestId, actorId: access.actorId,
        projectId: context.project.id, checkoutId: checkout.id, action: request.action,
        targetIds, state: 'running', outcomes: [],
      }
      const controller = new AbortController()
      const abort = () => { controller.abort(this.host.signal.reason) }
      this.host.signal.addEventListener('abort', abort, { once: true })
      this.operations.set(operation.id, operation)
      this.changed()
      let complete!: () => void
      const done = new Promise<void>((resolve) => { complete = resolve })
      publish({ operation, done })
      try {
        const output = await prepared.execute(controller.signal)
        for (const association of output.associations ?? []) await this.saveAssociation(association, currentContext)
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
    void work.then(() => { this.active.delete(work) }, (error: unknown) => { this.active.delete(work); reject(error) })
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
    for (const listener of this.listeners) {
      try { listener() }
      catch (error) { this.ctx.logger.warn(`Project service subscriber failed: ${String(error)}`) }
    }
  }
}
export default LocalProjectServiceRuntime
