/**
 * Docker and Compose service provider contribution.
 * @module
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  PreparedServiceOperation,
  ProjectServiceProvider,
  ServiceAccess,
  ServiceControlRequest,
  ServiceItem,
  ServiceLogPage,
  ServiceLogsRequest,
  ServiceProjectId,
  ServiceProviderContext,
  ServiceProviderId,
  ServiceProviderSnapshot,
} from '@deepseek-ai/dsh-project-services'
import { DockerTransport, SubprocessDockerCliExecutor, type DockerCliExecutor } from './transport.ts'
import { resolveDockerMemberships } from './membership.ts'
import { prepareDockerOperation } from './operations.ts'
import { fetchDockerLogs } from './logs.ts'

export { DockerTransport, type DockerCliExecutor } from './transport.ts'
export { resolveDockerMemberships } from './membership.ts'
export { prepareDockerOperation } from './operations.ts'
export { fetchDockerLogs } from './logs.ts'

/** Docker provider configuration; every scalar field is a deployment-varying bound settable from cordis.yml. */
export interface Config {
  /** Docker context name passed as `--context` on every CLI call; an empty string uses the Docker CLI's default context. */
  context: string
  /** Docker CLI executable name or path spawned for every transport call. */
  command: string
  /** Grace period in milliseconds for `docker stop` and `docker restart`, rounded to whole seconds with a one-second floor. */
  terminationGraceMs: number
  /** Interval in milliseconds between change notifications while at least one subscriber exists. */
  scanIntervalMs: number
  /** Window in milliseconds a cached snapshot serves `inspect` before the provider re-queries the daemon. */
  freshnessMaxMs: number
  /** Deadline in milliseconds for one Docker CLI dispatch. */
  scanTimeoutMs: number
  /** Per-stream capture cap in bytes for one Docker CLI dispatch. */
  scanMaxBytes: number
  /** Maximum container ids passed to one `docker inspect` invocation. */
  inspectBatchSize: number
  /** Maximum `--tail` lines requested for one container log read. */
  logTailMaxLines: number
  /**
   * Transport execution adapter replacing the default subprocess-backed Docker CLI executor; a
   * runtime seam supplied by embedding code and tests, not a cordis.yml value.
   */
  executor: DockerCliExecutor | undefined
}

const positive = () => z.number().min(1).max(2147483647).step(1)

/** Structural validation of the transport execution adapter seam. */
const executorSchema = z.union([
  z.const(undefined),
  z.transform(z.object({ exec: z.function() }), (value): DockerCliExecutor => value as DockerCliExecutor),
])

/** Validated Docker provider settings. */
export const Config: z<Config> = z.object({
  context: z.string().default(''),
  command: z.string().default('docker'),
  terminationGraceMs: positive().default(5000),
  scanIntervalMs: positive().default(2000),
  freshnessMaxMs: positive().default(10000),
  scanTimeoutMs: positive().default(10000),
  scanMaxBytes: positive().default(10 * 1024 * 1024),
  inspectBatchSize: positive().default(100),
  logTailMaxLines: positive().default(1000),
  executor: executorSchema,
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    dockerProjectServices: DockerServiceProvider
  }
}

/** Docker and Compose provider contribution; Host disposal preserves all running containers. */
export default class DockerServiceProvider extends Service implements ProjectServiceProvider {
  static inject = ['projectServices', 'subprocess']
  static Config = Config
  readonly id: ServiceProviderId = brandString<ServiceProviderId>('docker')
  readonly kind: ProjectServiceProvider['kind'] = 'docker'

  private transport!: DockerTransport
  private cachedDaemonId?: string
  /**
   * Observations kept per project: a snapshot serves `inspect` only for the project it
   * was observed for, so one project never reads another project's container surface.
   */
  private readonly observations = new Map<ServiceProjectId, { snapshot: ServiceProviderSnapshot; observedAt: number }>()
  /** Project contexts seen through `inspect`, re-observed by the change poll. */
  private readonly contexts = new Map<ServiceProjectId, ServiceProviderContext>()
  /** Provider-lifetime cancellation for in-flight polls. */
  private readonly lifecycle = new AbortController()
  private subscribers = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | undefined = undefined
  private polling = false
  private lastNotified: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dockerProjectServices')
    // `docker stop -t` spends its grace inside one CLI invocation, so a stop grace at or
    // beyond the dispatch deadline could never finish: the deadline aborts the CLI first.
    if (config.terminationGraceMs > config.scanTimeoutMs) {
      throw new Error(`Docker terminationGraceMs (${config.terminationGraceMs}) must not exceed scanTimeoutMs (${config.scanTimeoutMs})`)
    }
    this.transport = new DockerTransport(config.context, config.executor ?? new SubprocessDockerCliExecutor(
      this.ctx.subprocess, config.command, config.context, {
        scanTimeoutMs: config.scanTimeoutMs,
        terminationGraceMs: config.terminationGraceMs,
        scanMaxBytes: config.scanMaxBytes,
      },
    ), config.inspectBatchSize)
  }

  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.projectServices.registerProvider(this))
    this.ctx.effect(() => () => {
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.subscribers.clear()
      this.lifecycle.abort(new Error('Docker provider disposed'))
    })
  }

  /**
   * Inspect Docker resources matching the project context without mutating lifecycle.
   * @param context - Resolved project context.
   * @param signal - Scan cancellation.
   * @returns Snapshot of observed Docker items and Compose groups.
   */
  async inspect(context: ServiceProviderContext, signal: AbortSignal): Promise<ServiceProviderSnapshot> {
    const now = Date.now()
    this.contexts.set(context.project.id, context)
    const cached = this.observations.get(context.project.id)
    if (cached !== undefined && now - cached.observedAt < this.config.freshnessMaxMs) {
      return cached.snapshot
    }

    try {
      const daemon = await this.transport.info(signal)
      this.cachedDaemonId = daemon.id

      const containerIds = await this.transport.ps(signal)
      const inspects = containerIds.length > 0 ? await this.transport.inspect(containerIds, signal) : []
      const { items, groups } = resolveDockerMemberships(inspects, context, this.id)

      const snapshot: ServiceProviderSnapshot = {
        items,
        groups,
        status: {
          id: this.id,
          kind: 'docker',
          state: 'ready',
          observedAt: now,
        },
      }
      this.observations.set(context.project.id, { snapshot, observedAt: now })
      return snapshot
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const items = (cached?.snapshot.items ?? []).map(i => ({ ...i, stale: true }))
      const groups = (cached?.snapshot.groups ?? []).map(g => ({ ...g, stale: true }))
      return {
        items,
        groups,
        status: {
          id: this.id,
          kind: 'docker',
          state: cached !== undefined ? 'stale' : 'unavailable',
          observedAt: now,
          reason,
        },
      }
    }
  }

  /**
   * Prepare a mutating operation on a container or Compose group.
   * @param context - Project scope.
   * @param request - Operation request.
   * @param access - Caller authorization context.
   * @param signal - Preparation cancellation.
   * @returns Side-effect-free prepared operation.
   */
  async prepare(
    context: ServiceProviderContext,
    request: ServiceControlRequest,
    access: ServiceAccess,
    signal: AbortSignal,
  ): Promise<PreparedServiceOperation> {
    const daemonId = this.cachedDaemonId ?? (await this.transport.info(signal)).id
    const snapshot = await this.inspect(context, signal)

    return prepareDockerOperation(
      context,
      request,
      access,
      this.transport,
      daemonId,
      snapshot.items,
      snapshot.groups,
      this.config.terminationGraceMs,
      signal,
    )
  }

  /**
   * Fetch bounded logs for an observed Docker target.
   * @param target - Observed Docker service item.
   * @param request - Reader-local cursor and byte cap.
   * @param signal - Read cancellation.
   * @returns Log page.
   */
  async logs(target: ServiceItem, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage> {
    return fetchDockerLogs(target, request, this.transport, this.config.logTailMaxLines, signal)
  }

  /**
   * Subscribe to Docker state changes.
   * @param changed - Change notification callback.
   * @returns Disposer.
   */
  subscribe(changed: () => void): () => void {
    this.subscribers.add(changed)
    if (!this.pollTimer && this.subscribers.size === 1) {
      this.pollTimer = setInterval(() => { void this.poll() }, this.config.scanIntervalMs)
    }

    return () => {
      this.subscribers.delete(changed)
      if (this.subscribers.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = undefined
      }
    }
  }

  /**
   * Re-observe every context seen through `inspect` and notify subscribers only when the
   * combined observation fingerprint changed; one throwing subscriber neither stops the
   * poll timer nor the remaining subscribers.
   */
  private async poll(): Promise<void> {
    if (this.polling || this.contexts.size === 0) return
    this.polling = true
    try {
      const signal = this.lifecycle.signal
      const snapshots = await Promise.all([...this.contexts.values()].map(context => this.inspect(context, signal)))
      const fingerprint = JSON.stringify(snapshots.map(snapshot => [
        snapshot.status.state,
        snapshot.items.map(item => [item.id, item.revision]),
        snapshot.groups.map(group => [group.id, group.revision]),
      ]))
      if (fingerprint === this.lastNotified) return
      this.lastNotified = fingerprint
      for (const subscriber of [...this.subscribers]) {
        try {
          subscriber()
        } catch {
          // A failing subscriber must not abort the poll timer or its peers.
        }
      }
    } finally {
      this.polling = false
    }
  }
}
