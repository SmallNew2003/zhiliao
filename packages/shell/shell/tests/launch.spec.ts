/**
 * Launch-spec snapshot contract: `prepare` in every executor family snapshots
 * the resolved spec through it, so the published process keeps the policy and
 * environment maps preparation observed and never inherits the caller's signal.
 */

import { describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecSpec } from '../src/types.ts'
import { captureLaunchSpec } from '../src/launch.ts'

/** A resolved spec carrying every field the snapshot clones. */
function fullSpec(): ShellExecSpec {
  return {
    command: 'echo hi',
    workdir: '/work',
    timeoutMs: 1_000,
    stdoutMaxBytes: 4_096,
    signal: new AbortController().signal,
    env: { EXTRA: '1' },
    dshEnv: { DSH_SEAM_VAR: 'dsh-ok' },
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/work' },
  }
}

describe('captureLaunchSpec', () => {
  it('drops the caller signal so only the launch signal reaches the process', () => {
    expect(captureLaunchSpec(fullSpec()).signal).toBeUndefined()
  })

  it('keeps every other resolved field', () => {
    const captured = captureLaunchSpec(fullSpec())
    expect(captured.command).toBe('echo hi')
    expect(captured.workdir).toBe('/work')
    expect(captured.timeoutMs).toBe(1_000)
    expect(captured.stdoutMaxBytes).toBe(4_096)
  })

  it('clones the policy and environment maps instead of aliasing them', () => {
    const spec = fullSpec()
    const captured = captureLaunchSpec(spec)
    expect(captured.sandboxPolicy).not.toBe(spec.sandboxPolicy)
    expect(captured.env).not.toBe(spec.env)
    expect(captured.dshEnv).not.toBe(spec.dshEnv)
    expect(captured.sandboxPolicy).toEqual(spec.sandboxPolicy)
    expect(captured.env).toEqual(spec.env)
    expect(captured.dshEnv).toEqual(spec.dshEnv)
  })

  it('keeps a caller mutation between preparation and launch out of the snapshot', () => {
    const spec = fullSpec()
    const captured = captureLaunchSpec(spec)
    spec.sandboxPolicy!.workspaceRoot = '/elsewhere'
    ;(spec.env as Record<string, string>).EXTRA = '2'
    expect(captured.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: '/work' } satisfies SandboxExecutionPolicy)
    expect(captured.env).toEqual({ EXTRA: '1' })
  })

  it('leaves an absent policy and environment maps absent', () => {
    const spec = fullSpec()
    spec.sandboxPolicy = undefined
    delete spec.env
    delete spec.dshEnv
    const captured = captureLaunchSpec(spec)
    expect(captured.sandboxPolicy).toBeUndefined()
    expect(captured.env).toBeUndefined()
    expect(captured.dshEnv).toBeUndefined()
  })
})
