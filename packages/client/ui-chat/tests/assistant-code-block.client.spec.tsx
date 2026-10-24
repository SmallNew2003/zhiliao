// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarkdownCodeBlockRenderer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { registerChatNodeRenderers } from '../src/client/chat/register-node-renderers.ts'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'

afterEach(cleanup)

const source = '```html preview runtime=dsh-v1\n<b>Answer</b>\n```'
const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
const owner: ChatNodeOwnerProps = {
  openSkill: () => {}, openFile: () => {}, inspectCall: () => {}, forkAt: () => {},
  loadImage: async () => '', renderMessageImages: () => null, fileMentions: () => undefined,
}
const node: ChatNode<'assistant-step'> = {
  key: 'assistant:1', id: '1', kind: 'assistant-step', target: 'chat', anchorSeq: 1,
  location: { kind: 'session' }, visibility: 'visible',
  data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [{ kind: 'text', text: source }] },
}

describe('Assistant code-block extension', () => {
  it('passes the callback only to text blocks, including when reasoning is expanded', () => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    const view = render(<AssistantMarkdown blocks={[
      { kind: 'reasoning', text: source }, { kind: 'text', text: source },
    ]} streaming={false} renderMessageImages={owner.renderMessageImages} t={t} renderCodeBlock={renderCodeBlock} />)
    fireEvent.click(view.getByRole('button', { expanded: false }))
    expect(renderCodeBlock).toHaveBeenCalledOnce()
  })

  it('restores ordinary source when the session-scoped chain provider is disposed', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      await runtime.sessions.add({ id: 'code-block-session' })
      const session = runtime.sessions.retainFor(runtime.ctx, 'code-block-session' as SessionId)
      const localeRevision = { revision: 0 }
      runtime.slots.installLocale({
        getSnapshot: () => localeRevision, subscribe: () => () => {}, bind: () => () => 'label',
      })
      await runtime.declare({
        'conversation.chat.node': {
          kind: 'keyed', scope: 'session', inject: { hooks: { turnData: () => () => undefined } },
        },
      })
      await runtime.mount({ inject: ['slots'], apply: registerChatNodeRenderers })
      const nodeOwner = { ...owner, node }
      const view = runtime.renderSlot('conversation.chat.node', nodeOwner, {
        entryKey: 'assistant-step', session, hookContext: undefined,
      })
      expect(view.container.querySelector('pre')?.textContent).toContain('<b>Answer</b>')
      const provider = await runtime.mount({
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('conversation.chat.codeBlock', () => ctx.slots.register({
            name: 'conversation.chat.codeBlock', select: ({ block }) => block.closed ? {} : null,
          }, ({ block }: PropsRuntime<'conversation.chat.codeBlock'>) => <output>{block.language}:{block.code}</output>))
        },
      })
      expect(view.container.querySelector('output')?.textContent).toBe('html:<b>Answer</b>')
      expect(view.container.querySelector('pre')).toBeNull()
      await provider.dispose()
      expect(view.container.querySelector('output')).toBeNull()
      expect(view.container.querySelector('pre')?.textContent).toContain('<b>Answer</b>')
    } finally {
      await runtime.dispose()
    }
  })
})
