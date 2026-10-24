import { memo, useCallback, useMemo } from 'react'
import type { MarkdownCodeBlockRenderer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'> & PropsRenderSlots<'conversation.chat.codeBlock'>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, renderSlotChain, t,
}: AssistantNodeViewProps) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && turnProcess.spec.answerStep === data.step
    && turnProcess.spec.inlineReasoning
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  const renderCodeBlock = useCallback<MarkdownCodeBlockRenderer>(
    (block, fallback) => renderSlotChain('conversation.chat.codeBlock', { block }, { fallback }),
    [renderSlotChain],
  )
  return (
    <AssistantMarkdown
      blocks={data.blocks}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      renderMessageImages={renderMessageImages}
      renderCodeBlock={renderCodeBlock}
      reasoningHidden={reasoningHidden}
      revealProcess={revealProcess}
      mentions={mentions}
      t={t}
    />
  )
})
