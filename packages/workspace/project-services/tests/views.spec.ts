import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceCheckoutId,
  ServiceCursor,
  ServiceItem,
  ServiceLogChunk,
  ServiceLogPage,
  ServiceProjectId,
  ServiceProviderId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { serviceItemViewTail, serviceLogsView } from '../src/views.ts'

/** One observed item carrying every optional observation fact. */
function fullItem(): ServiceItem {
  return {
    id: brandString<ServiceTargetId>('native:server'),
    providerId: brandString<ServiceProviderId>('native'),
    projectId: brandString<ServiceProjectId>('proj-1'),
    checkoutId: brandString<ServiceCheckoutId>('chk-1'),
    revision: brandString<ServiceRevision>('7'),
    name: 'api-server',
    kind: 'native',
    state: 'running',
    ownership: 'managed',
    actions: ['start', 'stop', 'restart'],
    ports: [8080, 8443],
    detail: 'started by the operator',
    stale: true,
  }
}

/** One retained chunk naming its source target. */
function chunk(targetId: string, stream: ServiceLogChunk['stream'], text: string): ServiceLogChunk {
  return { targetId: brandString<ServiceTargetId>(targetId), stream, text }
}

describe('serviceItemViewTail', () => {
  it('publishes the tail keys in the fixed public order', () => {
    expect(Object.keys(serviceItemViewTail(fullItem()))).toEqual(['actions', 'ports', 'detail', 'stale'])
  })

  it('omits every observation fact the item does not carry', () => {
    const item = fullItem()
    delete item.ports
    delete item.detail
    delete item.stale
    expect(serviceItemViewTail(item)).toStrictEqual({ actions: ['start', 'stop', 'restart'] })
  })

  it('copies the action and port arrays instead of aliasing the observed ones', () => {
    const item = fullItem()
    const view = serviceItemViewTail(item)
    view.actions.push('stop')
    view.ports?.push(9090)
    expect(item.actions).toEqual(['start', 'stop', 'restart'])
    expect(item.ports).toEqual([8080, 8443])
  })
})

describe('serviceLogsView', () => {
  it('publishes the required keys in the fixed public order with stringified identities', () => {
    const page: ServiceLogPage = {
      chunks: [chunk('native:server', 'stdout', 'listening')],
      truncated: true,
      gap: false,
    }
    const view = serviceLogsView(page)
    expect(Object.keys(view)).toEqual(['chunks', 'truncated', 'gap'])
    expect(view.chunks).toStrictEqual([{ targetId: 'native:server', stream: 'stdout', text: 'listening' }])
  })

  it('appends the reader cursor and the unavailability reason when the page carries them', () => {
    const page: ServiceLogPage = {
      chunks: [],
      nextCursor: brandString<ServiceCursor>('cursor-2'),
      truncated: false,
      gap: true,
      unavailable: 'External native output is not captured',
    }
    const view = serviceLogsView(page)
    expect(Object.keys(view)).toEqual(['chunks', 'truncated', 'gap', 'nextCursor', 'unavailable'])
    expect(view.nextCursor).toBe('cursor-2')
    expect(view.unavailable).toBe('External native output is not captured')
  })
})
