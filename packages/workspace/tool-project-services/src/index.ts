/**
 * Model-facing project service tools: `service_list`, `service_logs`, and `service_control`.
 * @module
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, type GenericCallView, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  ResolvedServiceOperation,
  ServiceAccess,
  ServiceActorId,
  ServiceCheckoutId,
  ServiceControlRequest,
  ServiceCursor,
  ServiceExecutionIdentity,
  ServiceNativeExecution,
  ServiceRequestId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { createShellServiceExecution } from '@deepseek-ai/dsh-project-services-local/native'
// Type-only: merges the `ctx.approval` declaration so the opportunistic read
// below resolves to the ApprovalService type, and names the closed outcome
// union the mutation gate switches over.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  Config,
  type PublicServiceControlResult,
  type PublicServiceGroup,
  type PublicServiceItem,
  type PublicServiceListResult,
  type PublicServiceLogsResult,
} from './types.ts'

export const name = 'tool-project-services'
// `approval` and `nativeProjectServices` are read opportunistically through
// `ctx.get()` and deliberately stay out of `inject`: an inject entry is a hard
// load dependency, so an unmet one keeps this plugin body from running and
// removes all three tools — the reads included — instead of failing closed on
// the single mutating call that needed the seam.
export const inject = ['tools', 'projectServices', 'systemPrompt']
export { Config } from './types.ts'
export type * from './types.ts'

/** System prompt guidance for project service tools. */
const PROMPT_GUIDANCE =
  'Use `service_list` to see the native processes and Docker containers this project and its Git worktrees run, with each target\'s state, ports, and `revision`. '
  + 'Use `service_logs` to read one target\'s retained output: at most 16 KiB per call, so follow `nextCursor` for more; `truncated` marks a call that stopped at the cap, `gap` marks output the runtime already discarded, and `unavailable` names a target that keeps no output. '
  + 'Use `service_control` to start, stop, or restart one service; every action mutates and is gated by one approval decision. '
  + 'Pass `expected_revision` from the `service_list` row you act on: a revision that no longer matches fails the call instead of touching a service you no longer see. '
  + 'Prefer these tools over shelling out to `ps`, `lsof`, or `docker ps`; do not use them for a one-off command or a process that is not a project service.'

/**
 * Failure text per closed approval outcome. The exhaustive key set turns a new
 * {@link ApprovalOutcome} into a compile error instead of a silent grant.
 */
const CONTROL_DENIALS: Record<ApprovalOutcome, string | undefined> = {
  'allowed-once': undefined,
  rejected: 'the user rejected this service operation',
  cancelled: 'the approval request was cancelled',
  unavailable: 'no approval channel answered this service operation',
}

/** Generic presentation for service tool calls. */
function presentServiceCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return {
    card: 'generic',
    title,
    kind,
    ...(rawInput !== undefined ? { rawInput } : {}),
  }
}

/** Render public service items as formatted markdown lines. */
function renderServiceListMarkdown(result: PublicServiceListResult): string {
  const lines: string[] = []
  lines.push(`Project: ${result.project.id} (${result.project.path})`)
  if (result.checkouts.length > 0) {
    lines.push(`Checkouts: ${result.checkouts.map(c => `${c.id} [${c.availability}]`).join(', ')}`)
  }
  if (result.items.length === 0) {
    lines.push('(no matching services)')
  } else {
    lines.push('Services:')
    for (const item of result.items) {
      const ports = item.ports && item.ports.length > 0 ? ` (ports: ${item.ports.join(', ')})` : ''
      const stale = item.stale ? ' [stale]' : ''
      lines.push(`- [${item.kind}] ${item.name} (${item.id}) — ${item.state} [${item.ownership}]${ports}${stale} (rev: ${item.revision})`)
    }
  }
  if (result.providers.length > 0) {
    const degraded = result.providers.filter(p => p.state !== 'ready')
    if (degraded.length > 0) {
      lines.push(`Provider warnings: ${degraded.map(d => `${d.id}: ${d.state}${d.reason ? ` (${d.reason})` : ''}`).join('; ')}`)
    }
  }
  if (result.nextCursor) {
    lines.push(`Next cursor: ${result.nextCursor}`)
  }
  return lines.join('\n')
}

/**
 * Build the trusted Agent access one service tool call submits.
 * @param exec - registry execution carrying the calling Agent and call identity.
 * @param authorize - mutation gate; reads pass an inert callback because the runtime never asks them.
 * @param nativeExecution - native launch adapter for mutating calls; absent for reads.
 * @returns the access this call runs under.
 */
function serviceAccess(
  exec: ToolRunContext,
  authorize: ServiceAccess['authorize'],
  nativeExecution: ServiceNativeExecution | undefined,
): ServiceAccess {
  return {
    actorId: brandString<ServiceActorId>(exec.agent === undefined ? 'anonymous-reader' : String(exec.agent.id)),
    kind: 'agent',
    cwd: exec.agent?.session.header.cwd ?? process.cwd(),
    executionIdentity: brandString<ServiceExecutionIdentity>('host'),
    canRead: () => Promise.resolve(true),
    revalidate: async () => {},
    authorize,
    ...(nativeExecution === undefined ? {} : { nativeExecution }),
  }
}

/**
 * Native launch adapter for one control call, or `undefined` when this
 * composition mounts no native provider. Construction is deferred to the
 * resolve that needs it, because the native provider is the only consumer: a
 * deployment that mounts the provider without a Host-realm shell still stops
 * Docker targets and reads every surface.
 * @param ctx - plugin context whose shell and subprocess providers the adapter borrows.
 * @returns the adapter sharing the native provider's Host lifetime, or `undefined`.
 */
function nativeExecutionOf(ctx: Context): ServiceNativeExecution | undefined {
  const native = ctx.get('nativeProjectServices')
  if (native === undefined) return undefined
  const lifetime = native.lifetime
  return {
    lifetime,
    // A launched range is Host-owned and outlives the initiating session, so it
    // carries the shell executor's deployment policy instead of a session-scoped
    // sandbox escalation or managed environment.
    resolve: (command, cwd, signal) => createShellServiceExecution(ctx, lifetime, {}).resolve(command, cwd, signal),
  }
}

/**
 * Build the fail-closed mutation gate for one control call. The `'never'`
 * policy rejects before anyone is asked; otherwise the host approval service
 * decides, and a missing approval service, a missing calling Agent, and every
 * outcome but `'allowed-once'` reject the operation before any lifecycle side
 * effect.
 * @param ctx - plugin context owning the optional approval service.
 * @param exec - registry execution carrying the calling Agent and call identity.
 * @param policy - the configured stance on mutating operations.
 * @returns the gate the runtime calls with the exact resolved operation.
 */
function controlAuthorize(ctx: Context, exec: ToolRunContext, policy: 'ask' | 'never'): ServiceAccess['authorize'] {
  return async (operation: ResolvedServiceOperation, signal: AbortSignal) => {
    if (policy === 'never') {
      throw new Error('service_control: approval policy "never" rejects every mutating service operation')
    }
    const approval = ctx.get('approval')
    if (approval === undefined) {
      throw new Error('service_control: a mutating service operation requires the host approval service, which this composition does not mount')
    }
    if (exec.agent === undefined) {
      throw new Error('service_control: a mutating service operation requires the calling Agent, which this execution does not carry')
    }
    const targets = operation.targets.map(target => `${target.id}@${target.revision}`).join(', ')
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'service_control',
      callId: exec.callId,
      reason: `Authorize service ${operation.action} on [${targets}] in ${operation.checkout.path}`,
      signal,
    })
    const denial = CONTROL_DENIALS[outcome]
    if (denial !== undefined) throw new Error(`service_control: ${denial}`)
  }
}

/** Register service_list, service_logs, and service_control tools. */
export function apply(ctx: Context, config: Config = {}): void {
  const defaultLogBytes = config.defaultMaxLogBytes ?? 16_384
  const logBytesCap = config.maxLogBytesCap ?? 16_384
  const defaultPageLimit = config.defaultPageLimit ?? 50
  const maxPageLimit = config.maxPageLimit ?? 200
  const approvalPolicy = config.approvalPolicy ?? 'ask'

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    systemPrompt.section({
      name: 'tool:project-services',
      order: 1650,
      text: PROMPT_GUIDANCE,
    })
  }

  // --- service_list ---
  ctx.tools.register(defineTool({
    name: 'service_list',
    description: 'List the native processes and Docker containers this project and its Git worktrees run, with each target\'s state, ports, ownership, and revision. Call it before assuming a service is down or a port is free. Filter by checkout_id, kind, or state; follow nextCursor for later pages.',
    parameters: {
      checkout_id: { type: 'string', description: 'Filter services by Git checkout / worktree identifier.' },
      kind: { type: 'string', enum: ['native', 'docker'], description: 'Filter by service kind (native or docker).' },
      state: { type: 'string', enum: ['running', 'stopped', 'starting', 'unknown'], description: 'Filter by service state.' },
      cursor: { type: 'string', description: 'Pagination cursor from a previous listing.' },
      limit: { type: 'number', description: 'Maximum number of items to return.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              path: { type: 'string', required: true },
            },
            required: true,
          },
          checkouts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                availability: { type: 'string', required: true },
              },
            },
          },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['native', 'docker'] },
                state: { type: 'string', required: true, enum: ['running', 'stopped', 'starting', 'unknown'] },
                ownership: { type: 'string', required: true, enum: ['managed', 'external'] },
                checkoutId: { type: 'string', required: true },
                revision: { type: 'string', required: true },
                actions: { type: 'array', items: { type: 'string' }, required: true },
                ports: { type: 'array', items: { type: 'integer' } },
                detail: { type: 'string' },
                stale: { type: 'boolean' },
              },
            },
          },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                checkoutId: { type: 'string', required: true },
                revision: { type: 'string', required: true },
                targetIds: { type: 'array', items: { type: 'string' }, required: true },
                stale: { type: 'boolean' },
              },
            },
          },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                state: { type: 'string', required: true },
                reason: { type: 'string' },
              },
            },
          },
          revision: { type: 'string', required: true },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderServiceListMarkdown(value) }],
    },
    async execute(args, exec) {
      const access = serviceAccess(exec, async () => {}, undefined)
      const pageLimit = Math.min(args.limit ?? defaultPageLimit, maxPageLimit)
      const inv = await ctx.projectServices.list(
        access,
        {
          ...(args.cursor ? { cursor: brandString<ServiceCursor>(args.cursor) } : {}),
          limit: pageLimit,
        },
        exec.signal,
      )

      let filteredItems = inv.items
      if (args.checkout_id !== undefined) {
        filteredItems = filteredItems.filter(item => item.checkoutId === args.checkout_id)
      }
      if (args.kind !== undefined) {
        filteredItems = filteredItems.filter(item => item.kind === args.kind)
      }
      if (args.state !== undefined) {
        filteredItems = filteredItems.filter(item => item.state === args.state)
      }

      const publicItems: PublicServiceItem[] = filteredItems.map(item => ({
        id: String(item.id),
        name: item.name,
        kind: item.kind,
        state: item.state,
        ownership: item.ownership,
        checkoutId: String(item.checkoutId),
        revision: String(item.revision),
        actions: [...item.actions],
        ...(item.ports !== undefined ? { ports: [...item.ports] } : {}),
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.stale !== undefined ? { stale: item.stale } : {}),
      }))

      const publicGroups: PublicServiceGroup[] = inv.groups.map(group => ({
        id: String(group.id),
        name: group.name,
        checkoutId: String(group.checkoutId),
        revision: String(group.revision),
        targetIds: group.targetIds.map(String),
        ...(group.stale !== undefined ? { stale: group.stale } : {}),
      }))

      const result: PublicServiceListResult = {
        project: {
          id: String(inv.project.id),
          path: inv.project.path,
        },
        checkouts: inv.checkouts.map(c => ({
          id: String(c.id),
          path: c.path,
          availability: c.availability,
        })),
        items: publicItems,
        groups: publicGroups,
        providers: inv.providers.map(p => ({
          id: String(p.id),
          kind: p.kind,
          state: p.state,
          ...(p.reason !== undefined ? { reason: p.reason } : {}),
        })),
        revision: String(inv.revision),
        ...(inv.nextCursor !== undefined ? { nextCursor: String(inv.nextCursor) } : {}),
      }
      return result
    },
    presentCall: () => presentServiceCall('List project services', 'read'),
  }))

  // --- service_logs ---
  ctx.tools.register(defineTool({
    name: 'service_logs',
    description: 'Read retained stdout and stderr for one project service target, at most 16 KiB per call. Follow nextCursor for more output. `truncated` marks a call that stopped at the byte cap, `gap` marks output the runtime already discarded, and `unavailable` names a target that keeps no output.',
    parameters: {
      target_id: { type: 'string', required: true, description: 'Service target ID to read logs from.' },
      cursor: { type: 'string', description: 'Log stream cursor from previous read.' },
      max_bytes: { type: 'number', description: 'Max bytes to read (capped at 16 KiB).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                targetId: { type: 'string', required: true },
                stream: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          nextCursor: { type: 'string' },
          truncated: { type: 'boolean', required: true },
          gap: { type: 'boolean', required: true },
          unavailable: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.unavailable) {
          return [{ type: 'text', text: `(logs unavailable: ${value.unavailable})` }]
        }
        if (value.chunks.length === 0) {
          return [{ type: 'text', text: '(no new logs)' }]
        }
        const text = value.chunks.map(c => c.text).join('')
        const notice = value.truncated ? '\n[logs truncated]' : ''
        return [{ type: 'text', text: `${text}${notice}` }]
      },
    },
    async execute(args, exec) {
      const access = serviceAccess(exec, async () => {}, undefined)
      const maxBytes = Math.min(args.max_bytes ?? defaultLogBytes, logBytesCap)
      const page = await ctx.projectServices.logs(
        access,
        {
          targetId: brandString<ServiceTargetId>(args.target_id),
          ...(args.cursor ? { cursor: brandString<ServiceCursor>(args.cursor) } : {}),
          maxBytes,
        },
        exec.signal,
      )

      const result: PublicServiceLogsResult = {
        chunks: page.chunks.map(c => ({
          targetId: String(c.targetId),
          stream: c.stream,
          text: c.text,
        })),
        truncated: page.truncated,
        gap: page.gap,
        ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
        ...(page.unavailable !== undefined ? { unavailable: page.unavailable } : {}),
      }
      return result
    },
    presentCall: args => presentServiceCall(`Read logs for ${args.target_id}`, 'read', args.target_id),
  }))

  // --- service_control ---
  ctx.tools.register(defineTool({
    name: 'service_control',
    description: 'Start, stop, or restart one project service. Every action mutates and is gated by one approval decision. Stop or restart an existing target by `target_id` plus the `expected_revision` that `service_list` reported for it — a revision that no longer matches fails the call instead of acting on a service you no longer see. Start a saved definition by `definition` alone.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'stop', 'restart'], description: 'Lifecycle action to run; every action mutates the service.' },
      target_id: { type: 'string', description: 'Existing service target ID to stop or restart.' },
      expected_revision: { type: 'string', description: 'Revision that `service_list` reported for `target_id`; a revision that no longer matches fails this call.' },
      definition: {
        type: 'object',
        additionalProperties: false,
        description: 'Launch a new service from this definition instead of acting on an existing target.',
        properties: {
          name: { type: 'string', required: true, description: 'Name to record for the launched service.' },
          checkout_id: { type: 'string', required: true, description: 'Git checkout / worktree the service runs in.' },
          command: { type: 'array', items: { type: 'string' }, required: true, description: 'Exact executable and arguments to run.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          requestId: { type: 'string', required: true },
          operationId: { type: 'string' },
          state: { type: 'string', required: true, enum: ['running', 'succeeded', 'failed', 'unknown'] },
          outcomes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                targetId: { type: 'string', required: true },
                state: { type: 'string', required: true },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const subject = value.operationId ?? value.requestId
        if (value.state === 'unknown') {
          return [{ type: 'text', text: `Service ${value.action} (${subject}): submitted, but the current read policy denies reading its operation status` }]
        }
        const outcomes = value.outcomes.length > 0
          ? value.outcomes.map(o => `${o.targetId}: ${o.state}${o.message ? ` (${o.message})` : ''}`).join(', ')
          : `no per-target outcome (${value.state})`
        return [{ type: 'text', text: `Service ${value.action} (${subject}): ${outcomes}` }]
      },
    },
    async execute(args, exec) {
      const requestId = brandString<ServiceRequestId>(randomUUID())
      let controlRequest: ServiceControlRequest
      if (args.definition) {
        controlRequest = {
          requestId,
          action: 'start',
          definition: {
            name: args.definition.name,
            checkoutId: brandString<ServiceCheckoutId>(args.definition.checkout_id),
            command: { argv: [...args.definition.command] },
          },
        }
      } else if (args.target_id !== undefined && args.expected_revision !== undefined) {
        controlRequest = {
          requestId,
          action: args.action,
          targetId: brandString<ServiceTargetId>(args.target_id),
          expectedRevision: brandString<ServiceRevision>(args.expected_revision),
        }
      } else {
        throw new Error(args.action === 'start'
          ? 'service_control: start requires either definition or (target_id and expected_revision)'
          : `service_control: ${args.action} requires target_id and expected_revision`)
      }

      const access = serviceAccess(exec, controlAuthorize(ctx, exec, approvalPolicy), nativeExecutionOf(ctx))

      const res = await ctx.projectServices.control(access, controlRequest, exec.signal)
      const op = res.operation

      const result: PublicServiceControlResult = {
        action: args.action,
        requestId: String(requestId),
        ...(op !== undefined ? {
          operationId: String(op.id),
          state: op.state,
          outcomes: op.outcomes.map(o => ({
            targetId: String(o.targetId),
            state: o.state,
            ...(o.message !== undefined ? { message: o.message } : {}),
          })),
        } : {
          state: 'unknown',
          outcomes: [],
        }),
      }
      return result
    },
    presentCall: args => presentServiceCall(
      `${args.action} service ${args.target_id ?? args.definition?.name}`,
      'execute',
      args.target_id ?? args.definition?.name,
    ),
  }))
}

/** Plugin entry that registers the project service tools under their default config. */
export default {
  name,
  inject,
  Config,
  apply,
}
