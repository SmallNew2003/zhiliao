/** Recovery action for a partially hidden workspace Session list. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantState } from './state.ts'
import css from './Assistant.module.css'

type NoticeProps = PropsLocale<'assistant'> & InjectFace<{
  readonly hooks: { readonly state: HostObservable<AssistantState> }
  readonly retry: () => void
}>

/**
 * Explain missing Session rows and retry the read in place.
 * @param props - Assistant feature state, retry action, and localized labels.
 * @returns Recovery controls while the Session list cannot be refreshed.
 */
export function SessionListNotice({ useState, retry, t }: NoticeProps) {
  const failed = useState(snapshot => snapshot.visibility === 'error')
  if (!failed) return null
  return <div className={css.sessionListNotice} role="status">
    <span>{t('visibilityError')}</span>
    <Button size="sm" onClick={retry}>{t('retry')}</Button>
  </div>
}
