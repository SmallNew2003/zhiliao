/** Editing retains the pre-input history, including history shadowed by compaction. */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq, deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/edit-admit-project': { targetSeq: SessionSeq }
  }
}

function conversation() {
  const session = Session.create(SessionId('edit-history'))
  const input = (text: string) => createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  })
  const first = session.append('user/message', input('A'), { surfaceOp: 'append' })
  const answer = session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'answer A' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  const latest = session.append('user/message', input('B'), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 2, step: 1, stream: [],
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'answer B' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  return { session, input, first, answer, latest }
}

function texts(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block =>
    block.type === 'text' ? [block.text] : []))
}

describe('latest user message editing', () => {
  it('retains earlier input and response while replacing the latest input and response', () => {
    const { session, input, latest } = conversation()
    const original = session.snapshotEvents()
    const edit = session.append('user/message-edit', { targetSeq: latest.seq, message: input('B2') })
    expect(texts(session)).toEqual(['A', 'answer A', 'B2'])
    expect(session.surface.nodes).toEqual([0, 1, edit.seq])
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(deriveEventMessage(edit)?.content).toEqual([{ type: 'text', text: 'B2' }])
    const replay = Session.create(SessionId('replayed-edit'), session.snapshotEvents())
    expect(texts(replay)).toEqual(['A', 'answer A', 'B2'])
  })

  it('follows an earlier edit to its original prefix when the latest input is edited again', () => {
    const { session, input, latest } = conversation()
    const firstEdit = session.append('user/message-edit', { targetSeq: latest.seq, message: input('B2') })
    session.append('assistant/message', {
      turn: 3, step: 1, stream: [],
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'answer B2' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message-edit', { targetSeq: firstEdit.seq, message: input('B3') })
    expect(texts(session)).toEqual(['A', 'answer A', 'B3'])
  })

  it('restores earlier context when a compaction summary also covered the edited input', () => {
    const { session, input, latest } = conversation()
    const nodes = [...session.surface.nodes]
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary of A and B' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes })
    session.append('user/message-edit', { targetSeq: latest.seq, message: input('B2') })
    expect(texts(session)).toEqual(['A', 'answer A', 'B2'])
    expect(session.surface.replaceGeneration).toBe(2)
  })

  it('edits the first input without keeping its original response', () => {
    const { session, input, first, latest } = conversation()
    const prefix = Session.create(SessionId('first-edit'), session.snapshotEvents().slice(0, latest.seq))
    prefix.append('user/message-edit', { targetSeq: first.seq, message: input('A2') })
    expect(texts(prefix)).toEqual(['A2'])
  })

  it('rejects a historical target before changing the raw log or effective history', () => {
    const { session, input, first } = conversation()
    const original = session.snapshotEvents()
    expect(() => session.append('user/message-edit', { targetSeq: first.seq, message: input('A2') }))
      .toThrow(/latest user message/)
    expect(session.snapshotEvents()).toBe(original)
    expect(texts(session)).toEqual(['A', 'answer A', 'B', 'answer B'])
  })

  it('rejects a non-user target before changing history', () => {
    const { session, input, answer } = conversation()
    expect(() => session.append('user/message-edit', { targetSeq: answer.seq, message: input('wrong') }))
      .toThrow(/user message/)
    expect(texts(session)).toEqual(['A', 'answer A', 'B', 'answer B'])
  })
})


describe('prepared committed input', () => {
  it.each([-1, 100])('rejects an invalid admission target %s atomically', (target) => {
    const { session, input } = conversation()
    const original = session.snapshotEvents()
    expect(() => session.append('user/message-admit', { targetSeq: target as SessionSeq, message: input('prepared') }))
      .toThrow(/current earlier input/)
    expect(session.snapshotEvents()).toBe(original)
  })

  it('rejects admission at an assistant node and at a shadowed input', () => {
    const { session, input, answer, latest } = conversation()
    expect(() => session.append('user/message-admit', { targetSeq: answer.seq, message: input('prepared') }))
      .toThrow(/must be a user message/)
    session.append('user/message-edit', { targetSeq: latest.seq, message: input('edited') })
    expect(() => session.append('user/message-admit', { targetSeq: latest.seq, message: latest.data }))
      .toThrow(/current earlier input/)
  })

  it('rejects admission at an earlier retained human input or injected context', () => {
    const { session, first } = conversation()
    expect(() => session.append('user/message-admit', { targetSeq: first.seq, message: first.data }))
      .toThrow(/latest human input/)
    const injected = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    expect(() => session.append('user/message-admit', { targetSeq: injected.seq, message: injected.data }))
      .toThrow(/human-authored input/)
  })

  it('prepares an ordinary committed input without replacing its attachment', () => {
    const session = Session.create(SessionId('ordinary-admission'))
    const image = { type: 'image' as const, attachment: { attachmentId: 'image' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }
    const message = createUserMessage({ content: [{ type: 'text', text: 'input' }, image], source: { kind: 'user' } })
    const source = session.append('user/message', message, { surfaceOp: 'append' })
    session.append('user/message-admit', { targetSeq: source.seq, message: { ...message, content: [{ type: 'text', text: 'prepared' }, image] } })
    expect(session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'prepared' }, image])
  })

  it('retains projected attachments and additional plugin content during admission', () => {
    const image = { type: 'image' as const, attachment: { attachmentId: 'projected' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }
    const original = createUserMessage({ content: [{ type: 'text', text: 'original' }, image], source: { kind: 'user' } })
    const content = [image, { type: 'text' as const, text: 'projected note' }, { type: 'text' as const, text: 'retained context' }]
    const projection: SessionMessageProjection<'test/edit-admit-project'> = {
      type: 'test/edit-admit-project',
      project: event => new Map([[event.data.targetSeq, { ...original, content }]]),
    }
    const session = Session.create(SessionId('projected-admission'), undefined, undefined, undefined, [projection])
    const source = session.append('user/message', original, { surfaceOp: 'append' })
    session.append('test/edit-admit-project', { targetSeq: source.seq })
    session.append('user/message-admit', { targetSeq: source.seq, message: { ...original, content: [{ type: 'text', text: 'prepared' }, image] } })
    expect(session.deriveMessages()[0]?.content).toEqual(content)
  })
  it('updates edited text at the same surface position and replays it', () => {
    const { session, input, latest } = conversation()
    const message = input('B2')
    const edit = session.append('user/message-edit', { targetSeq: latest.seq, message })
    session.append('user/message-admit', { targetSeq: edit.seq, message: { ...message, content: [{ type: 'text', text: 'prepared B2' }] } })
    expect(texts(session)).toEqual(['A', 'answer A', 'prepared B2'])
    expect(session.surface.nodes.at(-1)).toBe(edit.seq)
    expect(texts(Session.create(SessionId('admitted-replay'), session.snapshotEvents()))).toEqual(texts(session))
  })

  it('rejects changes to the committed identity without changing the log', () => {
    const { session, input, latest } = conversation()
    const before = session.snapshotEvents()
    expect(() => session.append('user/message-admit', { targetSeq: latest.seq, message: input('prepared') })).toThrow(/only text/)
    expect(session.snapshotEvents()).toBe(before)
  })
})

describe('durable edit validation', () => {
  it.each([-1, 100])('rejects a non-earlier edit target %s', (target) => {
    const { session, input } = conversation()
    expect(() => session.append('user/message-edit', { targetSeq: target as SessionSeq, message: input('edited') }))
      .toThrow(/earlier user message/)
  })

  it('rejects a plugin input and a non-human replacement', () => {
    const { session, input, latest } = conversation()
    const injected = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' } }), { surfaceOp: 'append' })
    expect(() => session.append('user/message-edit', { targetSeq: injected.seq, message: input('edited') }))
      .toThrow(/target must be a human/)
    expect(() => session.append('user/message-edit', { targetSeq: latest.seq, message: injected.data }))
      .toThrow(/replacement must be a human/)
    const invalid = JSON.parse(JSON.stringify(input('edited'))) as ReturnType<typeof input>
    Object.assign(invalid, { role: 'assistant' })
    expect(() => session.append('user/message-edit', { targetSeq: latest.seq, message: invalid }))
      .toThrow(/replacement must be a human/)
  })

  it('requires the full prefix for replay and folds content generation before a message read', () => {
    const { session, input, latest } = conversation()
    const edit = session.append('user/message-edit', { targetSeq: latest.seq, message: input('edited') })
    const events = session.snapshotEvents()
    const partial = new SurfaceManager(events.slice(edit.seq), SessionLogOffset(edit.seq))
    expect(() => partial.nodes).toThrow(/complete historical event prefix/)
    const surface = new SurfaceManager(events)
    expect(surface.contentGeneration).toBe(1)
    expect(surface.contentGeneration).toBe(1)
  })
})
