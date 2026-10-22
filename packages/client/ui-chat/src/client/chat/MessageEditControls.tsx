/** Keyboard-accessible text-only editor for one sent human input. */
import { useId, useRef, useState, type ReactNode } from 'react'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, IconEditOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'
import actionCss from './MessageIconActions.module.css'

/** One sent message's eligibility, original text, and edit operation. */
export interface MessageEditControlsProps {
  readonly text: string
  readonly targetSeq: number
  readonly latest: boolean
  readonly running: boolean
  readonly hasAttachments: boolean
  readonly editMessage: ISession['editMessage']
  readonly t: ChatViewSlotProps['t']
  /** Report the draft lifetime to the owning Chat view. */
  readonly onEditingChange?: ((open: boolean) => void) | undefined
  /** Compose the edit trigger with the message's other actions. */
  readonly renderActions?: (trigger: ReactNode) => ReactNode
}

/**
 * Preserve an edit draft and request identity until acceptance or cancellation.
 * @param props - Original input, current eligibility, and session operation.
 * @returns Inline editor and the latest input's edit action.
 */
export function MessageEditControls({
  text, targetSeq, latest, running, hasAttachments, editMessage, t, renderActions, onEditingChange,
}: MessageEditControlsProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const originalText = useRef(text)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const request = useRef<{ text: string; requestId: SessionRequestId } | null>(null)
  const reasonId = useId()
  const close = (): void => {
    setDraft(null)
    setError(null)
    request.current = null
    triggerRef.current?.focus()
    onEditingChange?.(false)
  }
  const submit = async (): Promise<void> => {
    if (draft === null || running || pending.current) return
    if (draft === originalText.current) { close(); return }
    if (!latest && (request.current === null || request.current.text !== draft)) { setError(t('message.edit.stale')); return }
    if (draft.trim() === '' && !hasAttachments) { setError(t('message.edit.empty')); return }
    if (request.current === null || request.current.text !== draft) {
      request.current = { text: draft, requestId: randomUUID() as SessionRequestId }
    }
    pending.current = true
    setSending(true)
    setError(null)
    try {
      const result = await editMessage({ targetSeq: SessionSeq(targetSeq), ...request.current })
      if (result.ok) { close(); return }
      const code = result.error.code
      setError(t(code === 'session/edit-stale' ? 'message.edit.stale'
        : code === 'session/agent-busy' ? 'message.edit.busy'
          : code === 'session/attachment-invalid' ? 'message.edit.attachmentError' : 'message.edit.failed'))
    } catch (_error: unknown) {
      // An unreceived acceptance must retain the same request id on retry.
      setError(t('message.edit.failed'))
    } finally {
      pending.current = false
      setSending(false)
    }
  }
  const trigger = !latest && draft === null ? null : <>
    <Tooltip label={running ? t('message.edit.busy') : t('message.edit')} side="bottom">
      <button ref={triggerRef} type="button" className={actionCss.action} aria-label={t('message.edit')}
        aria-disabled={running || sending || !latest || undefined}
        aria-describedby={running ? reasonId : undefined}
        onClick={running || sending || !latest ? undefined : () => {
          originalText.current = text
          setDraft(text); setError(null); request.current = null; onEditingChange?.(true)
        }}>
        <IconEditOutline16 />
      </button>
    </Tooltip>
    {running && <span id={reasonId} className={actionCss.visuallyHidden}>{t('message.edit.busy')}</span>}
  </>
  return <>
    {renderActions === undefined ? trigger : renderActions(trigger)}
    {draft !== null && <form className={css.editPanel} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <textarea autoFocus aria-label={t('message.edit.label')} value={draft} disabled={sending}
        onChange={(event) => { setDraft(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !sending) { event.preventDefault(); close() }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
        }} />
      {hasAttachments && <span>{t('message.edit.attachments')}</span>}
      {running && <span role="status">{t('message.edit.busy')}</span>}
      {error !== null && <span role="alert">{error}</span>}
      <div className={css.editButtons}>
        <Button variant="outline" size="sm" disabled={sending} onClick={close}>{t('message.edit.cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={sending || running}>{t(sending ? 'message.edit.sending' : 'message.edit.resend')}</Button>
      </div>
    </form>}
  </>
}
