/** Current Host task state shared by the panel and create_task transcript card. */
import type { AssistantTaskStatus, AssistantTaskView } from '@deepseek-ai/dsh-assistant-task/client'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Assistant.module.css'
import { failureKey } from './failures.ts'
import { NS, type AssistantLocale } from './locales.ts'

const presentation = {
  created: ['statusCreated', 'idle', 'active'],
  running: ['statusRunning', 'ongoing', 'active'],
  cancelling: ['statusCancelling', 'ongoing', 'active'],
  'waiting-approval': ['statusWaitingApproval', 'warning', 'waiting'],
  'waiting-answer': ['statusWaitingAnswer', 'warning', 'waiting'],
  done: ['statusDone', 'done', 'finished'],
  failed: ['statusFailed', 'error', 'finished'],
  cancelled: ['statusCancelled', 'idle', 'finished'],
} as const satisfies Record<AssistantTaskStatus, readonly [keyof AssistantLocale, StateDotState, string]>

/**
 * Determine which section contains a task.
 * @param status - durable Host status.
 * @returns the task's activity group.
 */
export function taskGroup(status: AssistantTaskStatus) {
  return presentation[status][2]
}

type TaskCardProps = PropsLocale<typeof NS> & {
  task: AssistantTaskView
  project?: string | undefined
  cancelState?: 'pending' | 'error' | undefined
  openTask: (sessionId: string) => void
  cancelTask: (id: AssistantTaskView['id']) => void
}

/**
 * Render current task status, result, failure and available actions.
 * @param props - task, localized labels and actions for its execution Session.
 * @returns the task article.
 */
export function TaskCard({ task, project, cancelState, openTask, cancelTask, t }: TaskCardProps) {
  const [status, dot, group] = presentation[task.status]
  return (
    <article className={css.card}>
      <div className={css.meta}>
        <StateDot state={dot} size={12} />
        <span>{t(status)}</span>
        <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString(document.documentElement.lang || undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })}</time>
        {project && <span className={css.projectName}>{project}</span>}
      </div>
      <strong className={css.taskTitle}>{task.title}</strong>
      {task.resultSummary && <p className={css.summary}>{task.resultSummary}</p>}
      {task.failure && <p className={css.failure}>{t(failureKey(task.failure.code))}</p>}
      {group !== 'finished' && cancelState === 'error' && <p role="status" className={css.failure}>{t('cancelError')}</p>}
      <div className={css.actions}>
        {task.sessionAvailable && <Button size="sm" variant="outline" onClick={() => { openTask(task.sessionId) }}>{t('open')}</Button>}
        {group !== 'finished' && (task.status !== 'cancelling' || task.failure?.code === 'cancel_failed') && (
          <Button size="sm" disabled={cancelState === 'pending'} onClick={() => { cancelTask(task.id) }}>
            {t(cancelState === 'pending' ? 'statusCancelling' : task.failure?.code === 'cancel_failed' ? 'retryCancel' : 'cancel')}
          </Button>
        )}
      </div>
    </article>
  )
}
