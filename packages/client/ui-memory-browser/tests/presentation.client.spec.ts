// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { problemDetail, problemText, writtenText } from '../src/client/presentation.ts'
import { en, zh, type MemoryBrowserLocaleKey } from '../src/client/locales.ts'
import type { MemoryPanelProblem } from '../src/client/memory-store.ts'

/** Interpolate `{name}` placeholders the way the locale runtime does. */
const t = ((key: MemoryBrowserLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    // A missing key surfaces as the key itself, so a dictionary gap fails a wording
    // assertion instead of passing against an empty template.
    (zh as Record<string, string>)[key] ?? key,
  )) as Parameters<typeof problemText>[1]

const NOW = Date.parse('2026-10-10T12:00:00Z')

describe('problemText', () => {
  it('words each classified reason through the dictionary rather than the detail', () => {
    const reasons = [
      { kind: 'unavailable', reason: 'unavailable', detail: 'no provider' },
      { kind: 'unavailable', reason: 'misconfigured', detail: 'two providers' },
      { kind: 'unavailable', reason: 'unreachable', detail: 'no answer' },
      { kind: 'unavailable', reason: 'failed', detail: '500' },
    ] as const
    expect(reasons.map(problem => problemText(problem, t))).toEqual([
      zh.reasonUnavailable,
      zh.reasonMisconfigured,
      zh.reasonUnreachable,
      zh.reasonFailed,
    ])
    // The classified sentence never leaks the raw detail into the headline.
    expect(problemText(reasons[0], t)).not.toContain('no provider')
  })

  it('shows a transport failure as its own words, since that is all there is', () => {
    const problem: MemoryPanelProblem = { kind: 'error', detail: 'socket closed' }
    expect(problemText(problem, t)).toBe('socket closed')
  })
})

describe('problemDetail', () => {
  it('offers the diagnostic of a classified condition', () => {
    expect(problemDetail({ kind: 'unavailable', reason: 'failed', detail: 'the daemon said no' }))
      .toBe('the daemon said no')
  })

  it('offers nothing when a classified condition carries no diagnostic', () => {
    expect(problemDetail({ kind: 'unavailable', reason: 'unavailable', detail: '' })).toBeNull()
  })

  it('offers nothing for a transport failure, whose words are already the sentence', () => {
    expect(problemDetail({ kind: 'error', detail: 'socket closed' })).toBeNull()
  })
})

describe('writtenText', () => {
  it('reads a bank nothing has written to as never written', () => {
    expect(writtenText(undefined, NOW, t)).toBe(zh.neverWritten)
  })

  it('reads an instant this runtime cannot parse as never written', () => {
    // An unparsed backend string in the middle of a list reads as a bug; the
    // bank is shown as unwritten instead.
    expect(writtenText('not a timestamp', NOW, t)).toBe(zh.neverWritten)
  })

  it('reads a bank written within the minute as just now', () => {
    expect(writtenText(new Date(NOW - 10_000).toISOString(), NOW, t)).toBe(zh['time.now'])
  })

  it('buckets older writes through the shared relative-time units', () => {
    const at = (ms: number): string => writtenText(new Date(NOW - ms).toISOString(), NOW, t)
    expect(at(5 * 60_000)).toBe(zh['time.minutes'].replace('{n}', '5'))
    expect(at(3 * 3_600_000)).toBe(zh['time.hours'].replace('{n}', '3'))
    expect(at(2 * 86_400_000)).toBe(zh['time.days'].replace('{n}', '2'))
    expect(at(60 * 86_400_000)).toBe(zh['time.months'].replace('{n}', '2'))
    expect(at(400 * 86_400_000)).toBe(zh['time.years'].replace('{n}', '1'))
  })

  it('keeps the English dictionary\'s own wording for the same buckets', () => {
    const english = ((key: MemoryBrowserLocaleKey, params?: Record<string, string>): string => {
      return Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, value),
        (en as Record<string, string>)[key] ?? key,
      )
    }) as Parameters<typeof writtenText>[2]
    expect(writtenText(new Date(NOW - 3 * 3_600_000).toISOString(), NOW, english)).toBe('3h')
    expect(writtenText(undefined, NOW, english)).toBe(en.neverWritten)
  })
})
