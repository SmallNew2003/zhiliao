/** Durable public result of the initial task turn. */
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { AssistantTaskFailure } from './types.ts'

/** Largest prefix any supported result configuration may request, in UTF-16 units. */
export const MAX_RESULT_CHARS = 65_536

/** Prefix of a Session id reserved for one worker. */
export const WORKER_SESSION_PREFIX = 'session-assistant-task-'

const stateSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('unrelated') }),
  z.object({ phase: z.literal('active'), text: z.string() }),
  z.object({ phase: z.literal('done'), text: z.string() }),
  z.object({ phase: z.literal('cancelled') }),
  z.object({ phase: z.literal('failed'), code: z.string() }),
])

/** Bounded worker text and its first terminal outcome, independent of Agent activation. */
export type WorkerOutcome = z.infer<typeof stateSchema>

/**
 * Record the execution outcome without copying provider diagnostics into task data.
 * @param reason - Logged turn ending.
 * @param text - Public text of the most recent settled assistant message.
 * @returns The first terminal outcome.
 */
export function turnOutcome(reason: TurnEndReason, text: string): WorkerOutcome {
  switch (reason.kind) {
    case 'completed': return { phase: 'done', text }
    case 'aborted': return { phase: 'cancelled' }
    case 'error': return { phase: 'failed', code: 'turn_error' }
    case 'blocked':
    case 'interrupted':
    case 'max-tokens':
    case 'forked': return { phase: 'failed', code: reason.kind }
    // Extension-defined endings have no public task-specific explanation.
    default: return { phase: 'failed', code: 'execution_failed' }
  }
}

/** Task workers retain only their first turn outcome. Other Sessions retain no text. */
export const workerOutcome: ProjectionDefinition<'assistant-task-outcome', WorkerOutcome> = {
  key: 'assistant-task-outcome',
  stateVersion: 1,
  stateSchema,
  init: header => header.id.startsWith(WORKER_SESSION_PREFIX) ? { phase: 'active', text: '' } : { phase: 'unrelated' },
  apply(state, event) {
    if (state.phase === 'unrelated' && event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'user' && 'rpcId' in source && source.rpcId.startsWith('assistant-task-assistant-task-')) {
        return { phase: 'active', text: '' }
      }
    }
    if (state.phase !== 'active') return state
    if (event.type === 'turn/end') return turnOutcome(event.data.reason, state.text)
    if (event.type !== 'assistant/message' || event.data.interrupted) return state
    let text = ''
    for (const block of event.data.message.content) {
      if (block.type !== 'text') continue
      if (text.length > 0) text += '\n'
      text += block.text.slice(0, MAX_RESULT_CHARS - text.length)
      if (text.length >= MAX_RESULT_CHARS) break
    }
    return { phase: 'active', text: text.trim() }
  },
}

/**
 * Public task failure, safe for task tools and notifications, including records from older Hosts.
 * @param code - Task-domain discriminator.
 * @returns A stable explanation without transport or storage diagnostics.
 */
export function publicFailure(code: string): AssistantTaskFailure {
  switch (code) {
    case 'turn_error': return { code, message: 'The worker turn failed. Inspect the execution Session.' }
    case 'interrupted': return { code, message: 'The turn was interrupted.' }
    case 'blocked': return { code, message: 'The worker turn was blocked.' }
    case 'max-tokens': return { code, message: 'The worker reached the output token limit.' }
    case 'forked': return { code, message: 'The original turn ended at a Session fork.' }
    case 'cancel_failed': return { code, message: 'Task cancellation could not be confirmed. Retry cancellation.' }
    case 'prompt_outcome_unknown': return { code, message: 'Prompt admission could not be confirmed. Inspect the execution Session before repeating this work.' }
    case 'prompt_rejected': return { code, message: 'The execution Session could not accept the task prompt.' }
    case 'worker_preset_unavailable': return { code, message: 'The configured worker preset is unavailable.' }
    case 'workspace_not_registered': return { code, message: 'The target Workspace is not registered.' }
    case 'session_create_failed': return { code, message: 'The execution Session could not be created.' }
    case 'not_started': return { code, message: 'The task never reached an execution Session.' }
    default: return { code: 'execution_failed', message: 'The task could not finish. Inspect the execution Session.' }
  }
}
