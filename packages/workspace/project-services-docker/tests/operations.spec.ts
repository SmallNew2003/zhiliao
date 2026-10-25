import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceAccess,
  ServiceActorId,
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceControlRequest,
  ServiceExecutionIdentity,
  ServiceGroup,
  ServiceItem,
  ServiceProjectId,
  ServiceProviderContext,
  ServiceProviderId,
  ServiceRequestId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { prepareDockerOperation } from '../src/operations.ts'
import { DockerTransport, type DockerCliExecutor, type DockerContainerInspect } from '../src/transport.ts'
import { containerRevision } from '../src/membership.ts'

const projectId = brandString<ServiceProjectId>('proj-1')
const checkoutId = brandString<ServiceCheckoutId>('chk-1')
const providerId = brandString<ServiceProviderId>('docker')

const checkouts: ServiceCheckout[] = [
  { id: checkoutId, projectId, path: '/workspace/main', availability: 'present' },
]

const context: ServiceProviderContext = {
  project: { id: projectId, path: '/workspace/main', executionIdentity: brandString<ServiceExecutionIdentity>('local') },
  checkouts,
  definitions: [],
  associations: [],
}

const mockAccess: ServiceAccess = {
  actorId: brandString<ServiceActorId>('user-1'),
  kind: 'human',
  cwd: '/workspace/main',
  executionIdentity: brandString<ServiceExecutionIdentity>('local'),
  authorize: vi.fn().mockResolvedValue(undefined),
  canRead: vi.fn().mockResolvedValue(true),
  revalidate: vi.fn().mockResolvedValue(undefined),
}

function mockInspect(id: string, running = true): DockerContainerInspect {
  return {
    Id: id,
    State: {
      Status: running ? 'running' : 'exited',
      Running: running,
      Restarting: false,
      StartedAt: '2026-10-10T00:00:00Z',
      FinishedAt: '',
    },
    Name: `/${id}`,
    RestartCount: 0,
    Config: {
      Image: 'my-image',
      Labels: {
        'com.docker.compose.project': 'app',
        'com.docker.compose.service': 'worker',
        'com.docker.compose.project.working_dir': '/workspace/main',
      },
    },
    NetworkSettings: { Ports: {} },
    Mounts: [],
  }
}

describe('Docker Operations', () => {
  it('executes single container lifecycle operation with validated daemon identity', async () => {
    const executed: string[][] = []
    const container = mockInspect('c-single', false)
    const rev = containerRevision(container)

    const executor: DockerCliExecutor = {
      async exec(args) {
        executed.push([...args])
        if (args[0] === 'info') {
          return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'inspect') {
          return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'start') {
          return { stdout: 'c-single', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const transport = new DockerTransport('', executor, 100)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: rev,
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }

    const request: ServiceControlRequest = {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-1'),
      targetId: item.id,
      expectedRevision: rev,
    }

    const prepared = await prepareDockerOperation(
      context, request, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal,
    )

    expect(prepared.description.targets).toEqual([{ id: item.id, revision: rev }])
    expect(prepared.description.docker).toEqual({
      context: '',
      daemonId: 'daemon-1',
      containerIds: ['c-single'],
    })

    await prepared.validate(new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)

    expect(result.outcomes).toEqual([
      { targetId: item.id, state: 'succeeded' },
    ])
    expect(executed).toContainEqual(['start', 'c-single'])
  })

  it('rejects validation when daemon identity changes', async () => {
    const container = mockInspect('c-single', false)
    const rev = containerRevision(container)

    let daemonId = 'daemon-1'
    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') {
          return { stdout: JSON.stringify({ ID: daemonId }), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'inspect') {
          return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const transport = new DockerTransport('', executor, 100)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: rev,
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }

    const request: ServiceControlRequest = {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-2'),
      targetId: item.id,
      expectedRevision: rev,
    }

    const prepared = await prepareDockerOperation(
      context, request, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal,
    )

    // Switch daemon identity
    daemonId = 'daemon-2'
    await expect(prepared.validate(new AbortController().signal)).rejects.toThrow('Docker daemon changed')
  })

  it('rejects preflight when group membership drifts before operation', async () => {
    const c1 = mockInspect('c-rep-1', true)
    const c2 = mockInspect('c-rep-2', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-rep-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const item2: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-rep-2'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c2),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }

    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id, item2.id],
    }

    // Member 2 drifts: revision changes
    const c2Drifted = { ...c2, State: { ...c2.State, Status: 'exited' as const, Running: false } }

    const executor: DockerCliExecutor = {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          return { stdout: JSON.stringify([c1, c2Drifted]), stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const transport = new DockerTransport('', executor, 100)
    const request: ServiceControlRequest = {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-3'),
      targetId: group.id,
      expectedRevision: group.revision,
    }

    const prepared = await prepareDockerOperation(
      context, request, mockAccess, transport, 'daemon-1', [item1, item2], [group], 5000, new AbortController().signal,
    )

    await expect(prepared.validate(new AbortController().signal)).rejects.toThrow('Group member drifted')
  })

  it('rejects a group operation whose observed revision drifted', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp-current'),
      targetIds: [item1.id],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
      },
    }, 100)

    const request: ServiceControlRequest = {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-5'),
      targetId: group.id,
      expectedRevision: brandString<ServiceRevision>('rev-grp-stale'),
    }
    await expect(prepareDockerOperation(
      context, request, mockAccess, transport, 'daemon-1', [item1], [group], 5000, new AbortController().signal,
    )).rejects.toThrow('Docker group revision mismatch')
  })

  it('rejects a request that creates a new definition from scratch', async () => {
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-def'),
      definition: { name: 'web', checkoutId, command: { argv: ['npm', 'run', 'dev'] } },
    }, mockAccess, transport, 'daemon-1', [], [], 5000, new AbortController().signal)).rejects.toThrow(
      'Docker provider does not create new container definitions from scratch',
    )
  })

  it('rejects a target id that names neither a container nor a group', async () => {
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-bad'),
      targetId: brandString<ServiceTargetId>('other:container:c-1'),
      expectedRevision: brandString<ServiceRevision>('rev-1'),
    }, mockAccess, transport, 'daemon-1', [], [], 5000, new AbortController().signal)).rejects.toThrow(
      'Invalid Docker target ID: other:container:c-1',
    )
  })

  it('rejects a container target absent from the observations', async () => {
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-absent'),
      targetId: brandString<ServiceTargetId>('docker:container:c-missing'),
      expectedRevision: brandString<ServiceRevision>('rev-1'),
    }, mockAccess, transport, 'daemon-1', [], [], 5000, new AbortController().signal)).rejects.toThrow(
      'Docker target not found: docker:container:c-missing',
    )
  })

  it('rejects a container target whose observed revision drifted', async () => {
    const container = mockInspect('c-single', false)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-drift'),
      targetId: item.id,
      expectedRevision: brandString<ServiceRevision>('rev-old'),
    }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)).rejects.toThrow(
      'Docker target revision mismatch for docker:container:c-single',
    )
  })

  it('rejects a container target whose checkout is unknown', async () => {
    const container = mockInspect('c-orphan', false)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-orphan'),
      providerId,
      projectId,
      checkoutId: brandString<ServiceCheckoutId>('chk-missing'),
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-orphan'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)).rejects.toThrow(
      'Checkout not found for Docker target: docker:container:c-orphan',
    )
  })

  it('rejects validation when the container disappeared or drifted', async () => {
    const container = mockInspect('c-single', false)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }
    const gone = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        return { stdout: '[]', stderr: '', exitCode: 0 }
      },
    }, 100)
    const preparedGone = await prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-gone'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, gone, 'daemon-1', [item], [], 5000, new AbortController().signal)
    await expect(preparedGone.validate(new AbortController().signal)).rejects.toThrow('Container no longer exists: c-single')

    const drifted = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        return { stdout: JSON.stringify([mockInspect('c-single', true)]), stderr: '', exitCode: 0 }
      },
    }, 100)
    const preparedDrift = await prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-drift2'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, drifted, 'daemon-1', [item], [], 5000, new AbortController().signal)
    await expect(preparedDrift.validate(new AbortController().signal)).rejects.toThrow(
      'Container state drifted before operation for c-single',
    )
  })

  it('rejects execution when the daemon identity changed', async () => {
    const container = mockInspect('c-single', false)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-2' }), stderr: '', exitCode: 0 }
        return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-daemon'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)
    await expect(prepared.execute(new AbortController().signal)).rejects.toThrow(
      'Docker daemon changed: expected daemon-1, got daemon-2',
    )
  })

  it('stops and restarts a single container through the transport', async () => {
    const executed: string[][] = []
    const container = mockInspect('c-single', true)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop', 'restart'],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        executed.push([...args])
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    for (const [index, action] of (['stop', 'restart'] as const).entries()) {
      const prepared = await prepareDockerOperation(context, {
        action,
        requestId: brandString<ServiceRequestId>(`req-${index}`),
        targetId: item.id,
        expectedRevision: item.revision,
      }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)
      const result = await prepared.execute(new AbortController().signal)
      expect(result.outcomes).toEqual([{ targetId: item.id, state: 'succeeded' }])
    }
    expect(executed).toContainEqual(['stop', '-t', '5', 'c-single'])
    expect(executed).toContainEqual(['restart', '-t', '5', 'c-single'])
  })

  it('reports a failed single container action as a target outcome', async () => {
    const container = mockInspect('c-single', true)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        if (args[0] === 'stop') return { stdout: '', stderr: 'cannot stop', exitCode: 1 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-fail'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes).toEqual([{ targetId: item.id, state: 'failed', message: 'Docker stop failed for container c-single: cannot stop' }])
  })

  it('reports a non-error execution failure as a target outcome', async () => {
    const container = mockInspect('c-single', true)
    const item: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-single'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([container]), stderr: '', exitCode: 0 }
        if (args[0] === 'stop') throw 'string failure'
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-string'),
      targetId: item.id,
      expectedRevision: item.revision,
    }, mockAccess, transport, 'daemon-1', [item], [], 5000, new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes).toEqual([{ targetId: item.id, state: 'failed', message: 'string failure' }])
  })

  it('rejects a group target absent from the observations', async () => {
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-nogroup'),
      targetId: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      expectedRevision: brandString<ServiceRevision>('rev-grp'),
    }, mockAccess, transport, 'daemon-1', [], [], 5000, new AbortController().signal)).rejects.toThrow('Docker group not found')
  })

  it('rejects a group whose member or checkout is not observable', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const transport = new DockerTransport('', { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } }, 100)

    const missingMember: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id, brandString<ServiceTargetId>('docker:container:c-grp-absent')],
    }
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-member'),
      targetId: missingMember.id,
      expectedRevision: missingMember.revision,
    }, mockAccess, transport, 'daemon-1', [item1], [missingMember], 5000, new AbortController().signal)).rejects.toThrow(
      'Group member docker:container:c-grp-absent missing from observations',
    )

    const unknownCheckout: ServiceGroup = {
      id: brandString<ServiceTargetId>('docker:group:chk-gone:app:worker'),
      providerId,
      projectId,
      checkoutId: brandString<ServiceCheckoutId>('chk-gone'),
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id],
    }
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-chk'),
      targetId: unknownCheckout.id,
      expectedRevision: unknownCheckout.revision,
    }, mockAccess, transport, 'daemon-1', [item1], [unknownCheckout], 5000, new AbortController().signal)).rejects.toThrow(
      'Checkout not found for Docker group',
    )

    const foreignId = brandString<ServiceTargetId>('native:process:1')
    const foreignItem: ServiceItem = { ...item1, id: foreignId }
    const foreignMember: ServiceGroup = {
      id: brandString<ServiceTargetId>('docker:group:chk-other:app:worker'),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [foreignId],
    }
    await expect(prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-foreign'),
      targetId: foreignMember.id,
      expectedRevision: foreignMember.revision,
    }, mockAccess, transport, 'daemon-1', [foreignItem], [foreignMember], 5000, new AbortController().signal)).rejects.toThrow(
      'Group member is not a container target: native:process:1',
    )
  })

  it('rejects group validation when the daemon changed or members disappeared', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id],
    }
    const daemonChanged = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-9' }), stderr: '', exitCode: 0 }
        return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
      },
    }, 100)
    const preparedDaemon = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-gdaemon'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, daemonChanged, 'daemon-1', [item1], [group], 5000, new AbortController().signal)
    await expect(preparedDaemon.validate(new AbortController().signal)).rejects.toThrow(
      'Docker daemon changed: expected daemon-1, got daemon-9',
    )

    const disappeared = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        return { stdout: '[]', stderr: '', exitCode: 0 }
      },
    }, 100)
    const preparedGone = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-ggone'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, disappeared, 'daemon-1', [item1], [group], 5000, new AbortController().signal)
    await expect(preparedGone.validate(new AbortController().signal)).rejects.toThrow('Group members disappeared before operation')
  })

  it('rejects group execution when the daemon changed', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-3' }), stderr: '', exitCode: 0 }
        return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-gexec-daemon'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, transport, 'daemon-1', [item1], [group], 5000, new AbortController().signal)
    await expect(prepared.execute(new AbortController().signal)).rejects.toThrow(
      'Docker daemon changed: expected daemon-1, got daemon-3',
    )
  })

  it('starts and restarts every group member and skips the rest after a failure', async () => {
    const members = ['c-grp-1', 'c-grp-2', 'c-grp-3'].map(id => mockInspect(id, false))
    const items: ServiceItem[] = members.map(container => ({
      id: brandString<ServiceTargetId>(`docker:container:${container.Id}`),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(container),
      name: 'worker',
      kind: 'docker',
      state: 'stopped',
      ownership: 'external',
      actions: ['start'],
    }))
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: items.map(item => item.id),
    }
    const executed: string[][] = []
    const transport = new DockerTransport('', {
      async exec(args) {
        executed.push([...args])
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          const ids = args.slice(1)
          return { stdout: JSON.stringify(members.filter(member => ids.includes(member.Id))), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'start' && args[1] === 'c-grp-2') return { stdout: '', stderr: 'start failed', exitCode: 1 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'start',
      requestId: brandString<ServiceRequestId>('req-grp-start'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, transport, 'daemon-1', items, [group], 5000, new AbortController().signal)

    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes.map(outcome => outcome.state)).toEqual(['succeeded', 'failed', 'unattempted'])
    expect(result.outcomes[1]!.message).toBe('Docker start failed for container c-grp-2: start failed')
    expect(result.outcomes[2]!.message).toBe('Skipped after prior member failure')
    expect(executed).toContainEqual(['start', 'c-grp-1'])
    expect(executed).not.toContainEqual(['start', 'c-grp-3'])

    const restarted = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          const ids = args.slice(1)
          return { stdout: JSON.stringify(members.map(member => ({ ...member, State: { ...member.State, Running: true } })).filter(member => ids.includes(member.Id))), stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const preparedRestart = await prepareDockerOperation(context, {
      action: 'restart',
      requestId: brandString<ServiceRequestId>('req-grp-restart'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, restarted, 'daemon-1', items, [group], 5000, new AbortController().signal)
    await preparedRestart.validate(new AbortController().signal)
    const restartResult = await preparedRestart.execute(new AbortController().signal)
    expect(restartResult.outcomes.every(outcome => outcome.state === 'succeeded')).toBe(true)
  })

  it('reports a non-error group member failure as a target outcome', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id],
    }
    const transport = new DockerTransport('', {
      async exec(args) {
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
        if (args[0] === 'stop') throw 'group string failure'
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-gstring'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, transport, 'daemon-1', [item1], [group], 5000, new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes).toEqual([{ targetId: item1.id, state: 'failed', message: 'group string failure' }])
  })

  it('reports a group member whose container id was replaced as failed', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const c2 = mockInspect('c-grp-2', true)
    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const item2: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-2'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c2),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp'),
      targetIds: [item1.id, item2.id],
    }
    const executed: string[][] = []
    const transport = new DockerTransport('', {
      async exec(args) {
        executed.push([...args])
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          const ids = args.slice(1)
          // The second member's id now names a different container.
          if (ids.includes('c-grp-2')) {
            return { stdout: JSON.stringify([mockInspect('c-grp-replacement', true)]), stderr: '', exitCode: 0 }
          }
          return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'stop') return { stdout: args[args.length - 1]!, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }, 100)
    const prepared = await prepareDockerOperation(context, {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-replaced'),
      targetId: group.id,
      expectedRevision: group.revision,
    }, mockAccess, transport, 'daemon-1', [item1, item2], [group], 5000, new AbortController().signal)

    const result = await prepared.execute(new AbortController().signal)
    expect(result.outcomes).toEqual([
      { targetId: item1.id, state: 'succeeded' },
      { targetId: item2.id, state: 'failed', message: 'Container c-grp-2 was replaced or removed' },
    ])
    expect(executed).toContainEqual(['stop', '-t', '5', 'c-grp-1'])
    expect(executed.some(call => call.includes('c-grp-replacement') && call[0] === 'stop')).toBe(false)
  })

  it('does not act on a replacement container after the first group member succeeds', async () => {
    const c1 = mockInspect('c-grp-1', true)
    const c2Original = mockInspect('c-grp-2', true)

    const item1: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-1'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c1),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }
    const item2: ServiceItem = {
      id: brandString<ServiceTargetId>('docker:container:c-grp-2'),
      providerId,
      projectId,
      checkoutId,
      revision: containerRevision(c2Original),
      name: 'worker',
      kind: 'docker',
      state: 'running',
      ownership: 'external',
      actions: ['stop'],
    }

    const group: ServiceGroup = {
      id: brandString<ServiceTargetId>(`docker:group:${checkoutId}:app:worker`),
      providerId,
      projectId,
      checkoutId,
      name: 'worker',
      revision: brandString<ServiceRevision>('rev-grp-2'),
      targetIds: [item1.id, item2.id],
    }

    const c2ReplacementState = 'running'
    const executed: string[][] = []

    const executor: DockerCliExecutor = {
      async exec(args) {
        executed.push([...args])
        if (args[0] === 'info') return { stdout: JSON.stringify({ ID: 'daemon-1' }), stderr: '', exitCode: 0 }
        if (args[0] === 'inspect') {
          // If inspecting c-grp-1, return c1
          if (args[1] === 'c-grp-1' && args.length === 2) {
            return { stdout: JSON.stringify([c1]), stderr: '', exitCode: 0 }
          }
          // After c1 stopped, c-grp-2 was replaced by a new container c-grp-3!
          if (args[1] === 'c-grp-2' && args.length === 2) {
            return { stdout: JSON.stringify([]), stderr: 'No such container: c-grp-2', exitCode: 1 }
          }
          // For validate, return both originals
          return { stdout: JSON.stringify([c1, c2Original]), stderr: '', exitCode: 0 }
        }
        if (args[0] === 'stop') {
          return { stdout: args[args.length - 1]!, stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }

    const transport = new DockerTransport('', executor, 100)
    const request: ServiceControlRequest = {
      action: 'stop',
      requestId: brandString<ServiceRequestId>('req-4'),
      targetId: group.id,
      expectedRevision: group.revision,
    }

    const prepared = await prepareDockerOperation(
      context, request, mockAccess, transport, 'daemon-1', [item1, item2], [group], 5000, new AbortController().signal,
    )

    await prepared.validate(new AbortController().signal)
    const result = await prepared.execute(new AbortController().signal)

    // First member succeeded, second member failed (replacement/missing), stopped further attempts
    expect(result.outcomes.map(item => item.state)).toEqual(['succeeded', 'failed'])
    expect(executed).toContainEqual(['stop', '-t', '5', 'c-grp-1'])
    // replacement container was NOT touched
    expect(executed.some(call => call.includes('c-grp-3'))).toBe(false)
    expect(c2ReplacementState).toBe('running')
  })
})
