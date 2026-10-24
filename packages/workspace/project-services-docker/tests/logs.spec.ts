import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceCheckoutId,
  ServiceCursor,
  ServiceItem,
  ServiceProviderId,
  ServiceProjectId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { DockerTransport, type DockerCliExecutor } from '../src/transport.ts'
import { fetchDockerLogs } from '../src/logs.ts'

const projectId = brandString<ServiceProjectId>('proj-1')
const target: ServiceItem = {
  id: brandString<ServiceTargetId>('docker:container:c-app'),
  providerId: brandString<ServiceProviderId>('docker'),
  projectId,
  checkoutId: brandString<ServiceCheckoutId>('chk-1'),
  revision: brandString<ServiceRevision>('rev-1'),
  name: 'web',
  kind: 'docker',
  state: 'running',
  ownership: 'external',
  actions: ['stop'],
}

function transportWith(output: string, seen: string[][] = [], failure?: string): DockerTransport {
  const executor: DockerCliExecutor = {
    async exec(args) {
      seen.push([...args])
      if (failure !== undefined) throw new Error(failure)
      return { stdout: output, stderr: '', exitCode: 0 }
    },
  }
  return new DockerTransport('', executor, 100)
}

describe('fetchDockerLogs', () => {
  it('delivers timestamped lines and advances the cursor to the last delivered line', async () => {
    const transport = transportWith(
      '2026-10-10T12:00:00.000000000Z Line one\n2026-10-10T12:00:01.000000000Z Line two\n',
    )
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['Line one', 'Line two'])
    expect(page.nextCursor).toBe('2026-10-10T12:00:01.000000000Z')
    expect(page.truncated).toBe(false)
    expect(page.gap).toBe(false)
  })

  it('passes the cursor as --since and drops lines at or before it', async () => {
    const seen: string[][] = []
    const transport = transportWith(
      '2026-10-10T12:00:01.000000000Z boundary\n2026-10-10T12:00:02.000000000Z fresh\n', seen,
    )
    const page = await fetchDockerLogs(
      target,
      { targetId: target.id, maxBytes: 4096, cursor: brandString<ServiceCursor>('2026-10-10T12:00:01.000000000Z') },
      transport, 1000, new AbortController().signal,
    )
    expect(seen[0]).toEqual(['logs', '--timestamps', '--tail', '1000', '--since', '2026-10-10T12:00:01.000000000Z', 'c-app'])
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['fresh'])
    expect(page.nextCursor).toBe('2026-10-10T12:00:02.000000000Z')
  })

  it('keeps the cursor on a truncated page so undelivered lines survive', async () => {
    const transport = transportWith(
      '2026-10-10T12:00:00.000000000Z first\n2026-10-10T12:00:01.000000000Z second\n2026-10-10T12:00:02.000000000Z third\n',
    )
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 200 }, transport, 1000, new AbortController().signal)
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['first'])
    expect(page.truncated).toBe(true)
    expect(page.nextCursor).toBe('2026-10-10T12:00:00.000000000Z')
  })

  it('counts per-chunk metadata toward the byte cap', async () => {
    const transport = transportWith(
      '2026-10-10T12:00:00.000000000Z abcdefghij\n2026-10-10T12:00:01.000000000Z klmnopqrst\n',
    )
    const oneLine = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 200 }, transport, 1000, new AbortController().signal)
    const twoLines = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 244 }, transport, 1000, new AbortController().signal)
    expect(oneLine.chunks).toHaveLength(1)
    expect(oneLine.truncated).toBe(true)
    expect(twoLines.chunks).toHaveLength(2)
    expect(twoLines.truncated).toBe(false)
  })

  it('reports an unreadable limit that cannot hold one log line', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Z a very long line\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 100 }, transport, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([])
    expect(page.unavailable).toBe('Service log response limit cannot hold one log line')
  })

  it('reports an unreadable limit that cannot hold the page metadata', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Z line\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 40 }, transport, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([])
    expect(page.unavailable).toBe('Service log response limit cannot hold metadata')
  })

  it('counts multibyte characters by their encoded byte length', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Z 数据建模大屏\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 174 }, transport, 1000, new AbortController().signal)
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['数据建模大屏'])
    const ascii = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 170 }, transport, 1000, new AbortController().signal)
    expect(ascii.chunks).toEqual([])
  })

  it('preserves the cursor when the daemon reports no new output', async () => {
    const transport = transportWith('   \n')
    const page = await fetchDockerLogs(
      target, { targetId: target.id, maxBytes: 4096, cursor: brandString<ServiceCursor>('2026-10-10T12:00:01.000000000Z') },
      transport, 1000, new AbortController().signal,
    )
    expect(page.chunks).toEqual([])
    expect(page.nextCursor).toBe('2026-10-10T12:00:01.000000000Z')
    expect(page.truncated).toBe(false)
  })

  it('reports no cursor for an empty page read without one', async () => {
    const transport = transportWith('')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([])
    expect(page.nextCursor).toBeUndefined()
    expect(page.truncated).toBe(false)
  })

  it('delivers a bare timestamp line as an empty chunk that advances the cursor', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Z\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([{ targetId: target.id, stream: 'combined', text: '' }])
    expect(page.nextCursor).toBe('2026-10-10T12:00:00.000000000Z')
  })

  it('delivers a line whose timestamp prefix is not followed by whitespace verbatim', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Zattached\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['2026-10-10T12:00:00.000000000Zattached'])
    expect(page.nextCursor).toBeUndefined()
  })

  it('keeps unstamped lines when a cursor is set', async () => {
    const transport = transportWith('plain line\n2026-10-10T12:00:02.000000000Z fresh\n')
    const page = await fetchDockerLogs(
      target,
      { targetId: target.id, maxBytes: 4096, cursor: brandString<ServiceCursor>('2026-10-10T12:00:01.000000000Z') },
      transport, 1000, new AbortController().signal,
    )
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['plain line', 'fresh'])
    expect(page.nextCursor).toBe('2026-10-10T12:00:02.000000000Z')
  })

  it('delivers a line without a timestamp prefix verbatim', async () => {
    const transport = transportWith('plain line without timestamp\n')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks.map(chunk => chunk.text)).toEqual(['plain line without timestamp'])
    expect(page.nextCursor).toBeUndefined()
  })

  it('reports a non-container target as unavailable', async () => {
    const transport = transportWith('')
    const page = await fetchDockerLogs(
      { ...target, id: brandString<ServiceTargetId>('docker:group:app:web') },
      { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal,
    )
    expect(page.chunks).toEqual([])
    expect(page.unavailable).toBe('Cannot read logs from non-container target: docker:group:app:web')
  })

  it('requires an explicit response limit', async () => {
    const transport = transportWith('2026-10-10T12:00:00.000000000Z line\n')
    await expect(fetchDockerLogs(
      target, { targetId: target.id }, transport, 1000, new AbortController().signal,
    )).rejects.toThrow('Explicit log response limit required')
  })

  it('reports a non-error dispatch failure as unavailable', async () => {
    const throwing = new DockerTransport('', {
      async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> { throw 'logs exploded' },
    }, 100)
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, throwing, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([])
    expect(page.unavailable).toBe('logs exploded')
  })

  it('reports a failed CLI dispatch as unavailable', async () => {
    const transport = transportWith('', [], 'Docker logs failed for container c-app: no such container')
    const page = await fetchDockerLogs(target, { targetId: target.id, maxBytes: 4096 }, transport, 1000, new AbortController().signal)
    expect(page.chunks).toEqual([])
    expect(page.unavailable).toBe('Docker logs failed for container c-app: no such container')
  })
})
