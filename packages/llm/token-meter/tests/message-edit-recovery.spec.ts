/** Latest-input pricing and checkpoint recovery across historical edit materialization. */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import TokenMeter from '../src/index.ts'
import { estimateMessage } from '../src/estimate.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx
}

function legacyPrefix(namespaced: boolean) {
  const seed = Session.create(SessionId('edit-price-seed'))
  seed.append('step/start', { turn: 1, step: 1 })
  const input = seed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  seed.append('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } })
  seed.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'old answer' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
  seed.append('step/end', { turn: 1, step: 1 })
  const replacement = createUserMessage({ content: [{ type: 'text', text: 'edited' }], source: { kind: 'user' } })
  const edited = seed.append('user/message-edit', { targetSeq: input.seq, message: replacement })
  seed.append('user/message', { ...replacement, content: [{ type: 'text', text: 'prepared edited text' }] }, { surfaceOp: 'append' })
  const raw = seed.snapshotEvents().map(event => namespaced && event.type === 'user/message-edit'
    ? { ...event, type: 'plugin:user/message-edit', ignorable: true } as never : event)
  return { raw, header: seed.header, edited, replacement }
}

describe('latest edited-input pricing', () => {
  it.each([false, true])('retains edit identity and prices prepared materialization once (namespaced=%s)', async (namespaced) => {
    const ctx = await harness()
    const { raw, header, edited } = legacyPrefix(namespaced)
    const session = Session.fromRestore(header.id, raw, header, SessionLogOffset(0), 'detached')
    expect(ctx.tokenMeter.measure(session).surfaceTokens).toBe(estimateMessage(session.deriveMessages().find(message => message.role === 'user')!))
    const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(session))) as ProjectionCheckpoint
    const through = session.seq
    const replacement = createUserMessage({ content: [{ type: 'text', text: 'second edit' }], source: { kind: 'user' } })
    const next = session.append('user/message-edit', { targetSeq: edited.seq, message: replacement })
    expect(ctx.tokenMeter.measure(session).nodes.map(node => node.seq)).toEqual([next.seq])
    expect(ctx.tokenMeter.measure(session).surfaceTokens).toBe(estimateMessage(replacement))
    const recovered = await harness()
    const events = session.snapshotEvents()
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'detached')
    recovered.sessionProjections.hydrate(restored, checkpoint, events.slice(through), through)
    expect(recovered.tokenMeter.measure(restored).surfaceTokens).toBe(estimateMessage(replacement))
    expect(recovered.sessionProjections.checkpoint(restored).contextBreakdown?.val).toMatchObject({
      breakdown: { messageTokens: estimateMessage(replacement) },
    })
    expect(restored.snapshotEvents().slice(0, raw.length)).toEqual(raw)
  })
})
