/** Shipped Web authoring row activates through Loader and respects preset loaders. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import WebServer, { type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as Visualizations from '../../../client/ui-visualizations/src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

it('loads the shipped Web visualization row and uses agent-scoped skill availability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-visualizations-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const patches = loadOverlayPatches('web-visualizations-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const rows = patches.flatMap(patch => patch.insert ?? []).filter(row => row.id === 'ui-visualizations')
  expect(rows).toMatchObject([{ id: 'ui-visualizations', name: '@deepseek-ai/dsh-client-ui-visualizations' }])
  expect(patches.find(patch => patch.id === 'tool-skill')).toMatchObject({ disabled: true })
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
  expect(manifest.dependencies['@deepseek-ai/dsh-client-ui-visualizations']).toBe('workspace:^')
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-skill' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-agent' },
    ...rows,
  ]))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-skill', SkillRegistry], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-client-ui-visualizations', Visualizations],
  ])
  // Loader's import adapter selects source-plane Service classes in Vitest.
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'ui-visualizations')!
  await entry.fiber!.await()
  expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['visualize-charts', 'visualize-diagrams', 'visualize-html'])
  const injections: IndexInjection[] = []
  ctx.emit('webserver/index-inject', injections)
  expect(injections).toEqual([{ kind: 'global', name: '__DSH_VISUALIZATION_CONFIG__', value: Visualizations.Config({}) }])
  const key = {}
  let skillFiber!: ReturnType<Context['plugin']>
  await ctx.plugin({ inject: ['agents', 'tools', 'skills'], apply(owner: Context) {
    const scope = createScope(owner, key)
    skillFiber = scope.ctx.plugin(ToolSkill)
  } })
  await skillFiber.await()
  expect(ctx.tools.get('skill')).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: key })).sections.find(section => section.name === 'ui:visualizations')?.text).toContain('visualize-charts')
  expect((await ctx.systemPrompt.assemble({ scope: {} })).sections.find(section => section.name === 'ui:visualizations')?.text).toBe('')
  await skillFiber.dispose()
  expect((await ctx.systemPrompt.assemble({ scope: key })).sections.find(section => section.name === 'ui:visualizations')?.text).toBe('')
  await entry.fiber!.dispose()
  expect(await ctx.skills.list()).toEqual([])
  expect((await ctx.systemPrompt.assemble({ scope: key })).sections.some(section => section.name === 'ui:visualizations')).toBe(false)
})

it('keeps visualization mounting out of base and non-Web bundles', async () => {
  for (const bundle of ['base', 'headless', 'sdk-app', 'sdk-minimal', 'acp-app']) {
    const source = await readFile(new URL(`../../${bundle}/cordis.patch.yml`, import.meta.url), 'utf8')
    expect(source).not.toContain('@deepseek-ai/dsh-client-ui-visualizations')
  }
})
