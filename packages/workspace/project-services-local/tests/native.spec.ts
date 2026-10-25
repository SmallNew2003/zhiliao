import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile, unlink, mkdir, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceRequestId, ServiceItem, ServiceCheckoutId, ServiceCursor, ServiceProjectId, ServiceRevision, ServiceTargetId, ServiceNativeExecution, ServiceNativeLifetime, ServiceNativeProcess } from '@deepseek-ai/dsh-project-services'
import NativeServiceProvider, { createShellServiceExecution } from '../src/native.ts'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { NativeDiscovery, type NativeListener } from '../src/native-discovery.ts'
import { harness, accessFor, signal, git } from './helpers.ts'

// A path below a file answers ENOENT rather than ENOTDIR on Windows, so the
// non-ENOENT branch of the nested-repository probe is reachable only through an
// injected filesystem failure.
const fsControl = vi.hoisted(() => ({
  /** Absolute path whose nested-repository probe rejects. */
  denyLstat: undefined as string | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: vi.fn((async (path: unknown, ...rest: never[]) => {
      if (fsControl.denyLstat !== undefined && String(path) === join(fsControl.denyLstat, '.git')) {
        throw Object.assign(new Error('EACCES: injected unreadable directory'), { code: 'EACCES' })
      }
      return (actual.lstat as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.lstat),
  }
})

// Native lifecycle cases pay for multiple bounded lsof/ps scans and Host teardown.
// The 90-second unit subprocess lane budget also covers cleanup under worker contention.
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() }, 90000)
const requestId = () => brandString<ServiceRequestId>(randomUUID())
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-service-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness(); cleanup.push(() => h.ctx.fiber.dispose())
  const shellPath = '/bin/bash'
  const native = await h.ctx.plugin(NativeServiceProvider, {
    shellPath,
    retainedOutputBytes: 1048576,
    terminationGraceMs: 50,
    scanTimeoutMs: 10000,
    scanMaxBytes: 1048576,
    processInspectionMax: 200,
    captureIntervalMs: 10,
    historyMaxInstances: 200,
  })
  cleanup.push(() => native.dispose())
  const access = accessFor(root)
  const baseline = await h.runtime.list(access, {}, signal())
  const command = { argv: [process.execPath, '-e', 'require("node:net").createServer(s=>s.end("alive")).listen(0,"127.0.0.1",function(){console.log("READY "+this.address().port)});'] }
  const start = async (initiator = signal()) => h.runtime.control(access, { action: 'start', requestId: requestId(), definition: { name: 'fixture', checkoutId: baseline.checkouts[0]!.id, command } }, initiator)
  const item = async () => (await h.runtime.list(access, {}, signal())).items.findLast(value => value.ownership === 'managed' && value.state === 'running')!
  const ready = async () => {
    let output = ''
    await expect.poll(async () => {
      const target = await item()
      output = (await h.runtime.logs(access, { targetId: target.id }, signal())).chunks.map(chunk => chunk.text).join('')
      return output
    }).toContain('READY ')
    return Number(/READY (\d+)/.exec(output)![1])
  }
  const control = async (target: ServiceItem, action: 'stop' | 'restart') => h.runtime.control(access, { action, targetId: target.id, expectedRevision: target.revision, requestId: requestId() }, signal())
  return { ...h, native, root, access, baseline, command, start, item, ready, control, shellPath }
}
function responds(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('data', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

it.skipIf(process.platform !== 'darwin')('leaves the running instance alive when restart launch authorization is denied', { timeout: 90000 }, async () => {
  const h = await fixture()
  await h.start(); const port = await h.ready(); const target = await h.item()
  h.access.authorize = async (operation) => { expect(operation.nativeLaunch).toBeDefined(); throw new Error('launch denied') }
  await expect(h.control(target, 'restart')).rejects.toThrow('launch denied')
  expect(await responds(port)).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('retains independent output, deduplicates owned listeners, and stops the range', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.start(); const port = await h.ready()
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.items.filter(item => item.ports?.includes(port))).toHaveLength(1)
  const target = await h.item()
  const first = await h.runtime.logs(h.access, { targetId: target.id }, signal())
  const second = await h.runtime.logs(h.access, { targetId: target.id }, signal())
  expect(first).toEqual(second)
  expect((await h.control(target, 'stop')).operation?.state).toBe('succeeded')
  expect(await responds(port)).toBe(false)
})

it.skipIf(process.platform !== 'darwin')('keeps a service after initiator cancellation and terminates it at Host disposal', { timeout: 90000 }, async () => {
  const h = await fixture()
  const initiator = new AbortController()
  await h.start(initiator.signal); const port = await h.ready(); initiator.abort()
  expect(await responds(port)).toBe(true)
  await h.native.dispose()
  expect(await responds(port)).toBe(false)
  expect((await h.runtime.list(h.access, {}, signal())).providers).toHaveLength(0)
})

it.skipIf(process.platform !== 'darwin')('associates external listeners by cwd and refuses external control', { timeout: 90000 }, async () => {
  const h = await fixture()
  const handle = h.ctx.subprocess.spawn({ argv: h.command.argv, cwd: h.root, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 50 })
  cleanup.push(async () => { handle.terminate(); await handle.waitForExit() })
  await expect.poll(() => handle.collected.stdout!.readFrom(0).text).toContain('READY ')
  const port = Number(/READY (\d+)/.exec(handle.collected.stdout!.readFrom(0).text)![1])
  const item = (await h.runtime.list(h.access, {}, signal())).items.find(value => value.ports?.includes(port))!
  expect(item.checkoutId).toBe(h.baseline.checkouts[0]!.id)
  expect(item.ownership).toBe('external'); expect(item.actions).toEqual([])
  await expect(h.control(item, 'stop')).rejects.toThrow('External native')
  expect(await responds(port)).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('preflights agent launch failure before stopping a running range', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.start(); const port = await h.ready(); const target = await h.item()
  class RefusingSandbox extends SandboxProvider { override async confine(): Promise<never> { throw new Error('confinement refused') } }
  await h.ctx.plugin(SessionProjectionRegistry)
  await h.ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: h.root })
  await h.ctx.plugin(RefusingSandbox)
  await h.ctx.plugin(SandboxBashExecutor)
  h.access.kind = 'agent'
  h.access.nativeExecution = createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})
  await expect(h.control(target, 'restart')).rejects.toThrow('confinement refused')
  expect(await responds(port)).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('retains stale managed rows and blocks control after a failed scan', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.start(); const port = await h.ready(); const target = await h.item()
  const spawn = h.ctx.subprocess.spawn.bind(h.ctx.subprocess)
  const spy = vi.spyOn(h.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    if (spec.argv[0] === '/usr/sbin/lsof') throw new Error('scan unavailable')
    return spawn(spec)
  })
  cleanup.push(async () => { spy.mockRestore() })
  const inventory = await h.runtime.list(h.access, {}, signal())
  expect(inventory.providers[0]!.state).toBe('stale')
  expect(inventory.items.find(value => value.id === target.id)!.stale).toBe(true)
  await expect(h.control(target, 'stop')).rejects.toThrow('stale')
  expect(await responds(port)).toBe(true)
})

it('rejects an adapter with a Session-owned lifetime before launch', async () => {
  const h = await fixture()
  // The rejection happens before any launch, so a stubbed observation keeps the
  // case independent of the host process table and of concurrent suite load.
  const scan = vi.spyOn(NativeDiscovery.prototype, 'scan').mockResolvedValue([])
  cleanup.push(async () => { scan.mockRestore() })
  h.access.kind = 'agent'
  h.access.nativeExecution = { lifetime: { ...h.ctx.nativeProjectServices.lifetime, signal: signal() }, resolve: async () => { throw new Error('must not resolve') } }
  await expect(h.start()).rejects.toThrow('Host subprocess lifetime')
})

it.skipIf(process.platform !== 'darwin')('captures a published range after its initiating call is cancelled during startup', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.ctx.plugin(LocalBashExecutor)
  h.access.kind = 'agent'
  const adapter = createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  h.access.nativeExecution = { lifetime: adapter.lifetime, resolve: async (...args) => {
    const launch = await adapter.resolve(...args)
    return { ...launch, start: async (hostSignal) => {
      const process = await launch.start(hostSignal)
      entered.resolve(undefined); await release.promise
      return process
    } }
  } }
  const initiator = new AbortController(), launched = h.start(initiator.signal)
  await entered.promise; initiator.abort(new Error('outer call cancelled')); release.resolve(undefined)
  expect((await launched).operation?.state).toBe('succeeded')
  const port = await h.ready()
  expect(await responds(port)).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('rolls back a late acquired range and waits for it when the Host closes during launch', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.ctx.plugin(LocalBashExecutor); h.access.kind = 'agent'
  const adapter = createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  let owned: Awaited<ReturnType<Awaited<ReturnType<typeof adapter.resolve>>['start']>> | undefined
  h.access.nativeExecution = { lifetime: adapter.lifetime, resolve: async (...args) => {
    const launch = await adapter.resolve(...args)
    return { ...launch, start: async (hostSignal) => {
      owned = await launch.start(hostSignal)
      entered.resolve(undefined); await release.promise
      return owned
    } }
  } }
  const launched = h.start()
  await entered.promise
  let disposed = false
  const closing = h.native.dispose().then(() => { disposed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  release.resolve(undefined); await closing; await launched
  await owned!.waitForExit()
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it.skipIf(process.platform !== 'darwin')('publishes agent shell ranges into the Host lifetime across initiator disposal', { timeout: 90000 }, async () => {
  const h = await fixture()
  await h.ctx.plugin(LocalBashExecutor)
  const scope = await h.ctx.plugin({ name: 'native-initiator', apply() {} })
  const session = scope.ctx
  h.access.kind = 'agent'
  h.access.nativeExecution = createShellServiceExecution(session, h.ctx.nativeProjectServices.lifetime, {})
  await h.start(); const port = await h.ready()
  // Dispose a real initiating scope while retaining the shared Host subprocess.
  await scope.dispose()
  expect(await responds(port)).toBe(true)
  const isolated = h.ctx.isolate('subprocess')
  expect(() => createShellServiceExecution(isolated, h.ctx.nativeProjectServices.lifetime, {})).toThrow('differs from Host')
  await h.native.dispose(); expect(await responds(port)).toBe(false)
})

it.skipIf(process.platform !== 'darwin')('serializes concurrent stop and restart against the original revision', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.start(); const port = await h.ready(); const target = await h.item()
  const approved = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  h.access.authorize = async () => { approved.resolve(undefined); await release.promise }
  const stopped = h.control(target, 'stop')
  await approved.promise
  const restarted = h.control(target, 'restart')
  const observed = restarted.catch((error: unknown) => error as Error)
  release.resolve(undefined)
  expect((await stopped).operation?.state).toBe('succeeded')
  expect(await observed).toBeInstanceOf(Error)
  expect(await responds(port)).toBe(false)
})

it.skipIf(process.platform !== 'darwin')('authorizes replacement identities and preserves historical logs across restart', { timeout: 90000 }, async () => {
  const h = await fixture(); await h.start(); const port = await h.ready(); const old = await h.item()
  const oldLogs = await h.runtime.logs(h.access, { targetId: old.id }, signal())
  h.access.authorize = async (operation) => {
    expect(operation.targets.map(target => target.id)).toContain(old.id)
    expect(operation.targets).toHaveLength(2)
    expect(operation.nativeLaunch?.targetId).not.toBe(old.id)
    expect(operation.targets.map(target => target.id)).toContain(operation.nativeLaunch!.targetId)
  }
  expect((await h.control(old, 'restart')).operation?.state).toBe('succeeded')
  const nextPort = await h.ready(); const replacement = await h.item()
  expect(replacement.id).not.toBe(old.id)
  expect(await responds(port)).toBe(false); expect(await responds(nextPort)).toBe(true)
  expect(await h.runtime.logs(h.access, { targetId: old.id }, signal())).toEqual(oldLogs)
})

it.skipIf(process.platform === 'win32')('preserves quotes, empty argv and shell expansion bytes through the supported agent shell', async () => {
  const h = await fixture(); await h.ctx.plugin(LocalBashExecutor)
  const adapter = createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})
  const launch = await adapter.resolve({ argv: [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '', "a'b", '$(echo expanded)', 'line\nbreak'] }, h.root, signal())
  const proc = await launch.start(h.ctx.nativeProjectServices.lifetime.signal)
  await proc.done; await proc.waitForExit()
  expect(JSON.parse(proc.readOutput().text)).toEqual(['', "a'b", '$(echo expanded)', 'line\nbreak'])
})

it('refuses rendering POSIX arguments for an unsupported shell dialect', async () => {
  const h = await fixture()
  class UnsupportedShell extends LocalBashExecutor { override get supportsPosixCommandSyntax(): boolean { return false } }
  await h.ctx.plugin(UnsupportedShell)
  expect(() => createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})).toThrow('POSIX command syntax')
})

it('shares one in-flight native observation across concurrent project reads', async () => {
  const h = await fixture()
  const release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  let scans = 0
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockImplementation(async () => {
    if (++scans > 1) throw new Error('duplicate native scan')
    await release.promise
    return [{ pid: 31, name: 'fixture', ports: [49123], cwd: h.root, started: 'fixture' }]
  })
  cleanup.push(async () => { spy.mockRestore() })
  const context = { project: h.baseline.project, checkouts: h.baseline.checkouts, definitions: [], associations: [] }
  const first = h.ctx.nativeProjectServices.inspect(context, signal())
  const second = h.ctx.nativeProjectServices.inspect(context, signal())
  release.resolve(undefined)
  const results = await Promise.all([first, second])
  expect(results.map(result => result.items[0]?.ports)).toEqual([[49123], [49123]])
})

it('cancels one discovery reader independently and starts a fresh scan after settlement', async () => {
  const h = await fixture()
  const release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  let scans = 0
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockImplementation(async (sharedSignal) => {
    const ordinal = ++scans
    await release.promise; sharedSignal.throwIfAborted()
    return [{ pid: 31, name: 'fixture', ports: [49122 + ordinal], cwd: h.root, started: 'fixture' }]
  })
  cleanup.push(async () => { spy.mockRestore() })
  const context = { project: h.baseline.project, checkouts: h.baseline.checkouts, definitions: [], associations: [] }
  const caller = new AbortController()
  const first = h.ctx.nativeProjectServices.inspect(context, caller.signal)
  const cancelled = expect(first).rejects.toThrow('reader cancelled')
  const second = h.ctx.nativeProjectServices.inspect(context, signal())
  caller.abort(new Error('reader cancelled')); release.resolve(undefined)
  await cancelled
  expect((await second).items[0]?.ports).toEqual([49123])
  expect((await h.ctx.nativeProjectServices.inspect(context, signal())).items[0]?.ports).toEqual([49124])
})

it.skipIf(process.platform !== 'darwin')('resolves a checkout-local executable before authorizing a human launch', { timeout: 90000 }, async () => {
  const h = await fixture()
  const code = h.command.argv[2]
  await writeFile(join(h.root, 'dev.sh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${code}'\n`, { mode: 0o755 })
  h.command.argv.splice(0, h.command.argv.length, './dev.sh')
  h.access.authorize = async (operation) => { expect(operation.nativeLaunch?.command.argv[0]).toBe(join(h.root, 'dev.sh')) }
  expect((await h.start()).operation?.state).toBe('succeeded')
  expect(await responds(await h.ready())).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('refuses an agent restart with a deleted target executable before stopping the current range', { timeout: 90000 }, async () => {
  const h = await fixture()
  await writeFile(join(h.root, 'dev.sh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${h.command.argv[2]}'\n`, { mode: 0o755 })
  h.command.argv.splice(0, h.command.argv.length, './dev.sh')
  await h.start(); const port = await h.ready(); const target = await h.item()
  await unlink(join(h.root, 'dev.sh'))
  await h.ctx.plugin(LocalBashExecutor); h.access.kind = 'agent'
  h.access.nativeExecution = createShellServiceExecution(h.ctx, h.ctx.nativeProjectServices.lifetime, {})
  await expect(h.control(target, 'restart')).rejects.toThrow('executable file')
  expect(await responds(port)).toBe(true)
})

it('keeps a nested repository listener out of its containing project', async () => {
  const h = await fixture(), nested = join(h.root, 'nested')
  await mkdir(nested); await git(h.ctx, nested, 'init')
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockResolvedValue([{ pid: 31, name: 'nested', ports: [49123], cwd: nested, started: 'fixture' }])
  cleanup.push(async () => { spy.mockRestore() })
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
  const own = await h.runtime.list(accessFor(nested), {}, signal())
  expect(own.items[0]?.ports).toEqual([49123])
})

it('associates a same-project nested worktree with its most-specific checkout', async () => {
  const h = await fixture(), nested = join(h.root, 'nested-worktree')
  await git(h.ctx, h.root, 'init')
  await git(h.ctx, h.root, 'commit', '--allow-empty', '-m', 'fixture')
  await git(h.ctx, h.root, 'worktree', 'add', '-b', 'nested', nested)
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockResolvedValue([{ pid: 31, name: 'nested', ports: [49123], cwd: nested, started: 'fixture' }])
  cleanup.push(async () => { spy.mockRestore() })
  const inventory = await h.runtime.list(h.access, {}, signal())
  const checkout = inventory.checkouts.find(value => value.path.endsWith('nested-worktree'))!
  expect(inventory.items[0]?.checkoutId).toBe(checkout.id)
  expect(inventory.items[0]?.ports).toEqual([49123])
})

function fakeRange(overrides: Partial<ServiceNativeProcess> = {}) {
  const exit = Promise.withResolvers<undefined>()
  const process: ServiceNativeProcess = {
    done: exit.promise.then(() => ({ exitCode: 0, signal: null })),
    readOutput: () => ({ text: '', lossy: false }),
    terminate: async () => { exit.resolve(undefined) },
    waitForExit: async () => { await exit.promise },
    ...overrides,
  }
  return { process, settle: () => { exit.resolve(undefined) } }
}
function agentExecution(lifetime: ServiceNativeLifetime, process: ServiceNativeProcess): ServiceNativeExecution {
  return { lifetime, resolve: async (command, cwd) => ({ command: { argv: [...command.argv] }, cwd, start: async () => process }) }
}
function mockScan(listeners: NativeListener[]): void {
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockResolvedValue(listeners)
  cleanup.push(async () => { spy.mockRestore() })
}
function providerContext(h: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return { project: h.baseline.project, checkouts: h.baseline.checkouts, definitions: [], associations: [], ...overrides }
}

it('拒绝相对路径的人工 shell 配置', async () => {
  const h = await harness()
  cleanup.push(h.dispose)
  await expect(h.ctx.plugin(NativeServiceProvider, {
    shellPath: 'bash', retainedOutputBytes: 1048576, terminationGraceMs: 50, scanTimeoutMs: 10000,
    scanMaxBytes: 1048576, processInspectionMax: 200, captureIntervalMs: 10, historyMaxInstances: 200,
  })).rejects.toThrow('absolute executable path')
})

it('在人类发起路径上报告 shell 可执行文件解析失败', async () => {
  const h = await fixture()
  const resolve = h.ctx.subprocess.resolveExecutable.bind(h.ctx.subprocess)
  const spy = vi.spyOn(h.ctx.subprocess, 'resolveExecutable').mockImplementation(async (request, env, sig) => {
    if (request === h.shellPath) throw new Error('injected resolve failure')
    return resolve(request, env, sig)
  })
  cleanup.push(async () => { spy.mockRestore() })
  await expect(h.start()).rejects.toThrow('injected resolve failure')
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it('在 Host 处置时等待进行中的共享扫描', async () => {
  const h = await fixture()
  const release = Promise.withResolvers<undefined>()
  cleanup.push(async () => { release.resolve(undefined) })
  const spy = vi.spyOn(NativeDiscovery.prototype, 'scan').mockImplementation(async () => { await release.promise; return [] })
  cleanup.push(async () => { spy.mockRestore() })
  const reading = h.ctx.nativeProjectServices.inspect(providerContext(h), signal())
  const disposedReader = expect(reading).rejects.toThrow('Native service Host disposed')
  let disposed = false
  const closing = h.native.dispose().then(() => { disposed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await closing
  expect(disposed).toBe(true)
  await disposedReader
})

it('在范围终止失败时聚合报告 Host 处置错误', async () => {
  const h = await fixture()
  mockScan([])
  const errors = vi.spyOn(h.ctx.logger, 'error')
  cleanup.push(async () => { errors.mockRestore() })
  const { process } = fakeRange({ terminate: async () => { throw new Error('terminate refused') } })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  expect((await h.start()).operation?.state).toBe('succeeded')
  await h.native.dispose()
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'Native range termination failed' }))
})

it('忽略没有工作目录的外部监听', async () => {
  const h = await fixture()
  mockScan([{ pid: 31, name: 'orphan', ports: [49123], started: 'fixture' }])
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it('跳过工作目录已消失的外部监听', async () => {
  const h = await fixture()
  mockScan([{ pid: 31, name: 'gone', ports: [49123], cwd: join(h.root, 'absent'), started: 'fixture' }])
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it('对同一范围观察到的多个端口去重排序', async () => {
  const h = await fixture()
  const { process } = fakeRange({ ownsProcess: async pid => pid === 31 })
  mockScan([{ pid: 31, name: 'fixture', ports: [49124, 49123, 49123], cwd: h.root, started: 'fixture' }])
  const current = vi.spyOn(NativeDiscovery.prototype, 'current').mockResolvedValue(true)
  cleanup.push(async () => { current.mockRestore() })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.start()
  const item = (await h.runtime.list(h.access, {}, signal())).items.findLast(value => value.ownership === 'managed')!
  expect(item.ports).toEqual([49123, 49124])
})

it('在范围不归属该监听时把端口留给外部进程', async () => {
  const h = await fixture()
  const { process } = fakeRange({ ownsProcess: async () => false })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  mockScan([{ pid: 31, name: 'fixture', ports: [49123], cwd: h.root, started: 'fixture' }])
  await h.start()
  const items = (await h.runtime.list(h.access, {}, signal())).items
  expect(items.find(item => item.ownership === 'managed')?.ports ?? []).toEqual([])
  expect(items.find(item => item.ownership === 'external')?.ports).toEqual([49123])
})

it('在范围退出后不再把原进程的监听归入该范围', async () => {
  const h = await fixture()
  const listeners: NativeListener[] = []
  const scan = vi.spyOn(NativeDiscovery.prototype, 'scan').mockImplementation(async () => listeners)
  cleanup.push(async () => { scan.mockRestore() })
  const current = vi.spyOn(NativeDiscovery.prototype, 'current').mockResolvedValue(true)
  cleanup.push(async () => { current.mockRestore() })
  const { process } = fakeRange({ ownsProcess: async () => true })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.start()
  await h.control(await h.item(), 'stop')
  listeners.push({ pid: 31, name: 'fixture', ports: [49123], cwd: h.root, started: 'fixture' })
  const items = (await h.runtime.list(h.access, {}, signal())).items
  expect(items.find(item => item.ownership === 'managed')?.state).toBe('stopped')
  expect(items.find(item => item.ownership === 'managed')?.ports ?? []).toEqual([])
  expect(items.find(item => item.ownership === 'external')?.ports).toEqual([49123])
})

it('把检出目录内普通子目录的监听归入该项目', async () => {
  const h = await fixture()
  const sub = join(h.root, 'sub')
  await mkdir(sub)
  mockScan([{ pid: 31, name: 'worker', ports: [49123], cwd: sub, started: 'fixture' }])
  const item = (await h.runtime.list(h.access, {}, signal())).items[0]!
  expect(item.ownership).toBe('external')
  expect(item.checkoutId).toBe(h.baseline.checkouts[0]!.id)
})

it('在嵌套仓库探测遇到文件系统错误时向上层报告失败', async () => {
  const h = await fixture()
  const file = join(h.root, 'not-a-dir')
  await writeFile(file, 'placeholder')
  fsControl.denyLstat = file
  cleanup.push(async () => { fsControl.denyLstat = undefined })
  mockScan([{ pid: 31, name: 'worker', ports: [49123], cwd: file, started: 'fixture' }])
  await expect(h.ctx.nativeProjectServices.inspect(providerContext(h), signal())).rejects.toThrow('EACCES: injected unreadable directory')
})

it('按持久定义的身份重新启动已停止的范围', async () => {
  const h = await fixture()
  mockScan([])
  const first = fakeRange()
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, first.process)
  await h.start()
  await h.control(await h.item(), 'stop')
  const definition = (await h.runtime.list(h.access, {}, signal())).definitions[0]!
  const second = fakeRange()
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, second.process)
  const result = await h.runtime.control(h.access, { requestId: requestId(), action: 'start', targetId: definition.id, expectedRevision: definition.revision }, signal())
  expect(result.operation?.state).toBe('succeeded')
  expect((await h.runtime.list(h.access, {}, signal())).items.filter(item => item.ownership === 'managed' && item.state === 'running')).toHaveLength(1)
})

it('拒绝属于其他项目的持久定义', async () => {
  const h = await fixture()
  const foreign = { id: brandString<ServiceTargetId>('native:foreign'), projectId: brandString<ServiceProjectId>('other-project'), checkoutId: h.baseline.checkouts[0]!.id, name: 'foreign', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h, { definitions: [foreign] }),
    { requestId: requestId(), action: 'start', targetId: foreign.id, expectedRevision: foreign.revision }, h.access, signal()))
    .rejects.toThrow('another project')
})

it('拒绝控制既非运行实例也无持久定义的目标', async () => {
  const h = await fixture()
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h),
    { requestId: requestId(), action: 'stop', targetId: brandString<ServiceTargetId>('native:absent'), expectedRevision: brandString<ServiceRevision>('1') }, h.access, signal()))
    .rejects.toThrow('External native lifecycle control is unavailable')
})

it('拒绝解析不到检出目录的持久定义', async () => {
  const h = await fixture()
  const orphan = { id: brandString<ServiceTargetId>('native:orphan'), projectId: h.baseline.project.id, checkoutId: brandString<ServiceCheckoutId>('absent-checkout'), name: 'orphan', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h, { definitions: [orphan] }),
    { requestId: requestId(), action: 'start', targetId: orphan.id, expectedRevision: orphan.revision }, h.access, signal()))
    .rejects.toThrow('Native checkout unavailable')
})

it('拒绝在缺失的检出目录上启动', async () => {
  const h = await fixture()
  const missing = { ...h.baseline.checkouts[0]!, availability: 'missing' as const }
  const definition = { id: brandString<ServiceTargetId>('native:missing-checkout'), projectId: h.baseline.project.id, checkoutId: missing.id, name: 'gone', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h, { checkouts: [missing], definitions: [definition] }),
    { requestId: requestId(), action: 'start', targetId: definition.id, expectedRevision: definition.revision }, h.access, signal()))
    .rejects.toThrow('Native checkout is missing')
})

it('拒绝把已停止范围的停止请求当作可用实例', async () => {
  const h = await fixture()
  const definition = { id: brandString<ServiceTargetId>('native:stopped'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'stopped', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h, { definitions: [definition] }),
    { requestId: requestId(), action: 'stop', targetId: definition.id, expectedRevision: definition.revision }, h.access, signal()))
    .rejects.toThrow('Native managed instance unavailable')
})

it('拒绝解析出不同启动事实的代理适配器', async () => {
  const h = await fixture()
  mockScan([])
  h.access.kind = 'agent'
  const lifetime = h.ctx.nativeProjectServices.lifetime
  h.access.nativeExecution = { lifetime, resolve: async (command, cwd) => ({ command, cwd: join(cwd, 'elsewhere'), start: async () => { throw new Error('must not start') } }) }
  await expect(h.start()).rejects.toThrow('different launch facts')
  h.access.nativeExecution = { lifetime, resolve: async (command, cwd) => ({ command: { argv: [command.argv[0]!] }, cwd, start: async () => { throw new Error('must not start') } }) }
  await expect(h.start()).rejects.toThrow('different launch facts')
})

it('拒绝使用其他 Host 生命周期的代理适配器', async () => {
  const h = await fixture()
  const definition = { id: brandString<ServiceTargetId>('native:agent'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'agent', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  h.access.kind = 'agent'
  h.access.nativeExecution = { lifetime: { ...h.ctx.nativeProjectServices.lifetime, signal: signal() }, resolve: async () => { throw new Error('must not resolve') } }
  await expect(h.ctx.nativeProjectServices.prepare(providerContext(h, { definitions: [definition] }),
    { requestId: requestId(), action: 'start', targetId: definition.id, expectedRevision: definition.revision }, h.access, signal()))
    .rejects.toThrow('Host subprocess lifetime')
})

it('拒绝已被其他范围占用的启动身份', async () => {
  const h = await fixture()
  const pending = { id: brandString<ServiceTargetId>('native:pending'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'reserved', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, fakeRange().process)
  const prepared = await h.ctx.nativeProjectServices.prepare(providerContext(h, { pendingDefinition: pending }),
    { requestId: requestId(), action: 'start', definition: { name: pending.name, checkoutId: pending.checkoutId, command: pending.command } }, h.access, signal())
  const instances = Reflect.get(h.ctx.nativeProjectServices, 'instances') as Map<ServiceTargetId, unknown>
  instances.set(prepared.description.nativeLaunch!.targetId!, {})
  await expect(prepared.validate(signal())).rejects.toThrow('already claimed')
})

it('拒绝把未真正退出的范围当作已停止', async () => {
  const h = await fixture()
  const targetId = brandString<ServiceTargetId>('native:stuck')
  const definition = { id: brandString<ServiceTargetId>('native:stuck-definition'), projectId: h.baseline.project.id, checkoutId: h.baseline.checkouts[0]!.id, name: 'stuck', command: { argv: ['node'] }, revision: brandString<ServiceRevision>('1') }
  const instances = Reflect.get(h.ctx.nativeProjectServices, 'instances') as Map<ServiceTargetId, unknown>
  instances.set(targetId, {
    definition, checkout: h.baseline.checkouts[0]!, item: { id: targetId, revision: brandString<ServiceRevision>('1') },
    process: { terminate: async () => {} }, settled: Promise.resolve(), rangeExited: false, observationFailed: false,
  })
  const prepared = await h.ctx.nativeProjectServices.prepare(providerContext(h, { definitions: [definition] }),
    { requestId: requestId(), action: 'stop', targetId, expectedRevision: brandString<ServiceRevision>('1') }, h.access, signal())
  await expect(prepared.execute(signal())).rejects.toThrow('could not be observed')
})

it('在检出目录被替换为符号链接时中止已授权的操作', async () => {
  const h = await fixture()
  mockScan([])
  const moved = `${h.root}-moved`
  cleanup.push(async () => { await rm(moved, { recursive: true, force: true }) })
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  cleanup.push(async () => { gate.resolve(undefined) })
  h.access.authorize = async () => { entered.resolve(undefined); await gate.promise }
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, fakeRange().process)
  const started = h.start()
  await entered.promise
  await rename(h.root, moved)
  await symlink(moved, h.root, 'dir')
  gate.resolve(undefined)
  await expect(started).rejects.toThrow('Native checkout changed')
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it('在进程提供者立即失败时记录范围观测失败', async () => {
  const h = await fixture()
  mockScan([])
  const failed = Promise.reject(new Error('provider failed'))
  void failed.catch(() => {})
  const { process } = fakeRange({ done: failed, waitForExit: async () => { await failed } })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  expect((await h.start()).operation?.state).toBe('succeeded')
  const item = (await h.runtime.list(h.access, {}, signal())).items.findLast(value => value.ownership === 'managed')!
  expect(item.state).toBe('unknown')
  expect(item.detail).toContain('Native range observation failed')
  await expect(h.runtime.control(h.access, { requestId: requestId(), action: 'stop', targetId: item.id, expectedRevision: item.revision }, signal()))
    .rejects.toThrow('Native managed identity changed')
})

it('对外部监听明确报告输出未被捕获', async () => {
  const h = await fixture()
  mockScan([{ pid: 31, name: 'external', ports: [49123], cwd: h.root, started: 'fixture' }])
  const item = (await h.runtime.list(h.access, {}, signal())).items[0]!
  expect(item.ownership).toBe('external')
  expect((await h.runtime.logs(h.access, { targetId: item.id }, signal())).unavailable).toContain('External native output')
})

it('在读取托管范围日志时追加范围输出', async () => {
  const h = await fixture()
  mockScan([])
  let delivered = false
  const { process } = fakeRange({ readOutput: () => {
    if (delivered) return { text: '', lossy: false }
    delivered = true
    return { text: 'fixture output', lossy: false }
  } })
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.start()
  const target = await h.item()
  const page = await h.runtime.logs(h.access, { targetId: target.id, maxBytes: 1024 }, signal())
  expect(page.chunks.map(chunk => chunk.text).join('')).toBe('fixture output')
  expect(page.gap).toBe(false)
})

it('在保留窗口丢弃旧字节后向日志读取方报告缺口', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-log-gap-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness()
  cleanup.push(h.dispose)
  const native = await h.ctx.plugin(NativeServiceProvider, {
    shellPath: '/bin/bash', retainedOutputBytes: 8, terminationGraceMs: 50, scanTimeoutMs: 10000,
    scanMaxBytes: 1048576, processInspectionMax: 200, captureIntervalMs: 60000, historyMaxInstances: 200,
  })
  cleanup.push(() => native.dispose())
  mockScan([])
  const access = accessFor(root)
  const baseline = await h.runtime.list(access, {}, signal())
  let delivered = 0
  const { process } = fakeRange({ readOutput: () => delivered++ < 2 ? { text: 'abcdefgh', lossy: false } : { text: '', lossy: false } })
  access.kind = 'agent'
  access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.runtime.control(access, { action: 'start', requestId: requestId(), definition: { name: 'chatty', checkoutId: baseline.checkouts[0]!.id, command: { argv: ['node'] } } }, signal())
  const target = (await h.runtime.list(access, {}, signal())).items.findLast(item => item.ownership === 'managed')!
  const first = await h.runtime.logs(access, { targetId: target.id, maxBytes: 1024 }, signal())
  expect(first.gap).toBe(false)
  expect(first.chunks.map(chunk => chunk.text).join('')).toBe('abcdefgh')
  expect((await h.runtime.logs(access, { targetId: target.id, maxBytes: 1024, cursor: brandString<ServiceCursor>('0') }, signal())).gap).toBe(true)
})

it('在订阅者抛出异常时记录警告并继续通知其他订阅者', async () => {
  const h = await fixture()
  mockScan([])
  const warn = vi.spyOn(h.ctx.logger, 'warn')
  cleanup.push(async () => { warn.mockRestore() })
  const notified: string[] = []
  const remove = h.ctx.nativeProjectServices.subscribe(() => { throw new Error('listener failed') })
  h.ctx.nativeProjectServices.subscribe(() => { notified.push('notified') })
  const { process } = fakeRange()
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.start()
  remove()
  expect(notified).toContain('notified')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Native service subscriber failed'))
})

it('在历史容量达到上限时驱逐最早停止的范围', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-history-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness()
  cleanup.push(h.dispose)
  const native = await h.ctx.plugin(NativeServiceProvider, {
    shellPath: '/bin/bash', retainedOutputBytes: 1048576, terminationGraceMs: 50, scanTimeoutMs: 10000,
    scanMaxBytes: 1048576, processInspectionMax: 200, captureIntervalMs: 10, historyMaxInstances: 1,
  })
  cleanup.push(() => native.dispose())
  mockScan([])
  const access = accessFor(root)
  const baseline = await h.runtime.list(access, {}, signal())
  const start = async (name: string) => {
    const { process } = fakeRange()
    access.kind = 'agent'
    access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
    return await h.runtime.control(access, { action: 'start', requestId: requestId(), definition: { name, checkoutId: baseline.checkouts[0]!.id, command: { argv: ['node', 'server.js'] } } }, signal())
  }
  const stop = async (name: string) => {
    const target = (await h.runtime.list(access, {}, signal())).items.findLast(item => item.ownership === 'managed' && item.name === name)!
    return await h.runtime.control(access, { action: 'stop', requestId: requestId(), targetId: target.id, expectedRevision: target.revision }, signal())
  }
  await start('first')
  const evicted = (await h.runtime.list(access, {}, signal())).items.find(item => item.name === 'first')!.id
  await stop('first')
  await start('second'); await stop('second')
  await start('third')
  const items = (await h.runtime.list(access, {}, signal())).items
  expect(items.map(item => item.id)).not.toContain(evicted)
  expect(items.map(item => item.name).sort()).toEqual(['second', 'third'])
})

it('在更新的扫描已接管时不清理旧扫描的进行中状态', async () => {
  const h = await fixture()
  const stale = Promise.withResolvers<NativeListener[]>()
  const observed: NativeListener[] = [{ pid: 31, name: 'fixture', ports: [49123], cwd: h.root, started: 'fixture' }]
  const scan = vi.spyOn(NativeDiscovery.prototype, 'scan')
    .mockImplementationOnce(async () => stale.promise)
    .mockImplementation(async () => observed)
  cleanup.push(async () => { scan.mockRestore(); stale.resolve([]) })
  const context = providerContext(h)
  const reading = h.ctx.nativeProjectServices.inspect(context, signal())
  Reflect.set(h.ctx.nativeProjectServices, 'inFlight', Promise.resolve(observed))
  stale.resolve([])
  expect((await reading).items).toHaveLength(0)
  expect((await h.ctx.nativeProjectServices.inspect(context, signal())).items[0]?.ports).toEqual([49123])
  expect(scan).toHaveBeenCalledTimes(1)
})

it('在启动失败且未获得进程时直接向上报告', async () => {
  const h = await fixture()
  mockScan([])
  h.access.kind = 'agent'
  h.access.nativeExecution = { lifetime: h.ctx.nativeProjectServices.lifetime, resolve: async (command, cwd) => ({ command: { argv: [...command.argv] }, cwd, start: async () => { throw new Error('launch refused') } }) }
  const result = await h.start()
  expect(result.operation).toBeUndefined()
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
  const operations = Reflect.get(h.runtime, 'operations') as Map<string, { state: string; outcomes: { message?: string }[] }>
  expect([...operations.values()][0]?.state).toBe('failed')
  expect([...operations.values()][0]?.outcomes[0]?.message).toContain('launch refused')
})

it('在 Host 关闭后终止已获取的范围并放弃发布', async () => {
  const h = await fixture()
  mockScan([])
  let terminated = false
  const { process } = fakeRange({ terminate: async () => { terminated = true } })
  const host = Reflect.get(h.ctx.nativeProjectServices, 'host') as AbortController
  h.access.kind = 'agent'
  h.access.nativeExecution = {
    lifetime: h.ctx.nativeProjectServices.lifetime,
    resolve: async (command, cwd) => ({ command: { argv: [...command.argv] }, cwd, start: async () => {
      host.abort(new Error('Host closed during launch'))
      return process
    } }),
  }
  await h.runtime.control(h.access, { action: 'start', requestId: requestId(),
    definition: { name: 'closed', checkoutId: h.baseline.checkouts[0]!.id, command: { argv: ['node'] } } }, signal())
  expect(terminated).toBe(true)
  expect((await h.runtime.list(h.access, {}, signal())).items).toHaveLength(0)
})

it('拒绝在运行中的范围上再次启动', async () => {
  const h = await fixture()
  mockScan([])
  const { process } = fakeRange()
  h.access.kind = 'agent'
  h.access.nativeExecution = agentExecution(h.ctx.nativeProjectServices.lifetime, process)
  await h.start()
  const running = await h.item()
  await expect(h.runtime.control(h.access, { requestId: requestId(), action: 'start', targetId: running.id, expectedRevision: running.revision }, signal()))
    .rejects.toThrow('already running')
})
