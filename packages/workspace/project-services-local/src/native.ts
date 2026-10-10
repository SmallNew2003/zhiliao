/** Host-owned native service discovery, launch preparation and process-range lifecycle. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { isAbsolute, relative, sep, dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, PreparedServiceOperation, ServiceAccess, ServiceCheckout, ServiceControlRequest, ServiceDefinition, ServiceItem, ServiceLogsRequest, ServiceLogPage, ServiceNativeLaunch, ServiceNativeLifetime, ServiceNativeProcess, ServiceProviderContext, ServiceProviderId, ServiceProviderSnapshot, ServiceRevision, ServiceTargetId } from '@deepseek-ai/dsh-project-services'
import { RetainedServiceLog } from './logs.ts'
import { immutableFacts } from './operations.ts'
import { NativeDiscovery, type NativeListener } from './native-discovery.ts'
import { resolveHumanLaunch } from './native-execution.ts'
export { createShellServiceExecution } from './native-execution.ts'

/** Validated native resource bounds and explicit human shell selection. */
export interface Config {
  shellPath: string
  retainedOutputBytes: number
  terminationGraceMs: number
  scanTimeoutMs: number
  scanMaxBytes: number
  processInspectionMax: number
  captureIntervalMs: number
  historyMaxInstances: number
}
const positive = () => z.number().min(1).max(2147483647).step(1)
/** Native provider deployment settings. */
export const Config: z<Config> = z.object({
  shellPath: z.string().default('/bin/bash'), retainedOutputBytes: positive().default(1048576),
  terminationGraceMs: positive().default(5000), scanTimeoutMs: positive().default(10000),
  scanMaxBytes: positive().default(1048576), processInspectionMax: positive().default(200),
  captureIntervalMs: positive().default(25), historyMaxInstances: positive().default(200),
})
interface Instance {
  definition: ServiceDefinition
  checkout: ServiceCheckout
  item: ServiceItem
  process: ServiceNativeProcess
  log: RetainedServiceLog
  rangeExited: boolean
  observationFailed: boolean
  lossy: boolean
  timer: ReturnType<typeof setInterval>
  direct: Promise<void>
  settled: Promise<void>
}
const revision = () => brandString<ServiceRevision>(randomUUID())
const targetId = () => brandString<ServiceTargetId>(`native:instance:${randomUUID()}`)

declare module '@deepseek-ai/cordis' { interface Context { nativeProjectServices: NativeServiceProvider } }

/** Native contribution; Session disposal cannot dispose its Host-owned process ranges. */
export class NativeServiceProvider extends Service implements ProjectServiceProvider {
  static inject = ['projectServices', 'subprocess']
  static Config = Config
  readonly id: ServiceProviderId = brandString<ServiceProviderId>('native')
  readonly kind: ProjectServiceProvider['kind'] = 'native'
  /** Host lifetime identity used to construct a sandboxed native execution adapter. */
  readonly lifetime: ServiceNativeLifetime
  private readonly host = new AbortController()
  private readonly instances = new Map<ServiceTargetId, Instance>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private readonly discovery: NativeDiscovery
  private inFlight: Promise<NativeListener[]> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'nativeProjectServices')
    if (!isAbsolute(config.shellPath)) throw new Error('Native human shell must be an absolute executable path')
    this.lifetime = Object.freeze({ signal: this.host.signal, subprocessRealm: ctx[Context.isolate]['subprocess'] })
    this.discovery = new NativeDiscovery(ctx.subprocess, config)
  }
  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.projectServices.registerProvider(this))
    this.ctx.effect(() => async () => {
      this.listeners.clear(); this.host.abort(new Error('Native service Host disposed'))
      await Promise.allSettled([...this.active, ...this.inFlight === undefined ? [] : [this.inFlight]])
      const instances = [...this.instances.values()]
      for (const instance of instances) clearInterval(instance.timer)
      const results = await Promise.allSettled(instances.map(async (instance) => {
        await instance.process.terminate(); await instance.settled
      }))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Native range termination failed')
    })
  }
  /**
   * Observe managed ranges and project-associated external TCP listeners.
   * @param context - Current project and checkout facts.
   * @param signal - Scan cancellation.
   * @returns Listener rows; external processes remain read-only.
   */
  async inspect(context: ServiceProviderContext, signal: AbortSignal): Promise<ServiceProviderSnapshot> {
    const bounded = AbortSignal.any([signal, this.host.signal])
    const listeners = await this.scan(bounded)
    const owned = [...this.instances.values()].filter(instance => instance.item.projectId === context.project.id)
    const ports = new Map<Instance, number[]>()
    const external: ServiceItem[] = []
    for (const listener of listeners) {
      bounded.throwIfAborted()
      let managed: Instance | undefined
      for (const instance of owned) {
        bounded.throwIfAborted()
        if (instance.rangeExited || instance.observationFailed) continue
        if (await instance.process.ownsProcess?.(listener.pid) === true && await this.discovery.current(listener, bounded)) {
          managed = instance; break
        }
      }
      if (managed !== undefined) {
        ports.set(managed, [...ports.get(managed) ?? [], ...listener.ports]); continue
      }
      if (listener.cwd === undefined) continue
      let cwd: string
      try { cwd = await realpathNormalize(listener.cwd) }
      catch (_missingObservedDirectory) { continue }
      const checkout = [...context.checkouts].sort((a, b) => b.path.length - a.path.length).find((value) => {
        const path = relative(value.path, cwd)
        return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
      })
      if (checkout === undefined || await this.containsNestedRepository(cwd, checkout, bounded)) continue
      const identity = createHash('sha256').update(JSON.stringify([context.project.executionIdentity, listener.pid, listener.started])).digest('hex')
      external.push({ id: brandString<ServiceTargetId>(`native:external:${identity}`), providerId: this.id,
        projectId: context.project.id, checkoutId: checkout.id, revision: brandString<ServiceRevision>(createHash('sha256').update(JSON.stringify(listener)).digest('hex')),
        name: listener.name, kind: 'native', state: 'running', ownership: 'external', actions: [], ports: listener.ports,
        detail: 'External native stop is unavailable: no identity-bound signalling capability',
      })
    }
    for (const instance of owned) {
      const current = [...new Set(ports.get(instance) ?? [])].sort((a, b) => a - b)
      if (JSON.stringify(instance.item.ports ?? []) !== JSON.stringify(current)) {
        instance.item = { ...instance.item, ports: current, revision: revision() }
      }
    }
    bounded.throwIfAborted()
    return {
      capturedCheckouts: owned.map(instance => instance.checkout),
      items: [...owned.map(instance => instance.item), ...external], groups: [],
      status: { id: this.id, kind: this.kind, state: 'ready', observedAt: Date.now() } }
  }
  private async containsNestedRepository(cwd: string, checkout: ServiceCheckout, signal: AbortSignal): Promise<boolean> {
    let directory = cwd
    while (directory !== checkout.path) {
      signal.throwIfAborted()
      try { await lstat(join(directory, '.git')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        directory = dirname(directory)
        continue
      }
      return true
    }
    return false
  }
  private async scan(signal: AbortSignal): Promise<NativeListener[]> {
    signal.throwIfAborted(); this.host.signal.throwIfAborted()
    if (this.inFlight === undefined) {
      const shared = this.discovery.scan(AbortSignal.any([this.host.signal, AbortSignal.timeout(this.config.scanTimeoutMs)]))
      this.inFlight = shared
      const clear = (): void => { if (this.inFlight === shared) this.inFlight = undefined }
      void shared.then(clear, clear)
    }
    const shared = this.inFlight
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => {
      cancelled.reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    try { signal.throwIfAborted(); return await Promise.race([shared, cancelled.promise]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  /**
   * Resolve both restart phases and reserve the exact managed identity before authorization.
   * @param context - Current project, captured checkouts and definitions.
   * @param request - Requested action.
   * @param access - Trusted human or agent authority.
   * @param signal - Prepublication cancellation.
   * @returns Side-effect-free operation.
   */
  async prepare(
    context: ServiceProviderContext, request: ServiceControlRequest, access: ServiceAccess, signal: AbortSignal,
  ): Promise<PreparedServiceOperation> {
    signal.throwIfAborted(); this.host.signal.throwIfAborted()
    let current: Instance | undefined
    let definition: ServiceDefinition | undefined
    if ('definition' in request) definition = context.pendingDefinition
    else {
      current = this.instances.get(request.targetId)
      definition = current?.definition ?? context.definitions.find(value => value.id === request.targetId)
      if (current === undefined && definition !== undefined) {
        current = [...this.instances.values()].findLast(value => value.definition.id === definition?.id)
      }
    }
    if (definition === undefined) throw new Error('External native lifecycle control is unavailable')
    if (definition.projectId !== context.project.id) throw new Error('Native definition belongs to another project')
    if (request.action !== 'start' && current === undefined) throw new Error('Native managed instance unavailable')
    if (request.action === 'start' && [...this.instances.values()].some(value => value.definition.id === definition.id && !value.rangeExited)) throw new Error('Native managed range is already running')
    const checkout = context.checkouts.find(value => value.id === definition.checkoutId)
    if (checkout === undefined) throw new Error('Native checkout unavailable')
    if (request.action !== 'stop' && checkout.availability !== 'present') throw new Error('Native checkout is missing')
    let launch: ServiceNativeLaunch | undefined
    if (request.action !== 'stop') {
      if (access.kind === 'agent') {
        const adapter = access.nativeExecution
        if (adapter === undefined || adapter.lifetime.signal !== this.lifetime.signal || adapter.lifetime.subprocessRealm !== this.lifetime.subprocessRealm) throw new Error('Native agent execution must use the Host subprocess lifetime')
        launch = await adapter.resolve(definition.command, checkout.path, signal)
        if (launch.cwd !== checkout.path || JSON.stringify(launch.command.argv.slice(1)) !== JSON.stringify(definition.command.argv.slice(1))) throw new Error('Native adapter resolved different launch facts')
      } else launch = await resolveHumanLaunch(this.ctx.subprocess, definition.command, checkout.path, this.config, signal)
    }
    signal.throwIfAborted()
    const launchId = targetId()
    const id = current?.item.id ?? launchId
    const launchRevision = revision()
    const capturedRevision = current?.item.revision ?? revision()
    const description = immutableFacts({ action: request.action, project: context.project, checkout,
      targets: [
        ...current === undefined ? [] : [{ id, revision: capturedRevision }],
        ...launch === undefined ? [] : [{ id: launchId, revision: launchRevision }],
      ],
      ...launch === undefined ? {} : { nativeLaunch: {
        targetId: launchId, command: launch.command, cwd: launch.cwd, executionIdentity: context.project.executionIdentity,
      } },
    })
    const captured = current
    const validate = async (validationSignal: AbortSignal): Promise<void> => {
      validationSignal.throwIfAborted(); this.host.signal.throwIfAborted()
      if (captured !== undefined && (this.instances.get(id) !== captured || captured.item.revision !== capturedRevision || captured.observationFailed)) throw new Error('Native managed identity changed')
      if (launch !== undefined && this.instances.has(launchId)) throw new Error('Native launch identity already claimed')
      if (request.action !== 'stop' && await realpathNormalize(checkout.path) !== checkout.path) throw new Error('Native checkout changed')
    }
    const execute: PreparedServiceOperation['execute'] = async (operationSignal) => {
      const hostSignal = AbortSignal.any([operationSignal, this.host.signal])
      await validate(hostSignal)
      if (captured !== undefined && request.action !== 'start') {
        await captured.process.terminate()
        await captured.settled
        if (!captured.rangeExited) throw new Error('Native range termination could not be observed')
      }
      if (launch !== undefined) {
        hostSignal.throwIfAborted()
        let process: ServiceNativeProcess | undefined
        try {
          process = await launch.start(hostSignal)
          hostSignal.throwIfAborted()
          this.publish(launchId, definition, checkout, process)
        } catch (error) {
          if (process !== undefined) await process.terminate()
          throw error
        }
      }
      return { outcomes: [
        ...captured === undefined ? [] : [{ targetId: id, state: 'succeeded' as const }],
        ...launch === undefined ? [] : [{ targetId: launchId, state: 'succeeded' as const }],
      ] }
    }
    return { description, validate, execute: (operationSignal) => {
      const pending = execute(operationSignal)
      this.active.add(pending)
      void pending.then(() => this.active.delete(pending), () => this.active.delete(pending))
      return pending
    } }
  }
  private publish(id: ServiceTargetId, definition: ServiceDefinition, checkout: ServiceCheckout, process: ServiceNativeProcess): void {
    const log = new RetainedServiceLog(id, this.config.retainedOutputBytes)
    const instance: Instance = {
      definition: immutableFacts(definition), checkout: immutableFacts(checkout), process, log,
      item: { id, providerId: this.id, projectId: definition.projectId, checkoutId: checkout.id, definitionId: definition.id,
        revision: revision(), name: definition.name, kind: 'native', state: 'running', ownership: 'managed', actions: ['stop', 'restart'], command: definition.command },
      rangeExited: false, observationFailed: false, lossy: false,
      timer: setInterval(() => this.capture(instance), this.config.captureIntervalMs),
      direct: Promise.resolve(), settled: Promise.resolve(),
    }
    this.instances.set(id, instance)
    instance.direct = process.done.then((outcome) => {
      instance.item = { ...instance.item, detail: `Direct command exit: ${String(outcome.exitCode)}, signal: ${String(outcome.signal)}` }
      this.capture(instance); this.changed()
    }, (error: unknown) => {
      instance.item = { ...instance.item, detail: `Native process provider failed: ${String(error)}`, revision: revision() }
      this.capture(instance); this.changed()
    })
    instance.settled = Promise.all([process.waitForExit(), instance.direct]).then(() => {
      instance.rangeExited = true
      instance.item = { ...instance.item, state: 'stopped', actions: ['start'], revision: revision(), ports: [] }
      this.capture(instance); clearInterval(instance.timer); this.pruneHistory(); this.changed()
    }, (error: unknown) => {
      instance.observationFailed = true
      instance.item = { ...instance.item, state: 'unknown', actions: [], revision: revision(), detail: `Native range observation failed: ${String(error)}` }
      this.capture(instance); clearInterval(instance.timer); this.pruneHistory(); this.changed()
      throw error
    })
    void instance.settled.catch(() => {})
    this.changed()
  }
  private pruneHistory(): void {
    const stopped = [...this.instances.values()].filter(instance => instance.rangeExited)
    for (const instance of stopped.slice(0, Math.max(0, stopped.length - this.config.historyMaxInstances))) {
      this.instances.delete(instance.item.id)
    }
  }
  private capture(instance: Instance): void {
    const output = instance.process.readOutput()
    instance.lossy ||= output.lossy
    if (output.text !== '') instance.log.append(output.text)
  }
  /**
   * Read independently retained output from a managed instance.
   * @param target - Read-authorized service row.
   * @param request - Cursor and complete JSON byte limit.
   * @param signal - Read cancellation.
   * @returns Managed output or an explicit external-log limitation.
   */
  async logs(target: ServiceItem, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage> {
    signal.throwIfAborted()
    const instance = this.instances.get(target.id)
    if (instance === undefined) return { chunks: [], gap: false, truncated: false, unavailable: 'External native output is not captured' }
    this.capture(instance)
    const page = instance.log.read(request)
    return { ...page, gap: page.gap || instance.lossy, truncated: page.truncated || instance.lossy }
  }
  /**
   * Subscribe to committed lifecycle changes.
   * @param changed - Host consumer callback.
   * @returns Effect-owned unsubscribe.
   */
  subscribe(changed: () => void): () => void {
    this.listeners.add(changed)
    return () => { this.listeners.delete(changed) }
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() }
      catch (error) { this.ctx.logger.warn(`Native service subscriber failed: ${String(error)}`) }
    }
  }
}
export default NativeServiceProvider
