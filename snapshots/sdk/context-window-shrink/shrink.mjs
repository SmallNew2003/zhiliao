/** Lower a durable SDK selection below its reserved output allowance. */
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const name = 'context-window-shrink-fixture'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario runtime. */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const selection = { current: undefined, assembled: undefined }
    installModelSelection(agent.ctx, selection)
    let assemblyCount = 0
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      selection.current = {
        provider: agent.options.provider,
        model: agent.options.model,
        contextWindow: assemblyCount++ === 0 ? 640000 : 8192,
      }
      agent.session.append('model/selection', selection.current)
      return next()
    }, { prepend: true })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 8192 }))
  })
}
