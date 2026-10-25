/**
 * Agent control-path native launch wiring. The real `NativeServiceProvider`
 * supplies the Host lifetime and the adapter guard, so these specs prove the
 * tool hands it a matching adapter rather than a mock of its own.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ProjectServiceProvider,
  PreparedServiceOperation,
  ServiceAccess,
  ServiceActorId,
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceControlRequest,
  ServiceControlResult,
  ServiceExecutionIdentity,
  ServiceInventory,
  ServiceNativeExecution,
  ServiceOperationId,
  ServiceProject,
  ServiceProjectId,
  ServiceProviderContext,
  ServiceRequestId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import ProjectServiceRuntime from '@deepseek-ai/dsh-project-services'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import NativeServiceProvider, { createShellServiceExecution } from '@deepseek-ai/dsh-project-services-local/native'
import * as ToolProjectServices from '../src/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose()
  }
})

const signal = (): AbortSignal => new AbortController().signal

const checkoutId = brandString<ServiceCheckoutId>('chk-native')
const projectId = brandString<ServiceProjectId>('proj-native')
const checkout: ServiceCheckout = { id: checkoutId, projectId, path: '/worktree/native', availability: 'present' }
const project: ServiceProject = {
  id: projectId,
  path: '/worktree/native',
  executionIdentity: brandString<ServiceExecutionIdentity>('host'),
}
const definitionId = brandString<ServiceTargetId>('native:definition:fixture')
const definitionRevision = brandString<ServiceRevision>('rev-1')
const definition = {
  id: definitionId,
  projectId,
  checkoutId,
  name: 'fixture',
  command: { argv: [process.execPath, '-e', ''] },
  revision: definitionRevision,
}

/** Provider context the mock runtime hands the native provider for one call. */
function providerContext(pending: boolean): ServiceProviderContext {
  return {
    project,
    checkouts: [checkout],
    definitions: [definition],
    associations: [],
    ...(pending ? { pendingDefinition: { ...definition } } : {}),
  }
}

/**
 * Runtime that delegates `control` to the registered native provider exactly as
 * the real runtime does: the provider resolves the operation first, then the
 * access authorizes it. Reads are inert.
 */
function delegatingRuntime(ctx: Context, record: ServiceAccess[]) {
  const providers = new Map<string, ProjectServiceProvider>()

  class DelegatingRuntime extends ProjectServiceRuntime {
    async list(): Promise<ServiceInventory> {
      return {
        project, checkouts: [checkout], items: [], definitions: [], groups: [], providers: [], operations: [],
        revision: definitionRevision,
      }
    }

    async logs(): Promise<never> {
      throw new Error('logs are not exercised by this spec')
    }

    async control(access: ServiceAccess, request: ServiceControlRequest, abort: AbortSignal): Promise<ServiceControlResult> {
      record.push(access)
      const provider = providers.get('native')
      if (provider === undefined) throw new Error('Service provider unavailable')
      const prepared: PreparedServiceOperation = await provider.prepare(
        providerContext('definition' in request), request, access, abort,
      )
      await access.authorize(prepared.description, abort)
      return {
        operation: {
          id: brandString<ServiceOperationId>('op-native'),
          requestId: request.requestId,
          actorId: access.actorId,
          projectId,
          checkoutId,
          action: request.action,
          targetIds: prepared.description.targets.map(target => target.id),
          state: 'succeeded',
          outcomes: [],
        },
      }
    }

    async *follow(): AsyncIterable<never> {}
    registerProvider(provider: ProjectServiceProvider) {
      providers.set(String(provider.id), provider)
      return async () => { providers.delete(String(provider.id)) }
    }
  }

  return new DelegatingRuntime(ctx)
}

/** Minimal POSIX shell whose preparation succeeds without spawning anything. */
const posixShell = {
  supportsPosixCommandSyntax: true,
  resolve: (request: { command: string; workdir?: string; signal?: AbortSignal }) => ({
    command: request.command,
    workdir: request.workdir ?? checkout.path,
    timeoutMs: 1000,
    stdoutMaxBytes: 1024,
    signal: request.signal,
    sandboxPolicy: undefined,
  }),
  prepare: () => Promise.resolve({ start: () => Promise.reject(new Error('native-execution spec never starts a process')) }),
}

/** Subprocess realm facts the native provider and the adapter compare. */
const subprocess = {
  resolveExecutable: (program: string) => Promise.resolve(program),
  spawn: () => { throw new Error('native-execution spec never spawns a process') },
}

/** Access the specs hand the native provider directly for the guard assertions. */
function agentAccess(overrides: Partial<ServiceAccess> = {}): ServiceAccess {
  return {
    actorId: brandString<ServiceActorId>('agent-under-test'),
    kind: 'agent',
    cwd: checkout.path,
    executionIdentity: brandString<ServiceExecutionIdentity>('host'),
    authorize: async () => {},
    canRead: async () => true,
    revalidate: async () => {},
    ...overrides,
  }
}

/** Mount the tool over the real native provider plus the delegating runtime. */
async function setup(options: { native?: boolean; shell?: boolean; approval?: 'grant' | 'deny' } = {}) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const accesses: ServiceAccess[] = []
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  delegatingRuntime(ctx, accesses)
  ctx.provide('subprocess', subprocess)
  if (options.shell !== false) ctx.provide('shell', posixShell)
  if (options.native !== false) {
    const fiber = await ctx.plugin(NativeServiceProvider, {
      shellPath: '/bin/bash',
      retainedOutputBytes: 1048576,
      terminationGraceMs: 50,
      scanTimeoutMs: 10000,
      scanMaxBytes: 1048576,
      processInspectionMax: 200,
      captureIntervalMs: 25,
      historyMaxInstances: 200,
    })
    cleanup.push(() => fiber.dispose())
  }
  if (options.approval !== undefined) {
    ctx.provide('approval', {
      request: () => Promise.resolve(options.approval === 'grant' ? 'allowed-once' : 'rejected'),
    })
  }
  await ctx.plugin(ToolProjectServices)
  return { ctx, accesses, native: ctx.get('nativeProjectServices') }
}

const agent = {
  id: brandString<Agent['id']>('native-agent'),
  session: { header: { cwd: checkout.path } },
} as unknown as Agent

function exec(name: string): ToolRunContext {
  const callId = brandString<ToolRunContext['callId']>(`native-call-${name}`)
  return {
    signal: signal(),
    callId,
    rootCallId: callId,
    name,
    arguments: {},
    token: Symbol('dsh.tool.execution') as ToolRunContext['token'],
    deferContext: () => {},
    concludeTurn: () => {},
    agent,
  }
}

describe('tool-project-services native agent execution', () => {
  it('hands the native provider an adapter that shares its Host lifetime', async () => {
    const { ctx, accesses, native } = await setup({ approval: 'grant' })
    expect(native).toBeDefined()

    const result = await ctx.tools.get('service_control')!.execute({
      action: 'start',
      definition: { name: 'fixture', checkout_id: String(checkoutId), command: [process.execPath, '-e', ''] },
    }, exec('start')) as ToolProjectServices.PublicServiceControlResult

    expect(result.state).toBe('succeeded')
    const access = accesses.at(-1)!
    expect(access.nativeExecution).toBeDefined()
    expect(access.nativeExecution!.lifetime.signal).toBe(native!.lifetime.signal)
    expect(access.nativeExecution!.lifetime.subprocessRealm).toBe(native!.lifetime.subprocessRealm)
  })

  it('carries the adapter on the access a restart call submits', async () => {
    const { ctx, accesses } = await setup({ approval: 'grant' })

    await expect(ctx.tools.get('service_control')!.execute({
      action: 'restart',
      target_id: String(definitionId),
      expected_revision: 'rev-1',
    }, exec('restart'))).rejects.toThrow(/Native managed instance unavailable/)

    const access = accesses.at(-1)!
    expect(access.nativeExecution).toBeDefined()
  })

  it('omits the adapter and lets the native provider refuse when no provider is mounted', async () => {
    const { ctx, accesses } = await setup({ native: false, approval: 'grant' })
    expect(ctx.get('nativeProjectServices')).toBeUndefined()

    await expect(ctx.tools.get('service_control')!.execute({
      action: 'start',
      definition: { name: 'fixture', checkout_id: String(checkoutId), command: [process.execPath, '-e', ''] },
    }, exec('start'))).rejects.toThrow(/Service provider unavailable/)

    expect(accesses.at(-1)!.nativeExecution).toBeUndefined()
  })

  it('rejects an adapter whose lifetime belongs to another realm', async () => {
    const { native } = await setup({ approval: 'grant' })
    const foreign: ServiceNativeExecution = {
      lifetime: { signal: signal(), subprocessRealm: Symbol('foreign-realm') },
      resolve: () => Promise.reject(new Error('a foreign executor must never resolve')),
    }
    await expect(native!.prepare(
      providerContext(true),
      {
        requestId: brandString<ServiceRequestId>('req-foreign'),
        action: 'start',
        definition: { name: 'fixture', checkoutId, command: definition.command },
      },
      agentAccess({ nativeExecution: foreign }),
      signal(),
    )).rejects.toThrow('Native agent execution must use the Host subprocess lifetime')
  })

  it('rejects an agent access that carries no adapter at all', async () => {
    const { native } = await setup()
    await expect(native!.prepare(
      providerContext(true),
      {
        requestId: brandString<ServiceRequestId>('req-missing'),
        action: 'start',
        definition: { name: 'fixture', checkoutId, command: definition.command },
      },
      agentAccess(),
      signal(),
    )).rejects.toThrow('Native agent execution must use the Host subprocess lifetime')
  })

  it('builds the adapter through the shared shell execution helper', async () => {
    const { ctx } = await setup()
    const lifetime = ctx.get('nativeProjectServices')!.lifetime
    const adapter = createShellServiceExecution(ctx, lifetime, {})
    expect(adapter.lifetime.signal).toBe(lifetime.signal)
    await expect(adapter.resolve(definition.command, checkout.path, signal())).resolves.toMatchObject({
      cwd: checkout.path,
    })
  })

  it('leaves reads working when the composition mounts no shell provider', async () => {
    const { ctx } = await setup({ shell: false })
    const inventory = await ctx.tools.get('service_list')!.execute({}, exec('list')) as ToolProjectServices.PublicServiceListResult
    expect(inventory.items).toEqual([])
  })
})
