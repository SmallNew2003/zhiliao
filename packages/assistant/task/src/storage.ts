/** Durable assistant records and assistant tasks, independently of Session activation. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AssistantId, AssistantTaskId, AssistantTaskStatus } from './types.ts'

const assistantId = z.string().min(1).transform(value => brandString<AssistantId>(value))
const assistantTaskId = z.string().min(1).transform(value => brandString<AssistantTaskId>(value))
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const workspaceId = z.string().min(1).transform(value => brandString<WorkspaceId>(value))
const instant = z.iso.datetime()

/** Durable assistant record. */
export const assistantRecord = z.object({
  id: assistantId,
  kind: z.enum(['global', 'project']),
  workspaceId: workspaceId.optional(),
  name: z.string().min(1),
  sessionId,
  retiredSessionIds: z.array(sessionId),
  createdAt: instant,
  updatedAt: instant,
}).strict()

/** Durable assistant task record. */
export const assistantTaskRecord = z.object({
  id: assistantTaskId,
  assistantId,
  workspaceId: workspaceId.optional(),
  cwd: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  sessionId,
  status: z.enum(['created', 'running', 'waiting-approval', 'waiting-answer', 'done', 'failed', 'cancelled']),
  creatorTurn: z.number().int().nonnegative(),
  /** Caller idempotency key shared by retries of one creation. */
  requestId: z.string().min(1).optional(),
  /** Whether the first prompt reached the execution Session. */
  promptDelivered: z.boolean().optional(),
  createdAt: instant,
  updatedAt: instant,
  failure: z.object({ code: z.string().min(1), message: z.string() }).strict().optional(),
}).strict()

/** One stored assistant record. */
export type AssistantRecord = z.infer<typeof assistantRecord>

/** One stored assistant task record. */
export type AssistantTaskRecord = z.infer<typeof assistantTaskRecord>

/** Durable global state: the single global assistant identity. */
export const assistantDomainState = z.object({
  globalAssistantId: assistantId.optional(),
}).strict()

/** The assistant domain: assistant records, task records, and the global assistant identity. */
export const assistantDomain = defineDomain({
  name: 'assistant',
  version: 1,
  global: {
    schema: assistantDomainState,
    initial: {},
  },
  tables: {
    assistants: domainTable<AssistantId, AssistantRecord>(assistantRecord),
    tasks: domainTable<AssistantTaskId, AssistantTaskRecord>(assistantTaskRecord),
  },
})

/** Terminal task statuses that no longer count toward the active quota. */
export function isTerminalTaskStatus(status: AssistantTaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}
