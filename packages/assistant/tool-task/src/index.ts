/**
 * Model-facing `create_task` tool over the Host `ctx.assistantTasks` service.
 * Mounting the plugin registers the tool in the mounting scope; the assistant
 * preset mounts it, and a step-time `when` condition keeps it invisible to
 * assistant-preset Sessions that are not registered assistants.
 * @module @deepseek-ai/dsh-tool-assistant-task
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssistantTaskError, type AssistantTaskErrorCode } from '@deepseek-ai/dsh-assistant-task'
import type {} from '@deepseek-ai/dsh-assistant-task'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Plugin name registered with the Loader. */
export const name = 'tool-assistant-task'

/** Host services this plugin consumes. The assistant service is resolved per scope. */
export const inject = ['tools', 'systemPrompt']

/** Tool-local error code for failures not safe to expose. */
type ToolErrorCode = AssistantTaskErrorCode | 'internal_error'

const ERROR_CODES = [
  'not_an_assistant',
  'workspace_not_registered',
  'workspace_scope_denied',
  'workspace_unavailable',
  'prompt_empty',
  'prompt_too_large',
  'title_too_long',
  'quota_exceeded',
  'worker_preset_unavailable',
  'session_create_failed',
  'prompt_rejected',
  'task_store_failed',
  'task_not_found',
  'assistant_session_unavailable',
  'internal_error',
] as const satisfies readonly ToolErrorCode[]

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', required: true },
        sessionId: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true, enum: ERROR_CODES },
        message: { type: 'string', required: true },
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
      },
    },
  ],
} as const

const DESCRIPTION =
  'Create one independent task for the user. The task runs in its own Session and can outlive this conversation. '
  + 'This conversation keeps only the task card and its status; do not claim the task finished until its status says so. '
  + 'Use it when the user asks you to do or track work beyond this turn. '
  + 'A project assistant creates the task in its own project; the global assistant may name a registered project by id. '
  + 'If a creation call fails after the task record exists, retry with the same requestId to reuse the task and its Session. '
  + 'Do not use this tool for reminders or recurring schedules.'

const AUTHORIZATION =
  'Create assistant tasks only at the user\'s explicit request. A task is an independent Session that runs with the '
  + 'normal tool approval and permission policy; this conversation does not own its history. '
  + 'Do not create a task merely because a plan mentions future work.'

/** Render the complete tool value as canonical JSON. */
function renderValue(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Pure generic pending card. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register `create_task` and its guidance in the scope that resolved the assistant service.
 * @param ctx - Scope whose `assistantTasks` service the tool acts through.
 */
function registerAssistantTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:create_task',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 100,
    text: ({ scope, toolSet }) => {
      if (ctx.tools.executable('create_task', scope, toolSet) === undefined) return ''
      const projects = ctx.get('workspaceRegistry')?.list()
        .map(workspace => `- ${workspace.id}: ${workspace.title} (${workspace.path})`)
        .join('\n') ?? ''
      return projects.length === 0
        ? AUTHORIZATION
        : `${AUTHORIZATION}\n\nRegistered projects:\n${projects}`
    },
  })

  ctx.tools.register(defineTool({
    name: 'create_task',
    description: DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete task instruction delivered as the first message of the task Session.',
      },
      title: {
        type: 'string',
        description: 'Short task title in the user\'s language: action plus object. Omit timing, status, and ids.',
      },
      workspaceId: {
        type: 'string',
        description: 'Registered project id for a global assistant. A project assistant omits it or names its own project.',
      },
      requestId: {
        type: 'string',
        description: 'Idempotency key. Reuse the same value when retrying a creation that failed after its task record existed.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) {
        const failure: { code: ToolErrorCode; message: string } = { code: 'internal_error', message: 'The task call has no caller Agent.' }
        return failure
      }
      try {
        return await ctx.assistantTasks.createTask({
          callerSessionId: agent.session.id,
          prompt: args.prompt,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.workspaceId === undefined ? {} : { workspaceId: brandString<WorkspaceId>(args.workspaceId) }),
          ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
          signal: exec.signal,
        })
      } catch (error: unknown) {
        if (error instanceof AssistantTaskError) {
          const failure: { code: ToolErrorCode; message: string; taskId?: string; sessionId?: string } = {
            code: error.code,
            message: error.message,
            ...(error.details?.taskId === undefined ? {} : { taskId: error.details.taskId }),
            ...(error.details?.sessionId === undefined ? {} : { sessionId: error.details.sessionId }),
          }
          return failure
        }
        const failure: { code: ToolErrorCode; message: string } = { code: 'internal_error', message: 'The assistant task operation failed.' }
        return failure
      }
    },
    presentCall: args => present('Create assistant task', args.title),
  }), { when: ({ agent }) => ctx.assistantTasks.isAssistant(agent.session.id) })
}

/**
 * Register the assistant task tool when the Host exposes the assistant service.
 * @param ctx - Context owning the tool and system-prompt registries.
 */
export function apply(ctx: Context): void {
  ctx.inject(['assistantTasks'], registerAssistantTool)
}
