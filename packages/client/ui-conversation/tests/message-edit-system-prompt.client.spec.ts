/** Prompt inspection restores the prompt that preceded an edited human input. */

import { expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { inspectSystemPrompt } from '../src/client/contract/system-prompt.ts'

it('discards system updates introduced after the edited input', () => {
  const session = Session.create(SessionId('edit-prompt'))
  const prompt = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('before', 'test') }, { surfaceOp: 'append' })
  const input = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const update = session.append('system/message', { turn: 1, step: 2, message: createSystemMessage('after', 'test') }, { surfaceOp: 'append' })
  const edit = session.append('user/message-edit', { targetSeq: input.seq, message: createUserMessage({ content: [{ type: 'text', text: 'edited' }], source: { kind: 'user' } }) })
  let state = inspectSystemPrompt(undefined, prompt)
  state = inspectSystemPrompt(state, input)
  state = inspectSystemPrompt(state, update)
  expect(state.effective?.text).toBe('after')
  state = inspectSystemPrompt(state, edit)
  expect(state.effective?.text).toBe('before')
  expect(state.nodes.map(item => item.node.seq)).toEqual([prompt.seq])
})
