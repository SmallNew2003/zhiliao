/** Host-owned configuration injection for inline assistant previews. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/** Required Host page-injection service. */
export const inject = ['webserver']

/**
 * Publish resolved limits in each browser index.
 * @param ctx - Host serving the Client application.
 * @param config - Validated deployment limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_VISUALIZATION_CONFIG__', value: config })
  })
}
