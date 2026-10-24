import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectServiceProvider, ServiceItem, ServiceRequestId, ServiceTargetId, ServiceProviderId, ServiceRevision } from '@deepseek-ai/dsh-project-services'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessFor, git, harness, signal } from './helpers.ts'
import type { Config as RuntimeConfig } from '../src/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(config?: Partial<RuntimeConfig>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-projects-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const h = await harness(undefined, config)
  cleanup.push(() => h.dispose())
  return { ...h, root }
}
async function repository(root: string, ctx: Parameters<typeof git>[0], name: string) {
  const main = join(root, name)
  await mkdir(main)
  await git(ctx, main, 'init')
  await git(ctx, main, 'commit', '--allow-empty', '-m', 'initial')
  return main
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

it('拒绝把文件当作项目工作目录', async () => {
  const { root, runtime } = await fixture()
  const file = join(root, 'not-a-directory')
  await writeFile(file, 'placeholder')
  await expect(runtime.list(accessFor(file), {}, signal())).rejects.toThrow('Project cwd is not a directory')
})

it('在 git 探测返回其他错误时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture()
  const repo = await repository(root, ctx, 'corrupt')
  await rm(join(repo, '.git'), { recursive: true, force: true })
  await writeFile(join(repo, '.git'), 'not-a-gitfile')
  await expect(runtime.list(accessFor(repo), {}, signal())).rejects.toThrow('Git project inspection failed')
})

it('在 git 工作树清单失败时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main')
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const refused = (reason: string) => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: reason, nextOffset: reason.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 128, signal: null }), terminate: () => {}, waitForExit: async () => true,
  })
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec =>
    spec.argv.includes('worktree') ? refused('worktree listing refused') : spawn(spec))
  cleanup.push(async () => { spy.mockRestore() })
  await expect(runtime.list(accessFor(main), {}, signal())).rejects.toThrow('Git worktree inspection failed')
})

it('在 git 公共目录查询失败时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main')
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec =>
    spec.argv.includes('--git-common-dir') ? {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'common directory refused', nextOffset: 30, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 128, signal: null }), terminate: () => {}, waitForExit: async () => true,
    } : spawn(spec))
  cleanup.push(async () => { spy.mockRestore() })
  await expect(runtime.list(accessFor(main), {}, signal())).rejects.toThrow('Git common directory inspection failed')
})

it('在项目检查子进程中清除环境里的 Git 变量', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main')
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const environments: Record<string, string | undefined>[] = []
  const spy = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    if (spec.argv.includes('rev-parse') && spec.env !== undefined) environments.push(spec.env)
    return spawn(spec)
  })
  cleanup.push(async () => { spy.mockRestore() })
  process.env.GIT_TEST_AMBIENT = 'ambient'
  try {
    await runtime.list(accessFor(main), {}, signal())
  } finally { delete process.env.GIT_TEST_AMBIENT }
  expect(environments.length).toBeGreaterThan(0)
  expect(environments.every(env => env.GIT_TEST_AMBIENT === undefined)).toBe(true)
  expect(environments[0]).toMatchObject({ LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' })
})

it('在 git 输出超过字节上限时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture({ scanMaxBytes: 8 })
  const main = await repository(root, ctx, 'main')
  await expect(runtime.list(accessFor(main), {}, signal())).rejects.toThrow('Git inspection exceeded its output limit')
})

it('跳过已删除但仍留在清单中的工作树', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), linked = join(root, 'linked')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  await rm(linked, { recursive: true, force: true })
  const inventory = await runtime.list(accessFor(main), {}, signal())
  expect(inventory.checkouts.map(item => item.path)).toEqual([main])
})

it('在工作树路径无法解析时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), linked = join(root, 'linked')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  await rm(linked, { recursive: true, force: true })
  await symlink(linked, linked)
  await expect(runtime.list(accessFor(main), {}, signal())).rejects.toThrow(/ELOOP|too many levels/)
})

it('跳过清单中已变成文件的工作树路径', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), linked = join(root, 'linked')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  await rm(linked, { recursive: true, force: true })
  await writeFile(linked, 'not a directory')
  const inventory = await runtime.list(accessFor(main), {}, signal())
  expect(inventory.checkouts.map(item => item.path)).toEqual([main])
})

it('跳过清单中 git 探测失败的工作树', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), linked = join(root, 'linked')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  await writeFile(join(linked, '.git'), 'not-a-gitfile')
  const inventory = await runtime.list(accessFor(main), {}, signal())
  expect(inventory.checkouts.map(item => item.path)).toEqual([main])
})

it('跳过属于其他仓库的工作树条目', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), other = await repository(root, ctx, 'other'), otherLinked = join(root, 'other-linked')
  await git(ctx, other, 'worktree', 'add', '-b', 'other-linked', otherLinked)
  await mkdir(join(main, '.git', 'worktrees', 'foreign'), { recursive: true })
  await writeFile(join(main, '.git', 'worktrees', 'foreign', 'gitdir'), `${otherLinked}/.git\n`)
  const inventory = await runtime.list(accessFor(main), {}, signal())
  expect(inventory.checkouts.map(item => item.path)).toEqual([main])
})

it('跳过顶层目录与清单路径不一致的工作树条目', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), plain = join(main, 'plain')
  await mkdir(plain)
  await mkdir(join(main, '.git', 'worktrees', 'plain'), { recursive: true })
  await writeFile(join(main, '.git', 'worktrees', 'plain', 'gitdir'), `${plain}/.git\n`)
  const inventory = await runtime.list(accessFor(main), {}, signal())
  expect(inventory.checkouts.map(item => item.path)).toEqual([main])
})

it('在当前检出不在工作树清单中时向上报告失败', async () => {
  const { root, ctx, runtime } = await fixture()
  const main = await repository(root, ctx, 'main'), linked = join(root, 'linked')
  await git(ctx, main, 'worktree', 'add', '-b', 'linked', linked)
  await writeFile(join(main, '.git', 'worktrees', 'linked', 'gitdir'), `${join(root, 'absent')}/.git\n`)
  await expect(runtime.list(accessFor(linked), {}, signal())).rejects.toThrow('absent from Git worktree inventory')
})
