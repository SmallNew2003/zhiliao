/** Failure classification shared by Assistant selection and task reads. */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Normalize rejected calls and generated Remote responses for consumers.
 * @param operation - Host operation in the current access scope.
 * @returns the response, including a typed failure for a disconnected or unmounted Remote.
 */
export async function remoteRead<Value>(operation: () => Promise<RemoteResult<Value>>): Promise<RemoteResult<Value>> {
  try {
    return await operation()
  } catch (cause) {
    return { ok: false, error: remoteErrorOf(cause) ?? new RemoteError('gateway/internal', 'Assistant read unavailable.', {}, { cause }) }
  }
}

/**
 * Decide whether retained entity data must be withdrawn on a failed read.
 * @param error - structured Host failure for a task or assistant.
 * @returns true when the entity is missing or the caller lacks access.
 */
export function entityUnavailable(error: RemoteFailure): boolean {
  return error.code === 'remote-access/denied' || error.code === 'assistant/task-error'
    && (error.details.code === 'task_not_found' || error.details.code === 'workspace_not_registered'
      || error.details.code === 'workspace_scope_denied')
}
