/**
 * Docker container membership resolution and Compose grouping for Git worktree checkouts.
 * @module
 */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceAction,
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceGroup,
  ServiceItem,
  ServiceProviderContext,
  ServiceProviderId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import type { DockerContainerInspect } from './transport.ts'

/** Check if a candidate path is inside or identical to a checkout root. */
function isPathWithin(checkoutPath: string, targetPath: string): boolean {
  const normCheckout = resolve(checkoutPath)
  const normTarget = resolve(targetPath)
  const rel = relative(normCheckout, normTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep))
}

/** Find the most specific checkout matching a set of paths. */
function findBestMatchingCheckout(
  candidatePaths: readonly string[],
  checkouts: readonly ServiceCheckout[],
): ServiceCheckout | undefined {
  let best: ServiceCheckout | undefined
  let bestLength = -1

  for (const candidate of candidatePaths) {
    for (const checkout of checkouts) {
      if (isPathWithin(checkout.path, candidate)) {
        if (checkout.path.length > bestLength) {
          best = checkout
          bestLength = checkout.path.length
        }
      }
    }
  }

  return best
}

/**
 * Create deterministic revision hash for a container state.
 * @param container - Inspected container record.
 * @returns Revision identifying this exact container state.
 */
export function containerRevision(container: DockerContainerInspect): ServiceRevision {
  const hash = createHash('sha256')
    .update(JSON.stringify([
      container.Id,
      container.State.Status,
      container.State.StartedAt,
      container.State.FinishedAt,
      container.RestartCount,
    ]))
    .digest('hex')
  return brandString<ServiceRevision>(hash)
}

/** Derive available actions from container lifecycle state. */
function resolveActions(state: DockerContainerInspect['State']): ServiceAction[] {
  if (state.Status === 'dead' || state.Status === 'removing') return []
  if (state.Running) return ['stop', 'restart']
  return ['start']
}

/** Map Docker container state to normalized ServiceItem state. */
function resolveState(state: DockerContainerInspect['State']): ServiceItem['state'] {
  if (state.Restarting) return 'starting'
  if (state.Running) return 'running'
  if (state.Status === 'created' || state.Status === 'exited' || state.Status === 'paused') return 'stopped'
  return 'unknown'
}

/** Extract published Host ports from inspect network settings. */
function resolvePublishedPorts(ports: DockerContainerInspect['NetworkSettings']['Ports']): number[] {
  const result = new Set<number>()
  for (const bindings of Object.values(ports)) {
    if (!bindings) continue
    for (const binding of bindings) {
      const port = Number.parseInt(binding.HostPort, 10)
      if (!Number.isNaN(port) && port > 0) result.add(port)
    }
  }
  return [...result].sort((a, b) => a - b)
}

/**
 * Resolve inspect records into project-bound items and Compose groups.
 * @param containers - Inspected container records.
 * @param context - Project and checkout scope.
 * @param providerId - Docker provider identity.
 * @returns Projected items and Compose groups.
 */
export function resolveDockerMemberships(
  containers: readonly DockerContainerInspect[],
  context: ServiceProviderContext,
  providerId: ServiceProviderId,
): { items: ServiceItem[]; groups: ServiceGroup[] } {
  const items: ServiceItem[] = []
  const groupBuckets = new Map<string, {
    project: string
    service: string
    checkoutId: ServiceCheckoutId
    items: ServiceItem[]
  }>()

  const associationByContainerId = new Map(
    context.associations.map(assoc => [assoc.id as string, assoc]),
  )

  for (const container of containers) {
    const labels = container.Config.Labels
    // Exclude one-off run containers
    if (labels['com.docker.compose.oneoff'] === 'True' || labels['com.docker.compose.oneoff'] === 'true') {
      continue
    }

    const targetId = brandString<ServiceTargetId>(`docker:container:${container.Id}`)

    // Gather candidate paths from Compose metadata and bind mounts
    const candidatePaths: string[] = []
    const workingDir = labels['com.docker.compose.project.working_dir']
    if (workingDir) candidatePaths.push(workingDir)

    const configFiles = labels['com.docker.compose.project.config_files']
    if (configFiles) {
      for (const file of configFiles.split(',')) {
        if (file.trim()) candidatePaths.push(dirname(file.trim()))
      }
    }

    for (const mount of container.Mounts) {
      if (mount.Type === 'bind' && mount.Source) {
        candidatePaths.push(mount.Source)
      }
    }

    let checkout = findBestMatchingCheckout(candidatePaths, context.checkouts)
    let ownership: ServiceItem['ownership'] = 'external'

    if (!checkout) {
      const assoc = associationByContainerId.get(targetId)
      if (assoc) {
        checkout = context.checkouts.find(c => c.id === assoc.checkoutId)
        ownership = 'managed'
      }
    }

    // If container does not match any project checkout or association, exclude it
    if (!checkout) continue

    const name = labels['com.docker.compose.service'] ?? container.Name.replace(/^\//, '')
    const state = resolveState(container.State)
    const actions = resolveActions(container.State)
    const ports = resolvePublishedPorts(container.NetworkSettings.Ports)
    const revision = containerRevision(container)

    let detail = `image: ${container.Config.Image}`
    if (container.State.Health?.Status && container.State.Health.Status !== 'none') {
      detail += `, health: ${container.State.Health.Status}`
    }

    const item: ServiceItem = {
      id: targetId,
      providerId,
      projectId: checkout.projectId,
      checkoutId: checkout.id,
      revision,
      name,
      kind: 'docker',
      state,
      ownership,
      actions,
      ...(ports.length > 0 ? { ports } : {}),
      detail,
    }
    items.push(item)

    // Check for Compose group
    const composeProject = labels['com.docker.compose.project']
    const composeService = labels['com.docker.compose.service']
    if (composeProject && composeService) {
      const groupKey = `${checkout.id}:${composeProject}:${composeService}`
      let bucket = groupBuckets.get(groupKey)
      if (!bucket) {
        bucket = {
          project: composeProject,
          service: composeService,
          checkoutId: checkout.id,
          items: [],
        }
        groupBuckets.set(groupKey, bucket)
      }
      bucket.items.push(item)
    }
  }

  const groups: ServiceGroup[] = []
  for (const bucket of groupBuckets.values()) {
    const sortedItems = [...bucket.items].sort((a, b) => (a.id as string).localeCompare(b.id))
    const targetIds = sortedItems.map(i => i.id)
    const groupRevHash = createHash('sha256')
      .update(JSON.stringify(sortedItems.map(i => [i.id, i.revision])))
      .digest('hex')
    // The checkout dimension keeps group ids unique across worktrees of one repository:
    // two worktrees can run the same Compose project and service name side by side.
    const groupId = brandString<ServiceTargetId>(`docker:group:${bucket.checkoutId}:${bucket.project}:${bucket.service}`)

    groups.push({
      id: groupId,
      providerId,
      projectId: context.project.id,
      checkoutId: bucket.checkoutId,
      name: bucket.service,
      revision: brandString<ServiceRevision>(groupRevHash),
      targetIds,
    })
  }

  return { items, groups }
}
