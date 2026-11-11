/** Live, authorized task details for transcript occurrences. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { AssistantTaskId, AssistantTaskView } from '@deepseek-ai/dsh-assistant-task/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { entityUnavailable, remoteRead } from './remote-read.ts'

const PREFIX = 'dsh-resource://assistant-task/'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Null when the Host explicitly denies the task or no longer has it. */
    'assistant-task': AssistantTaskView | null
  }
}

/**
 * Address a task independently of the currently loaded list page.
 * @param id - durable task id.
 * @returns the task detail resource URL.
 */
export function taskAddress(id: AssistantTaskId): string {
  return PREFIX + encodeURIComponent(id)
}

/** Registered task-detail protocol and its per-task invalidation callback. */
interface TaskResources {
  readonly provider: ResourceProvider<'assistant-task'>
  readonly refresh: (id: AssistantTaskId) => void
}

/**
 * Bind detail reads to the resource lifetime. Subscribers to an id share one
 * read; an invalidation during that read supersedes its result.
 * @param ctx - authorized Remote provider.
 * @param remember - include confirmed execution Sessions in workspace separation.
 * @returns the provider and the invalidation used for Host events and manual retry.
 */
export function createTaskResources(ctx: Context, remember: (row: AssistantTaskView) => void): TaskResources {
  const invalidations = new Map<AssistantTaskId, () => void>()
  const provider: ResourceProvider<'assistant-task'> = {
    protocol: 'assistant-task',
    async *open(address, { signal }) {
      let id: AssistantTaskId
      try {
        id = brandString<AssistantTaskId>(decodeURIComponent(address.slice(PREFIX.length)))
      } catch (_malformedAddress) {
        yield { ok: true, value: null }
        return
      }
      let version = 0
      let wake = Promise.withResolvers<void>()
      const invalidate = (): void => { version++; wake.resolve() }
      const aborted = (): boolean => signal.aborted
      invalidations.set(id, invalidate)
      signal.addEventListener('abort', invalidate, { once: true })
      try {
        while (!aborted()) {
          const current = version
          wake = Promise.withResolvers<void>()
          const result = await Promise.race([
            remoteRead(() => ctx.remote.assistantTasks.task({ id })),
            wake.promise.then(() => undefined),
          ])
          if (aborted()) return
          if (version !== current || result === undefined) continue
          if (result.ok) remember(result.value)
          yield !result.ok && entityUnavailable(result.error) ? { ok: true, value: null } : result
          await wake.promise
        }
      } finally {
        signal.removeEventListener('abort', invalidate)
        if (invalidations.get(id) === invalidate) invalidations.delete(id)
      }
    },
  }
  return { provider, refresh: (id: AssistantTaskId): void => { invalidations.get(id)?.() } }
}
