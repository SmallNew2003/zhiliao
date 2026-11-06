/** Preview uses the selected executor without reopening step admission. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('previews native schemas and scoped executor sections without evaluating conditions', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const key = {}
  let scope!: Scope
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) { scope = createScope(inner, key) } })
  let evaluated = 0
  const definition = defineTool({
    name: 'read', description: 'Read data', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'data' },
  })
  ctx.tools.register(definition, { when: () => { evaluated++; return true } })
  expect(ctx.tools.preview([definition]).schemas.map(schema => schema.name)).toEqual(['read'])
  scope.ctx.tools.setExecutor({
    sections: [{ name: 'custom:sdk', order: 1, text: tools => tools.map(tool => tool.name).join(',') }],
    describe: () => ({ schemas: [] }),
    async execute() { return { results: [], additionalContexts: [], concluded: false } },
  })
  expect(ctx.tools.preview([definition], key)).toMatchObject({ schemas: [], sections: [{ name: 'custom:sdk', text: 'read' }] })
  expect(ctx.tools.preview([definition]).sections).toEqual([])
  expect(evaluated).toBe(0)
})

it('previews the PTC transport and generated SDK through the selected executor', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' } as never)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  const definition = defineTool({
    name: 'read', description: 'Read data', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'data' },
  })
  const preview = ctx.tools.preview([definition])
  expect(preview.schemas.map(schema => schema.name)).toEqual(['run_code'])
  expect(preview.sections.find(section => section.name === 'tools:sdk')?.text).toContain('read')
})
