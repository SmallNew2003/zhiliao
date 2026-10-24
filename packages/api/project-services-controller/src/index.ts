/**
 * Remote controller exposing project service discovery, log streaming, and lifecycle control.
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ServiceAccess,
  ServiceActorId,
  ServiceCheckoutId,
  ServiceControlRequest,
  ServiceCursor,
  ServiceExecutionIdentity,
  ServiceInventory,
  ServiceLogPage,
  ServiceRequestId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import type {
  ApiServiceCheckoutView,
  ApiServiceControlRequest,
  ApiServiceControlView,
  ApiServiceFeedFrameView,
  ApiServiceGroupView,
  ApiServiceInventoryView,
  ApiServiceItemView,
  ApiServiceListRequest,
  ApiServiceLogsRequest,
  ApiServiceLogsView,
  ApiServiceProviderView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Remote controller for project services. */
    projectServicesController: ProjectServicesController
  }
}

/**
 * Caller identity one mutating control call must name. The Host rejects a
 * mutation that cannot say who asked, so an operation log entry always names a
 * real caller instead of one shared placeholder.
 */
const CALLER_PATTERN = /^[\w.-]{1,128}$/u

/** Read identity every connected client reads under; reads gate nothing. */
const READ_ACTOR_ID = 'remote:reader'

/**
 * Maps domain service items into clean JSON views for wire transfer.
 * @param inventory - Raw service inventory.
 * @returns Serialized public inventory view.
 */
function mapInventoryView(inventory: ServiceInventory): ApiServiceInventoryView {
  const checkouts: ApiServiceCheckoutView[] = inventory.checkouts.map(checkout => ({
    id: String(checkout.id),
    path: checkout.path,
    availability: checkout.availability,
  }))

  const items: ApiServiceItemView[] = inventory.items.map(item => ({
    id: String(item.id),
    providerId: String(item.providerId),
    projectId: String(item.projectId),
    checkoutId: String(item.checkoutId),
    revision: String(item.revision),
    name: item.name,
    kind: item.kind,
    state: item.state,
    ownership: item.ownership,
    actions: [...item.actions],
    ...(item.ports !== undefined ? { ports: [...item.ports] } : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.stale !== undefined ? { stale: item.stale } : {}),
  }))

  const groups: ApiServiceGroupView[] = inventory.groups.map(group => ({
    id: String(group.id),
    checkoutId: String(group.checkoutId),
    revision: String(group.revision),
    name: group.name,
    targetIds: group.targetIds.map(String),
    ...(group.stale !== undefined ? { stale: group.stale } : {}),
  }))

  const providers: ApiServiceProviderView[] = inventory.providers.map(provider => ({
    id: String(provider.id),
    kind: provider.kind,
    state: provider.state,
    observedAt: provider.observedAt,
    ...(provider.reason !== undefined ? { reason: provider.reason } : {}),
  }))

  return {
    project: {
      id: String(inventory.project.id),
      path: inventory.project.path,
    },
    checkouts,
    items,
    groups,
    providers,
    revision: String(inventory.revision),
    ...(inventory.nextCursor !== undefined ? { nextCursor: String(inventory.nextCursor) } : {}),
  }
}

/**
 * Maps raw service log page into public view.
 * @param page - Domain log page.
 * @returns Wire log page.
 */
function mapLogsView(page: ServiceLogPage): ApiServiceLogsView {
  return {
    chunks: page.chunks.map(chunk => ({
      targetId: String(chunk.targetId),
      stream: chunk.stream,
      text: chunk.text,
    })),
    truncated: page.truncated,
    gap: page.gap,
    ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
    ...(page.unavailable !== undefined ? { unavailable: page.unavailable } : {}),
  }
}

/**
 * Host Remote service controller exposing project services endpoints.
 */
export class ProjectServicesController extends TypertRemoteService {
  static inject = ['typert', 'projectServices']

  /**
   * @param ctx - Host cordis context.
   */
  constructor(ctx: Context) {
    super(ctx, 'projectServicesController', { namespace: 'projectServices' })
  }

  /**
   * Constructs trusted human access context for RPC clients.
   * @param actorId - Caller identity the access runs under.
   * @param cwd - Target working directory or defaults to process.cwd().
   * @returns Authorized ServiceAccess representation.
   */
  private createAccess(actorId: string, cwd?: string): ServiceAccess {
    return {
      actorId: brandString<ServiceActorId>(actorId),
      kind: 'human',
      cwd: cwd ?? process.cwd(),
      executionIdentity: brandString<ServiceExecutionIdentity>('host'),
      canRead: () => Promise.resolve(true),
      revalidate: () => Promise.resolve(),
      authorize: () => Promise.resolve(),
    }
  }

  /**
   * List current project services, checkouts, and provider status.
   * @param request - Filter and paging options.
   * @param signal - Cancellation signal.
   * @returns Current service inventory view.
   */
  @Remote('list')
  async list(request: ApiServiceListRequest, signal: AbortSignal): Promise<ApiServiceInventoryView> {
    const access = this.createAccess(READ_ACTOR_ID, request.cwd)
    const inventory = await this.ctx.projectServices.list(
      access,
      {
        ...(request.cursor !== undefined ? { cursor: brandString<ServiceCursor>(request.cursor) } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      },
      signal,
    )
    return mapInventoryView(inventory)
  }

  /**
   * Read retained output logs for a service target.
   * @param request - Target and pagination parameters.
   * @param signal - Cancellation signal.
   * @returns Log page view.
   */
  @Remote('logs')
  async logs(request: ApiServiceLogsRequest, signal: AbortSignal): Promise<ApiServiceLogsView> {
    const access = this.createAccess(READ_ACTOR_ID, request.cwd)
    const page = await this.ctx.projectServices.logs(
      access,
      {
        targetId: brandString<ServiceTargetId>(request.targetId),
        ...(request.cursor !== undefined ? { cursor: brandString<ServiceCursor>(request.cursor) } : {}),
        ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
      },
      signal,
    )
    return mapLogsView(page)
  }

  /**
   * Execute a service lifecycle action (start, stop, restart).
   * @param request - Action, target, revision guard, and the caller identity the mutation runs under.
   * @param signal - Cancellation signal.
   * @returns Result of the executed operation.
   */
  @Remote('control')
  async control(request: ApiServiceControlRequest, signal: AbortSignal): Promise<ApiServiceControlView> {
    if (request.caller === undefined || !CALLER_PATTERN.test(request.caller)) {
      throw new Error('service_control: a mutating call must name its caller (1-128 letters, digits, "_", "-", or ".")')
    }
    if (request.definition !== undefined && request.action !== 'start') {
      throw new Error('service_control: a launch definition is only valid with action "start"')
    }
    const access = this.createAccess(`remote:${request.caller}`, request.cwd)
    const requestId = brandString<ServiceRequestId>(request.requestId ?? randomUUID())
    let controlRequest: ServiceControlRequest
    if (request.definition !== undefined) {
      controlRequest = {
        requestId,
        action: 'start',
        definition: {
          name: request.definition.name,
          checkoutId: brandString<ServiceCheckoutId>(request.definition.checkoutId),
          command: { argv: [...request.definition.command] },
        },
      }
    } else if (request.targetId !== undefined && request.expectedRevision !== undefined) {
      controlRequest = {
        requestId,
        action: request.action,
        targetId: brandString<ServiceTargetId>(request.targetId),
        expectedRevision: brandString<ServiceRevision>(request.expectedRevision),
      }
    } else if (request.targetId === undefined) {
      throw new Error('service_control: target_id is required when no definition is provided')
    } else {
      throw new Error('service_control: expected_revision is required for a mutating call')
    }

    const result = await this.ctx.projectServices.control(access, controlRequest, signal)
    const operation = result.operation
      ? {
        id: String(result.operation.id),
        requestId: String(result.operation.requestId),
        actorId: String(result.operation.actorId),
        action: result.operation.action,
        targetIds: result.operation.targetIds.map(String),
        state: result.operation.state,
        outcomes: result.operation.outcomes.map(outcome => ({
          targetId: String(outcome.targetId),
          state: outcome.state,
        })),
      }
      : undefined

    return {
      ...(operation !== undefined ? { operation } : {}),
      ...(result.pending !== undefined ? { pending: result.pending } : {}),
    }
  }

  /**
   * Subscribe to live service inventory changes and operations.
   * @param request - Filter and paging options.
   * @param signal - Cancellation signal.
   * @returns Async stream of update frames.
   */
  @Remote({ mode: 'stream' })
  async *follow(request: ApiServiceListRequest, signal: AbortSignal): AsyncIterable<ApiServiceFeedFrameView> {
    const access = this.createAccess(READ_ACTOR_ID, request.cwd)
    const stream = this.ctx.projectServices.follow(
      access,
      {
        ...(request.cursor !== undefined ? { cursor: brandString<ServiceCursor>(request.cursor) } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      },
      signal,
    )

    for await (const frame of stream) {
      yield {
        kind: frame.kind,
        snapshot: mapInventoryView(frame.snapshot),
      }
    }
  }
}

export default ProjectServicesController
