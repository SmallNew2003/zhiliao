import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ProjectServiceProvider,
  ResolvedServiceOperation,
  ServiceAccess,
  ServiceActorId,
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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ToolProjectServices from '../src/index.ts'

let callCounter = 0

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose()
  }
})

/** Facts every mock inventory and operation shares. */
const checkoutId = brandString<ServiceCheckoutId>('chk-1')
const projectId = brandString<ServiceProjectId>('proj-1')
const checkout: ServiceCheckout = {
  id: checkoutId,
  projectId,
  path: '/worktree/main',
  availability: 'present',
}

/** The approval payload service_control submits to the approval service for a mutating action. */
interface ApprovalRequestView {
  agent: Agent
  toolName: string
  callId: ToolRunContext['callId']
  reason: string
  signal: AbortSignal
}

/** What one mock runtime recorded about the calls the tools submitted. */
interface RuntimeRecord {
  /** Accesses submitted so far, in call order. */
  accesses: ServiceAccess[]
  /** How many times the runtime asked an access to authorize a mutating operation. */
  authorizeCalls: number
  /** Set when control must report an unreadable operation status. */
  hideStatus: boolean
  /** Set when control must report an operation that carries no per-target outcome. */
  emptyOutcomes: boolean
  /** Set when a log read reports retained output the runtime already discarded. */
  unavailableLogs: boolean
}

/**
 * Mock runtime that records the access each call submits, so a spec can assert
 * which calls authorize and which carry the native launch adapter. It reads
 * through the access exactly as the real runtime does before answering.
 */
function mockRuntime(ctx: Context, record: RuntimeRecord) {
  let revision = 1
  let running = false

  const items: ServiceItem[] = [
    {
      id: brandString<ServiceTargetId>('native:web'),
      providerId: brandString<ServiceProviderId>('native'),
      projectId,
      checkoutId,
      revision: brandString<ServiceRevision>(String(revision)),
      name: 'web-server',
      kind: 'native',
      state: 'stopped',
      ownership: 'managed',
      actions: ['start', 'stop', 'restart'],
      ports: [3000],
      detail: 'started by the operator',
      stale: true,
    },
    {
      id: brandString<ServiceTargetId>('docker:db'),
      providerId: brandString<ServiceProviderId>('docker'),
      projectId,
      checkoutId,
      revision: brandString<ServiceRevision>('1'),
      name: 'postgres',
      kind: 'docker',
      state: 'running',
      ownership: 'managed',
      actions: ['start', 'stop', 'restart'],
      ports: [5432],
    },
    {
      id: brandString<ServiceTargetId>('native:cache'),
      providerId: brandString<ServiceProviderId>('native'),
      projectId,
      checkoutId,
      revision: brandString<ServiceRevision>('3'),
      name: 'cache',
      kind: 'native',
      state: 'running',
      ownership: 'external',
      actions: [],
    },
  ]

  class MockProjectServiceRuntime extends ProjectServiceRuntime {
    async list(access: ServiceAccess, _request: ServiceListRequest, signal: AbortSignal): Promise<ServiceInventory> {
      record.accesses.push(access)
      await access.revalidate(signal)
      items[0]!.state = running ? 'running' : 'stopped'
      items[0]!.revision = brandString<ServiceRevision>(String(revision))
      return {
        project: {
          id: projectId,
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
            projectId,
            checkoutId,
            name: 'compose-stack',
            revision: brandString<ServiceRevision>('1'),
            targetIds: [brandString<ServiceTargetId>('docker:db')],
            stale: true,
          },
          {
            id: brandString<ServiceTargetId>('group:solo'),
            providerId: brandString<ServiceProviderId>('docker'),
            projectId,
            checkoutId,
            name: 'solo',
            revision: brandString<ServiceRevision>('1'),
            targetIds: [brandString<ServiceTargetId>('docker:db')],
          },
        ],
        providers: [
          { id: brandString<ServiceProviderId>('native'), kind: 'native', state: 'ready', observedAt: Date.now() },
          { id: brandString<ServiceProviderId>('docker'), kind: 'docker', state: 'stale', observedAt: Date.now(), reason: 'daemon unreachable' },
        ],
        operations: [],
        revision: brandString<ServiceRevision>(String(revision)),
        nextCursor: brandString<ServiceCursor>('cursor-2'),
      }
    }

    async logs(access: ServiceAccess, _req: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage> {
      record.accesses.push(access)
      await access.revalidate(signal)
      if (record.unavailableLogs) {
        return { chunks: [], truncated: false, gap: true, unavailable: 'External native output is not captured' }
      }
      return {
        chunks: [{ targetId: brandString<ServiceTargetId>('native:web'), stream: 'stdout', text: 'output' }],
        truncated: true,
        gap: false,
        nextCursor: brandString<ServiceCursor>('logs-cursor-2'),
      }
    }

    async control(
      access: ServiceAccess,
      req: ServiceControlRequest,
      signal: AbortSignal,
    ): Promise<ServiceControlResult> {
      record.accesses.push(access)
      await access.canRead(checkout, signal)
      const op: ResolvedServiceOperation = {
        action: req.action,
        project: {
          id: projectId,
          path: '/worktree/main',
          executionIdentity: brandString<ServiceExecutionIdentity>('host'),
        },
        checkout,
        targets: [{ id: brandString<ServiceTargetId>('native:web'), revision: brandString<ServiceRevision>(String(revision)) }],
      }
      record.authorizeCalls += 1
      await access.authorize(op, signal)
      if (req.action === 'start') running = true
      if (req.action === 'stop') running = false
      if (req.action === 'restart') running = true
      revision += 1
      if (record.hideStatus) return {}
      return {
        operation: {
          id: brandString<ServiceOperationId>('op-1'),
          requestId: req.requestId,
          actorId: brandString<ServiceActorId>('agent'),
          projectId,
          checkoutId,
          action: req.action,
          targetIds: [brandString<ServiceTargetId>('native:web')],
          state: 'succeeded' as const,
          outcomes: record.emptyOutcomes
            ? []
            : [
              { targetId: brandString<ServiceTargetId>('native:web'), state: 'succeeded' as const, message: 'range exited' },
              { targetId: brandString<ServiceTargetId>('native:cache'), state: 'failed' as const },
            ],
        },
      }
    }

    async *follow(): AsyncIterable<ServiceFeedFrame> {}
    registerProvider(_provider: ProjectServiceProvider) { return async () => {} }
  }

  return new MockProjectServiceRuntime(ctx)
}

/** Build a registry-shaped ToolRunContext; agent is set only when a test exercises authorization. */
function makeExec(name: string, agent?: Agent): ToolRunContext {
  const callId = brandString<ToolRunContext['callId']>(`call-${++callCounter}`)
  return {
    signal: new AbortController().signal,
    callId,
    rootCallId: callId,
    name,
    arguments: {},
    token: Symbol('dsh.tool.execution') as ToolRunContext['token'],
    deferContext: () => {},
    concludeTurn: () => {},
    ...(agent !== undefined ? { agent } : {}),
  }
}

/** One context with the prompt, tool registry, and a recording mock runtime. */
async function setup(config: ToolProjectServices.Config = {}) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const record: RuntimeRecord = {
    accesses: [], authorizeCalls: 0, hideStatus: false, emptyOutcomes: false, unavailableLogs: false,
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  mockRuntime(ctx, record)
  await ctx.plugin(ToolProjectServices, config)
  return { ctx, record }
}

/** Mount an approval service that answers with the outcome the test chooses. */
function provideApproval(ctx: Context, outcome: ApprovalOutcome | (() => ApprovalOutcome)): { requests: ApprovalRequestView[] } {
  const requests: ApprovalRequestView[] = []
  ctx.provide('approval', {
    request: async (req: ApprovalRequestView): Promise<ApprovalOutcome> => {
      requests.push(req)
      return typeof outcome === 'function' ? outcome() : outcome
    },
  })
  return { requests }
}

/**
 * The registry-declared render value type, reached through the tool's own
 * signature so this spec needs no extra package dependency.
 */
type RenderValue = Parameters<NonNullable<ReturnType<typeof toolsOf>['list']>['output']['render']>[1]

/** Join one rendered result's text blocks for substring assertions. */
function textOf(blocks: ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

/** Render one tool result through its declared projection and join its text. */
function renderText(
  tool: { output: { render(args: unknown, value: RenderValue): ContentBlock[] } },
  args: unknown,
  value: unknown,
): string {
  return textOf(tool.output.render(args, value as RenderValue))
}

/** The presentation one tool declares for a call, asserted on its title and kind. */
function presentOf(tool: { presentCall?(args: unknown): unknown }, args: unknown): unknown {
  return tool.presentCall?.(args)
}

const agent = {
  id: brandString<Agent['id']>('test-agent'),
  session: { header: { cwd: '/worktree/main' } },
} as unknown as Agent

/** Every tool the package registers, resolved once per context. */
function toolsOf(ctx: Context) {
  return {
    list: ctx.tools.get('service_list')!,
    logs: ctx.tools.get('service_logs')!,
    control: ctx.tools.get('service_control')!,
  }
}

describe('@deepseek-ai/dsh-tool-project-services', () => {
  it('service_list lists and filters services by kind and state', async () => {
    const { ctx } = await setup()
    const { list } = toolsOf(ctx)
    const exec = makeExec('service_list')

    const all = await list.execute({}, exec) as ToolProjectServices.PublicServiceListResult
    expect(all.items).toHaveLength(3)
    expect(all.project.id).toBe('proj-1')
    expect(all.checkouts[0]!.availability).toBe('present')
    expect(all.groups[0]!.stale).toBe(true)
    expect(all.providers[1]!.reason).toBe('daemon unreachable')
    expect(all.nextCursor).toBe('cursor-2')

    const dockerOnly = await list.execute({ kind: 'docker' }, exec) as ToolProjectServices.PublicServiceListResult
    expect(dockerOnly.items).toHaveLength(1)
    expect(dockerOnly.items[0]!.kind).toBe('docker')
    expect(dockerOnly.items[0]!.name).toBe('postgres')

    const runningOnly = await list.execute({ state: 'running' }, exec) as ToolProjectServices.PublicServiceListResult
    expect(runningOnly.items).toHaveLength(2)
    expect(runningOnly.items.map(item => item.name).sort()).toEqual(['cache', 'postgres'])

    const nonExistent = await list.execute({ checkout_id: 'chk-nonexistent' }, exec) as ToolProjectServices.PublicServiceListResult
    expect(nonExistent.items).toHaveLength(0)
  })

  it('service_list renders every listing line and its omissions', async () => {
    const { ctx } = await setup()
    const { list } = toolsOf(ctx)
    const exec = makeExec('service_list')
    const inventory = await list.execute({}, exec) as ToolProjectServices.PublicServiceListResult
    const rendered = renderText(list, {}, inventory)
    expect(rendered).toContain('Provider warnings: docker: stale (daemon unreachable)')
    expect(rendered).toContain('Next cursor: cursor-2')
    expect(rendered).toContain('[stale]')

    const bare = {
      project: { id: 'proj-1', path: '/worktree/main' },
      checkouts: [],
      items: [],
      groups: [],
      providers: [{ id: 'native', kind: 'native', state: 'ready' }],
      revision: '1',
    }
    expect(renderText(list, {}, bare)).toContain('(no matching services)')

    const unexplained = { ...bare, providers: [{ id: 'docker', kind: 'docker', state: 'stale' }] }
    expect(renderText(list, {}, unexplained)).toContain('Provider warnings: docker: stale')
    expect(renderText(list, {}, { ...bare, providers: [] })).toContain('(no matching services)')
  })

  it('service_list pages with an explicit cursor and a caller limit', async () => {
    const { ctx } = await setup({ defaultPageLimit: 1, maxPageLimit: 3 })
    const { list } = toolsOf(ctx)
    const page = await list.execute({ cursor: 'cursor-1', limit: 99 }, makeExec('service_list')) as ToolProjectServices.PublicServiceListResult
    expect(page.items).toHaveLength(3)
  })

  it('service_logs caps output bytes and reports retained output', async () => {
    const { ctx } = await setup({ maxLogBytesCap: 16_384 })
    const { logs } = toolsOf(ctx)
    const exec = makeExec('service_logs')

    const res = await logs.execute({ target_id: 'native:web', max_bytes: 100_000 }, exec) as ToolProjectServices.PublicServiceLogsResult
    expect(res.truncated).toBe(true)
    expect(res.gap).toBe(false)
    expect(res.nextCursor).toBe('logs-cursor-2')
    expect(res.unavailable).toBeUndefined()
    expect(renderText(logs, { target_id: 'native:web' }, res)).toContain('[logs truncated]')

    const paged = await logs.execute({ target_id: 'native:web', cursor: 'logs-cursor-2' }, exec) as ToolProjectServices.PublicServiceLogsResult
    expect(paged.chunks).toHaveLength(1)
  })

  it('service_logs reports an unavailable target and an empty page', async () => {
    const { ctx, record } = await setup()
    const { logs } = toolsOf(ctx)
    const exec = makeExec('service_logs')

    record.unavailableLogs = true
    const unavailable = await logs.execute({ target_id: 'native:external' }, exec) as ToolProjectServices.PublicServiceLogsResult
    expect(unavailable.unavailable).toContain('External native output')
    expect(renderText(logs, { target_id: 'native:external' }, unavailable)).toContain('logs unavailable')

    record.unavailableLogs = false
    const empty = { chunks: [], truncated: false, gap: false }
    expect(renderText(logs, { target_id: 'native:web' }, empty)).toBe('(no new logs)')
    const complete = { chunks: [{ targetId: 'native:web', stream: 'stdout', text: 'ready' }], truncated: false, gap: false }
    expect(renderText(logs, { target_id: 'native:web' }, complete)).toBe('ready')
  })

  it('service_control validates parameters', async () => {
    const { ctx } = await setup()
    const { control } = toolsOf(ctx)
    const exec = makeExec('service_control')

    await expect(control.execute({ action: 'start' }, exec)).rejects.toThrow(/either definition or/)
    await expect(control.execute({ action: 'stop' }, exec)).rejects.toThrow(/requires target_id and expected_revision/)
  })

  it('service_control starts from a launch definition', async () => {
    const { ctx } = await setup()
    provideApproval(ctx, 'allowed-once')
    const { control } = toolsOf(ctx)

    const result = await control.execute({
      action: 'start',
      definition: { name: 'fixture', checkout_id: 'chk-1', command: ['node', 'server.js'] },
    }, makeExec('service_control', agent)) as ToolProjectServices.PublicServiceControlResult

    expect(result.state).toBe('succeeded')
    expect(presentOf(control, { action: 'start', definition: { name: 'fixture', checkout_id: 'chk-1', command: [] } }))
      .toMatchObject({ kind: 'execute', title: 'start service fixture' })
  })

  it('read-only tools never ask the runtime to authorize', async () => {
    const { ctx, record } = await setup()
    provideApproval(ctx, 'rejected')
    const { list, logs } = toolsOf(ctx)

    await list.execute({}, makeExec('service_list', agent))
    await logs.execute({ target_id: 'native:web' }, makeExec('service_logs', agent))

    expect(record.authorizeCalls).toBe(0)
    // A read access carries an inert authorize: the runtime never asks a read to authorize.
    const readOperation: ResolvedServiceOperation = {
      action: 'stop',
      project: { id: projectId, path: '/worktree/main', executionIdentity: brandString<ServiceExecutionIdentity>('host') },
      checkout,
      targets: [{ id: brandString<ServiceTargetId>('native:web'), revision: brandString<ServiceRevision>('1') }],
    }
    for (const access of record.accesses) {
      await expect(access.authorize(readOperation, new AbortController().signal)).resolves.toBeUndefined()
    }
    expect(record.authorizeCalls).toBe(0)
    expect(presentOf(list, {})).toMatchObject({ kind: 'read', title: 'List project services' })
    expect(presentOf(logs, { target_id: 'native:web' })).toMatchObject({ kind: 'read', rawInput: 'native:web' })
  })

  it('service_control fails closed when the host approval service is not mounted', async () => {
    const { ctx } = await setup()
    const { control } = toolsOf(ctx)

    await expect(control.execute({
      action: 'stop',
      target_id: 'native:web',
      expected_revision: '1',
    }, makeExec('service_control', agent))).rejects.toThrow(/requires the host approval service/)
  })

  it('service_control fails closed when the execution carries no calling Agent', async () => {
    const { ctx } = await setup()
    provideApproval(ctx, 'allowed-once')
    const { control } = toolsOf(ctx)

    await expect(control.execute({
      action: 'stop',
      target_id: 'native:web',
      expected_revision: '1',
    }, makeExec('service_control'))).rejects.toThrow(/requires the calling Agent/)
  })

  it('service_control fails immediately under approvalPolicy "never"', async () => {
    const { ctx } = await setup({ approvalPolicy: 'never' })
    const { control } = toolsOf(ctx)

    await expect(control.execute({
      action: 'start',
      target_id: 'native:web',
      expected_revision: '1',
    }, makeExec('service_control', agent))).rejects.toThrow(/approval policy "never"/)
  })

  it('service_control grants only "allowed-once" and reports every other outcome', async () => {
    const { ctx } = await setup()
    let outcome: ApprovalOutcome = 'allowed-once'
    const { requests } = provideApproval(ctx, () => outcome)
    const { control } = toolsOf(ctx)
    const exec = makeExec('service_control', agent)

    outcome = 'allowed-once'
    const success = await control.execute({
      action: 'start',
      target_id: 'native:web',
      expected_revision: '1',
    }, exec) as ToolProjectServices.PublicServiceControlResult
    expect(success.action).toBe('start')
    expect(success.outcomes[0]!.state).toBe('succeeded')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.toolName).toBe('service_control')
    expect(requests[0]!.reason).toContain('native:web@1')
    expect(renderText(control, { action: 'start' }, success)).toContain('range exited')

    for (const [denial, pattern] of [
      ['rejected', /the user rejected/],
      ['cancelled', /was cancelled/],
      ['unavailable', /no approval channel/],
    ] as const) {
      outcome = denial
      await expect(control.execute({
        action: 'stop',
        target_id: 'native:web',
        expected_revision: '2',
      }, exec)).rejects.toThrow(pattern)
    }
  })

  it('service_control reports an unreadable status instead of asserting completion', async () => {
    const { ctx, record } = await setup()
    provideApproval(ctx, 'allowed-once')
    record.hideStatus = true
    const { control } = toolsOf(ctx)
    const exec = makeExec('service_control', agent)

    const result = await control.execute({
      action: 'stop',
      target_id: 'native:web',
      expected_revision: '1',
    }, exec) as ToolProjectServices.PublicServiceControlResult

    expect(result.state).toBe('unknown')
    expect(result.operationId).toBeUndefined()
    expect(result.outcomes).toEqual([])
    expect(renderText(control, { action: 'stop' }, result)).toContain('read policy denies')
  })

  it('service_control reports an operation that carries no per-target outcome', async () => {
    const { ctx, record } = await setup()
    provideApproval(ctx, 'allowed-once')
    record.emptyOutcomes = true
    const { control } = toolsOf(ctx)
    const exec = makeExec('service_control', agent)

    const result = await control.execute({
      action: 'stop',
      target_id: 'native:web',
      expected_revision: '1',
    }, exec) as ToolProjectServices.PublicServiceControlResult

    expect(result.state).toBe('succeeded')
    expect(renderText(control, { action: 'stop' }, result)).toContain('no per-target outcome (succeeded)')
  })

  it('registers the tools under their default config when apply is called directly', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const record: RuntimeRecord = {
      accesses: [], authorizeCalls: 0, hideStatus: false, emptyOutcomes: false, unavailableLogs: false,
    }
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    mockRuntime(ctx, record)
    ToolProjectServices.apply(ctx)

    const { list } = toolsOf(ctx)
    const page = await list.execute({ limit: 500 }, makeExec('service_list')) as ToolProjectServices.PublicServiceListResult
    expect(page.items).toHaveLength(3)
  })

  it('registers the tools without a system prompt section when none is mounted', () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const registered: string[] = []
    ctx.provide('tools', { register: (tool: { name: string }) => { registered.push(tool.name) } })

    ToolProjectServices.apply(ctx)

    expect(ctx.get('systemPrompt')).toBeUndefined()
    expect(registered).toEqual(['service_list', 'service_logs', 'service_control'])
  })
})
