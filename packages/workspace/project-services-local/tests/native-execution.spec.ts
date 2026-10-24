import { tmpdir } from 'node:os'
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

it('以精确引用的人工启动合并 stderr 并在没有范围归属时省略 ownsProcess', async () => {
  const spawned: { argv: string[]; cwd: string }[] = []
  let terminated = false
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: 'out-line', nextOffset: 8, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'err-line', nextOffset: 8, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => { terminated = true },
    waitForExit: async () => undefined,
  }
  const subprocess = {
    resolveExecutable: async (program: string) => program,
    spawn: (spec: { argv: string[]; cwd: string }) => { spawned.push(spec); return handle },
  } as unknown as SubprocessRuntime
  const command: ServiceCommand = { argv: ['server', '--flag', "it's"] }
  const launch = await resolveHumanLaunch(subprocess, command, '/tmp',
    { shellPath: '/bin/sh', retainedOutputBytes: 1024, terminationGraceMs: 50 }, new AbortController().signal)
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
