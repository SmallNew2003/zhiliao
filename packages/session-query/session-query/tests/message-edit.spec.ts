/** Edited input remains searchable and restored history remains current. */

import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords, buildSessionEventSearchDocuments } from '../src/documents.ts'
import { currentSurfaceEvents, traceEvent } from '../src/tracing.ts'

it('returns prepared text at an ordinary input sequence without changing its durable event', () => {
  const session = Session.create(SessionId('query-admitted'))
  const input = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('user/message-admit', { targetSeq: input.seq, message: { ...input.data, content: [{ type: 'text', text: 'prepared' }] } })
  const [current] = currentSurfaceEvents(session.id, session.snapshotEvents())
  expect(current?.seq).toBe(input.seq)
  expect(current?.type === 'user/message' && current.data.content).toEqual([{ type: 'text', text: 'prepared' }])
  expect(input.data.content).toEqual([{ type: 'text', text: 'original' }])
})

it('classifies restored prefix nodes as current and indexes modified input', () => {
  const session = Session.create(SessionId('query-edited'))
  const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const first = session.append('user/message', message('earlier'), { surfaceOp: 'append' })
  const latest = session.append('user/message', message('original'), { surfaceOp: 'append' })
  const nodes = [...session.surface.nodes]
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' } }), {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: latest.seq }, sourceEventSeqs: nodes,
  })
  const edit = session.append('user/message-edit', { targetSeq: latest.seq, message: message('replacement') })
  const events = session.snapshotEvents()
  const records = buildSessionEventRecords(session.id, events)
  expect(records.find(record => record.seq === first.seq)?.surface).toBe('current')
  expect(records.find(record => record.seq === latest.seq)?.surface).toBe('shadowed')
  expect(records.find(record => record.seq === edit.seq)?.surface).toBe('current')
  expect(currentSurfaceEvents(session.id, events).map(event => event.seq)).toEqual([first.seq, edit.seq])
  expect(buildSessionEventSearchDocuments(session.id, events).find(document => document.seq === edit.seq)?.text).toBe('replacement')
  expect(traceEvent(session.id, events, edit.seq).sourceEventSeqs).toEqual([latest.seq])
  session.append('user/message-admit', { targetSeq: edit.seq, message: { ...edit.data.message, content: [{ type: 'text', text: 'prepared replacement' }] } })
  const projected = currentSurfaceEvents(session.id, session.snapshotEvents()).at(-1)
  expect(projected?.seq).toBe(edit.seq)
  expect(projected?.type === 'user/message-edit' && projected.data.message.content)
    .toEqual([{ type: 'text', text: 'prepared replacement' }])
})
