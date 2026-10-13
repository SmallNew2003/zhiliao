/** Display labels for the memory browser: each unavailability reason's sentence and the compact write time. */

import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryUnavailableReason } from '@deepseek-ai/dsh-host-memory-controller/types'
import type { MemoryBrowserLocaleKey } from './locales.ts'
import type { MemoryPanelProblem } from './memory-store.ts'

/** The translate seat of the memory browser's dictionary. */
export type Translate = PropsLocale<'memoryBrowser'>['t']

/** The sentence each of the Host's unavailability reasons reads as. */
const REASON_KEYS = {
  unavailable: 'reasonUnavailable',
  misconfigured: 'reasonMisconfigured',
  unreachable: 'reasonUnreachable',
  failed: 'reasonFailed',
} satisfies Record<MemoryUnavailableReason, MemoryBrowserLocaleKey>

/**
 * The sentence a failure reads as: the Host's own classification for a
 * condition it named, and the transport's words for a call that never answered.
 * @param problem - why the panel cannot show memory.
 * @param t - the panel's translate seat.
 * @returns the sentence.
 */
export function problemText(problem: MemoryPanelProblem, t: Translate): string {
  return problem.kind === 'unavailable' ? t(REASON_KEYS[problem.reason]) : problem.detail
}

/**
 * Whether a failure has words of its own to show beside the sentence. A
 * classified condition carries a provider diagnostic worth reading; a transport
 * failure's own message *is* the sentence, so showing it twice would be noise.
 * @param problem - why the panel cannot show memory.
 * @returns the detail line, or null when there is nothing extra to say.
 */
export function problemDetail(problem: MemoryPanelProblem): string | null {
  return problem.kind === 'unavailable' && problem.detail.length > 0 ? problem.detail : null
}

/**
 * How a bank's last write reads: a compact localized relative time, or the
 * sentence for a bank nothing has written to. Bucketing comes from the shared
 * helper so this panel and the session lists agree on when "5 minutes" ends.
 * @param lastWriteAt - the bank's ISO-8601 last-write instant, when it has one.
 * @param now - current epoch ms, injected so rendering stays pure.
 * @param t - the panel's translate seat.
 * @returns the trailing label.
 */
export function writtenText(lastWriteAt: string | undefined, now: number, t: Translate): string {
  if (lastWriteAt === undefined) return t('neverWritten')
  const at = Date.parse(lastWriteAt)
  // An instant this runtime cannot read is shown as unwritten rather than as an
  // unparsed backend string in the middle of the list.
  if (Number.isNaN(at)) return t('neverWritten')
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n: String(n) })
}
