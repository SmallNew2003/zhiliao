/** Recorded model selection, identity bindings and cleanup for the assistant follow-through scenario. */
import { isDeepStrictEqual } from 'node:util'
import { deriveReplayScript, parseSessionLog, type ReplayEntry, type ReplayProviderConfig } from '@deepseek-ai/dsh-llm-replay'
import { AssistantStreamAccumulator, expandAssistantStream, type AssistantStreamRecord, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-assistant-task'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

function roleModelMetadata(source: string) {
  const events = parseSessionLog(source)
  const headers = events.flatMap((event) => {
    if (event.type !== 'request/header') return []
    const { config, adapterDefaults } = event.data.header
    return [{ config, adapterDefaults }]
  })
  const contexts = events.flatMap(event => event.type === 'request/context' ? [event.data] : [])
  const header = headers[0], context = contexts[0]
  if (header === undefined || context === undefined || context.provider !== header.config.provider || context.model !== header.config.model
    || !headers.every(value => isDeepStrictEqual(value, header)) || !contexts.every(value => isDeepStrictEqual(value, context))) {
    throw new Error('assistant fixture: each role requires one consistent set of request model metadata')
  }
  return { ...header, context }
}

/**
 * Reconstruct the shared selection and replay adapter used by the assistant and its worker.
 * @param parent - Recorded assistant Session JSONL.
 * @param worker - Recorded worker Session JSONL.
 * @returns The initial selection and the provider metadata that supplies its recorded defaults.
 * @throws if the roles disagree or the selection cannot reproduce their recorded request controls.
 */
export function assistantReplayModel(parent: string, worker: string): { selection: ModelSelection; providers: ReplayProviderConfig[] } {
  const primary = roleModelMetadata(parent)
  if (!isDeepStrictEqual(primary, roleModelMetadata(worker))) throw new Error('assistant fixture: the roles have different request model metadata')
  const { config, adapterDefaults, context } = primary
  const { provider, model, reasoningEffort, maxTokens } = config
  if (config.temperature !== undefined || config.stop !== undefined
    || (maxTokens !== undefined) !== (adapterDefaults?.maxTokens === true)
    || (adapterDefaults?.reasoningEffort === true && reasoningEffort === undefined)) {
    throw new Error('assistant fixture: request model metadata cannot be expressed by the default selection and replay provider')
  }
  return {
    selection: { provider, model,
      ...reasoningEffort === undefined || adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort },
      ...config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow },
    },
    providers: [{ id: provider, models: [{
      id: model,
      ...context.contextWindow === undefined ? {} : { contextWindow: context.contextWindow },
      ...context.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: context.systemPromptUpdate },
      ...maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens },
      ...reasoningEffort === undefined ? {} : { reasoningEfforts: [reasoningEffort] },
      ...adapterDefaults?.reasoningEffort === true && reasoningEffort !== undefined ? { defaultReasoningEffort: reasoningEffort } : {},
    }] }],
  }
}

interface ToolIdentity {
  readonly field: 'workspaceId' | 'id'
  readonly from: string
  readonly to: string
}

type IdentityBinding = (tool: string, args: string) => ToolIdentity | undefined

function argumentIdentity(tool: string, args: string): ToolIdentity | undefined {
  const field = tool === 'create_task' ? 'workspaceId' : tool === 'get_task' ? 'id' : undefined
  if (field === undefined) return undefined
  const parsed = JSON.parse(args) as Record<string, unknown>
  const from = parsed[field]
  if (typeof from !== 'string' || from === '') throw new Error(`recorded ${tool} requires a ${field} identity`)
  return { field, from, to: from }
}

// A fromRequest expression must stay in one delta for the replay adapter to resolve it.
function rewriteToolChunks(chunks: StreamChunk[], binding: IdentityBinding): void {
  for (const [endIndex, end] of chunks.entries()) {
    if (end.type !== 'block-end' || end.block.type !== 'tool-call') continue
    const block = end.block
    const identity = binding(block.name, block.arguments)
    if (identity === undefined) continue
    const { field, from, to } = identity
    const deltas = chunks.flatMap((chunk, index) => chunk.type === 'tool-call-delta'
      && chunk.index === end.index && chunk.id === block.id ? [{ index, chunk }] : [])
    if (deltas.map(({ chunk }) => chunk.argumentsDelta).join('') !== block.arguments) {
      throw new Error(`assistant fixture: ${block.name} stream differs from block arguments`)
    }
    const property = new RegExp(`(?:\\{|,)\\s*"${field}"\\s*:\\s*"`, 'g')
    const literal = JSON.stringify(from).slice(1, -1)
    const offsets = [...block.arguments.matchAll(property)].map(match => match.index + match[0].length)
      .filter(offset => block.arguments.startsWith(`${literal}"`, offset))
    if (offsets.length !== 1) throw new Error(`assistant fixture: expected one ${block.name}.${field} argument`)
    const start = offsets[0]!
    const stop = start + literal.length
    let cursor = 0
    for (const { index, chunk } of deltas) {
      const fragment = chunk.argumentsDelta
      const next = cursor + fragment.length
      if (cursor < stop && next > start && fragment.length > 0) {
        const prefix = fragment.slice(0, Math.max(0, start - cursor))
        const replacement = cursor <= start ? to : ''
        chunks[index] = { ...chunk, argumentsDelta: prefix + replacement + fragment.slice(Math.max(0, stop - cursor)) }
      }
      cursor = next
    }
    chunks[endIndex] = { ...end, block: { ...block, arguments: block.arguments.slice(0, start) + to + block.arguments.slice(stop) } }
  }
}

/**
 * Keep an assistant tool argument's identity in one delta for Session identity redaction.
 * @param stream - Packed timed stream from the assistant fixture.
 * @param workspaces - Registered Workspace ids and their scenario tokens.
 * @returns The packed stream with its original member order, count and times.
 */
export function normalizeAssistantFixtureStream(
  stream: readonly AssistantStreamRecord[], workspaces: ReadonlyMap<string, string>,
): readonly AssistantStreamRecord[] {
  const members = expandAssistantStream(stream)
  const chunks = members.map(member => member.chunk)
  rewriteToolChunks(chunks, (tool, args) => {
    const identity = argumentIdentity(tool, args)
    if (identity?.field === 'workspaceId') return { ...identity, to: workspaces.get(identity.from) ?? identity.from }
    return identity
  })
  const packed = new AssistantStreamAccumulator()
  for (const [index, member] of members.entries()) packed.push({ time: member.time, chunk: chunks[index]! })
  return packed.snapshot()
}

/**
 * Derive the recorded assistant's model script with request-addressed Workspace and task identities.
 * @param source - Recorded assistant Session JSONL.
 * @param workspaceTitle - Exact registered project title selected by the scenario.
 * @param workspacePath - Absolute path staged by the live directory picker.
 * @returns The recorded model chunks with live request identities substituted on replay.
 * @throws when the recorded call or attributed task notice is missing or malformed.
 */
export function assistantReplayScript(source: string, workspaceTitle: string, workspacePath: string): ReplayEntry[] {
  const events = parseSessionLog(source)
  const script = deriveReplayScript(events)
  const calls = events.filter(event => event.type === 'tool/call' && event.data.name === 'create_task')
  if (calls.length !== 1 || calls[0]?.type !== 'tool/call') throw new Error('assistant fixture requires exactly one create_task call')
  const parsed: unknown = JSON.parse(calls[0].data.arguments)
  if (typeof parsed !== 'object' || parsed === null || !('workspaceId' in parsed)
    || typeof parsed.workspaceId !== 'string' || parsed.workspaceId === '') {
    throw new Error('recorded create_task requires a Workspace identity')
  }
  const notice = events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? event.data.inserted.filter(message => message.source.kind === 'assistant-task') : [])[0]
  if (notice?.source.kind !== 'assistant-task') throw new Error('recorded assistant task has no attributed notice')
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rows = '(?:- [^\\r\\n]*\\r?\\n)*'
  const suffix = `: ${escape(workspaceTitle)} \\(${escape(workspacePath)}\\)`
  const titledRow = `- [^:\\r\\n]+${suffix}`
  const unique = `(?!${rows}${titledRow}\\r?\\n${rows}${titledRow}(?:\\r?\\n|$))`
  const project = `{{fromRequest:Registered projects:\\r?\\n${unique}${rows}?- ([^:\\r\\n]+)${suffix}(?:\\r?\\n|$)}}`
  const taskId = notice.source.taskId
  for (const entry of script) {
    if (entry.kind !== 'chunks') continue
    rewriteToolChunks(entry.chunks, (tool, args) => {
      const identity = argumentIdentity(tool, args)
      if (identity === undefined) return undefined
      const isWorkspace = identity.field === 'workspaceId'
      if (identity.from !== (isWorkspace ? parsed.workspaceId : taskId)) {
        throw new Error(`assistant fixture: unexpected ${tool}.${identity.field} identity`)
      }
      return { ...identity, to: isWorkspace ? project : '{{fromRequest:"taskId":"([^"]+)"}}' }
    })
  }
  return script
}

/**
 * Resolve the scenario's selected Workspace from the live registry.
 * @param workspaces - Registered projects for this isolated Web world.
 * @param title - Exact selected project title.
 * @param path - Canonical directory opened by the picker.
 * @returns The known Workspace identity and its stable fixture token.
 * @throws when the registry has zero or multiple matches for that title and directory.
 */
export function assistantFixtureWorkspace(workspaces: readonly Pick<Workspace, 'id' | 'title' | 'path'>[], title: string, path: string) {
  const matches = workspaces.filter(item => item.title === title && item.path === path)
  if (matches.length > 1) throw new Error(`assistant fixture: ambiguous Workspace title ${JSON.stringify(title)} at ${JSON.stringify(path)}`)
  const workspace = matches[0]
  if (workspace === undefined) throw new Error(`assistant fixture: no Workspace titled ${JSON.stringify(title)} at ${JSON.stringify(path)}`)
  return { id: workspace.id, token: '{{workspace:1}}' as const }
}

/**
 * Run one scenario scope and close its acquired resource.
 * @param run - Scenario operation.
 * @param close - Async cleanup that reaches resource quiescence.
 * @returns The operation's result after cleanup.
 * @throws the original failure, or both operation and cleanup failures in one AggregateError.
 */
export async function withAssistantFixtureCleanup<T>(run: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let result: T
  try {
    result = await run()
  } catch (scenarioError) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([scenarioError, cleanupError], 'assistant scenario and cleanup both failed')
    }
    throw scenarioError
  }
  await close()
  return result
}
