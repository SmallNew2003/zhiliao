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
  let label = group.summary.toolCount === 0
    ? t('message.processGroup.done')
    : t(group.summary.toolCount === 1 ? 'message.processGroup.tools.one' : 'message.processGroup.tools.other', {
      count: group.summary.toolCount,
    })
  if (group.summary.failedToolCount > 0) {
    label += `${t('message.turnProcess.separator')}${t('message.processGroup.failed', {
      count: group.summary.failedToolCount,
    })}`
  }
  return label
}
