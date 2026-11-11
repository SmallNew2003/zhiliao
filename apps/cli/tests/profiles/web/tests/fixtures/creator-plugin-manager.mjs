/** Test-only IPC assertions over real Creator presets and profile management. */
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { LlmAttemptId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

export const inject = ['agents', 'agentPresets', 'tools', 'pluginManager', 'permissionPresets', 'mcpDiscovery', 'systemPrompt']

export function apply(ctx, config) {
  const receive = message => {
    if (message !== 'initial' && message !== 'restart') return
    void inspect(message).then(result => process.send({ result }), error => process.send({ error: String(error.stack ?? error) }))
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  async function inspect(phase) {
    const handles = []
    let activeSession
    let answer = 'rejected'
    const approvals = []
    const disposeApproval = ctx.on('approval/request', (request, next) => {
      if (request.toolName !== 'plugin_manager') return next()
      approvals.push(answer)
      return Promise.resolve(answer)
    }, { prepend: true })
    const make = async id => {
      const handle = await ctx.agents.create({ sessionId: id, cwd: process.cwd(),
        setup: scope => ctx.agentPresets.mount(scope, 'cordis').then(() => undefined) })
      handles.push(handle)
      return handle.agent
    }
    const names = agent => ctx.tools.schemas(agent).map(tool => tool.name)
    try {
      const first = await make(`${phase}-first`)
      const before = names(first)
      const manage = args => executeModelToolFixture(ctx, { name: 'plugin_manager', arguments: args, agent: first,
        callId: `${phase}-manage`, signal: new AbortController().signal })
      ctx.permissionPresets.set(first.session, 'workspace-write')
      first.session.append('turn/start', { turn: 1 })
      activeSession = first.session
      const denied = await manage({ action: 'install_bundle', target: config.bundle })
      const afterDenied = names(first)
      const bundlesAfterDenied = await ctx.pluginManager.listBundles()
      answer = 'allowed-once'
      const result = phase === 'initial'
        ? JSON.parse((await manage({ action: 'install_bundle', target: config.bundle })).value)
        : await ctx.pluginManager.listBundles()
      const second = await make(`${phase}-second`)
      const after = names(first)
      const other = names(second)
      const selection = ctx.mcpDiscovery.load(first, ['mcp__demo__ping'])
      if (!selection.ok) throw new Error('MCP fixture selection failed')
      const signal = new AbortController().signal
      const modelSelection = { provider: 'fixture', model: 'fixture' }
      const toolSet = await ctx.tools.resolve({ agent: first, modelSelection, signal })
      first.session.append('step/start', { turn: 1, step: 1 })
      let ping
      try {
        const assembly = await ctx.systemPrompt.assemble({ scope: first, agent: first, modelSelection, toolSet,
          stepInput: { turn: 1, step: 1, messages: [] } })
        first.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(renderPrompt(assembly)) }, { surfaceOp: 'append' })
        first.session.append('request/header', { header: { config: modelSelection, tools: assembly.tools }, reason: 'initial' })
        ctx.emit(scopeTarget(first, first), 'agent/assistant-stream', { agent: first, frame: {
          type: 'start', attemptId: LlmAttemptId(`${phase}-attempt`), revision: 1, turn: 1, step: 1,
        } })
        ping = await executeModelToolFixture(ctx, { name: 'mcp__demo__ping', arguments: {}, agent: first,
          callId: `${phase}-ping`, signal, toolSet })
      } finally { toolSet.dispose() }
      const removed = phase === 'restart'
        ? JSON.parse((await manage({ action: 'remove_bundle', target: '@test/creator-mcp' })).value) : undefined
      return { approvals, permission: ctx.permissionPresets.current(first.session), before, denied, afterDenied, bundlesAfterDenied, result, after, other, ping, removed, remaining: names(first) }
    } finally {
      disposeApproval()
      activeSession?.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await Promise.all(handles.map(handle => handle.dispose()))
    }
  }
}
