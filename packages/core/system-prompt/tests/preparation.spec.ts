import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  return ctx
}

it('awaits scoped preparation before reading providers and preserves waterfall edits', async () => {
  const ctx = await setup()
  const key = { name: 'prepared' }
  const scope = createScope(ctx, key)
  let prepared = false
  const signal = new AbortController().signal
  const dispose = scope.ctx.on('system-prompt/prepare', async (context) => {
    expect(context.signal).toBe(signal)
    await Promise.resolve()
    prepared = true
  })
  ctx.systemPrompt.tools(() => ({ schemas: prepared ? [
    { name: 'zulu', description: 'zulu', parameters: {} },
    { name: 'beta', description: 'beta', parameters: {} },
  ] : [] }))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, tools: [...assembly.tools, { name: 'alpha', description: 'alpha', parameters: {} }] }
  })
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['alpha'])
  expect((await ctx.systemPrompt.assemble({ scope: key, signal })).tools.map(tool => tool.name))
    .toEqual(['beta', 'zulu', 'alpha'])
  dispose()
  prepared = false
  expect((await ctx.systemPrompt.assemble({ scope: key, signal })).tools.map(tool => tool.name)).toEqual(['alpha'])
})

it('rejects failed preparation without evaluating providers', async () => {
  const ctx = await setup()
  let reads = 0
  ctx.systemPrompt.tools(() => { reads++; return { schemas: [] } })
  ctx.on('system-prompt/prepare', () => { throw new Error('Preparation failed') })
  await expect(ctx.systemPrompt.assemble()).rejects.toThrow('Preparation failed')
  expect(reads).toBe(0)
})

it('stops before reading providers when preparation cancels the assembly', async () => {
  const ctx = await setup()
  const abort = new AbortController()
  let reads = 0
  ctx.systemPrompt.tools(() => { reads++; return { schemas: [] } })
  ctx.on('system-prompt/prepare', () => { abort.abort(new Error('Canceled preparation')) })
  await expect(ctx.systemPrompt.assemble({ signal: abort.signal })).rejects.toThrow('Canceled preparation')
  expect(reads).toBe(0)
})
