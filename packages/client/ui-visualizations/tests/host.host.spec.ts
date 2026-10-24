/** Host-resolved settings follow reversible index-injection ownership. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as Visualizations from '../src/index.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Config } from '../src/config.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

it('injects one resolved configuration and removes its callback on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const config = Config({ maxActiveFrames: 2 })
  const fork = ctx.plugin(Visualizations, config)
  await fork.await()
  try {
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    expect(table).toEqual([{ kind: 'global', name: '__DSH_VISUALIZATION_CONFIG__', value: config }])
    await fork.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after)
    expect(after).toEqual([])
  } finally { await fork.dispose() }
})
