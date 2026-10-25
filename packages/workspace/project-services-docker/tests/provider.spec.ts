import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceControlResult,
  ServiceExecutionIdentity,
  ServiceFeedFrame,
  ServiceInventory,
  ServiceItem,
  ServiceActorId,
  ServiceLogPage,
  ServiceProjectId,
  ServiceProviderContext,
  ServiceProviderId,
  ServiceRequestId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { ProjectServiceRuntime } from '@deepseek-ai/dsh-project-services'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import DockerServiceProvider, { Config, type Config as ConfigType } from '../src/index.ts'
import { containerRevision } from '../src/membership.ts'
import type { DockerCliExecutor, DockerContainerInspect } from '../src/transport.ts'

const projectId = brandString<ServiceProjectId>('proj-1')
const otherProjectId = brandString<ServiceProjectId>('proj-2')
const checkoutId = brandString<ServiceCheckoutId>('chk-1')
const otherCheckoutId = brandString<ServiceCheckoutId>('chk-2')

const checkouts: ServiceCheckout[] = [
  { id: checkoutId, projectId, path: '/workspace/main', availability: 'present' },
]

const otherCheckouts: ServiceCheckout[] = [
  { id: otherCheckoutId, projectId: otherProjectId, path: '/workspace/other', availability: 'present' },
]

const context: ServiceProviderContext = {
  project: { id: projectId, path: '/workspace/main', executionIdentity: brandString<ServiceExecutionIdentity>('local') },
  checkouts,
  definitions: [],
  associations: [],
}

const otherContext: ServiceProviderContext = {
  project: { id: otherProjectId, path: '/workspace/other', executionIdentity: brandString<ServiceExecutionIdentity>('local') },
  checkouts: otherCheckouts,
  definitions: [],
  associations: [],
}

class MockRuntime extends ProjectServiceRuntime {
  public registered = false
  public disposed = false
  registerProvider() {
    this.registered = true
    return async () => {
      this.disposed = true
    }
  }
  async list(): Promise<ServiceInventory> { throw new Error('stub') }
  async logs(): Promise<ServiceLogPage> { throw new Error('stub') }
  async control(): Promise<ServiceControlResult> { throw new Error('stub') }
  async *follow(): AsyncIterable<ServiceFeedFrame> { throw new Error('stub') }
}

function containerInspect(id: string, running: boolean, image = 'nginx'): DockerContainerInspect {
  return {
    Id: id,
    State: {
      Status: running ? 'running' : 'exited',
      Running: running,
      Restarting: false,
      StartedAt: '2026-10-10T00:00:00Z',
      FinishedAt: '',
    },
    Name: `/web-${id}`,
    RestartCount: 0,
    Config: {
      Image: image,
      Labels: {
        'com.docker.compose.project.working_dir': '/workspace/main',
        'com.docker.compose.service': 'web',
      },
    },
    NetworkSettings: { Ports: {} },
    Mounts: [],
  }
}

/** Executor answering daemon, container id list, and inspect calls from scripted facts. */
function scriptedExecutor(facts: {
  daemonId?: string
  daemonFailure?: string
  containerIds?: string[]
  inspects?: DockerContainerInspect[]
}): DockerCliExecutor {
  return {
    async exec(args) {
      if (args[0] === 'info') {
        if (facts.daemonFailure !== undefined) return { stdout: '', stderr: facts.daemonFailure, exitCode: 1 }
        return { stdout: JSON.stringify({ ID: facts.daemonId ?? 'daemon-test' }), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'ps') {
        return { stdout: (facts.containerIds ?? []).join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'inspect') {
        return { stdout: JSON.stringify(facts.inspects ?? []), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  }
}

async function loadProvider(
  executor: DockerCliExecutor,
  overrides: Partial<Record<'scanIntervalMs' | 'freshnessMaxMs' | 'terminationGraceMs' | 'scanTimeoutMs' | 'scanMaxBytes' | 'inspectBatchSize' | 'logTailMaxLines', number>> = {},
) {
  const ctx = new Context()
  new MockRuntime(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(DockerServiceProvider, {
    context: 'my-ctx',
    command: 'docker',
    terminationGraceMs: 5000,
    scanIntervalMs: 100,
    freshnessMaxMs: 1000,
    scanTimeoutMs: 5000,
    scanMaxBytes: 1048576,
    inspectBatchSize: 100,
    logTailMaxLines: 500,
    executor,
    ...overrides,
  })
  return { fiber, provider: ctx.dockerProjectServices }
}

/** Validate a partial configuration; the schema resolves every omitted field from its default. */
function validateConfig(input: Partial<ConfigType>): ConfigType {
  return Config(input as ConfigType)
}

describe('DockerServiceProvider', () => {
  it('registers with ProjectServiceRuntime and discovers ready status', async () => {
    const { fiber, provider } = await loadProvider(scriptedExecutor({
      containerIds: ['c-app'],
      inspects: [containerInspect('c-app', true)],
    }))

    const snapshot = await provider.inspect(context, new AbortController().signal)
    expect(snapshot.status.state).toBe('ready')
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]!.name).toBe('web')
    expect(snapshot.items[0]!.id).toBe('docker:container:c-app')

    await fiber.dispose()
  })

  it('falls back to the subprocess executor when no adapter is configured', async () => {
    const ctx = new Context()
    new MockRuntime(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    // A command that cannot exist: the default executor really spawns it and the failed
    // dispatch surfaces as an unavailable observation instead of a silent success.
    const fiber = await ctx.plugin(DockerServiceProvider, {
      context: '',
      command: 'dsh-docker-cli-that-does-not-exist',
      terminationGraceMs: 5000,
      scanIntervalMs: 100,
      freshnessMaxMs: 1000,
      scanTimeoutMs: 5000,
      scanMaxBytes: 1048576,
      inspectBatchSize: 100,
      logTailMaxLines: 500,
      executor: undefined,
    })
    const snapshot = await ctx.dockerProjectServices.inspect(context, new AbortController().signal)
    expect(snapshot.status.state).toBe('unavailable')
    expect(snapshot.status.reason).toContain('dsh-docker-cli-that-does-not-exist')

    await fiber.dispose()
  })

  it('serves a repeat inspection of the same project from the freshness cache', async () => {
    let scans = 0
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') { scans += 1; return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 } }
        if (args[0] === 'ps') { scans += 1; return { stdout: 'c-app\n', stderr: '', exitCode: 0 } }
        if (args[0] === 'inspect') { scans += 1; return { stdout: JSON.stringify([containerInspect('c-app', true)]), stderr: '', exitCode: 0 } }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { freshnessMaxMs: 60000 })

    const first = await provider.inspect(context, new AbortController().signal)
    const scansAfterFirst = scans
    const second = await provider.inspect(context, new AbortController().signal)
    expect(second).toBe(first)
    expect(scans).toBe(scansAfterFirst)

    await fiber.dispose()
  })

  it('reports unavailable provider status with error reason when daemon is offline', async () => {
    const { fiber, provider } = await loadProvider(scriptedExecutor({ daemonFailure: 'Cannot connect to Docker daemon' }))

    const snapshot = await provider.inspect(context, new AbortController().signal)
    expect(snapshot.status.state).toBe('unavailable')
    expect(snapshot.status.reason).toBe('Docker info failed: Cannot connect to Docker daemon')
    expect(snapshot.items).toEqual([])

    await fiber.dispose()
  })

  it('reports an empty surface when the daemon runs no containers', async () => {
    const seen: string[][] = []
    const { fiber, provider } = await loadProvider({
      async exec(args) {
        seen.push([...args])
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })

    const snapshot = await provider.inspect(context, new AbortController().signal)
    expect(snapshot.status.state).toBe('ready')
    expect(snapshot.items).toEqual([])
    expect(seen.some(call => call[0] === 'inspect')).toBe(false)

    await fiber.dispose()
  })

  it('serves another project a fresh observation instead of the cached one inside the freshness window', async () => {
    const { fiber, provider } = await loadProvider(scriptedExecutor({
      containerIds: ['c-app'],
      inspects: [containerInspect('c-app', true)],
    }), { freshnessMaxMs: 60000 })

    const first = await provider.inspect(context, new AbortController().signal)
    expect(first.items).toHaveLength(1)

    // The other project owns a different checkout tree; the cached project-1 observation
    // must not leak into it as a silently empty or foreign surface.
    const second = await provider.inspect(otherContext, new AbortController().signal)
    expect(second.status.state).toBe('ready')
    expect(second.items).toEqual([])
    expect(second.groups).toEqual([])

    await fiber.dispose()
  })

  it('classifies a non-error dispatch failure in the stale reason', async () => {
    const executor: DockerCliExecutor = {
      async exec() { throw 'daemon exploded' },
    }
    const { fiber, provider } = await loadProvider(executor)

    const snapshot = await provider.inspect(context, new AbortController().signal)
    expect(snapshot.status.state).toBe('unavailable')
    expect(snapshot.status.reason).toBe('daemon exploded')

    await fiber.dispose()
  })

  it('marks Compose groups of the same project as stale after the freshness window', async () => {
    let failing = false
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') {
          if (failing) return { stdout: '', stderr: 'daemon gone', exitCode: 1 }
          return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'ps') return { stdout: 'c-app\n', stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          const container = containerInspect('c-app', true)
          container.Config.Labels['com.docker.compose.project'] = 'myproject'
          container.Config.Labels['com.docker.compose.service'] = 'web'
          return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { freshnessMaxMs: 30 })

    const ready = await provider.inspect(context, new AbortController().signal)
    expect(ready.groups).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 60))

    failing = true
    const stale = await provider.inspect(context, new AbortController().signal)
    expect(stale.status.state).toBe('stale')
    expect(stale.groups).toHaveLength(1)
    expect(stale.groups[0]!.stale).toBe(true)

    await fiber.dispose()
  })

  it('reports the previous observation of the same project as stale after the freshness window', async () => {
    let failing = false
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info' && failing) return { stdout: '', stderr: 'daemon gone', exitCode: 1 }
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 }
        if (args[0] === 'ps') return { stdout: 'c-app\n', stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([containerInspect('c-app', true)]), stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { freshnessMaxMs: 30 })

    const ready = await provider.inspect(context, new AbortController().signal)
    expect(ready.status.state).toBe('ready')
    await new Promise(resolve => setTimeout(resolve, 60))

    failing = true
    const stale = await provider.inspect(context, new AbortController().signal)
    expect(stale.status.state).toBe('stale')
    expect(stale.status.reason).toBe('Docker info failed: daemon gone')
    expect(stale.items).toHaveLength(1)
    expect(stale.items[0]!.stale).toBe(true)

    await fiber.dispose()
  })

  it('prepares an operation before any inspection cached the daemon identity', async () => {
    const container = containerInspect('c-app', false)
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-fresh' }), stderr: '', exitCode: 0 }
        if (args[0] === 'ps') return { stdout: 'c-app\n', stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        if (args[0] === 'start') return { stdout: 'c-app', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-app'),
      providerId: brandString<ServiceProviderId>('docker'),
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'web',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }

    const prepared = await provider.prepare(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-fresh'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, {
      actorId: brandString<ServiceActorId>('user-1'),
      kind: 'human',
      cwd: '/workspace/main',
      executionIdentity: brandString<ServiceExecutionIdentity>('local'),
      authorize: vi.fn().mockResolvedValue(undefined),
      canRead: vi.fn().mockResolvedValue(true),
      revalidate: vi.fn().mockResolvedValue(undefined),
    }, new AbortController().signal)

    // The daemon identity comes from the preparation's own info call, and the frozen
    // membership comes from the inspection the provider runs inside prepare.
    expect(prepared.description.docker).toEqual({
      context: 'my-ctx',
      daemonId: 'daemon-fresh',
      containerIds: ['c-app'],
    })

    await fiber.dispose()
  })

  it('prepares a container operation against the observed snapshot', async () => {
    const inspects = [containerInspect('c-app', false)]
    const { fiber, provider } = await loadProvider(scriptedExecutor({
      containerIds: ['c-app'], inspects,
    }), { freshnessMaxMs: 60000 })

    const snapshot = await provider.inspect(context, new AbortController().signal)
    const item = snapshot.items[0]!
    const prepared = await provider.prepare(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-1'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, {
      actorId: brandString<ServiceActorId>('user-1'),
      kind: 'human',
      cwd: '/workspace/main',
      executionIdentity: brandString<ServiceExecutionIdentity>('local'),
      authorize: vi.fn().mockResolvedValue(undefined),
      canRead: vi.fn().mockResolvedValue(true),
      revalidate: vi.fn().mockResolvedValue(undefined),
    }, new AbortController().signal)

    expect(prepared.description.docker).toEqual({
      context: 'my-ctx',
      daemonId: 'daemon-test',
      containerIds: ['c-app'],
    })
    await prepared.validate(new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes).toEqual([{ targetId: item.id, state: 'succeeded' }])

    await fiber.dispose()
  })

  it('does not poll before any project context was observed', async () => {
    let scans = 0
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] !== undefined) scans += 1
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { scanIntervalMs: 10 })

    const dispose = provider.subscribe(() => {})
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(scans).toBe(0)

    // Disposal with a live subscription clears the poll timer through the provider effect.
    await fiber.dispose()
    dispose()
  })

  it('notifies subscribers only when the observed state changes', async () => {
    let running = true
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 }
        if (args[0] === 'ps') return { stdout: 'c-app\n', stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          const container = containerInspect('c-app', running)
          container.Config.Labels['com.docker.compose.project'] = 'myproject'
          container.Config.Labels['com.docker.compose.service'] = 'web'
          return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { scanIntervalMs: 20, freshnessMaxMs: 1 })

    await provider.inspect(context, new AbortController().signal)
    let notifications = 0
    const dispose = provider.subscribe(() => { notifications += 1 })

    await vi.waitFor(() => { expect(notifications).toBeGreaterThan(0) })
    const afterFirst = notifications
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(notifications).toBe(afterFirst)

    running = false
    await vi.waitFor(() => { expect(notifications).toBeGreaterThan(afterFirst) })

    dispose()
    const afterDispose = notifications
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(notifications).toBe(afterDispose)

    await fiber.dispose()
  })

  it('keeps notifying remaining subscribers when one throws', async () => {
    let running = true
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-test' }), stderr: '', exitCode: 0 }
        if (args[0] === 'ps') return { stdout: 'c-app\n', stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([containerInspect('c-app', running)]), stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const { fiber, provider } = await loadProvider(executor, { scanIntervalMs: 20, freshnessMaxMs: 1 })

    await provider.inspect(context, new AbortController().signal)
    let peer = 0
    const disposeThrower = provider.subscribe(() => { throw new Error('subscriber failed') })
    const disposePeer = provider.subscribe(() => { peer += 1 })

    await vi.waitFor(() => { expect(peer).toBeGreaterThan(0) })
    const before = peer
    running = false
    await vi.waitFor(() => { expect(peer).toBeGreaterThan(before) })

    disposeThrower()
    disposePeer()
    await fiber.dispose()
  })

  it('reads bounded container logs through the transport', async () => {
    const logsOutput = [
      '2026-10-10T12:00:00.000000000Z Line 1: Server started',
      '2026-10-10T12:00:01.000000000Z Line 2: Ready for connections',
    ].join('\n')
    const { fiber, provider } = await loadProvider({
      async exec(args) {
        if (args[0] === 'logs') return { stdout: logsOutput, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })

    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-app'),
      providerId: brandString<ServiceProviderId>('docker'),
      projectId,
      checkoutId,
      revision: brandString<ServiceRevision>('rev-1'),
      name: 'web',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }

    const logPage = await provider.logs(item, { targetId: item.id, maxBytes: 4096 }, new AbortController().signal)
    expect(logPage.chunks).toHaveLength(2)
    expect(logPage.chunks[0]!.text).toBe('Line 1: Server started')
    expect(logPage.chunks[1]!.text).toBe('Line 2: Ready for connections')
    expect(logPage.nextCursor).toBe('2026-10-10T12:00:01.000000000Z')
    expect(logPage.truncated).toBe(false)

    await fiber.dispose()
  })

  it('rejects at load a configuration whose stop grace exceeds the dispatch deadline', async () => {
    const ctx = new Context()
    new MockRuntime(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(DockerServiceProvider, validateConfig({
      terminationGraceMs: 15000,
      scanTimeoutMs: 10000,
      executor: { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } },
    }))).rejects.toThrow('Docker terminationGraceMs (15000) must not exceed scanTimeoutMs (10000)')
  })

  it('rejects a transport executor without an exec function', () => {
    expect(() => validateConfig({ executor: { exec: 'not-a-function' } as never })).toThrow()
  })

  it('applies defaults for every deployment-varying bound', () => {
    expect(validateConfig({})).toEqual({
      context: '',
      command: 'docker',
      terminationGraceMs: 5000,
      scanIntervalMs: 2000,
      freshnessMaxMs: 10000,
      scanTimeoutMs: 10000,
      scanMaxBytes: 10485760,
      inspectBatchSize: 100,
      logTailMaxLines: 1000,
      executor: undefined,
    })
  })
})
