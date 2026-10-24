/**
 * Prepared Docker container and Compose group operations with preflight membership verification.
 * @module
 */
import type {
  PreparedServiceOperation,
  ResolvedServiceOperation,
  ServiceAccess,
  ServiceAction,
  ServiceControlRequest,
  ServiceExecutionResult,
  ServiceGroup,
  ServiceItem,
  ServiceProviderContext,
  ServiceTargetId,
  ServiceTargetOutcome,
} from '@deepseek-ai/dsh-project-services'
import type { DockerTransport } from './transport.ts'
import { containerRevision } from './membership.ts'

/**
 * Extract container ID from a target ID string.
 * @param targetId - Service target identifier.
 * @returns Container ID when the target names a container, otherwise `undefined`.
 */
export function extractContainerId(targetId: ServiceTargetId): string | undefined {
  const str = targetId as string
  if (str.startsWith('docker:container:')) {
    return str.slice('docker:container:'.length)
  }
  return undefined
}

/**
 * Whether a target ID names a Docker Compose group.
 * @param targetId - Service target identifier.
 * @returns Whether the target ID carries the Compose group prefix.
 */
export function isDockerGroupId(targetId: ServiceTargetId): boolean {
  return (targetId as string).startsWith('docker:group:')
}

/**
 * Prepare a Docker container or Compose group lifecycle operation.
 * @param context - Project scope.
 * @param request - Mutating control request.
 * @param _access - Trusted caller access.
 * @param transport - Docker transport.
 * @param daemonId - Initial verified daemon ID.
 * @param items - Observed items.
 * @param groups - Observed Compose groups.
 * @param terminationGraceMs - Configured grace period in milliseconds.
 * @param signal - Preparation cancellation.
 * @returns Prepared operation with immutable description and execution capability.
 */
export async function prepareDockerOperation(
  context: ServiceProviderContext,
  request: ServiceControlRequest,
  _access: ServiceAccess,
  transport: DockerTransport,
  daemonId: string,
  items: readonly ServiceItem[],
  groups: readonly ServiceGroup[],
  terminationGraceMs: number,
  signal: AbortSignal,
): Promise<PreparedServiceOperation> {
  if (!('targetId' in request)) {
    throw new Error('Docker provider does not create new container definitions from scratch')
  }

  const graceSeconds = Math.max(1, Math.round(terminationGraceMs / 1000))

  if (isDockerGroupId(request.targetId)) {
    return prepareGroupOperation(
      context, request.targetId, request.expectedRevision, request.action, transport, daemonId, items, groups, graceSeconds, signal,
    )
  }

  return prepareSingleContainerOperation(
    context, request.targetId, request.expectedRevision, request.action, transport, daemonId, items, graceSeconds, signal,
  )
}

/** Prepare operation for a single container. */
async function prepareSingleContainerOperation(
  context: ServiceProviderContext,
  targetId: ServiceTargetId,
  expectedRevision: string,
  action: ServiceAction,
  transport: DockerTransport,
  initialDaemonId: string,
  items: readonly ServiceItem[],
  graceSeconds: number,
  _signal: AbortSignal,
): Promise<PreparedServiceOperation> {
  const containerId = extractContainerId(targetId)
  if (!containerId) throw new Error(`Invalid Docker target ID: ${targetId}`)

  const item = items.find(i => i.id === targetId)
  if (!item) throw new Error(`Docker target not found: ${targetId}`)
  if (item.revision !== expectedRevision) {
    throw new Error(`Docker target revision mismatch for ${targetId}`)
  }

  const checkout = context.checkouts.find(c => c.id === item.checkoutId)
  if (!checkout) throw new Error(`Checkout not found for Docker target: ${targetId}`)

  const description: ResolvedServiceOperation = {
    action,
    project: context.project,
    checkout,
    targets: [{ id: item.id, revision: item.revision }],
    docker: {
      context: transport.contextName,
      daemonId: initialDaemonId,
      containerIds: [containerId],
    },
  }

  return Promise.resolve({
    description,
    async validate(sig: AbortSignal): Promise<void> {
      const currentDaemon = await transport.info(sig)
      if (currentDaemon.id !== initialDaemonId) {
        throw new Error(`Docker daemon changed: expected ${initialDaemonId}, got ${currentDaemon.id}`)
      }
      const inspects = await transport.inspect([containerId], sig)
      const current = inspects[0]
      if (current === undefined) throw new Error(`Container no longer exists: ${containerId}`)
      const currentRev = containerRevision(current)
      if (currentRev !== item.revision) {
        throw new Error(`Container state drifted before operation for ${containerId}`)
      }
    },
    async execute(sig: AbortSignal): Promise<ServiceExecutionResult> {
      const currentDaemon = await transport.info(sig)
      if (currentDaemon.id !== initialDaemonId) {
        throw new Error(`Docker daemon changed: expected ${initialDaemonId}, got ${currentDaemon.id}`)
      }
      try {
        if (action === 'start') {
          await transport.start(containerId, sig)
        } else if (action === 'stop') {
          await transport.stop(containerId, graceSeconds, sig)
        } else {
          await transport.restart(containerId, graceSeconds, sig)
        }
        return {
          outcomes: [{ targetId, state: 'succeeded' }],
        }
      } catch (error) {
        return {
          outcomes: [{
            targetId,
            state: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }],
        }
      }
    },
  })
}

/** Prepare operation for a Compose group with preflight and mid-flight frozen membership protection. */
async function prepareGroupOperation(
  context: ServiceProviderContext,
  groupId: ServiceTargetId,
  expectedRevision: string,
  action: ServiceAction,
  transport: DockerTransport,
  initialDaemonId: string,
  items: readonly ServiceItem[],
  groups: readonly ServiceGroup[],
  graceSeconds: number,
  _signal: AbortSignal,
): Promise<PreparedServiceOperation> {
  const group = groups.find(g => g.id === groupId)
  if (!group) throw new Error(`Docker group not found: ${groupId}`)
  if (group.revision !== expectedRevision) {
    throw new Error(`Docker group revision mismatch for ${groupId}`)
  }

  const frozenTargetIds = [...group.targetIds].sort((a, b) => (a as string).localeCompare(b))
  const memberItems = frozenTargetIds.map((tid) => {
    const it = items.find(item => item.id === tid)
    if (!it) throw new Error(`Group member ${tid} missing from observations`)
    return it
  })

  const checkout = context.checkouts.find(c => c.id === group.checkoutId)
  if (!checkout) throw new Error(`Checkout not found for Docker group: ${groupId}`)

  const frozenMembers = frozenTargetIds.map((targetId) => {
    const containerId = extractContainerId(targetId)
    if (containerId === undefined) throw new Error(`Group member is not a container target: ${targetId}`)
    return { targetId, containerId }
  })
  const frozenContainerIds = frozenMembers.map(member => member.containerId)

  const description: ResolvedServiceOperation = {
    action,
    project: context.project,
    checkout,
    targets: memberItems.map(it => ({ id: it.id, revision: it.revision })),
    docker: {
      context: transport.contextName,
      daemonId: initialDaemonId,
      containerIds: frozenContainerIds,
    },
  }

  return Promise.resolve({
    description,
    async validate(sig: AbortSignal): Promise<void> {
      const currentDaemon = await transport.info(sig)
      if (currentDaemon.id !== initialDaemonId) {
        throw new Error(`Docker daemon changed: expected ${initialDaemonId}, got ${currentDaemon.id}`)
      }
      const inspects = await transport.inspect(frozenContainerIds, sig)
      if (inspects.length !== frozenContainerIds.length) {
        throw new Error(`Group members disappeared before operation in ${groupId}`)
      }
      for (const inspect of inspects) {
        const item = memberItems.find(m => m.id === `docker:container:${inspect.Id}`)
        if (!item || containerRevision(inspect) !== item.revision) {
          throw new Error(`Group member drifted before operation: ${inspect.Id}`)
        }
      }
    },
    async execute(sig: AbortSignal): Promise<ServiceExecutionResult> {
      const currentDaemon = await transport.info(sig)
      if (currentDaemon.id !== initialDaemonId) {
        throw new Error(`Docker daemon changed: expected ${initialDaemonId}, got ${currentDaemon.id}`)
      }

      const outcomes: ServiceTargetOutcome[] = []

      for (const [index, member] of frozenMembers.entries()) {
        const { targetId, containerId } = member

        try {
          // Verify container still exists and matches expected ID before acting
          const currentInspects = await transport.inspect([containerId], sig)
          const currentInspect = currentInspects[0]
          if (currentInspect === undefined || currentInspect.Id !== containerId) {
            throw new Error(`Container ${containerId} was replaced or removed`)
          }

          if (action === 'start') {
            await transport.start(containerId, sig)
          } else if (action === 'stop') {
            await transport.stop(containerId, graceSeconds, sig)
          } else {
            await transport.restart(containerId, graceSeconds, sig)
          }

          outcomes.push({ targetId, state: 'succeeded' })
        } catch (error) {
          outcomes.push({
            targetId,
            state: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })

          // Mark all remaining unattempted members
          for (const remaining of frozenMembers.slice(index + 1)) {
            outcomes.push({
              targetId: remaining.targetId,
              state: 'unattempted',
              message: 'Skipped after prior member failure',
            })
          }
          break
        }
      }

      return { outcomes }
    },
  })
}
