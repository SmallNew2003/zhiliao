/** Query readers interpret historical edit records without changing their raw identity. */
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildSessionEventSearchDocuments } from '../src/index.ts'
import { currentSurfaceEvents, traceEvent } from '../src/tracing.ts'

it('indexes, reads, and traces a historical namespaced edit', () => {
  const session = Session.create(SessionId('legacy-query'))
  const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const original = session.append('user/message', input('before'), { surfaceOp: 'append' })
  const edit = session.append('user/message-edit', { targetSeq: original.seq, message: input('after') })
  const events = session.snapshotEvents().map(event => event.type === 'user/message-edit'
    ? { ...event, type: 'plugin:user/message-edit', ignorable: true } as never
    : event)
  expect(buildSessionEventSearchDocuments(session.id, events)).toMatchObject([
    { type: 'user/message', surface: 'shadowed', text: 'before' },
    { type: 'plugin:user/message-edit', surface: 'current', text: 'after' },
  ])
  expect(currentSurfaceEvents(session.id, events)).toMatchObject([{ type: 'user/message-edit', seq: edit.seq }])
  expect(traceEvent(session.id, events, original.seq)).toMatchObject({ replacedBy: edit.seq, derivedEventSeqs: [edit.seq] })
  expect(events[1]?.type).toBe('plugin:user/message-edit')
})
