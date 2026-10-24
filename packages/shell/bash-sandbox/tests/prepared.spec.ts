import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import SandboxBashExecutor from '../src/index.ts'

async function fixture(confine: () => Promise<ConfinedArgv>) {
  const ctx = new Context()
  class Provider extends SandboxProvider { override confine() { return confine() } }
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(Provider)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor)
  return ctx
}

it('rejects confinement during preparation without launching the requested command', async () => {
  const ctx = await fixture(async () => { throw new Error('confinement refused') })
  try { await expect(ctx.shell.prepare(ctx.shell.resolve({ command: 'exit 99' }))).rejects.toThrow('confinement refused') }
  finally { await ctx.fiber.dispose() }
})

it('starts the captured confined argv and refuses cancellation before launch', async () => {
  let calls = 0
  const ctx = await fixture(async () => {
    calls++
    return { argv: [process.execPath, '-e', 'console.log("confined")'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  })
  try {
    const prepared = await ctx.shell.prepare(ctx.shell.resolve({ command: 'printf bypassed' }))
    const proc = await prepared.start(new AbortController().signal)
    await proc.done
    await proc.waitForExit()
    expect(proc.readOutput().delta).toBe('confined\n')
    expect(calls).toBe(1)
    const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
    await expect(prepared.start(cancelled.signal)).rejects.toThrow('cancelled')
  } finally { await ctx.fiber.dispose() }
})

it('prepares full access as the unconfined local launch without confining', async () => {
  const ctx = await fixture(async () => { throw new Error('confinement must not run under full access') })
  try {
    const prepared = await ctx.shell.prepare(ctx.shell.resolve({
      command: 'exit 99',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
    }))
    const proc = await prepared.start(new AbortController().signal)
    await proc.done
    expect(proc.exitCode).toBe(99)
    expect(proc.sandbox).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
