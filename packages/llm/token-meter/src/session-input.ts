/** Resolve historical edited input before token pricing. */
import { readSessionInputEvent, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'

/**
 * @param sourceEvent - next persisted Session event.
 * @param previous - latest input retained by the caller.
 * @returns the event with legacy edited input represented as an admission.
 */
export function tokenInputEvent(sourceEvent: SessionEvent, previous: { seq: SessionSeq; messageId: Message['id']; edited: boolean } | undefined): SessionEvent {
  const input = readSessionInputEvent(sourceEvent)
  return input.type === 'user/message' && previous?.edited === true && previous.messageId === input.data.id
    ? { type: 'user/message-admit', seq: input.seq, time: input.time, data: { targetSeq: previous.seq, message: input.data } }
    : input
}
