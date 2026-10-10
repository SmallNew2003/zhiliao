import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceRequestId, ServiceItem } from '@deepseek-ai/dsh-project-services'
import NativeServiceProvider, { createShellServiceExecution } from '../src/native.ts'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { NativeDiscovery } from '../src/native-discovery.ts'
import { harness, accessFor, signal, git } from './helpers.ts'

// Native lifecycle cases pay for multiple bounded lsof/ps scans and Host teardown.
// The 90-second unit subprocess lane budget also covers cleanup under worker contention.
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() }, 90000)
const requestId = () => brandString<ServiceRequestId>(randomUUID())
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-service-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness(); cleanup.push(() => h.ctx.fiber.dispose())
  const native = await h.ctx.plugin(NativeServiceProvider, { terminationGraceMs: 50, captureIntervalMs: 10 })
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
  return { ...h, native, root, access, baseline, command, start, item, ready, control }
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

it.skipIf(process.platform !== 'darwin')('rejects an adapter with a Session-owned lifetime before launch', { timeout: 90000 }, async () => {
  const h = await fixture()
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
  const observed = restarted.catch(error => error as Error)
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
