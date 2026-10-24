/** Bundled skill templates and short scoped guidance share the runtime manifest. */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { runtimeManifest } from './runtime-manifest.ts'

const skillNames = ['visualize-html', 'visualize-charts', 'visualize-diagrams'] as const
const guidance = `Use an inline visualization when interaction, a chart or a diagram helps explain the answer. Load the matching skill first: visualize-html for interactive panels, visualize-charts for data charts, or visualize-diagrams for Mermaid diagrams. Use only top-level assistant fences marked html preview runtime=${runtimeManifest.id} (add libs=echarts for charts) or mermaid preview runtime=${runtimeManifest.id}; explicitly close each fence. Ordinary code stays source. Include data inline and use the packaged libraries. Inputs are transient; previews cannot access files, the Host or the network. Offer a file artifact when the user needs durable data or an unsupported export.`

/**
 * Validate packaged routing metadata and resolve authoring identifiers.
 * @param raw - Complete packaged Markdown template.
 * @param path - Instruction path used in malformed-metadata diagnostics.
 * @returns Routing description and full body with manifest substitutions.
 */
export function parseTemplate(raw: string, path: string): { description: string; content: string } {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (header?.[1] === undefined) throw new Error(`ui-visualizations: ${path} requires YAML frontmatter`)
  const metadata: unknown = parseYaml(header[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`ui-visualizations: ${path} requires a non-empty description`)
  }
  let content = raw.slice(header[0].length).trim().replaceAll('{{runtime}}', runtimeManifest.id)
  for (const [library, version] of Object.entries(runtimeManifest.libraries)) {
    content = content.replaceAll(`{{${library}}}`, version)
  }
  return { description, content }
}

/**
 * Register packaged skills and guide only agents with a visible skill loader.
 * Missing or invalid packaged instructions throw before either registration.
 * @param ctx - Host context injecting prompt, tools and skills services.
 */
export function registerAuthoring(ctx: Context): void {
  const candidates: SkillCandidate[] = skillNames.map((name) => {
    const directory = fileURLToPath(new URL(`../assets/${name}/`, import.meta.url))
    const path = fileURLToPath(new URL(`../assets/${name}/SKILL.md`, import.meta.url))
    const { description } = parseTemplate(readFileSync(path, 'utf8'), path)
    return { name, description, invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled', provider: 'dsh-visualizations', rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory }, locator: path }
  })
  const provider: SkillProvider = {
    name: 'dsh-visualizations',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const path = locator as string
      const raw = await readFile(path, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: parseTemplate(raw, path).content }
    },
  }
  ctx.skills.registerProvider(() => provider)
  ctx.systemPrompt.section({
    name: 'ui:visualizations',
    order: ctx.systemPrompt.getSectionOrder('UI_VISUALIZATIONS'),
    text: ({ scope }) => ctx.tools.get('skill', scope) === undefined ? '' : guidance,
  })
}
