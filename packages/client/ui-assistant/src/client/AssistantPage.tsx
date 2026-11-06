/** Assistant main panel: global/project selector, task list, and task actions. */

import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AssistantState } from './index.ts'
import type { AssistantTaskStatus, AssistantTaskView } from '@deepseek-ai/dsh-assistant-task/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { failureKey } from './failures.ts'
import css from './Assistant.module.css'
import { NS, type AssistantLocale } from './locales.ts'

const STATUS_KEYS: Record<AssistantTaskStatus, keyof AssistantLocale> = {
  created: 'statusCreated',
  running: 'statusRunning',
  'waiting-approval': 'statusWaitingApproval',
  'waiting-answer': 'statusWaitingAnswer',
  done: 'statusDone',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
}

/** Injected share of the assistant page. */
export interface AssistantPageInjected {
  /** Snapshot sources the renderer binds to selector hooks. */
  readonly hooks: {
    readonly state: HostObservable<AssistantState>
    readonly workspaces: HostObservable<WorkspaceSnapshot>
  }
  readonly selectGlobal: () => void
  readonly selectProject: (workspaceId: string) => void
  readonly refresh: () => void
  readonly cancelTask: (id: string) => void
  readonly openTask: (sessionId: string) => void
  readonly openAssistant: (sessionId: string) => void
}

/** Full props of the assistant page. */
export type AssistantPageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & InjectFace<AssistantPageInjected>

function isTerminal(status: AssistantTaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function canOpen(task: AssistantTaskView): boolean {
  return task.sessionAvailable
}

/**
 * Render the assistant surface.
 * @param props - Bound snapshot hooks, actions, and locale seat.
 * @returns the assistant selector and task list.
 */
export function AssistantPage({
  useState,
  useWorkspaces,
  selectGlobal,
  selectProject,
  refresh,
  cancelTask,
  openTask,
  openAssistant,
  t,
}: AssistantPageProps) {
  const state = useState(snapshot => snapshot)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const selected = state.selectedWorkspace ?? 'global'
  const selectedAssistant = state.assistants.find(assistant => assistant.id === state.selected)
    ?? state.assistants.find(assistant => selected === 'global'
      ? assistant.kind === 'global'
      : assistant.workspaceId === selected)
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <label className={css.selector}>
          <span>{t('selector')}</span>
          <select
            value={selected}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'global') selectGlobal()
              else selectProject(value)
            }}
          >
            <option value="global">{t('global')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>
        {selectedAssistant === undefined ? null : (
          <button type="button" onClick={() => { openAssistant(selectedAssistant.sessionId) }}>{t('openAssistant')}</button>
        )}
        <button type="button" onClick={refresh}>{t('refresh')}</button>
        {state.phase === 'loading' ? <span>{t('loading')}</span> : null}
      </header>
      {state.phase === 'error' ? (
        <div role="status" className={css.notice}>
          <span>{t('loadError')}</span>
          <button type="button" onClick={refresh}>{t('retry')}</button>
        </div>
      ) : null}
      <section className={css.tasks}>
        <h2 className={css.sectionTitle}>{t('tasks')}</h2>
        {state.tasks.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
          <ul className={css.list}>
            {state.tasks.map((task) => {
              const project = workspaces.find(workspace => workspace.workspaceId === task.workspaceId)
              return (
                <li key={task.id} className={css.task}>
                  <div className={css.taskBody}>
                    <strong className={css.taskTitle}>{task.title}</strong>
                    <span className={css.meta}>
                      {project?.title ?? t('global')} · {t(STATUS_KEYS[task.status])} · {new Date(task.updatedAt).toLocaleString()}
                    </span>
                    {task.failure === undefined ? null : <span className={css.failure}>{t(failureKey(task.failure.code))}</span>}
                  </div>
                  {canOpen(task) ? (
                    <button type="button" onClick={() => { openTask(task.sessionId) }}>{t('open')}</button>
                  ) : null}
                  {isTerminal(task.status) ? null : (
                    <button type="button" onClick={() => { cancelTask(task.id) }}>{t('cancel')}</button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
