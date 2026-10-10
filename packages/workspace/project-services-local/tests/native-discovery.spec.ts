import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeDiscovery, parseLsofRecords, parseProcessRecords } from '../src/native-discovery.ts'

it('reads structured IPv4 and IPv6 listener records without treating command text as fields', () => {
  expect(parseLsofRecords('p31\0cnode with spaces\0\nf20\0n127.0.0.1:49123\0\nf21\0n[::1]:49124\0\n')).toEqual([{ pid: 31, name: 'node with spaces', ports: [49123, 49124] }])
})

async function observedScan(changedCreation = false, lossy = false) {
  const ctx = new Context(), fiber = await ctx.plugin(LocalSubprocessRuntime)
  let inspections = 0
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const text = spec.argv.includes('-iTCP') ? 'p31\0cnode\0\nf20\0n127.0.0.1:49123\0\n'
      : spec.argv.includes('-d') ? 'p31\0\nfcwd\0n/tmp/project\0\n'
        : `31 Sat Oct 10 16:00:0${changedCreation && inspections++ > 0 ? '1' : '0'} 2026 /usr/bin/node\n`
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {}, waitForExit: async () => true }
  })
  try {
    const config = { scanTimeoutMs: 10000, scanMaxBytes: 1048576, processInspectionMax: 200, terminationGraceMs: 5000 }
    return await new NativeDiscovery(ctx.subprocess, config).scan(new AbortController().signal)
  } finally { spy.mockRestore(); await fiber.dispose() }
}
it.skipIf(process.platform !== 'darwin')('omits a listener whose process creation observation changes during the scan', async () => {
  expect(await observedScan(true)).toEqual([])
})
it.skipIf(process.platform !== 'darwin')('combines verified listener and working-directory records', async () => {
  expect(await observedScan()).toEqual([{ pid: 31, name: 'node', ports: [49123], cwd: '/tmp/project', started: 'Sat Oct 10 16:00:00 2026' }])
})
it.skipIf(process.platform !== 'darwin')('reports an overflowing observation as failure instead of empty inventory', async () => {
  await expect(observedScan(false, true)).rejects.toThrow('output limit')
})
it('preserves working directory whitespace from structured records', () => {
  expect(parseLsofRecords('p31\0\nfcwd\0n/tmp/with spaces \0\n')).toEqual([{ pid: 31, name: '', ports: [], cwd: '/tmp/with spaces ' }])
})
it('rejects malformed structured process ids and ports', () => {
  expect(() => parseLsofRecords('pbad\0\n')).toThrow()
  expect(() => parseLsofRecords('p31\0\nf20\0n*:99999\0\n')).toThrow()
})
it('keeps process creation observations distinct from command text', () => {
  expect(parseProcessRecords(' 31 Sat Oct 10 16:00:00 2026 /usr/bin/node\n')).toEqual(new Map([[31, { started: 'Sat Oct 10 16:00:00 2026', command: '/usr/bin/node' }]]))
})

it('preserves newlines inside cwd field values', () => {
  expect(parseLsofRecords('p31\0\nfcwd\0n/tmp/line\nbreak \0\n')[0]?.cwd).toBe('/tmp/line\nbreak ')
})
