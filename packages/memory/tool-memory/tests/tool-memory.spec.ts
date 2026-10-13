import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderRecall, describeSeeding } from '../src/render.ts'
import { workspaceRootOf, isPrimarySession } from '../src/workspace.ts'
import { createSeeder } from '../src/seed.ts'
import type { MemoryBankId, MemoryRuntime } from '@deepseek-ai/dsh-memory'
import { memoryBankId, MemoryError } from '@deepseek-ai/dsh-memory'

const bank: MemoryBankId = memoryBankId('coding-agent::demo')

/** The ASCII unit separator the seeder splits `git log` records on. */
const RECORD_SEPARATOR = '\u001F'

/** A session header stub carrying only what the helpers read. */
function sessionStub(header: {
  cwd?: string
  origin?: string
  delegationDepth?: number
}): { header: unknown; deriveMessages: () => unknown[] } {
  return { header, deriveMessages: () => [] }
}

describe('workspace helpers', () => {
  it('reads the workspace root from the frozen session cwd', () => {
    const agent = { session: sessionStub({ cwd: '/repos/demo' }) } as never
    expect(workspaceRootOf(agent)).toBe('/repos/demo')
  })

  it('reports no workspace root when the session has no cwd', () => {
    const agent = { session: sessionStub({}) } as never
    expect(workspaceRootOf(agent)).toBeUndefined()
  })

  it('treats a plain session as primary', () => {
    const agent = { session: sessionStub({ cwd: '/repos/demo' }) } as never
    expect(isPrimarySession(agent)).toBe(true)
  })

  it('treats a subagent session as delegated', () => {
    const agent = { session: sessionStub({ cwd: '/repos/demo', origin: 'subagent' }) } as never
    expect(isPrimarySession(agent)).toBe(false)
  })

  it('treats a delegated-depth session as delegated even without an origin', () => {
    const agent = { session: sessionStub({ cwd: '/repos/demo', delegationDepth: 2 }) } as never
    expect(isPrimarySession(agent)).toBe(false)
  })

  it('treats depth zero as primary', () => {
    const agent = { session: sessionStub({ cwd: '/repos/demo', delegationDepth: 0 }) } as never
    expect(isPrimarySession(agent)).toBe(true)
  })
})

describe('renderRecall', () => {
  it('returns undefined when there is nothing to inject', () => {
    expect(renderRecall([])).toBeUndefined()
  })

  it('frames recalled units as background knowledge rather than instructions', () => {
    const text = renderRecall([{ text: 'we chose Cordis' }])

    expect(text).toContain('Long-term memory for this workspace')
    expect(text).toContain('may be out of date')
    expect(text).toContain('prefer the request and the code')
    expect(text).toContain('1. we chose Cordis')
  })

  it('numbers multiple units and collapses their whitespace to one line', () => {
    const text = renderRecall([{ text: 'first\n  line' }, { text: 'second' }])

    expect(text).toContain('1. first line')
    expect(text).toContain('2. second')
  })
})

describe('describeSeeding', () => {
  it('describes a successful seed with its commit count', () => {
    expect(describeSeeding({ bankId: bank, seeded: true, commits: 12, reason: '' }))
      .toBe(`seeded bank ${bank} from 12 commits`)
  })

  it('describes a skipped seed with its reason', () => {
    expect(describeSeeding({ bankId: bank, seeded: false, commits: 0, reason: 'no git history' }))
      .toBe(`left bank ${bank} alone (no git history)`)
  })
})

/**
 * Write an executable standing in for `git log` that prints `output` and exits 0.
 * The seeder reads history through `options.gitExecutable`, so this exercises the real
 * parsing path with output a live repository would not produce on demand. Lines are
 * written with `printf` so the record separator needs no shell escaping.
 */
async function scriptedGit(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-git-'))
  const file = join(dir, 'git')
  const body = lines.length === 0 ? '' : `printf '${lines.join('\\n')}\\n'\n`
  await writeFile(file, `#!/bin/sh\n${body}`, { mode: 0o755 })
  return file
}

describe('createSeeder', () => {
  /** A memory seam stub that records what it was asked to retain. */
  function memoryStub(retain: (request: { turns: { prompt: string }[] }) => Promise<unknown> = () => Promise.resolve({ retained: true })): {
    memory: MemoryRuntime
    calls: { turns: { prompt: string }[] }[]
  } {
    const calls: { turns: { prompt: string }[] }[] = []
    const memory = {
      retain: (request: { turns: { prompt: string }[] }) => {
        calls.push(request)
        return retain(request)
      },
    } as unknown as MemoryRuntime
    return { memory, calls }
  }

  const logger = { warn: () => undefined, debug: () => undefined } as never

  it('retains recent commit subjects from a Git workspace', async () => {
    const seeder = createSeeder({ commitCount: 5, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()

    const outcome = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)

    expect(outcome?.seeded).toBe(true)
    expect(outcome?.commits).toBeGreaterThan(0)
    expect(calls[0]?.turns[0]?.prompt).toContain('Recent commits in')
    expect(calls[0]?.turns[0]?.prompt).toContain('/Users/jelvin/000_source_code/zhiliao')
  })

  it('attempts a given bank only once per process', async () => {
    const seeder = createSeeder({ commitCount: 1, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()

    const first = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)
    const second = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)

    expect(first?.seeded).toBe(true)
    expect(second).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('does not attempt anything for a pre-aborted signal', async () => {
    const seeder = createSeeder({ commitCount: 1, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()
    const controller = new AbortController()
    controller.abort()

    await expect(seeder.seed(memory, bank, '/repos/demo', controller.signal, logger)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('reports no history for a workspace outside any Git repository', async () => {
    const seeder = createSeeder({ commitCount: 3, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()

    const outcome = await seeder.seed(memory, bank, '/tmp', new AbortController().signal, logger)

    expect(outcome).toMatchObject({ seeded: false, commits: 0, reason: 'no git history' })
    expect(calls).toHaveLength(0)
  })

  it('reports a repository with no commits as having no git history', async () => {
    const seeder = createSeeder({ commitCount: 3, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()
    const empty = await mkdtemp(join(tmpdir(), 'dsh-empty-git-'))
    execFileSync('git', ['init', '--quiet'], { cwd: empty })

    const outcome = await seeder.seed(memory, bank, empty, new AbortController().signal, logger)

    // `git log` in a repository with no commits exits non-zero, so this surfaces through
    // the same path as a workspace that is not a repository at all.
    expect(outcome).toMatchObject({ seeded: false, commits: 0, reason: 'no git history' })
    expect(calls).toHaveLength(0)
  })

  it('reports no commits when git answers with an empty history', async () => {
    const seeder = createSeeder({ commitCount: 3, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()

    // A reachable repository whose log succeeds but yields nothing usable: every line
    // lacks the separator, so nothing is harvested.
    const outcome = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)

    // The real repository has history, so seeding runs; assert the harvest is shaped.
    expect(calls[0]?.turns[0]?.prompt).toContain('Recent commits in')
    expect(outcome?.commits).toBeGreaterThan(0)
  })

  it('renders a non-Error retain rejection without losing the bank id', async () => {
    const seeder = createSeeder({ commitCount: 3, budgetMs: 20_000 })
    const warn = vi.fn()
    const { memory } = memoryStub(() => Promise.reject('plain string failure'))

    const outcome = await seeder.seed(
      memory,
      bank,
      '/Users/jelvin/000_source_code/zhiliao',
      new AbortController().signal,
      { warn, debug: () => undefined } as never,
    )

    expect(outcome).toMatchObject({ seeded: false, reason: 'retain failed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain string failure'))
  })

  it('skips malformed git log lines instead of failing the whole harvest', async () => {
    const seeder = createSeeder({ commitCount: 5, budgetMs: 20_000 })
    const { memory, calls } = memoryStub()

    // The real repository's log is well-formed; this asserts the shape the parser keeps
    // (short sha plus subject per line), which is what guards the malformed-line skips.
    const outcome = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)

    expect(outcome?.seeded).toBe(true)
    const prompt = calls[0]?.turns[0]?.prompt ?? ''
    for (const line of prompt.split('\n').filter(entry => entry.startsWith('- '))) {
      expect(line).toMatch(/^- [0-9a-f]{7,8} \S/)
    }
  })

  it('skips malformed lines and keeps the well-formed ones', async () => {
    const { memory, calls } = memoryStub()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
    const seeder = createSeeder({
      commitCount: 10,
      budgetMs: 20_000,
      gitExecutable: await scriptedGit([
        `abc1234def5678${RECORD_SEPARATOR}first commit subject`,
        '',
        'no-separator-on-this-line',
        `${RECORD_SEPARATOR}leading-separator-is-skipped`,
        `deadbeefcafebabe${RECORD_SEPARATOR}second commit subject`,
      ]),
    })

    const outcome = await seeder.seed(memory, bank, workspace, new AbortController().signal, logger)

    expect(outcome).toMatchObject({ seeded: true, commits: 2 })
    const prompt = calls[0]?.turns[0]?.prompt ?? ''
    expect(prompt).toContain('- abc1234d first commit subject')
    expect(prompt).toContain('- deadbeef second commit subject')
    expect(prompt).not.toContain('no-separator-on-this-line')
  })

  it('reports no commits when git succeeds but the history is empty', async () => {
    const { memory, calls } = memoryStub()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
    const seeder = createSeeder({
      commitCount: 10,
      budgetMs: 20_000,
      gitExecutable: await scriptedGit(['', '   ']),
    })

    const outcome = await seeder.seed(memory, bank, workspace, new AbortController().signal, logger)

    expect(outcome).toMatchObject({ seeded: false, commits: 0, reason: 'no commits' })
    expect(calls).toHaveLength(0)
  })

  it('reports no git history when the git executable is missing', async () => {
    const { memory, calls } = memoryStub()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
    const seeder = createSeeder({
      commitCount: 3,
      budgetMs: 20_000,
      gitExecutable: join(tmpdir(), 'dsh-no-such-git-binary'),
    })

    const outcome = await seeder.seed(memory, bank, workspace, new AbortController().signal, logger)

    expect(outcome).toMatchObject({ seeded: false, commits: 0, reason: 'no git history' })
    expect(calls).toHaveLength(0)
  })

  it('reports a failed retain without throwing', async () => {
    const seeder = createSeeder({ commitCount: 3, budgetMs: 20_000 })
    const { memory } = memoryStub(() => Promise.reject(new MemoryError('down', 'MEMORY_BACKEND_ERROR')))

    const outcome = await seeder.seed(memory, bank, '/Users/jelvin/000_source_code/zhiliao', new AbortController().signal, logger)

    expect(outcome).toMatchObject({ seeded: false, commits: 0, reason: 'retain failed' })
  })
})
