/** Host-resolved settings follow reversible index-injection ownership. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { Config } from '../src/config.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

it('injects one resolved configuration and removes its callback on disposal', async () => {
  const ctx = new Context()
  const config = Config({ maxActiveFrames: 2 })
  const fork = ctx.plugin({ apply: (owner: Context) => { apply(owner, config) } })
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
