/** Localized title composition for one process-group disclosure. */
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ProcessGroup } from '../contract/process-groups.ts'

/**
 * Compose a process group's running or completed title.
 * @param group - current group state and activity summary.
 * @param elapsed - localized elapsed duration, or an empty string when unavailable.
 * @param t - Chat namespace translator.
 * @returns the header title.
 */
export function processGroupTitle(
  group: ProcessGroup,
  elapsed: string,
  t: ChatViewSlotProps['t'],
): string {
  if (!group.closed) {
    const activity = group.summary.running ?? 'thinking'
    const label = t(`message.processGroup.running.${activity}`)
    return elapsed === '' ? label : `${label}${t('message.turnProcess.separator')}${elapsed}`
  }
  const actions = group.summary.counts.slice(0, 2)
    .map(({ kind }) => t(`message.processGroup.completed.${kind}`))
  let label = actions.length === 0
    ? t('message.processGroup.completed.thinking')
    : actions.join(t('message.processGroup.completed.listSeparator'))
  if (group.summary.counts.length > actions.length) {
    label += t('message.processGroup.completed.more')
  }
  if (group.summary.failed) {
    label += `${t('message.turnProcess.separator')}${t('message.processGroup.completed.failed')}`
  }
  return label
}
