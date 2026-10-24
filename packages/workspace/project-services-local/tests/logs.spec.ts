import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceCursor, ServiceTargetId } from '@deepseek-ai/dsh-project-services'
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
it('拒绝非正整数的保留上限', () => {
  expect(() => new RetainedServiceLog(targetId, 0)).toThrow('Invalid retained log limit')
  expect(() => new RetainedServiceLog(targetId, 1.5)).toThrow('Invalid retained log limit')
})
it('拒绝属于其他服务的游标以及缺失或非法的响应上限', () => {
  const log = new RetainedServiceLog(targetId, 64)
  const other = brandString<ServiceTargetId>('native:other')
  expect(() => log.read({ targetId: other, maxBytes: 300 })).toThrow('belongs to another service')
  expect(() => log.read({ targetId })).toThrow('Explicit log response limit required')
  expect(() => log.read({ targetId, maxBytes: 0 })).toThrow('Explicit log response limit required')
  expect(() => log.read({ targetId, maxBytes: 1.5 })).toThrow('Explicit log response limit required')
})
it('拒绝越界、负数与不可表示的绝对游标', () => {
  const log = new RetainedServiceLog(targetId, 64)
  log.append('0123456789')
  for (const value of ['not-a-number', '-1', '999']) {
    const cursor = brandString<ServiceCursor>(value)
    expect(() => log.read({ targetId, cursor, maxBytes: 300 })).toThrow('Invalid service log cursor')
  }
})
it('从字符中间的游标继续读取并报告保留缺口', () => {
  const log = new RetainedServiceLog(targetId, 4096)
  log.append('中中中')
  const page = log.read({ targetId, cursor: brandString<ServiceCursor>('1'), maxBytes: 300 })
  expect(page.gap).toBe(true)
  expect(page.chunks.map(chunk => chunk.text).join('')).toBe('中中')
})
it('在字节上限处丢弃最旧字节时跳过被截断的字符', () => {
  const log = new RetainedServiceLog(targetId, 4)
  log.append('中中中')
  const page = log.read({ targetId, maxBytes: 300 })
  expect(page.chunks.map(chunk => chunk.text).join('')).toBe('中')
  expect(page.gap).toBe(true)
})
it('在元数据可容纳但单个字符不可容纳时拒绝读取', () => {
  const log = new RetainedServiceLog(targetId, 8192)
  log.append('中')
  expect(() => log.read({ targetId, maxBytes: 70 })).toThrow('cannot hold a character')
})
