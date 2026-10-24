/**
 * Canonical local Git-common-directory and checkout resolution.
 * @module
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ServiceAccess, ServiceCheckout, ServiceProject, ServiceProjectId, ServiceCheckoutId } from '@deepseek-ai/dsh-project-services'

/** Explicit resource bounds for local Git inspection. */
export interface ProjectResolutionConfig { scanTimeoutMs: number; scanMaxBytes: number; terminationGraceMs: number }
/** Current repository and validated worktrees. */
export interface ResolvedServiceProject { project: ServiceProject; checkouts: ServiceCheckout[] }

/** Canonical paths and execution identity jointly determine project identity. */
export class ProjectResolver {
  constructor(private readonly subprocess: SubprocessRuntime, private readonly config: ProjectResolutionConfig) {}

  /**
   * Resolve the execution world’s canonical project and validate each checkout.
   * @param access - Execution world and cwd.
   * @param signal - Scan cancellation.
   * @returns Validated project and checkout paths.
   */
  async resolve(access: ServiceAccess, signal: AbortSignal): Promise<ResolvedServiceProject> {
    signal.throwIfAborted()
    const cwd = await realpathNormalize(access.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error('Project cwd is not a directory')
    const probe = await this.git(cwd, ['rev-parse', '--show-toplevel'], signal)
    if (probe.exitCode !== 0) {
      if (!probe.error.includes('not a git repository')) throw new Error(`Git project inspection failed: ${probe.error}`)
      return this.result(access, cwd, undefined, [cwd])
    }
    const root = await realpathNormalize(probe.text.slice(0, -1))
    const common = await this.commonDirectory(cwd, signal)
    const listing = await this.git(cwd, ['worktree', 'list', '--porcelain', '-z'], signal)
    if (listing.exitCode !== 0) throw new Error(`Git worktree inspection failed: ${listing.error}`)
    const paths: string[] = []
    for (const field of listing.text.split('\0')) {
      if (!field.startsWith('worktree ')) continue
      let path: string
      try { path = await realpathNormalize(field.slice('worktree '.length)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!(await stat(path)).isDirectory()) continue
      const candidate = await this.git(path, ['rev-parse', '--show-toplevel'], signal)
      if (candidate.exitCode !== 0) continue
      if (await this.commonDirectory(path, signal) !== common) continue
      if (await realpathNormalize(candidate.text.slice(0, -1)) !== path) continue
      paths.push(path)
    }
    if (!paths.includes(root)) throw new Error('Current checkout is absent from Git worktree inventory')
    return this.result(access, root, common, [...new Set(paths)].sort())
  }

  private result(access: ServiceAccess, root: string, common: string | undefined, paths: string[]): ResolvedServiceProject {
    const digest = createHash('sha256').update(JSON.stringify([access.executionIdentity, common ?? root])).digest('hex')
    const project: ServiceProject = {
      id: brandString<ServiceProjectId>(digest), path: common === undefined ? root : common,
      executionIdentity: access.executionIdentity, ...(common === undefined ? {} : { gitCommonDir: common }),
    }
    return { project, checkouts: paths.map(path => ({ id: brandString<ServiceCheckoutId>(createHash('sha256').update(JSON.stringify([digest, path])).digest('hex')), projectId: project.id, path, availability: 'present' as const })) }
  }

  private async commonDirectory(cwd: string, signal: AbortSignal): Promise<string> {
    const result = await this.git(cwd, ['rev-parse', '--git-common-dir'], signal)
    if (result.exitCode !== 0) throw new Error(`Git common directory inspection failed: ${result.error}`)
    return await realpathNormalize(resolve(cwd, result.text.slice(0, -1)))
  }

  private async git(cwd: string, args: string[], signal: AbortSignal) {
    const deadline = AbortSignal.timeout(this.config.scanTimeoutMs)
    const combined = AbortSignal.any([signal, deadline])
    const executable = await this.subprocess.resolveExecutable('git', undefined, combined)
    const env: NodeJS.ProcessEnv = { LC_ALL: 'C' }
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('GIT_')) env[key] = undefined
    env.GIT_OPTIONAL_LOCKS = '0'
    const handle = this.subprocess.spawn({ argv: [executable, ...args], cwd, env,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.scanMaxBytes }, stderr: { maxBytes: this.config.scanMaxBytes } },
      graceMs: this.config.terminationGraceMs, signal: combined,
    })
    const outcome = await handle.done
    combined.throwIfAborted()
    const output = (handle.collected.stdout as SubprocessOutputReader).readFrom(0),
      error = (handle.collected.stderr as SubprocessOutputReader).readFrom(0)
    if (output.lossy || error.lossy) throw new Error('Git inspection exceeded its output limit')
    return { exitCode: outcome.exitCode, text: output.text, error: error.text }
  }
}
