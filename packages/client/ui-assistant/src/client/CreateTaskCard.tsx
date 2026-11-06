/** Durable card for one `create_task` call. */

import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { failureKey } from './failures.ts'
import css from './Assistant.module.css'
import { NS } from './locales.ts'

/** Injected share: open the execution Session created by the call. */
export interface CreateTaskCardInjected {
  readonly openTask: (sessionId: string) => void
}

/** Full props of the created-task card. */
export type CreateTaskCardProps = ToolCallViewProps & PropsLocale<typeof NS> & InjectFace<CreateTaskCardInjected>

interface CreateTaskArgs {
  readonly title?: string
  readonly prompt?: string
}

interface CreateTaskResult {
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
      if (sessionId !== undefined || code !== undefined) {
        return {
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

/**
 * Render the task title and open action for one create_task call.
 * @param props - Tool call slice, injected open action, and locale seat.
 * @returns a compact task card.
 */
export function CreateTaskCard({ block, openTask, t }: CreateTaskCardProps) {
  const settled = 'kind' in block
  const args = parseArgs(settled ? block.call?.argsRaw : block.phase === 'start' ? block.argsRaw : undefined)
  const result = settled ? parseResult(block) : {}
  const title = args.title ?? args.prompt?.split(/\r?\n/, 1)[0] ?? t('tasks')
  const failed = result.code !== undefined || (settled && block.isError)
  const statusText = result.code !== undefined
    ? t(failureKey(result.code))
    : failed ? t('statusFailed') : settled ? t('tasks') : t('loading')
  const sessionId = result.sessionId
  return (
    <div className={css.card}>
      <div className={css.cardBody}>
        <strong className={css.taskTitle}>{title}</strong>
        <span className={css.meta}>{statusText}</span>
      </div>
      {sessionId === undefined ? null : (
        <button type="button" onClick={() => { openTask(sessionId) }}>{t('open')}</button>
      )}
    </div>
  )
}
