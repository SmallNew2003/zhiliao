/** Edited inputs contribute their current text to referenced conversations. */
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { retainReferencedSession } from '../src/projection.ts'

it.each(['replacement', ''])('projects an edited input with text %j', (text) => {
  const session = Session.create(SessionId('referenced-edit'))
  const original = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const edit = session.append('user/message-edit', {
    targetSeq: original.seq,
    message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  })
  const retained = retainReferencedSession({
    session: session.header, inheritedEventCount: SessionLogOffset(0),
    capturedThroughSeq: edit.seq, events: [edit],
  }, 'Referenced chat', 10_000)
  expect(retained?.data.conversation).toEqual(text === '' ? [] : [{ role: 'user', text }])
})
