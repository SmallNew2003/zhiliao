import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeDiscovery, parseLsofRecords, parseProcessRecords, type NativeScanConfig } from '../src/native-discovery.ts'

it('reads structured IPv4 and IPv6 listener records without treating command text as fields', () => {
  expect(parseLsofRecords('p31\0cnode with spaces\0\nf20\0n127.0.0.1:49123\0\nf21\0n[::1]:49124\0\n')).toEqual([{ pid: 31, name: 'node with spaces', ports: [49123, 49124] }])
})
it('对同一进程在两个地址族上监听的同一端口去重', () => {
  expect(parseLsofRecords('p31\0\nf20\0n127.0.0.1:49123\0\nf21\0n[::1]:49123\0\n')).toEqual([{ pid: 31, name: '', ports: [49123] }])
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
/**
 * Listener discovery inspects the macOS process table, so `scan` rejects every
 * other platform. Fixing the label keeps these stubbed inspections running on
 * the Linux and Windows lanes, where no real lsof/ps pair exists.
 */
async function onDarwin<T>(body: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try { return await body() } finally { Object.defineProperty(process, 'platform', platform) }
}
it('omits a listener whose process creation observation changes during the scan', async () => {
  expect(await onDarwin(() => observedScan(true))).toEqual([])
})
it('combines verified listener and working-directory records', async () => {
  expect(await onDarwin(() => observedScan())).toEqual([{ pid: 31, name: 'node', ports: [49123], cwd: '/tmp/project', started: 'Sat Oct 10 16:00:00 2026' }])
})
it('reports an overflowing observation as failure instead of empty inventory', async () => {
  await expect(onDarwin(() => observedScan(false, true))).rejects.toThrow('output limit')
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

type ScanOutcome = { exitCode?: number; text?: string; errText?: string; lossy?: boolean }
async function discoveryScan(respond: (argv: readonly string[]) => ScanOutcome, config?: Partial<NativeScanConfig>) {
  const ctx = new Context(), fiber = await ctx.plugin(LocalSubprocessRuntime)
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const outcome = respond(spec.argv)
    const text = outcome.text ?? '', errText = outcome.errText ?? ''
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: outcome.lossy ?? false }) },
        stderr: { readFrom: () => ({ text: errText, nextOffset: errText.length, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: outcome.exitCode ?? 0, signal: null }), terminate: () => {}, waitForExit: async () => true }
  })
  try {
    const discovery = new NativeDiscovery(ctx.subprocess, {
      scanTimeoutMs: 10000, scanMaxBytes: 1048576, processInspectionMax: 200, terminationGraceMs: 5000, ...config,
    })
    return await discovery.scan(new AbortController().signal)
  } finally { spy.mockRestore(); await fiber.dispose() }
}
const processRecord = ' 31 Sat Oct 10 16:00:00 2026 /usr/bin/node\n'
it('在非 macOS 平台上拒绝监听发现', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const ctx = new Context(), fiber = await ctx.plugin(LocalSubprocessRuntime)
  try {
    const config = { scanTimeoutMs: 10000, scanMaxBytes: 1048576, processInspectionMax: 200, terminationGraceMs: 5000 }
    await expect(new NativeDiscovery(ctx.subprocess, config).scan(new AbortController().signal)).rejects.toThrow('requires macOS')
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    await fiber.dispose()
  }
})
it('在没有监听进程时返回空清单', async () => {
  expect(await onDarwin(() => discoveryScan(argv => argv.includes('-iTCP') ? { text: '' } : { text: processRecord }))).toEqual([])
})
it('在监听进程超过检查上限时拒绝扫描', async () => {
  await expect(onDarwin(() => discoveryScan(argv => argv.includes('-iTCP') ? { text: 'p1\0\np2\0\np3\0\n' } : { text: processRecord }, { processInspectionMax: 2 })))
    .rejects.toThrow('process inspection limit')
})
it('容忍以退出码 1 且无输出结束的检查命令', async () => {
  expect(await onDarwin(() => discoveryScan(() => ({ exitCode: 1, text: '' })))).toEqual([])
})
it('在检查命令带输出失败时拒绝扫描', async () => {
  await expect(onDarwin(() => discoveryScan(() => ({ exitCode: 1, text: processRecord })))).rejects.toThrow('Native process inspection failed')
})
it('在检查命令以其他退出码失败时拒绝扫描', async () => {
  await expect(onDarwin(() => discoveryScan(() => ({ exitCode: 2, text: '' })))).rejects.toThrow('Native process inspection failed')
})
it('忽略出现在进程记录之前的命令名字段', () => {
  expect(parseLsofRecords('corphan\0p31\0cnode\0\n')[0]).toEqual({ pid: 31, name: 'node', ports: [] })
})
it('拒绝没有进程记录的地址字段', () => {
  expect(() => parseLsofRecords('n127.0.0.1:49123\0\n')).toThrow('without process record')
})
it('跳过无法识别的字段', () => {
  expect(parseLsofRecords('p31\0zunknown\0\n')[0]).toEqual({ pid: 31, name: '', ports: [] })
})
it('拒绝格式非法的进程检查记录', () => {
  expect(() => parseProcessRecords('not a record\n')).toThrow('Invalid process inspection record')
})
it('在创建标签不再匹配时报告监听已消失', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(LocalSubprocessRuntime)
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: ' 31 Sat Oct 10 16:00:01 2026 /usr/bin/node\n', nextOffset: 100, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {}, waitForExit: async () => true }))
  try {
    const config = { scanTimeoutMs: 10000, scanMaxBytes: 1048576, processInspectionMax: 200, terminationGraceMs: 5000 }
    const discovery = new NativeDiscovery(ctx.subprocess, config)
    const observed = { pid: 31, name: 'node', ports: [49123], started: 'Sat Oct 10 16:00:00 2026' }
    expect(await discovery.current(observed, new AbortController().signal)).toBe(false)
    expect(await discovery.current({ ...observed, started: 'Sat Oct 10 16:00:01 2026' }, new AbortController().signal)).toBe(true)
  } finally { spy.mockRestore(); await fiber.dispose() }
})
it('拒绝没有端口号的监听地址字段', () => {
  expect(() => parseLsofRecords('p31\0\nf20\0n/some/file\0\n')).toThrow('Invalid lsof listener address')
})
