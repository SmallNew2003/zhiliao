/**
 * Process-ownership observation on the fallback owner. `ownsProcess` answers
 * whether a numeric pid belongs to the spawned process group; only a host that
 * can observe groups answers, and the observation stops once the owner has
 * stopped. The `/bin/ps` probe is injected so every host exercises the same
 * answer matrix instead of only what its own `ps` can report.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSubprocess } from '../src/spawn.ts'
import type { LocalSubprocessHandle } from '../src/spawn.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

type ProbeCallback = (error: Error | null, stdout: string) => void
type ExecFileMock = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: ProbeCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock }
})

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-ownership-'))

beforeEach(() => {
  execFileMock.mockClear()
})

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

/**
 * Answer the next process-group probe with `stdout`, or with a probe failure
 * when `stdout` is null. `defer` holds the answer until the caller has already
 * observed the launch, for probes whose outcome depends on later state.
 */
function answerProbe(stdout: string | null, defer = false): void {
  execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
    const answer = (): void => {
      callback(stdout === null ? new Error('ps: no such process') : null, stdout ?? '')
    }
    if (defer) setTimeout(answer, 0)
    else answer()
  })
}

/** A spec whose child publishes its own pid, then either stays alive or exits. */
function publishingSpec(argv: readonly string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 3_000,
  }
}

/** Spawn a child that writes its pid to a fresh file, and return the handle and pid. */
async function publishingChild(script: string, platform: NodeJS.Platform = 'darwin'): Promise<{ handle: LocalSubprocessHandle; pid: number }> {
  const pidFile = join(spillDir, `owner-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`)
  const handle = spawnSubprocess(
    publishingSpec([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));${script}`]),
    { platform, spillDir },
  )
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return { handle, pid }
    } catch {
      // The child has not written the pid file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('the ownership probe child never published its pid')
}

describe('fallbackOwner.ownsProcess', () => {
  it('matches a pid inside the spawned group and reports absence for one outside it', async () => {
    const { handle, pid } = await publishingChild(' setTimeout(() => {}, 60000)')
    try {
      answerProbe(`  ${pid}\n`)
      await expect(handle.ownsProcess!(pid)).resolves.toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/ps',
        ['-o', 'pgid=', '-p', String(pid)],
        expect.objectContaining({ maxBuffer: 1024 }),
        expect.any(Function),
      )
      answerProbe('  999999\n')
      await expect(handle.ownsProcess!(pid)).resolves.toBe(false)
    } finally {
      handle.terminate()
      await handle.done
    }
  })

  it('reports an unobservable group when the probe fails', async () => {
    const { handle, pid } = await publishingChild(' setTimeout(() => {}, 60000)')
    try {
      answerProbe(null)
      await expect(handle.ownsProcess!(pid)).resolves.toBeUndefined()
    } finally {
      handle.terminate()
      await handle.done
    }
  })

  it('reports an unobservable group when the probe answer is not a process group', async () => {
    const { handle, pid } = await publishingChild(' setTimeout(() => {}, 60000)')
    try {
      answerProbe('not-a-group\n')
      await expect(handle.ownsProcess!(pid)).resolves.toBeUndefined()
      answerProbe('  0\n')
      await expect(handle.ownsProcess!(pid)).resolves.toBeUndefined()
    } finally {
      handle.terminate()
      await handle.done
    }
  })

  it('reports absence for a probe already in flight once the owner has stopped', async () => {
    // Nothing has signalled or waited yet, so the owner is still observing when
    // the probe launches; waiting for range exit stops it before the answer
    // lands and must answer absence rather than a stale verdict.
    const { handle, pid } = await publishingChild('')
    await handle.done
    answerProbe(`  ${pid}\n`, true)
    const ownership = handle.ownsProcess!(pid)
    await handle.waitForExit()
    await expect(ownership).resolves.toBe(false)
  })

  it('reports no ownership when the spawn published no pid', async () => {
    const handle = spawnSubprocess({
      argv: ['dsh-ownership-probe-missing-program'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 3_000,
    }, { platform: 'darwin', spillDir })
    // Asked before the launch failure settles, so the owner is still the one
    // answering and the missing pid alone decides the verdict.
    const ownership = handle.ownsProcess!(4242)
    await expect(ownership).resolves.toBe(false)
    await expect(handle.done).rejects.toThrow()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('reports an unobservable group on a platform without process-group observation', async () => {
    const { handle, pid } = await publishingChild(' setTimeout(() => {}, 60000)', 'linux')
    try {
      await expect(handle.ownsProcess!(pid)).resolves.toBeUndefined()
      expect(execFileMock).not.toHaveBeenCalled()
    } finally {
      handle.terminate()
      await handle.done
    }
  })
})
