import { afterEach, expect, it } from 'vitest'
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
