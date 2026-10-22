/** Produce a committed edit and prepared admission through the shipped SDK loop. */
export const name = 'snapshot-message-edit-producer'
export const inject = ['agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime context.
 * @param {{ replacementText: string, preparedText: string, originalResponse: string }} config - Recorded edit text and request-history assertions.
 */
export function apply(ctx, config) {
  const runs = new Map()
  let disposed = false
  ctx.effect(() => async () => {
    disposed = true
    await Promise.all([...runs.values()].map(state => state.commit))
  })
  ctx.on('session/event', (session, event) => {
    const state = runs.get(session.id)
    if (event.type !== 'turn/end' || state?.pendingMessage === undefined || state.receipt !== undefined) return
    // Commit after all turn-end observers and before the queued driver's next turn.
    state.commit = Promise.resolve().then(() => {
      if (disposed) return
      const edited = session.append('user/message-edit', {
        targetSeq: state.targetSeq, message: state.pendingMessage,
      })
      state.receipt = { seq: edited.seq, message: edited.data.message }
    })
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
    if (agent === undefined || agent.session.header.parentSession !== undefined || options.purpose !== undefined) {
      yield* next()
      return
    }
    if (JSON.stringify(options.messages) !== JSON.stringify(agent.session.deriveMessages())) {
      throw new Error('SDK model request differs from committed input history')
    }
    const state = runs.get(agent.id) ?? { calls: 0 }
    state.calls += 1
    runs.set(agent.id, state)
    if (state.receipt !== undefined) {
      const text = JSON.stringify(options.messages)
      if (!text.includes(config.preparedText) || text.includes(state.originalText)
        || text.includes(config.originalResponse)) {
        throw new Error('edited SDK request must contain prepared input and exclude the original input and response')
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    const state = runs.get(agent.id)
    if (state === undefined) throw new Error('edit snapshot requires a root model request')
    if (state.receipt !== undefined) {
      if (state.calls !== state.originalCalls + 1) throw new Error('edit snapshot requires one replacement model request')
      return
    }
    const target = agent.session.snapshotEvents().findLast(event =>
      event.type === 'user/message' && event.data.source.kind === 'user')
    if (target === undefined) throw new Error('edit snapshot requires a human input')
    state.originalCalls = state.calls
    state.originalText = target.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const message = {
      id: 'snapshot-edited-input', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: config.replacementText }],
    }
    state.targetSeq = target.seq
    state.pendingMessage = message
    agent.followup(message)
  })
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    const receipt = runs.get(agent.id)?.receipt
    if (decision.kind !== 'enter' || receipt === undefined
      || !messages.some(message => message.id === receipt.message.id)) return decision
    const committed = new Map(decision.committedMessages?.map(item => [item.message.id, item]))
    committed.set(receipt.message.id, receipt)
    return {
      ...decision,
      committedMessages: [...committed.values()],
      messages: decision.messages.map(message => message.id !== receipt.message.id ? message : {
        ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: config.preparedText } : block),
      }),
    }
  })
}
