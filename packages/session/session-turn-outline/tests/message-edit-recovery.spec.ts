/** Edited turn previews preserve input identity through materialization and checkpoint recovery. */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as SessionTurnOutline from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTurnOutline)
  return ctx
}

function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function answer(session: Session, turn: number, text: string) {
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function historicalAliases(events: readonly SessionEvent[], namespaced: boolean): readonly SessionEvent[] {
  return events.map(event => namespaced && event.type === 'user/message-edit'
    ? { ...event, type: 'plugin:user/message-edit', ignorable: true } as never : event)
}

describe('edited turn outline recovery', () => {
  it.each([
    { namespaced: false, materializeBeforeTurn: false },
    { namespaced: false, materializeBeforeTurn: true },
    { namespaced: true, materializeBeforeTurn: false },
    { namespaced: true, materializeBeforeTurn: true },
  ])('retains edit identity and replays a second edit after checkpoint hydration ($namespaced, $materializeBeforeTurn)', async ({ namespaced, materializeBeforeTurn }) => {
    const ctx = await harness()
    const seed = Session.create(SessionId('outline-edited-input'))
    const firstBoundary = seed.append('turn/start', { turn: 1 })
    seed.append('user/message', input('retained prompt'), { surfaceOp: 'append' })
    answer(seed, 1, 'retained answer')
    seed.append('turn/start', { turn: 2 })
    const original = seed.append('user/message', input('original prompt'), { surfaceOp: 'append' })
    answer(seed, 2, 'discarded answer')
    const replacement = input('edited prompt')
    const firstEdit = seed.append('user/message-edit', { targetSeq: original.seq, message: replacement })
    const materialize = () => seed.append('user/message', { ...replacement, content: [{ type: 'text', text: 'prepared edited prompt' }] }, { surfaceOp: 'append' })
    if (materializeBeforeTurn) materialize()
    seed.append('turn/start', { turn: 3 })
    if (!materializeBeforeTurn) materialize()
    answer(seed, 3, 'discarded edited answer')
    const rawPrefix = historicalAliases(seed.snapshotEvents(), namespaced)
    const session = Session.fromRestore(seed.id, rawPrefix, seed.header, SessionLogOffset(0), 'detached')
    expect(ctx.sessionProjections.snapshot(session).values.turnOutline).toEqual([
      { turn: 1, seq: firstBoundary.seq, prompt: 'retained prompt', response: 'retained answer' },
      { turn: 3, seq: firstEdit.seq, prompt: 'prepared edited prompt', response: 'discarded edited answer' },
    ])
    const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(session))) as ProjectionCheckpoint
    expect(checkpoint.turnOutline?.val).toMatchObject({ latestInput: { seq: firstEdit.seq, messageId: replacement.id, edited: true } })
    const through = session.seq
    const secondEdit = session.append('user/message-edit', { targetSeq: firstEdit.seq, message: input('second edited prompt') })
    session.append('turn/start', { turn: 4 })
    answer(session, 4, 'second edited answer')
    const raw = historicalAliases(session.snapshotEvents(), namespaced)
    const expected = Session.fromRestore(seed.id, raw, seed.header, SessionLogOffset(0), 'detached')
    const turns = ctx.sessionProjections.snapshot(expected).values.turnOutline
    expect(turns).toEqual([
      { turn: 1, seq: firstBoundary.seq, prompt: 'retained prompt', response: 'retained answer' },
      { turn: 4, seq: secondEdit.seq, prompt: 'second edited prompt', response: 'second edited answer' },
    ])
    const recovered = await harness()
    const restored = Session.fromRestore(seed.id, raw, seed.header, SessionLogOffset(0), 'detached')
    recovered.sessionProjections.hydrate(restored, checkpoint, raw.slice(through), through)
    expect(recovered.sessionProjections.snapshot(restored).values.turnOutline).toEqual(turns)
    expect(recovered.sessionProjections.checkpoint(restored).turnOutline).toEqual(ctx.sessionProjections.checkpoint(expected).turnOutline)
    expect(restored.snapshotEvents().slice(0, rawPrefix.length)).toEqual(rawPrefix)
  })
})
