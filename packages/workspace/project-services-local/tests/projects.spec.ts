import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, ServiceItem, ServiceRequestId, ServiceTargetId, ServiceProviderId, ServiceRevision } from '@deepseek-ai/dsh-project-services'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessFor, git, harness, signal } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-projects-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness()
  cleanup.push(() => h.dispose())
  return { ...h, root }
}
it('groups an external worktree with its common repository but excludes an independent clone', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = join(root, 'main'), linked = join(root, 'outside'), clone = join(root, 'clone')
  await mkdir(main)
  await git(ctx, main, 'init')
  await git(ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  await git(ctx, main, 'worktree', 'add', '-b', 'other', linked)
  await git(ctx, root, 'clone', '--local', main, clone)
  const inventory = await runtime.list(accessFor(linked), {}, signal())
  expect(inventory.checkouts.map(item => item.path).sort()).toEqual([main, linked].sort())
  expect((await runtime.list(accessFor(clone), {}, signal())).project.id).not.toBe(inventory.project.id)
})
it('keeps nested repositories independent and canonicalizes symlink directories', async () => {
  const { root, ctx, runtime } = await fixture()
  const nested = join(root, 'nested'), alias = join(root, 'alias')
  await git(ctx, root, 'init')
  await mkdir(nested)
  await git(ctx, nested, 'init')
  await symlink(nested, alias, 'junction')
  const parent = await runtime.list(accessFor(root), {}, signal())
  const child = await runtime.list(accessFor(alias), {}, signal())
  expect(child.project.id).not.toBe(parent.project.id)
  expect(child.checkouts.map(item => item.path)).toEqual([nested])
})
it('uses canonical non-Git directories and rejects missing paths', async () => {
  const { root, runtime } = await fixture()
  const inventory = await runtime.list(accessFor(root), {}, signal())
  expect(inventory.project.path).toBe(root)
  expect(inventory.project.gitCommonDir).toBeUndefined()
  await expect(runtime.list(accessFor(join(root, 'absent')), {}, signal())).rejects.toThrow()
})
// Windows filenames cannot contain newlines or end with spaces.
it.skipIf(process.platform === 'win32')('preserves whitespace in repository paths', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = join(root, 'main \n'), linked = join(root, 'linked \n')
  await mkdir(main)
  await git(ctx, main, 'init')
  await git(ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  await git(ctx, main, 'worktree', 'add', '-b', 'other', linked)
  expect((await runtime.list(accessFor(linked), {}, signal())).checkouts.map(item => item.path).sort()).toEqual([main, linked].sort())
})

it('keeps a managed target readable and stoppable after its linked checkout disappears', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = join(root, 'main'), linked = join(root, 'linked')
  await mkdir(main)
  await git(ctx, main, 'init')
  await git(ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  const baseline = await runtime.list(accessFor(linked), {}, signal())
  const checkout = baseline.checkouts.find(item => item.path === linked)!
  let stopped = false
  const providerId = brandString<ServiceProviderId>('native')
  const target: ServiceItem = { id: brandString<ServiceTargetId>('native:owned'), projectId: baseline.project.id, checkoutId: checkout.id, providerId, revision: brandString<ServiceRevision>('1'), name: 'owned', kind: 'native', state: 'running', ownership: 'managed', actions: ['stop', 'restart'] }
  const provider: ProjectServiceProvider = {
    id: providerId, kind: 'native',
    inspect: async () => ({ items: [target], groups: [], capturedCheckouts: [checkout], status: { id: providerId, kind: 'native', state: 'ready', observedAt: Date.now() } }),
    prepare: async (context, request) => ({
      description: {
        action: request.action, project: context.project, checkout: context.checkouts.find(item => item.id === checkout.id)!,
        targets: [{ id: target.id, revision: target.revision }],
      },
      validate: async () => {},
      execute: async () => { stopped = true; return { outcomes: [{ targetId: target.id, state: 'succeeded' }] } },
    }),
    logs: async () => ({ chunks: [{ targetId: target.id, stream: 'stdout', text: 'owned output' }], gap: false, truncated: false }),
  }
  const fiber = await ctx.plugin({ name: 'captured-provider', inject: ['projectServices'], apply(ctx) { ctx.effect(() => ctx.projectServices.registerProvider(provider)) } })
  cleanup.push(() => fiber.dispose())
  await rm(linked, { recursive: true })
  const access = accessFor(main)
  const inventory = await runtime.list(access, {}, signal())
  expect(inventory.items.map(item => item.id)).toEqual([target.id])
  expect(inventory.checkouts.find(item => item.id === checkout.id)?.availability).toBe('missing')
  expect(inventory.items[0]?.actions).toEqual(['stop'])
  expect((await runtime.logs(access, { targetId: target.id }, signal())).chunks[0]?.text).toBe('owned output')
  for (const action of ['start', 'restart'] as const) {
    await expect(runtime.control(access, {
      requestId: brandString<ServiceRequestId>(action), action, targetId: target.id, expectedRevision: target.revision,
    }, signal())).rejects.toThrow(/missing|checkout/)
  }
  await runtime.control(access, { requestId: brandString<ServiceRequestId>('stop'), action: 'stop', targetId: target.id, expectedRevision: target.revision }, signal())
  expect(stopped).toBe(true)
})
