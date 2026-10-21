/**
 * Cold-bank seeding: give a workspace's memory a starting point on first open.
 *
 * A bank that has never been written is amnesiac — the first session would recall nothing
 * and have nothing to reflect on. Seeding retains the workspace's recent commit subjects
 * as a first memory, which is cheap, read-only, and enough for hindsight to have real
 * project vocabulary to work with.
 *
 * Seeding is deliberately narrow. It does not read file contents, run a codebase survey,
 * or clone the repository: those belong to hindsight's own ingestion engine, and doing
 * them here would duplicate work the backend already does better. Every step is bounded
 * by a wall-clock budget and aborts quietly.
 *
 * @module @deepseek-ai/dsh-tool-memory/seed
 */

import { execFile } from 'node:child_process'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { MemoryBankId, MemoryRuntime } from '@deepseek-ai/dsh-memory'

/** How many commits to read and how long the whole seed may take. */
export interface SeedOptions {
  /** Number of recent commits whose subject lines seed the bank. */
  readonly commitCount: number
  /** Wall-clock budget for one workspace; exceeded work is abandoned. */
  readonly budgetMs: number
  /**
   * Git executable used to read history. Defaults to `git` on PATH; a deployment whose
   * git lives elsewhere (or a test that needs scripted output) overrides it here.
   */
  readonly gitExecutable?: string
}

/** What a seeding attempt did, for the caller's log line. */
export interface SeedOutcome {
  /** The bank that was considered. */
  readonly bankId: MemoryBankId
  /** Whether anything was retained. */
  readonly seeded: boolean
  /** Commit count retained when seeding; zero otherwise. */
  readonly commits: number
  /** Why seeding was skipped when it was. */
  readonly reason: string
}

/** Seeds a cold bank's workspace, once per process. */
export interface Seeder {
  /**
   * Seed `bankId` from `workspaceRoot` when the bank looks empty.
   * @param memory - the memory seam to retain through.
   * @param bankId - the bank to seed.
   * @param workspaceRoot - absolute directory whose Git history should be read.
   * @param signal - cancels the attempt.
   * @param logger - receives a debug line on success.
   * @returns what happened, or undefined when the attempt was cancelled.
   */
  seed(
    memory: MemoryRuntime,
    bankId: MemoryBankId,
    workspaceRoot: string,
    signal: AbortSignal,
    logger: LoggerService,
  ): Promise<SeedOutcome | undefined>
}

/** One line of a recent commit, as read from `git log`. */
interface CommitLine {
  readonly sha: string
  readonly subject: string
}

/**
 * Build a {@link Seeder} bound to `options`.
 * @param options - commit count, wall-clock budget, and the git executable to read.
 * @returns a seeder that harvests each bank at most once per process.
 */
export function createSeeder(options: SeedOptions): Seeder {
  const attempted = new Set<string>()
  return {
    async seed(memory, bankId, workspaceRoot, signal, logger): Promise<SeedOutcome | undefined> {
      // One attempt per bank per process: a resumed session must not re-seed, and two
      // windows on the same repo would otherwise race to seed the same bank.
      if (attempted.has(bankId)) return undefined
      if (signal.aborted) return undefined
      attempted.add(bankId)
      const budget = AbortSignal.timeout(options.budgetMs)
      const combined = AbortSignal.any([signal, budget])
      let commits: readonly CommitLine[]
      try {
        commits = await readRecentCommits(workspaceRoot, options.commitCount, options.gitExecutable ?? 'git', combined)
      } catch {
        // No repository, no git binary, or the read was cancelled: a workspace without
        // Git history is normal, not a failure.
        return { bankId, seeded: false, commits: 0, reason: 'no git history' }
      }
      if (commits.length === 0 || combined.aborted) {
        return { bankId, seeded: false, commits: 0, reason: 'no commits' }
      }
      const turns = [{
        turn: 0,
        prompt: [
          `Recent commits in ${workspaceRoot}, newest first:`,
          ...commits.map(commit => `- ${commit.sha.slice(0, 8)} ${commit.subject}`),
        ].join('\n'),
        response: 'This is repository history, recorded as initial project context.',
      }]
      try {
        await memory.retain({ turns }, bankId, combined)
      } catch (error: unknown) {
        logger.warn(`memory: seeding ${bankId} failed to retain: ${error instanceof Error ? error.message : String(error)}`)
        return { bankId, seeded: false, commits: 0, reason: 'retain failed' }
      }
      return { bankId, seeded: true, commits: commits.length, reason: '' }
    },
  }
}

/**
 * Read the most recent commit subjects from `workspaceRoot`.
 *
 * Uses `--no-optional-locks` and a scrubbed environment so the read cannot take the
 * repository's index lock, prompt for credentials, or depend on the caller's locale.
 */
async function readRecentCommits(
  workspaceRoot: string,
  count: number,
  executable: string,
  signal: AbortSignal,
): Promise<readonly CommitLine[]> {
  // ASCII unit separator: cannot occur in a commit subject, so the split is unambiguous.
  const separator = '\u001F'
  const stdout = await execFileAsync(
    executable,
    ['--no-optional-locks', 'log', `-${count}`, '--no-merges', `--format=%H${separator}%s`],
    workspaceRoot,
    signal,
  )
  const commits: CommitLine[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const at = trimmed.indexOf(separator)
    if (at <= 0) continue
    commits.push({ sha: trimmed.slice(0, at), subject: trimmed.slice(at + 1) })
  }
  return commits
}

/** `execFile` promisified with an abort signal, bounded stdout, and a scrubbed environment. */
function execFileAsync(
  command: string,
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      command,
      [...argv],
      {
        cwd,
        signal,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
        env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error: Error | null, stdout: string) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
    // An aborted child rejects on its own; this keeps the promise from lingering when
    // the caller only cares about the abort.
    child.on('error', () => undefined)
  })
}
