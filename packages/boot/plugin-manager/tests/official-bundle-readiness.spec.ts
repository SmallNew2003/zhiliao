/** The snapshot runner must wait for its real management tool. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { exposeReadiness } from './fixtures/official-bundle-media.mjs'

it('publishes and withdraws runner readiness with the management tool', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const fiber = ctx.plugin({ name: 'fixture-readiness', apply: exposeReadiness })
  let starts = 0
  ctx.inject(['officialBundleMediaReady'], () => { starts++ })
  try {
    await fiber.await()
    expect(starts).toBe(0)
    expect(ctx.get('officialBundleMediaReady')).toBeUndefined()
    const remove = ctx.tools.register(defineTool({ name: 'plugin_manager', description: 'fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'ready' },
    }))
    await expect.poll(() => starts).toBe(1)
    expect(ctx.get('officialBundleMediaReady')).toBe(true)
    remove()
    await expect.poll(() => ctx.get('officialBundleMediaReady')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
