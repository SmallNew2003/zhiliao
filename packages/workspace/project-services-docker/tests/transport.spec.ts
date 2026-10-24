import { describe, expect, it } from 'vitest'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DockerTransport,
  SubprocessDockerCliExecutor,
  type DockerCliDispatch,
  type DockerCliExecutor,
  type DockerContainerInspect,
} from '../src/transport.ts'

const dispatch: DockerCliDispatch = { scanTimeoutMs: 10000, terminationGraceMs: 5000, scanMaxBytes: 1048576 }

function executorWith(stdout: string, stderr = '', exitCode = 0): DockerCliExecutor {
  return { async exec() { return { stdout, stderr, exitCode } } }
}

function inspectRecord(payload: Record<string, unknown>, state: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    Id: 'c-app',
    State: {
      Status: 'running',
      Running: true,
      Restarting: false,
      StartedAt: '2026-10-10T00:00:00Z',
      FinishedAt: '',
      ...state,
    },
    Name: '/web',
    RestartCount: 0,
    Config: { Image: 'nginx', Labels: {} },
    NetworkSettings: { Ports: {} },
    Mounts: [],
    ...payload,
  }])
}

/** Recorded spawn facts of one fake subprocess dispatch. */
interface FakeDispatch {
  specs: SubprocessSpawnSpec[]
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null }
  stdout: string
  stderr: string
  lossy: boolean
  doneDelayMs: number
  terminated?: boolean
  waited?: boolean
}

function fakeRuntime(dispatch: FakeDispatch): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      dispatch.specs.push(spec)
      const reader = (text: string): SubprocessOutputReader => ({
        readFrom: () => ({ text, nextOffset: text.length, lossy: dispatch.lossy }),
      })
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        // A real provider settles the outcome when the abort escalation kills the child.
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
        setTimeout(() => { resolve(dispatch.outcome) }, dispatch.doneDelayMs)
      })
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: reader(dispatch.stdout), stderr: reader(dispatch.stderr) },
        done,
        terminate: () => { dispatch.terminated = true },
        waitForExit: async () => { dispatch.waited = true; return true },
      }
    },
  } as unknown as SubprocessRuntime
}

function newDispatch(overrides: Partial<FakeDispatch> = {}): FakeDispatch {
  return { specs: [], outcome: { exitCode: 0, signal: null }, stdout: '', stderr: '', lossy: false, doneDelayMs: 0, ...overrides }
}

describe('DockerTransport wire validation', () => {
  it('accepts the legacy Id spelling and defaults absent identity fields', async () => {
    const transport = new DockerTransport('', executorWith(JSON.stringify({ Id: 'daemon-legacy' })), 100)
    await expect(transport.info()).resolves.toEqual({
      id: 'daemon-legacy',
      name: '',
      serverVersion: '',
      operatingSystem: '',
    })
  })

  it('rejects a daemon identity payload without either id spelling', async () => {
    const transport = new DockerTransport('', executorWith(JSON.stringify({ Name: 'daemon' })), 100)
    await expect(transport.info()).rejects.toThrow('Docker daemon identity is missing or invalid')
  })

  it('rejects daemon identity output that is not JSON', async () => {
    const transport = new DockerTransport('', executorWith('docker info: daemon unreachable'), 100)
    await expect(transport.info()).rejects.toThrow('Docker daemon identity output is not valid JSON')
  })

  it('reports one id per line from docker ps -a -q', async () => {
    const transport = new DockerTransport('', executorWith('c-app\nc-db\n\n'), 100)
    await expect(transport.ps()).resolves.toEqual(['c-app', 'c-db'])
  })

  it('reports no containers when docker ps prints nothing', async () => {
    const transport = new DockerTransport('', executorWith(''), 100)
    await expect(transport.ps()).resolves.toEqual([])
  })

  it('rejects docker ps when the CLI exits nonzero', async () => {
    const transport = new DockerTransport('', executorWith('', 'Cannot connect to the Docker daemon', 1), 100)
    await expect(transport.ps()).rejects.toThrow('Docker ps failed: Cannot connect to the Docker daemon')
  })

  it('rejects an inspect record whose container state is unknown', async () => {
    const transport = new DockerTransport('', executorWith(inspectRecord({}, { Status: 'quantum' })), 100)
    await expect(transport.inspect(['c-app'])).rejects.toThrow('Docker inspect output failed validation: $[0].State.Status')
  })

  it('projects optional inspect fields only when the daemon reports them', async () => {
    const transport = new DockerTransport('', executorWith(inspectRecord({
      Config: { Image: 'nginx', Labels: { 'com.docker.compose.service': 'web' } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostPort: '8080' }], '443/tcp': null } },
      Mounts: [{ Type: 'bind', Source: '/workspace/main' }],
    })), 100)
    const [record] = await transport.inspect(['c-app'])
    expect(record!.NetworkSettings.Ports['443/tcp']).toBeNull()
    expect(record!.NetworkSettings.Ports['80/tcp']).toEqual([{ HostPort: '8080' }])
    expect(record!.Mounts[0]!.Source).toBe('/workspace/main')
    expect(record!.State.Health).toBeUndefined()
  })

  it('defaults an empty health log when the daemon omits it', async () => {
    const transport = new DockerTransport('', executorWith(inspectRecord({}, { Health: { Status: 'healthy' } })), 100)
    const [record] = await transport.inspect(['c-app'])
    expect(record!.State.Health!.Status).toBe('healthy')
  })

  it('reports the exit code when a failing daemon call prints nothing', async () => {
    const info = new DockerTransport('', executorWith('', '', 1), 100)
    await expect(info.info()).rejects.toThrow('Docker info failed: exit code 1')
    const ps = new DockerTransport('', executorWith('', '', 2), 100)
    await expect(ps.ps()).rejects.toThrow('Docker ps failed: exit code 2')
    const inspect = new DockerTransport('', executorWith('', '', 3), 100)
    await expect(inspect.inspect(['c-app'])).rejects.toThrow('Docker inspect failed: exit code 3')
  })

  it('reports a failing log read with the daemon diagnosis or exit code', async () => {
    const diagnosed = new DockerTransport('', executorWith('', 'no such container', 1), 100)
    await expect(diagnosed.logs('c-app', { tail: 10 })).rejects.toThrow('Docker logs failed for container c-app: no such container')
    const silent = new DockerTransport('', executorWith('', '', 1), 100)
    await expect(silent.logs('c-app', { tail: 10 })).rejects.toThrow('Docker logs failed for container c-app: exit code 1')
  })

  it('passes the tail and since bounds to a log read', async () => {
    const seen: string[][] = []
    const transport = new DockerTransport('', {
      async exec(args) { seen.push([...args]); return { stdout: 'out', stderr: 'err', exitCode: 0 } },
    }, 100)
    await expect(transport.logs('c-app', { tail: 25, since: '2026-10-10T12:00:00Z' })).resolves.toBe('out\nerr')
    expect(seen[0]).toEqual(['logs', '--timestamps', '--tail', '25', '--since', '2026-10-10T12:00:00Z', 'c-app'])
  })

  it('reports a failing container start with the daemon diagnosis', async () => {
    const transport = new DockerTransport('', executorWith('', 'container already running', 1), 100)
    await expect(transport.start('c-app')).rejects.toThrow('Docker start failed for container c-app: container already running')
  })

  it('reports a failing container start without daemon output', async () => {
    const transport = new DockerTransport('', executorWith('', '', 1), 100)
    await expect(transport.start('c-app')).rejects.toThrow('Docker start failed for container c-app: exit code 1')
  })

  it('reports a failing container stop with the daemon diagnosis', async () => {
    const transport = new DockerTransport('', executorWith('', 'no such container', 1), 100)
    await expect(transport.stop('c-app', 5)).rejects.toThrow('Docker stop failed for container c-app: no such container')
  })

  it('reports a failing container stop without daemon output', async () => {
    const transport = new DockerTransport('', executorWith('', '', 1), 100)
    await expect(transport.stop('c-app', 5)).rejects.toThrow('Docker stop failed for container c-app: exit code 1')
  })

  it('passes the grace seconds to a container restart and reports its failure', async () => {
    const seen: string[][] = []
    const ok = new DockerTransport('', {
      async exec(args) { seen.push([...args]); return { stdout: 'c-app', stderr: '', exitCode: 0 } },
    }, 100)
    await expect(ok.restart('c-app', 7)).resolves.toBeUndefined()
    expect(seen[0]).toEqual(['restart', '-t', '7', 'c-app'])

    const failing = new DockerTransport('', executorWith('', 'restart failed', 1), 100)
    await expect(failing.restart('c-app', 7)).rejects.toThrow('Docker restart failed for container c-app: restart failed')
    const silent = new DockerTransport('', executorWith('', '', 1), 100)
    await expect(silent.restart('c-app', 7)).rejects.toThrow('Docker restart failed for container c-app: exit code 1')
  })

  it('inspects every container in request order across id batches', async () => {
    const seen: string[][] = []
    const executor: DockerCliExecutor = {
      async exec(args) {
        seen.push([...args])
        const ids = args.slice(1)
        const records = ids.map(id => (JSON.parse(inspectRecord({ Id: id })) as DockerContainerInspect[])[0]!)
        return { stdout: JSON.stringify(records), stderr: '', exitCode: 0 }
      },
    }
    const transport = new DockerTransport('', executor, 2)
    const records = await transport.inspect(['c-1', 'c-2', 'c-3'])
    expect(records.map(record => record.Id)).toEqual(['c-1', 'c-2', 'c-3'])
    expect(seen).toEqual([['inspect', 'c-1', 'c-2'], ['inspect', 'c-3']])
  })

  it('inspects nothing when no container id is given', async () => {
    const seen: string[][] = []
    const transport = new DockerTransport('', { async exec(args) { seen.push([...args]); return { stdout: '', stderr: '', exitCode: 0 } } }, 2)
    await expect(transport.inspect([])).resolves.toEqual([])
    expect(seen).toEqual([])
  })
})

describe('SubprocessDockerCliExecutor', () => {
  it('injects the configured context and pins the dispatch bounds', async () => {
    const fake = newDispatch({ stdout: 'ok', stderr: 'warn' })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', 'remote-ctx', dispatch)
    await expect(executor.exec(['ps', '-a'], new AbortController().signal)).resolves.toEqual({
      stdout: 'ok', stderr: 'warn', exitCode: 0,
    })
    expect(fake.specs).toHaveLength(1)
    const spec = fake.specs[0]!
    expect(spec.argv).toEqual(['docker', '--context', 'remote-ctx', 'ps', '-a'])
    expect(spec.cwd).toBe('/')
    expect(spec.graceMs).toBe(5000)
    expect(spec.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: 1048576 },
      stderr: { maxBytes: 1048576 },
    })
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    expect(fake.terminated).toBe(true)
    expect(fake.waited).toBe(true)
  })

  it('omits the context flag when no context is configured', async () => {
    const fake = newDispatch({ stdout: '' })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    await executor.exec(['info'])
    expect(fake.specs[0]!.argv).toEqual(['docker', 'info'])
  })

  it('reports the exit code of a failed dispatch', async () => {
    const fake = newDispatch({ outcome: { exitCode: 7, signal: null }, stderr: 'boom' })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    await expect(executor.exec(['ps'])).resolves.toEqual({ stdout: '', stderr: 'boom', exitCode: 7 })
  })

  it('classifies a signal death instead of reporting a successful empty exit', async () => {
    const fake = newDispatch({ outcome: { exitCode: null, signal: 'SIGKILL' }, stdout: '' })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    await expect(executor.exec(['ps'])).rejects.toThrow('Docker CLI was killed by signal SIGKILL')
  })

  it('rejects an outcome without any exit code', async () => {
    const fake = newDispatch({ outcome: { exitCode: null, signal: null } })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    await expect(executor.exec(['ps'])).rejects.toThrow('Docker CLI exited without an exit code')
  })

  it('rejects output that overflowed the capture limit', async () => {
    const fake = newDispatch({ stdout: 'partial', lossy: true })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    await expect(executor.exec(['ps'])).rejects.toThrow('Docker CLI output exceeded the capture limit')
  })

  it('aborts a dispatch that outruns the scan deadline', async () => {
    const fake = newDispatch({ doneDelayMs: 50 })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', { ...dispatch, scanTimeoutMs: 1 })
    await expect(executor.exec(['ps'])).rejects.toThrow(/timed out|aborted/)
  })

  it('propagates caller cancellation before the deadline', async () => {
    const fake = newDispatch({ doneDelayMs: 50 })
    const executor = new SubprocessDockerCliExecutor(fakeRuntime(fake), 'docker', '', dispatch)
    const controller = new AbortController()
    const pending = executor.exec(['ps'], controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })
})
