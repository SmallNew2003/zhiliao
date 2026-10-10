/** Host-owned configuration injection for inline assistant previews. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { registerAuthoring } from './authoring.ts'

export { Config } from './config.ts'

/** Required page injection, prompt, skill catalog and scoped tool services. */
export const inject = ['webServer', 'systemPrompt', 'skills', 'tools']

/**
 * Publish resolved limits and reversible, scoped authoring instructions.
 * @param ctx - Host serving the Client application.
 * @param config - Validated deployment limits; omission resolves defaults before registration.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  registerAuthoring(ctx)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_VISUALIZATION_CONFIG__', value: config })
  })
}
