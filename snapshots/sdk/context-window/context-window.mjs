/** Durable selection with an explicit context budget for both SDK projections. */
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const name = 'context-window-fixture'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario runtime. */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const selected = {
      provider: agent.options.provider,
      model: agent.options.model,
      contextWindow: 640000,
    }
    installModelSelection(agent.ctx, { current: selected, assembled: undefined })
    let recorded = false
    // SDK run results begin at the inbox receipt, after agent creation.
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      if (!recorded) {
        agent.session.append('model/selection', selected)
        recorded = true
      }
      return next()
    }, { prepend: true })
  })
}
