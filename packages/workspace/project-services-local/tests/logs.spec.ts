import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceTargetId } from '@deepseek-ai/dsh-project-services'
import { RetainedServiceLog } from '../src/logs.ts'
const targetId = brandString<ServiceTargetId>('native:source')
it('retains a byte-bounded tail while independent readers observe the same data and gaps', () => {
  const log = new RetainedServiceLog(targetId, 8)
  log.append('01234567')
  const first = log.read({ targetId, maxBytes: 300 })
  expect(first.chunks.map(chunk => chunk.text).join('')).toBe('01234567')
  expect(log.read({ targetId, maxBytes: 300 })).toEqual(first)
  log.append('abcdefghij')
  const next = log.read({ targetId, cursor: first.nextCursor!, maxBytes: 300 })
  expect(next.gap).toBe(true)
  expect(next.chunks.map(chunk => chunk.text).join('')).toBe('cdefghij')
})
it('bounds complete serialized pages and never splits a UTF-8 character', () => {
  const log = new RetainedServiceLog(targetId, 8192)
  log.append('中😀'.repeat(200))
  const page = log.read({ targetId, maxBytes: 180 })
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(180)
  expect(page.truncated).toBe(true)
  expect(page.chunks.map(chunk => chunk.text).join('')).not.toContain('�')
  expect(page.chunks.length).toBe(1)
  const next = log.read({ targetId, cursor: page.nextCursor!, maxBytes: 180 })
  expect(next.nextCursor).not.toBe(page.nextCursor)
  expect(() => log.read({ targetId, maxBytes: 1 })).toThrow(/limit/)
})
