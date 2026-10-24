/**
 * Structured Docker CLI transport and daemon verification.
 * @module
 */
import z from '@deepseek-ai/schemastery'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Bounded daemon identity facts. */
export interface DockerDaemonInfo {
  id: string
  name: string
  serverVersion: string
  operatingSystem: string
}

/** Inspected container state details. */
export interface DockerContainerState {
  Status: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead'
  Running: boolean
  Restarting: boolean
  StartedAt: string
  FinishedAt: string
  Health?: {
    Status: 'healthy' | 'unhealthy' | 'starting' | 'none'
  }
}

/** Mount definition from docker inspect. */
export interface DockerMount {
  Type: 'bind' | 'volume' | 'tmpfs'
  Source: string
}

/** Published port binding entry. */
export interface DockerPortBinding {
  HostPort: string
}

/** Inspected container full record. */
export interface DockerContainerInspect {
  Id: string
  State: DockerContainerState
  Name: string
  RestartCount: number
  Config: {
    Image: string
    Labels: Record<string, string>
  }
  NetworkSettings: {
    Ports: Record<string, readonly DockerPortBinding[] | null>
  }
  Mounts: readonly DockerMount[]
}

/** Daemon identity payload of docker info; the id field is spelled ID or Id depending on the Docker version. */
const daemonIdentitySchema = z.object({
  ID: z.union([z.string().min(1), z.const(undefined)]),
  Id: z.union([z.string().min(1), z.const(undefined)]),
  Name: z.string().default(''),
  ServerVersion: z.string().default(''),
  OperatingSystem: z.string().default(''),
})

/** Container state payload of docker inspect. */
const containerStateSchema = z.object({
  Status: z.union(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
  Running: z.boolean().required(),
  Restarting: z.boolean().required(),
  StartedAt: z.string().default(''),
  FinishedAt: z.string().default(''),
  Health: z.union([
    z.object({ Status: z.union(['healthy', 'unhealthy', 'starting', 'none']) }),
    z.const(undefined),
  ]),
})

/** Mount payload of docker inspect. */
const containerMountSchema = z.object({
  Type: z.union(['bind', 'volume', 'tmpfs']),
  Source: z.string().default(''),
})

/** Published port binding payload of docker inspect. */
const portBindingSchema = z.object({
  HostPort: z.string().default(''),
})

/** Container record payload of docker inspect. */
const containerInspectSchema = z.object({
  Id: z.string().min(1).required(),
  State: containerStateSchema,
  Name: z.string().default(''),
  RestartCount: z.number().default(0),
  Config: z.object({
    Image: z.string().default(''),
    Labels: z.dict(z.string()).default({}),
  }),
  NetworkSettings: z.object({
    Ports: z.dict(z.union([z.array(portBindingSchema), z.const(null)])).default({}),
  }),
  Mounts: z.array(containerMountSchema).default([]),
})

const containerInspectListSchema = z.array(containerInspectSchema)

function parseWirePayload<T>(schema: z<T>, payload: string, label: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new Error(`${label} output is not valid JSON`)
  }
  try {
    // The schema validates the parsed value; the cast only bridges JSON's `unknown`.
    return schema(parsed as T)
  } catch (error) {
    // Schemastery reports validation failures as Error instances whose message carries the field path.
    throw new Error(`${label} output failed validation: ${(error as Error).message}`)
  }
}

/** Bounded dispatch settings for one Docker CLI invocation, owned by the provider configuration. */
export interface DockerCliDispatch {
  /** Wall-clock deadline in milliseconds for one CLI invocation; expiry aborts the spawn. */
  scanTimeoutMs: number
  /** SIGTERM-to-SIGKILL escalation window in milliseconds for one CLI invocation. */
  terminationGraceMs: number
  /** Per-stream capture cap in bytes for one CLI invocation. */
  scanMaxBytes: number
}

/** Transport execution adapter, allowing subprocess or mock dispatch. */
export interface DockerCliExecutor {
  /**
   * Execute docker CLI with exact arguments and bounded cancellation.
   * @param args - CLI arguments excluding context flag.
   * @param signal - Execution cancellation.
   * @returns Trimmed stdout and stderr strings.
   */
  exec(args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** Default subprocess-backed Docker CLI executor. */
export class SubprocessDockerCliExecutor implements DockerCliExecutor {
  /**
   * @param subprocess - Host-lived subprocess provider.
   * @param command - Docker CLI executable name.
   * @param contextName - Docker context to select; empty uses the CLI default.
   * @param dispatch - Deadline, termination grace, and capture bounds for one invocation.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly command: string,
    private readonly contextName: string,
    private readonly dispatch: DockerCliDispatch,
  ) {}

  async exec(args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const fullArgs = this.contextName ? ['--context', this.contextName, ...args] : [...args]
    const deadline = AbortSignal.timeout(this.dispatch.scanTimeoutMs)
    const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const handle = this.subprocess.spawn({
      argv: [this.command, ...fullArgs],
      // Every dispatched argument is a literal flag or an absolute container id, so the
      // child runs from a fixed root instead of inheriting the Host's launch directory.
      cwd: '/',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.dispatch.scanMaxBytes },
        stderr: { maxBytes: this.dispatch.scanMaxBytes },
      },
      graceMs: this.dispatch.terminationGraceMs,
      signal: bounded,
    })
    try {
      const outcome = await handle.done
      bounded.throwIfAborted()
      if (outcome.signal !== null) {
        throw new Error(`Docker CLI was killed by signal ${outcome.signal} before reporting an exit code`)
      }
      if (outcome.exitCode === null) throw new Error('Docker CLI exited without an exit code')
      const stdout = (handle.collected.stdout as SubprocessOutputReader).readFrom(0)
      const stderr = (handle.collected.stderr as SubprocessOutputReader).readFrom(0)
      if (stdout.lossy || stderr.lossy) throw new Error('Docker CLI output exceeded the capture limit')
      return { stdout: stdout.text.trim(), stderr: stderr.text.trim(), exitCode: outcome.exitCode }
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
}

/** Structured transport with verified daemon identity. */
export class DockerTransport {
  constructor(
    readonly contextName: string,
    private readonly executor: DockerCliExecutor,
    private readonly inspectBatchSize: number,
  ) {}

  /**
   * Inspect daemon identity facts.
   * @param signal - Scan cancellation.
   * @returns Verified daemon identity.
   */
  async info(signal?: AbortSignal): Promise<DockerDaemonInfo> {
    const { stdout, stderr, exitCode } = await this.executor.exec(['info', '--format', '{{json .}}'], signal)
    if (exitCode !== 0) throw new Error(`Docker info failed: ${stderr || `exit code ${exitCode}`}`)
    const identity = parseWirePayload(daemonIdentitySchema, stdout, 'Docker daemon identity')
    const id = identity.ID ?? identity.Id
    if (!id) throw new Error('Docker daemon identity is missing or invalid')
    return {
      id,
      name: identity.Name,
      serverVersion: identity.ServerVersion,
      operatingSystem: identity.OperatingSystem,
    }
  }

  /**
   * Query all container ids.
   * @param signal - Scan cancellation.
   * @returns Container ids reported by the daemon.
   */
  async ps(signal?: AbortSignal): Promise<string[]> {
    const { stdout, stderr, exitCode } = await this.executor.exec(['ps', '-a', '-q'], signal)
    if (exitCode !== 0) throw new Error(`Docker ps failed: ${stderr || `exit code ${exitCode}`}`)
    return stdout.split('\n').filter(Boolean)
  }

  /**
   * Inspect one or more containers by exact ID.
   * @param containerIds - Nonempty container IDs to inspect.
   * @param signal - Scan cancellation.
   * @returns Detailed inspect records in request order.
   */
  async inspect(containerIds: readonly string[], signal?: AbortSignal): Promise<DockerContainerInspect[]> {
    if (containerIds.length === 0) return []
    const records: DockerContainerInspect[] = []
    // One CLI invocation receives a bounded id count so a busy host cannot exhaust the
    // argument limit and fail the whole scan.
    for (let start = 0; start < containerIds.length; start += this.inspectBatchSize) {
      const batch = containerIds.slice(start, start + this.inspectBatchSize)
      const { stdout, stderr, exitCode } = await this.executor.exec(['inspect', ...batch], signal)
      if (exitCode !== 0) throw new Error(`Docker inspect failed: ${stderr || `exit code ${exitCode}`}`)
      records.push(...parseWirePayload(containerInspectListSchema, stdout, 'Docker inspect').map(toContainerInspect))
    }
    return records
  }

  /**
   * Start an existing stopped container.
   * @param containerId - Exact container ID.
   * @param signal - Operation cancellation.
   */
  async start(containerId: string, signal?: AbortSignal): Promise<void> {
    const { stderr, exitCode } = await this.executor.exec(['start', containerId], signal)
    if (exitCode !== 0) throw new Error(`Docker start failed for container ${containerId}: ${stderr || `exit code ${exitCode}`}`)
  }

  /**
   * Stop a running container with a specified grace period.
   * @param containerId - Exact container ID.
   * @param graceSeconds - Termination grace period in seconds.
   * @param signal - Operation cancellation.
   */
  async stop(containerId: string, graceSeconds: number, signal?: AbortSignal): Promise<void> {
    const { stderr, exitCode } = await this.executor.exec(['stop', '-t', String(graceSeconds), containerId], signal)
    if (exitCode !== 0) throw new Error(`Docker stop failed for container ${containerId}: ${stderr || `exit code ${exitCode}`}`)
  }

  /**
   * Restart an existing container with a specified grace period.
   * @param containerId - Exact container ID.
   * @param graceSeconds - Termination grace period in seconds.
   * @param signal - Operation cancellation.
   */
  async restart(containerId: string, graceSeconds: number, signal?: AbortSignal): Promise<void> {
    const { stderr, exitCode } = await this.executor.exec(['restart', '-t', String(graceSeconds), containerId], signal)
    if (exitCode !== 0) throw new Error(`Docker restart failed for container ${containerId}: ${stderr || `exit code ${exitCode}`}`)
  }

  /**
   * Fetch bounded timestamps and logs for a container.
   * @param containerId - Exact container ID.
   * @param options - Log query bounds; the tail line count is always explicit.
   * @param signal - Read cancellation.
   * @returns Raw timestamped log output; both container streams are concatenated.
   */
  async logs(containerId: string, options: { tail: number; since?: string }, signal?: AbortSignal): Promise<string> {
    const args = ['logs', '--timestamps', '--tail', String(options.tail)]
    if (options.since !== undefined) args.push('--since', options.since)
    args.push(containerId)
    const { stdout, stderr, exitCode } = await this.executor.exec(args, signal)
    if (exitCode !== 0) throw new Error(`Docker logs failed for container ${containerId}: ${stderr || `exit code ${exitCode}`}`)
    return [stdout, stderr].filter(Boolean).join('\n')
  }
}

function toContainerInspect(record: Schemastery.TypeT<typeof containerInspectSchema>): DockerContainerInspect {
  return {
    Id: record.Id,
    State: {
      Status: record.State.Status,
      Running: record.State.Running,
      Restarting: record.State.Restarting,
      StartedAt: record.State.StartedAt,
      FinishedAt: record.State.FinishedAt,
      ...(record.State.Health !== undefined ? { Health: { Status: record.State.Health.Status } } : {}),
    },
    Name: record.Name,
    RestartCount: record.RestartCount,
    Config: {
      Image: record.Config.Image,
      Labels: record.Config.Labels,
    },
    NetworkSettings: { Ports: record.NetworkSettings.Ports },
    Mounts: record.Mounts.map(mount => ({ Type: mount.Type, Source: mount.Source })),
  }
}
