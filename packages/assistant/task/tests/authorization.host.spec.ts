/** Assistant endpoints preserve Session and Workspace resource authorization. */
import { expect, it } from 'vitest'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessBinding, RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { harness, storedSession } from './harness.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Non-owner fixture caller with independently granted resources. */
    'assistant-test-peer': { readonly kind: 'assistant-test-peer' }
  }
}

it('filters inaccessible entities and refuses cancellation without every entity resource', async () => {
  const workspaceId = brandString<WorkspaceId>('private-project')
  const workspaces = new Map([[workspaceId, { id: workspaceId, path: '/private/project', title: 'Private project' }]])
  const { ctx, service, sessions } = await harness({ workspaces })
  try {
    await ctx.plugin(TypertGatewayService)
    ctx.typert.resources.register('session', { field: 'sessionId' })
    ctx.typert.resources.register('workspace', { field: 'workspaceId' })
    const assistant = await service.ensureAssistant({ kind: 'project', workspaceId })
    sessions.set(assistant.sessionId, storedSession(assistant.sessionId))
    const task = await service.createTask({ callerSessionId: assistant.sessionId, workspaceId, prompt: 'Private task' })
    const actions: RemoteAccessAction[] = ['assistantTasks/tasks', 'assistantTasks/assistants', 'assistantTasks/visibility', 'assistantTasks/cancelTask', 'assistantTasks/ensureAssistant']
    const bindings: RemoteAccessBinding[] = [{ role: { name: 'endpoint', resource: 'global', actions }, resource: { kind: 'global' } }]
    ctx.remoteAccess.registerPolicy('assistant-test-peer', { bindings: () => bindings })
    const peer = new Peer(ctx, { principal: { kind: 'assistant-test-peer' } })
    const call = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ peer, namespace: 'assistantTasks', method, args })
    await expect(call('tasks', { request: {} })).resolves.toEqual([])
    await expect(call('assistants', { request: {} })).resolves.toEqual([])
    await expect(call('visibility')).resolves.toEqual({ sessionIds: [], conversations: [], executions: [] })
    await expect(call('cancelTask', { request: { id: task.taskId } })).rejects.toMatchObject({ code: 'remote-access/denied' })
    bindings.push({ role: { name: 'session', resource: 'session', actions }, resource: { kind: 'session', id: task.sessionId } })
    await expect(call('tasks', { request: {} })).resolves.toEqual([])
    await expect(call('cancelTask', { request: { id: task.taskId } })).rejects.toMatchObject({ code: 'remote-access/denied' })
    bindings.push({ role: { name: 'workspace', resource: 'workspace', actions }, resource: { kind: 'workspace', id: workspaceId } })
    await expect(call('tasks', { request: {} })).resolves.toEqual([expect.objectContaining({ id: task.taskId })])
    await expect(call('assistants', { request: {} })).resolves.toEqual([])
    await expect(call('visibility')).resolves.toEqual({ sessionIds: [task.sessionId], conversations: [], executions: [expect.objectContaining({ taskId: task.taskId })] })
    await expect(call('ensureAssistant', { request: { kind: 'project', workspaceId } })).rejects.toMatchObject({ code: 'remote-access/denied' })
    bindings.push({ role: { name: 'assistant-session', resource: 'session', actions }, resource: { kind: 'session', id: assistant.sessionId } })
    await expect(call('ensureAssistant', { request: { kind: 'project', workspaceId } })).resolves.toMatchObject({ sessionId: assistant.sessionId })
    await expect(call('assistants', { request: {} })).resolves.toEqual([expect.objectContaining({ id: assistant.id })])
    await expect(call('cancelTask', { request: { id: task.taskId } })).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    await ctx.fiber.dispose()
  }
})
