/** Durable card for one `create_task` call. */

import type { AssistantTaskId } from '@deepseek-ai/dsh-assistant-task/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantState } from './state.ts'
import { TaskCard } from './TaskCard.tsx'
import { taskAddress } from './task-resource.ts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { failureKey } from './failures.ts'
import css from './Assistant.module.css'
import { NS } from './locales.ts'

/** Authorized live lookup and actions for a task referenced by a tool result. */
export interface CreateTaskCardInjected {
  readonly hooks: { readonly state: HostObservable<AssistantState> }
  readonly retryTask: (id: AssistantTaskId) => void
  readonly cancelTask: (id: AssistantTaskId) => void
  readonly openTask: (sessionId: string) => void
}

/** Full props of the created-task card. */
export type CreateTaskCardProps = ToolCallViewProps & PropsLocale<typeof NS> & InjectFace<CreateTaskCardInjected>

interface CreateTaskArgs {
  readonly title?: string
  readonly prompt?: string
}

interface CreateTaskResult {
  readonly taskId?: AssistantTaskId
  readonly sessionId?: string
  readonly code?: string
}

function parseArgs(raw: string | undefined): CreateTaskArgs {
  if (raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const title = (parsed as Record<string, unknown>).title
    const prompt = (parsed as Record<string, unknown>).prompt
    return {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof prompt === 'string' ? { prompt } : {}),
    }
  } catch (_error: unknown) {
    return {}
  }
}

function parseResult(block: Extract<ToolCallViewProps['block'], { readonly kind: string }>): CreateTaskResult {
  for (const item of block.content) {
    if (item.type !== 'text') continue
    try {
      const parsed: unknown = JSON.parse(item.text)
      if (typeof parsed !== 'object' || parsed === null) continue
      const record = parsed as Record<string, unknown>
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
      const code = typeof record.code === 'string' ? record.code : undefined
      const taskId = typeof record.taskId === 'string' ? brandString<AssistantTaskId>(record.taskId) : undefined
      if (taskId !== undefined || sessionId !== undefined || code !== undefined) {
        return {
          ...(taskId === undefined ? {} : { taskId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(code === undefined ? {} : { code }),
        }
      }
    } catch (_error: unknown) {
      // The card keeps its title-only form for a non-JSON result.
    }
  }
  return {}
}

type LiveTaskProps = Pick<CreateTaskCardProps, 'openTask' | 'cancelTask' | 'useState' | 'useResource' | 'retryTask' | 't'>
  & { id: AssistantTaskId; title: string }

function LiveTask({ id, title, useResource, retryTask, useState: useAssistant, openTask, cancelTask, t }: LiveTaskProps) {
  const resource = useResource<'assistant-task'>(taskAddress(id))
  const cancelState = useAssistant(snapshot => snapshot.cancel[id])
  return <>
    {resource.value ? (
      <TaskCard task={resource.value} cancelState={cancelState} openTask={openTask} cancelTask={cancelTask} t={t} />
    ) : <strong className={css.taskTitle}>{title}</strong>}
    {(resource.status === 'failed' || resource.value === null) ? (
      <div role="status" className={css.notice}>
        <span>{t(resource.value === null ? 'taskUnavailable' : 'loadError')}</span>
        <Button size="sm" onClick={() => { retryTask(id) }}>{t('retry')}</Button>
      </div>
    ) : resource.value === undefined && <div role="status" className={css.notice}><StateDot state="ongoing" />{t('loading')}</div>}
  </>
}

/**
 * Render a creation failure, pending call, or a task subscribed by durable id.
 * @param props - create_task transcript and authorized reads and actions.
 * @returns the task card.
 */
export function CreateTaskCard(props: CreateTaskCardProps) {
  const { block, openTask, t } = props
  const settled = 'kind' in block
  const args = parseArgs(settled ? block.call?.argsRaw : block.phase === 'start' ? block.argsRaw : undefined)
  const result = settled ? parseResult(block) : {}
  const title = args.title ?? args.prompt?.split(/\r?\n/, 1)[0] ?? t('tasks')
  if (result.taskId !== undefined && !result.code && settled && !block.isError) {
    return <LiveTask key={result.taskId} id={result.taskId} title={title} {...props} />
  }
  const sessionId = result.sessionId
  const status = result.code ? failureKey(result.code) : settled && block.isError ? 'statusFailed'
    : settled ? 'statusCreated' : 'loading'
  return <article className={css.card}>
    <strong className={css.taskTitle}>{title}</strong>
    <span className={css.meta}>{t(status)}</span>
    {sessionId && <Button size="sm" variant="outline" onClick={() => { openTask(sessionId) }}>{t('open')}</Button>}
  </article>
}
