/** Bundled authoring instructions use the executing runtime and scoped loader. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import WebServer, { type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Visualizations from '../src/index.ts'
import { runtimeManifest } from '../src/runtime-manifest.ts'
import { parseTemplate } from '../src/authoring.ts'

const names = ['visualize-charts', 'visualize-diagrams', 'visualize-html']

async function host(omit?: string): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  if (omit !== 'systemPrompt') await ctx.plugin(SystemPrompt)
  if (omit !== 'skills') await ctx.plugin(SkillRegistry)
  if (omit !== 'tools') await ctx.plugin(ToolRuntime)
  if (omit !== 'webServer') await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx
}

describe('visualization authoring', () => {
  it('discovers bundled summaries and loads complete manifest-derived instructions', async () => {
    const ctx = await host()
    await ctx.plugin(Visualizations)
    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual(names)
    for (const skill of catalog) {
      expect(skill).toMatchObject({ provider: 'dsh-visualizations', source: 'bundled',
        invocation: { modelInvocable: true, userInvocable: true } })
      expect(skill.description.length).toBeLessThan(500)
      const loaded = await ctx.skills.get(skill.name)
      const raw = await readFile(new URL(`../assets/${skill.name}/SKILL.md`, import.meta.url), 'utf8')
      const body = raw.slice(raw.indexOf('\n---\n') + 5).trim()
      let expected = body.replaceAll('{{runtime}}', runtimeManifest.id)
      for (const [library, version] of Object.entries(runtimeManifest.libraries)) {
        expected = expected.replaceAll(`{{${library}}}`, version)
      }
      expect(loaded?.content).toBe(expected)
      expect(loaded?.content).toContain(runtimeManifest.id)
      expect(loaded?.content).not.toMatch(/\{\{/u)
    }
    expect((await ctx.skills.get('visualize-html'))?.content).toContain(`Bootstrap ${runtimeManifest.libraries.bootstrap}`)
    expect((await ctx.skills.get('visualize-charts'))?.content).toContain(`ECharts ${runtimeManifest.libraries.echarts}`)
    expect((await ctx.skills.get('visualize-diagrams'))?.content).toContain(`Mermaid ${runtimeManifest.libraries.mermaid}`)
  })

  it('contributes short guidance only to scopes with a visible skill loader', async () => {
    const ctx = await host()
    await ctx.plugin(Visualizations)
    const key = {}
    let dispose!: () => Promise<void>
    await ctx.plugin({ inject: ['tools'], apply(owner: Context) {
      const scope = createScope(owner, key)
      dispose = () => scope.dispose()
      scope.ctx.tools.register({ name: 'skill', description: 'Load instructions', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: () => Promise.resolve('instructions') })
    } })
    const guidance = (await ctx.systemPrompt.assemble({ scope: key })).sections.find(section => section.name === 'ui:visualizations')?.text
    expect(guidance).toContain('visualize-html')
    expect(guidance).toContain('visualize-charts')
    expect(guidance).toContain('visualize-diagrams')
    expect(guidance).toContain('html preview runtime=dsh-v1')
    expect(guidance).toContain('mermaid preview runtime=dsh-v1')
    expect(guidance).toContain('libs=echarts')
    expect(guidance?.split(/\s+/u).length).toBeLessThan(150)
    expect(guidance).not.toContain('dsh.chart(')
    expect(guidance).not.toContain('```')
    expect(guidance).toBe('Use an inline visualization when interaction, a chart or a diagram helps explain the answer. Load the matching skill first: visualize-html for interactive panels, visualize-charts for data charts, or visualize-diagrams for Mermaid diagrams. Use only top-level assistant fences marked html preview runtime=dsh-v1 (add libs=echarts for charts) or mermaid preview runtime=dsh-v1; explicitly close each fence. Ordinary code stays source. Include data inline and use the packaged libraries. Inputs are transient; previews cannot access files, the Host or the network. Offer a file artifact when the user needs durable data or an unsupported export.')
    for (const scope of [undefined, {}]) {
      expect((await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })).sections.find(section => section.name === 'ui:visualizations')?.text).toBe('')
    }
    await dispose()
    expect((await ctx.systemPrompt.assemble({ scope: key })).sections.find(section => section.name === 'ui:visualizations')?.text).toBe('')
  })

  it('retracts prompt guidance and skill candidates with the feature fiber', async () => {
    const ctx = await host()
    const fiber = await ctx.plugin(Visualizations)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'ui:visualizations')).toBe(true)
    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('visualize-html')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'ui:visualizations')).toBe(false)
  })

  it.each(['webServer', 'systemPrompt', 'skills', 'tools'])('requires %s before advertising the feature', async (missing) => {
    const ctx = await host(missing)
    await ctx.plugin(Visualizations)
    const injections: IndexInjection[] = []
    ctx.emit('webserver/index-inject', injections)
    expect(injections).toEqual([])
    expect(await ctx.get('skills')?.list() ?? []).toEqual([])
    expect((await ctx.get('systemPrompt')?.assemble())?.sections.some(section => section.name === 'ui:visualizations') ?? false).toBe(false)
  })

  it('leaves compositions without the feature free of its instructions', async () => {
    const ctx = await host()
    expect(await ctx.skills.list()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'ui:visualizations')).toBe(false)
  })

  it('rejects missing frontmatter and invalid packaged descriptions', () => {
    expect(() => parseTemplate('# Instructions', 'SKILL.md')).toThrow('requires YAML frontmatter')
    for (const metadata of ['null', 'scalar', 'name: visualize-html', 'description: 3', 'description: " "']) {
      expect(() => parseTemplate(`---\n${metadata}\n---\n# Instructions`, 'SKILL.md')).toThrow('requires a non-empty description')
    }
  })
})
