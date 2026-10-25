import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ProjectServiceProvider,
  ResolvedServiceOperation,
  ServiceAccess,
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceControlRequest,
  ServiceCursor,
  ServiceControlResult,
  ServiceExecutionIdentity,
  ServiceFeedFrame,
  ServiceInventory,
  ServiceItem,
  ServiceListRequest,
  ServiceLogPage,
  ServiceLogsRequest,
  ServiceOperationId,
  ServiceProviderId,
  ServiceProjectId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import ProjectServiceRuntime from '@deepseek-ai/dsh-project-services'
import ProjectServicesController from '../src/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose()
  }
})

/** What one mock runtime recorded about the accesses the controller submitted. */
interface RuntimeRecord {
  /** Accesses submitted so far, in call order. */
  accesses: ServiceAccess[]
  /** How many times the runtime asked an access to authorize a mutating operation. */
  authorizeCalls: number
  /** Set when control must report an unreadable operation status. */
  hideStatus: boolean
  /** Set when control must report an operation that is still running. */
  stillPending: boolean
  /** Set when a listing must report no further page. */
  hideNextCursor: boolean
}

function setupHarness() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())

  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)

  const record: RuntimeRecord = {
    accesses: [], authorizeCalls: 0, hideStatus: false, stillPending: false, hideNextCursor: false,
  }
  let revision = 1
  let running = false
  const checkoutId = brandString<ServiceCheckoutId>('chk-main')
  const checkout: ServiceCheckout = {
    id: checkoutId,
    projectId: brandString<ServiceProjectId>('proj-1'),
    path: '/worktree/main',
    availability: 'present',
  }

  const items: ServiceItem[] = [
    {
      id: brandString<ServiceTargetId>('native:server'),
      providerId: brandString<ServiceProviderId>('native'),
      projectId: brandString<ServiceProjectId>('proj-1'),
      checkoutId,
      revision: brandString<ServiceRevision>(String(revision)),
      name: 'api-server',
      kind: 'native',
      state: 'stopped',
      ownership: 'managed',
      actions: ['start', 'stop', 'restart'],
      ports: [8080],
      detail: 'started by the operator',
      stale: true,
    },
    {
      id: brandString<ServiceTargetId>('docker:db'),
      providerId: brandString<ServiceProviderId>('docker'),
      projectId: brandString<ServiceProjectId>('proj-1'),
      checkoutId,
      revision: brandString<ServiceRevision>('1'),
      name: 'postgres',
      kind: 'docker',
      state: 'running',
      ownership: 'managed',
      actions: ['start', 'stop', 'restart'],
    },
  ]

  /** The operation the mock hands the access's authorize gate. */
  const resolvedOperation = (action: ServiceControlRequest['action']): ResolvedServiceOperation => ({
    action,
    project: {
      id: brandString<ServiceProjectId>('proj-1'),
      path: '/worktree/main',
      executionIdentity: brandString<ServiceExecutionIdentity>('host'),
    },
    checkout,
    targets: [{ id: items[0]!.id, revision: items[0]!.revision }],
  })

  class MockRuntime extends ProjectServiceRuntime {
    async list(access: ServiceAccess, _request: ServiceListRequest, read: AbortSignal): Promise<ServiceInventory> {
      record.accesses.push(access)
      await access.revalidate(read)
      await access.canRead(checkout, read)
      items[0]!.state = running ? 'running' : 'stopped'
      items[0]!.revision = brandString<ServiceRevision>(String(revision))
      return {
        project: {
          id: brandString<ServiceProjectId>('proj-1'),
          path: '/worktree/main',
          executionIdentity: brandString<ServiceExecutionIdentity>('host'),
        },
        checkouts: [checkout],
        items: [...items],
        definitions: [],
        groups: [
          {
            id: brandString<ServiceTargetId>('group:stack'),
            providerId: brandString<ServiceProviderId>('docker'),
            projectId: brandString<ServiceProjectId>('proj-1'),
            checkoutId,
            name: 'compose-stack',
            revision: brandString<ServiceRevision>('1'),
            targetIds: [brandString<ServiceTargetId>('docker:db')],
            stale: true,
          },
          {
            id: brandString<ServiceTargetId>('group:solo'),
            providerId: brandString<ServiceProviderId>('docker'),
            projectId: brandString<ServiceProjectId>('proj-1'),
            checkoutId,
            name: 'solo',
            revision: brandString<ServiceRevision>('1'),
            targetIds: [brandString<ServiceTargetId>('docker:db')],
          },
        ],
        providers: [
          { id: brandString<ServiceProviderId>('native'), kind: 'native', state: 'ready', observedAt: 1000 },
          { id: brandString<ServiceProviderId>('docker'), kind: 'docker', state: 'stale', observedAt: 1000, reason: 'daemon unreachable' },
        ],
        operations: [],
        revision: brandString<ServiceRevision>(String(revision)),
        ...(record.hideNextCursor ? {} : { nextCursor: brandString<ServiceCursor>('cursor-2') }),
      }
    }

    async logs(access: ServiceAccess, req: ServiceLogsRequest, read: AbortSignal): Promise<ServiceLogPage> {
      record.accesses.push(access)
      await access.revalidate(read)
      await access.canRead(checkout, read)
      if (req.targetId === 'native:external') {
        return { chunks: [], truncated: false, gap: false, unavailable: 'External native output is not captured' }
      }
      return {
        chunks: [
          {
            targetId: req.targetId,
            stream: 'stdout',
            text: `Logs for ${req.targetId} (max ${req.maxBytes ?? 'default'})`,
          },
        ],
        truncated: true,
        gap: false,
        nextCursor: brandString<ServiceCursor>('logs-cursor-2'),
      }
    }

    async control(access: ServiceAccess, req: ServiceControlRequest, run: AbortSignal): Promise<ServiceControlResult> {
      record.accesses.push(access)
      await access.revalidate(run)
      await access.canRead(checkout, run)
      // The runtime enforces the revision guard before it authorizes anything.
      const target = 'targetId' in req ? items.find(item => item.id === req.targetId) : items[0]
      if (target === undefined || ('targetId' in req && req.expectedRevision !== target.revision)) {
        throw new Error('Service target revision changed')
      }
      record.authorizeCalls += 1
      await access.authorize(resolvedOperation(req.action), new AbortController().signal)
      if (req.action === 'start') running = true
      if (req.action === 'stop') running = false
      if (req.action === 'restart') running = true
      revision += 1
      items[0]!.revision = brandString<ServiceRevision>(String(revision))

      if (record.hideStatus) return {}
      const targetId = 'targetId' in req ? req.targetId : brandString<ServiceTargetId>('native:server')
      return {
        ...(record.stillPending ? { pending: true } : {}),
        operation: {
          id: brandString<ServiceOperationId>('op-100'),
          requestId: req.requestId,
          actorId: access.actorId,
          projectId: brandString<ServiceProjectId>('proj-1'),
          checkoutId,
          action: req.action,
          targetIds: [targetId],
          state: 'succeeded',
          outcomes: [
            {
              targetId,
              state: 'succeeded',
            },
          ],
        },
      }
    }

    async *follow(access: ServiceAccess): AsyncIterable<ServiceFeedFrame> {
      record.accesses.push(access)
      const inv = await this.list(access, {}, new AbortController().signal)
      yield { kind: 'baseline', snapshot: inv }
      yield { kind: 'updated', snapshot: inv }
    }

    registerProvider(_provider: ProjectServiceProvider) {
      return async () => {}
    }
  }

  new MockRuntime(ctx)
  const controller = new ProjectServicesController(ctx)
  return { controller, ctx, record }
}

const signal = (): AbortSignal => new AbortController().signal

describe('@deepseek-ai/dsh-api-project-services-controller', () => {
  it('lists inventory and transforms brands to wire JSON views', async () => {
    const { controller, record } = setupHarness()

    const res = await controller.list({ cwd: '/worktree/main', cursor: 'cursor-1', limit: 10 }, signal())
    expect(res.project.id).toBe('proj-1')
    expect(res.project.path).toBe('/worktree/main')
    expect(res.checkouts).toHaveLength(1)
    expect(res.checkouts[0]!.id).toBe('chk-main')
    expect(res.items).toHaveLength(2)
    expect(res.items[0]!.id).toBe('native:server')
    expect(res.items[0]!.state).toBe('stopped')
    expect(res.items[1]!.id).toBe('docker:db')
    expect(res.items[1]!.kind).toBe('docker')
    expect(res.groups).toHaveLength(2)
    expect(res.groups[0]!.id).toBe('group:stack')
    expect(res.groups[1]!.stale).toBeUndefined()
    expect(res.providers).toHaveLength(2)
    expect(res.providers[1]!.reason).toBe('daemon unreachable')
    expect(res.items[0]!.detail).toBe('started by the operator')
    expect(res.items[0]!.stale).toBe(true)
    expect(res.items[1]!.ports).toBeUndefined()
    expect(res.groups[0]!.stale).toBe(true)
    expect(res.nextCursor).toBe('cursor-2')
    expect(record.accesses[0]!.actorId).toBe('remote:reader')
    expect(record.authorizeCalls).toBe(0)
  })

  it('reports a final page when the inventory has no further cursor', async () => {
    const { controller, record } = setupHarness()
    record.hideNextCursor = true

    const res = await controller.list({}, signal())
    expect(res.nextCursor).toBeUndefined()
  })

  it('reads bounded logs for an explicit target', async () => {
    const { controller, record } = setupHarness()

    const res = await controller.logs({ targetId: 'native:server', maxBytes: 2048 }, signal())
    expect(res.chunks).toHaveLength(1)
    expect(res.chunks[0]!.targetId).toBe('native:server')
    expect(res.chunks[0]!.text).toContain('max 2048')
    expect(res.truncated).toBe(true)
    expect(res.nextCursor).toBe('logs-cursor-2')
    expect(record.authorizeCalls).toBe(0)

    const paged = await controller.logs(
      { targetId: 'native:server', cursor: 'logs-cursor-2', maxBytes: 512 },
      signal(),
    )
    expect(paged.chunks[0]!.text).toContain('max 512')
  })

  it('reports a log read the runtime cannot answer', async () => {
    const { controller } = setupHarness()
    const res = await controller.logs({ targetId: 'native:external' }, signal())
    expect(res.unavailable).toBe('External native output is not captured')
  })

  it('issues lifecycle control operations and returns outcomes', async () => {
    const { controller } = setupHarness()

    const res = await controller.control(
      {
        action: 'start',
        targetId: 'native:server',
        expectedRevision: '1',
        caller: 'panel',
      },
      signal(),
    )

    expect(res.operation?.id).toBe('op-100')
    expect(res.operation?.action).toBe('start')
    expect(res.operation?.state).toBe('succeeded')
    expect(res.operation?.actorId).toBe('remote:panel')
    expect(res.operation?.outcomes[0]!.targetId).toBe('native:server')

    // Subsequent list confirms state transition
    const inventory = await controller.list({}, signal())
    expect(inventory.items[0]!.state).toBe('running')
    expect(inventory.revision).toBe('2')
  })

  it('reports a running operation and an unreadable status', async () => {
    const { controller, record } = setupHarness()

    record.stillPending = true
    const running = await controller.control(
      { action: 'restart', targetId: 'native:server', expectedRevision: '1', caller: 'panel' },
      signal(),
    )
    expect(running.pending).toBe(true)
    expect(running.operation?.state).toBe('succeeded')

    record.stillPending = false
    record.hideStatus = true
    const unreadable = await controller.control(
      { action: 'stop', targetId: 'native:server', expectedRevision: '2', caller: 'panel' },
      signal(),
    )
    expect(unreadable).toEqual({})
  })

  it('rejects a control whose expected revision no longer matches', async () => {
    const { controller } = setupHarness()

    await controller.control({ action: 'stop', targetId: 'native:server', expectedRevision: '1', caller: 'panel' }, signal())
    await expect(controller.control(
      { action: 'stop', targetId: 'native:server', expectedRevision: '1', caller: 'panel' },
      signal(),
    )).rejects.toThrow(/Service target revision changed/)
  })

  it('rejects a mutating control that omits its caller', async () => {
    const { controller, record } = setupHarness()

    await expect(controller.control(
      { action: 'stop', targetId: 'native:server', expectedRevision: '1' },
      signal(),
    )).rejects.toThrow(/must name its caller/)
    await expect(controller.control(
      { action: 'stop', targetId: 'native:server', expectedRevision: '1', caller: 'not a caller' },
      signal(),
    )).rejects.toThrow(/must name its caller/)
    expect(record.authorizeCalls).toBe(0)
  })

  it('rejects a mutating control that omits its revision guard', async () => {
    const { controller, record } = setupHarness()

    await expect(controller.control(
      { action: 'stop', targetId: 'native:server', caller: 'panel' },
      signal(),
    )).rejects.toThrow(/expected_revision is required/)
    expect(record.authorizeCalls).toBe(0)
  })

  it('rejects a mutating control that omits its target', async () => {
    const { controller, record } = setupHarness()

    await expect(controller.control(
      { action: 'restart', expectedRevision: '1', caller: 'panel' },
      signal(),
    )).rejects.toThrow(/target_id is required/)
    expect(record.authorizeCalls).toBe(0)
  })

  it('rejects a launch definition paired with a non-start action', async () => {
    const { controller, record } = setupHarness()

    await expect(controller.control(
      {
        action: 'stop',
        caller: 'panel',
        definition: { name: 'fixture', checkoutId: 'chk-main', command: ['node', 'server.js'] },
      },
      signal(),
    )).rejects.toThrow(/only valid with action "start"/)
    expect(record.authorizeCalls).toBe(0)
  })

  it('starts a service from a launch definition', async () => {
    const { controller } = setupHarness()

    const res = await controller.control(
      {
        action: 'start',
        caller: 'panel',
        definition: { name: 'fixture', checkoutId: 'chk-main', command: ['node', 'server.js'] },
      },
      signal(),
    )

    expect(res.operation?.action).toBe('start')
    expect(res.operation?.state).toBe('succeeded')
  })

  it('streams feed frames including snapshot and update events', async () => {
    const { controller, record } = setupHarness()

    const frames: unknown[] = []
    for await (const frame of controller.follow({}, signal())) {
      frames.push(frame)
    }
    for await (const frame of controller.follow({ cursor: 'cursor-1', limit: 5 }, signal())) {
      frames.push(frame)
    }

    expect(frames).toHaveLength(4)
    expect((frames[0] as { kind: string }).kind).toBe('baseline')
    expect((frames[1] as { kind: string }).kind).toBe('updated')
    expect((frames[2] as { kind: string }).kind).toBe('baseline')
    expect((frames[3] as { kind: string }).kind).toBe('updated')
    expect(record.authorizeCalls).toBe(0)
  })
})
