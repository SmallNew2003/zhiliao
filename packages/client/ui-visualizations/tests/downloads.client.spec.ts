/** Local-date filenames and decoded byte bounds. */
import { expect, it } from 'vitest'
import { createDownloadNames } from '../src/client/downloads.ts'

it('uses the local calendar date and same-day counters, with safe content names', () => {
  const names = createDownloadNames()
  const day = new Date(2026, 9, 10, 1)
  expect(names('Revenue / Q4', 'html', day)).toBe('Revenue Q4_20261010.html')
  expect(names('Revenue / Q4', 'html', day)).toBe('Revenue Q4_20261010_02.html')
  expect(names('Revenue / Q4', 'html', new Date(2026, 9, 11))).toBe('Revenue Q4_20261011.html')
  expect(names('你好', 'svg', day)).toBe('你好_20261010.svg')
  expect(names('CON', 'txt', day)).toBe('_CON_20261010.txt')
})
