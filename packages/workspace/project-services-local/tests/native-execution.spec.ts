import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ServiceCommand, ServiceNativeLifetime } from '@deepseek-ai/dsh-project-services'
import { expect, it, vi } from 'vitest'
import { createShellServiceExecution, resolveHumanLaunch } from '../src/native-execution.ts'

const lifetimeFor = (realm: symbol | undefined): ServiceNativeLifetime => ({ signal: new AbortController().signal, subprocessRealm: realm })

it('拒绝缺少 shell provider 的发起上下文', () => {
  const ctx = { get: () => undefined, [Context.isolate]: { subprocess: undefined } } as unknown as Context
  expect(() => createShellServiceExecution(ctx, lifetimeFor(undefined), {})).toThrow('requires a shell provider')
})

it('拒绝缺少 subprocess provider 的发起上下文', () => {
  const realm = Symbol('host realm')
  const ctx = {
    get: (key: string) => (key === 'shell' ? { supportsPosixCommandSyntax: true } : undefined),
    [Context.isolate]: { subprocess: realm },
  } as unknown as Context
  expect(() => createShellServiceExecution(ctx, lifetimeFor(realm), {})).toThrow('requires a subprocess provider')
})

it('拒绝来自其他子进程域的发起上下文', () => {
  const realm = Symbol('host realm')
  const ctx = {
    get: (key: string) => (key === 'shell' ? { supportsPosixCommandSyntax: true } : undefined),
    [Context.isolate]: { subprocess: realm },
  } as unknown as Context
  expect(() => createShellServiceExecution(ctx, lifetimeFor(Symbol('session realm')), {})).toThrow('differs from Host')
})

function stubbedSubprocess(stdout: string, stderr: string, overrides: Record<string, unknown> = {}) {
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: async () => undefined,
    ...overrides,
  }
  const spawned: { argv: string[]; cwd: string }[] = []
  const subprocess = {
    resolveExecutable: async (program: string) => program,
    spawn: (spec: { argv: string[]; cwd: string }) => { spawned.push(spec); return handle },
  } as unknown as SubprocessRuntime
  return { subprocess, spawned, handle }
}
const humanConfig = { shellPath: '/bin/sh', retainedOutputBytes: 1024, terminationGraceMs: 50 }

it('把检出目录内的相对可执行文件解析为绝对路径后授权人工启动', async () => {
  const { subprocess, spawned } = stubbedSubprocess('', '')
  const resolved = resolve('/tmp/project', './dev.sh')
  const launch = await resolveHumanLaunch(subprocess, { argv: ['./dev.sh', '--flag'] }, '/tmp/project', humanConfig, new AbortController().signal)
  expect(launch.command.argv).toEqual([resolved, '--flag'])
  expect(launch.cwd).toBe('/tmp/project')
  await launch.start(new AbortController().signal)
  expect(spawned[0]!.argv).toEqual([humanConfig.shellPath, '-c', `exec '${resolved}' '--flag'`])
})

it('在子进程没有标准错误输出时省略错误分隔段', async () => {
  const { subprocess } = stubbedSubprocess('out-line', '')
  const launch = await resolveHumanLaunch(subprocess, { argv: ['server'] }, '/tmp', humanConfig, new AbortController().signal)
  expect((await launch.start(new AbortController().signal)).readOutput()).toEqual({ text: 'out-line', lossy: false })
})

it('把子进程的范围归属与退出等待转交给服务进程', async () => {
  const waitForExit = vi.fn(async () => undefined)
  const { subprocess } = stubbedSubprocess('', '', {
    waitForExit, ownsProcess: async (pid: number) => pid === 31,
  })
  const launch = await resolveHumanLaunch(subprocess, { argv: ['server'] }, '/tmp', humanConfig, new AbortController().signal)
  const process = await launch.start(new AbortController().signal)
  expect(await process.ownsProcess!(31)).toBe(true)
  expect(await process.ownsProcess!(1)).toBe(false)
  await process.waitForExit()
  expect(waitForExit).toHaveBeenCalledTimes(1)
})

it('以精确引用的人工启动合并 stderr 并在没有范围归属时省略 ownsProcess', async () => {
  let terminated = false
  const { subprocess, spawned } = stubbedSubprocess('out-line', 'err-line', { terminate: () => { terminated = true } })
  const command: ServiceCommand = { argv: ['server', '--flag', "it's"] }
  const launch = await resolveHumanLaunch(subprocess, command, '/tmp', humanConfig, new AbortController().signal)
  expect(launch.command.argv).toEqual(['server', '--flag', "it's"])
  expect(launch.cwd).toBe('/tmp')
  const process = await launch.start(new AbortController().signal)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]!.argv).toEqual(['/bin/sh', '-c', "exec 'server' '--flag' 'it'\\''s'"])
  expect(spawned[0]!.cwd).toBe('/tmp')
  expect('ownsProcess' in process).toBe(false)
  expect(process.readOutput()).toEqual({ text: 'out-line\n[stderr]\nerr-line', lossy: false })
  await process.terminate()
  expect(terminated).toBe(true)
  expect(await process.done).toEqual({ exitCode: 0, signal: null })
})

it('在没有范围归属的 shell 执行器上省略 ownsProcess 并转交退出事实', async () => {
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const executor = await ctx.plugin(LocalBashExecutor, { graceMs: 50 })
  const shellProcess = {
    status: 'completed' as const, exitCode: 7, signal: null, done: Promise.resolve(),
    readOutput: () => ({ delta: 'shell output', lossy: false }),
    kill: () => false, terminate: async () => {}, waitForExit: async () => {},
  }
  const prepare = vi.spyOn(ctx.shell, 'prepare').mockResolvedValue({ start: async () => shellProcess })
  try {
    const adapter = createShellServiceExecution(ctx, { signal: new AbortController().signal, subprocessRealm: ctx[Context.isolate]['subprocess'] }, {})
    const launch = await adapter.resolve({ argv: ['node', '-e', '0'] }, tmpdir(), new AbortController().signal)
    const process = await launch.start(new AbortController().signal)
    expect('ownsProcess' in process).toBe(false)
    expect(process.readOutput()).toEqual({ text: 'shell output', lossy: false })
    expect(await process.done).toEqual({ exitCode: 7, signal: null })
  } finally {
    prepare.mockRestore()
    await executor.dispose()
    await subprocess.dispose()
  }
})

it('在有范围归属的 shell 执行器上转交退出与归属事实', async () => {
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const executor = await ctx.plugin(LocalBashExecutor, { graceMs: 50 })
  const terminated: string[] = []
  const waitForExit = vi.fn(async () => undefined)
  const shellProcess = {
    status: 'completed' as const, exitCode: 0, signal: null, done: Promise.resolve(),
    readOutput: () => ({ delta: 'shell output', lossy: false }),
    kill: () => false, terminate: async () => { terminated.push('terminated') }, waitForExit,
    ownsProcess: async (pid: number) => pid === 31,
  }
  const prepare = vi.spyOn(ctx.shell, 'prepare').mockResolvedValue({ start: async () => shellProcess })
  try {
    const adapter = createShellServiceExecution(ctx, { signal: new AbortController().signal, subprocessRealm: ctx[Context.isolate]['subprocess'] }, {})
    const launch = await adapter.resolve({ argv: ['node', '-e', '0'] }, tmpdir(), new AbortController().signal)
    const process = await launch.start(new AbortController().signal)
    expect(await process.ownsProcess!(31)).toBe(true)
    await process.terminate()
    expect(terminated).toEqual(['terminated'])
    await process.waitForExit()
    expect(waitForExit).toHaveBeenCalledTimes(1)
  } finally {
    prepare.mockRestore()
    await executor.dispose()
    await subprocess.dispose()
  }
})
