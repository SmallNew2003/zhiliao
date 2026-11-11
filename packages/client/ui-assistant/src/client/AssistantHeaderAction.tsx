/** Session-header marker and return action for assistant conversations and task Sessions. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantState } from './index.ts'
import css from './Assistant.module.css'
import { NS } from './locales.ts'

/** Injected share of the assistant header action. */
export interface AssistantHeaderInjected {
  /** These hooks are handed to the renderer as `useState`. */
  readonly hooks: {
    readonly state: HostObservable<AssistantState>
  }
  /** Select the owning assistant and open the assistant surface. */
  readonly returnToAssistant: (sessionId: string) => void
}

/** Full props of the assistant header action. */
export type AssistantHeaderProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<AssistantHeaderInjected>

/**
 * Mark an assistant conversation or task Session and offer the way back.
 * @param props - Standard Session props, the assistant snapshot hook, and the return action.
 * @returns the marker and return button, or null for an unrelated Session.
 */
export function AssistantHeaderAction({ sessionId, useState, returnToAssistant, t }: AssistantHeaderProps) {
  const role = useState((snapshot) => {
    if (snapshot.conversations.some(entry => entry.sessionId === sessionId)) return 'assistant' as const
    if (snapshot.executions.some(entry => entry.sessionId === sessionId)) return 'task' as const
    return undefined
  })
  if (role === undefined) return null
  return (
    <div className={css.headerAction}>
      <span className={css.meta}>
        {t(role === 'assistant' ? 'headerAssistant' : 'headerAssistantTask')}
      </span>
      <Button size="sm" onClick={() => { returnToAssistant(sessionId) }}>{t('backToAssistant')}</Button>
    </div>
  )
}
