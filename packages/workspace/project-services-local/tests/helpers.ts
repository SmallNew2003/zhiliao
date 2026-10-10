import type * as ServiceTypes from '@deepseek-ai/dsh-project-services'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ServiceAccess } from '@deepseek-ai/dsh-project-services'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LocalProjectServiceRuntime from '../src/index.ts'

export const signal = () => new AbortController().signal
export const accessFor = (cwd: string): ServiceAccess => ({
  actorId: brandString<ServiceTypes.ServiceActorId>('actor'), kind: 'human', cwd, executionIdentity: brandString<ServiceTypes.ServiceExecutionIdentity>('local'),
  authorize: async () => {}, canRead: async () => true, revalidate: async () => {},
})
export async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  const storage = await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('memory', new MemoryStorageBackend(pool)))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.effect(() => () => facility.closeAll())
  ctx.provide('storageDomain', facility)
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const runtimeFiber = await ctx.plugin(LocalProjectServiceRuntime)
  return { ctx, runtime: ctx.projectServices, pool, dispose: async () => {
    await runtimeFiber.dispose()
    await subprocess.dispose()
    await facility.closeAll()
    await storage.dispose()
  } }
}
export async function git(ctx: Context, cwd: string, ...args: string[]) {
  const handle = ctx.subprocess.spawn({ argv: ['git', ...args], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000,
    env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' },
  })
  const result = await handle.done
  if (result.exitCode !== 0) throw new Error(handle.collected.stderr?.readFrom(0).text)
  return handle.collected.stdout?.readFrom(0).text ?? ''
}
