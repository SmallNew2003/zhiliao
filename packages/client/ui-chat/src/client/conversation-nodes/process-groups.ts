import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import { isRunningTool, type ChatNode, type ToolChatData } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type {
  ChatProcessGroups, ProcessGroup, ProcessGroupActivity, ProcessGroupMember, ProcessGroupSeat,
  ProcessGroupSummary,
} from '../contract/process-groups.ts'

function turnOf(node: ChatConversationViewNode): number | undefined {
  const location = node.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

function reasoning(node: ChatNode): boolean {
  return node.kind === 'assistant-step'
    && node.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
}

function reply(node: ChatNode): boolean {
  return node.kind === 'assistant-step' && hasAssistantReplyContent(node.data.blocks)
}

function activity(name: string): ProcessGroupActivity {
  if (['read', 'read_image', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)) {
    return name === 'read_image' ? 'readImage' : 'read'
  }
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

function summary(nodes: readonly ChatNode[]): ProcessGroupSummary {
  const counts = new Map<ProcessGroupActivity, number>()
  let toolCount = 0
  let failedToolCount = 0
  let running: ProcessGroupActivity | undefined
  const seen = new Set<string>()
  const visit = (block: ToolChatData['root']): void => {
    if (seen.has(block.callId)) return
    seen.add(block.callId)
    const call = isRunningTool(block) ? block : block.call
    if (call !== null) {
      const kind = activity(call.name)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      toolCount += 1
      if (isRunningTool(block)) running = kind
      else if (block.isError) failedToolCount += 1
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  if (running === undefined && nodes.some(node => node.kind === 'assistant-step' && node.data.status === 'running')) {
    running = 'thinking'
  }
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count),
    toolCount,
    failedToolCount,
    running,
    runningDetail: '',
  }
}

function closedTurn(timeline: ConversationTimelineSnapshot, turn: number | undefined): boolean {
  return turn === undefined || timeline.turns.get(turn)?.status === 'closed'
}

function nodeSeat(node: ChatNode): ProcessGroupSeat {
  const part = reply(node) ? 'response' as const : undefined
  return {
    kind: 'node',
    key: part === undefined ? `node:${node.key}` : `node:${node.key}:${part}`,
    nodeKey: node.key,
    ...part === undefined ? {} : { part },
  }
}

/**
 * Project visible Chat Nodes into process groups and standalone renderer seats.
 * @param nodes - visible Chat Nodes in presentation order.
 * @param timeline - current Turn and Step lifecycle.
 * @returns ordered seats and keyed group data.
 */
export function projectProcessGroups(
  nodes: readonly ChatConversationViewNode[],
  timeline: ConversationTimelineSnapshot,
  previous?: ChatProcessGroups,
): ChatProcessGroups {
  const groups = new Map<string, ProcessGroup>()
  const layout: ProcessGroupSeat[] = []
  const retained = new Set<string>()
  const previousGroups = previous === undefined
    ? []
    : [...new Set(previous.layout.flatMap(entry => entry.kind === 'group' ? [entry.groupKey] : []))]
      .flatMap((key) => {
        const group = previous.get(key)
        return group === undefined ? [] : [group]
      })
  let pending: ProcessGroupMember[] = []
  let pendingNodes: ChatNode[] = []
  let pendingTurn: number | undefined

  const flush = (closed: boolean): void => {
    const first = pending[0]
    if (first === undefined) return
    const reusable = previousGroups.find(candidate => !retained.has(candidate.key)
      && containsMembers(pending, candidate.members))
    const key = reusable?.key ?? processGroupKey(first)
    retained.add(key)
    groups.set(key, {
      key,
      turn: pendingTurn,
      members: pending,
      closed,
      summary: summary(pendingNodes),
    })
    layout.push({ kind: 'group', key, groupKey: key })
    pending = []
    pendingNodes = []
  }

  for (const raw of nodes) {
    const node = raw as ChatNode
    if (node.kind === 'turn-process') continue
    const turn = turnOf(node)
    if (pending.length > 0 && turn !== pendingTurn) flush(closedTurn(timeline, pendingTurn))
    pendingTurn = turn
    if (turn === undefined || TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) {
      flush(true)
      layout.push(nodeSeat(node))
      continue
    }
    if (node.kind === 'assistant-step') {
      if (reasoning(node)) {
        pending.push({ nodeKey: node.key, part: 'reasoning' })
        pendingNodes.push(node)
      }
      if (reply(node)) {
        flush(true)
        layout.push(nodeSeat(node))
      }
      continue
    }
    pending.push({ nodeKey: node.key })
    pendingNodes.push(node)
  }
  flush(closedTurn(timeline, pendingTurn))
  return { layout, get: key => groups.get(key) }
}

function processGroupKey(member: ProcessGroupMember): string {
  return `process:${member.nodeKey}${member.part === undefined ? '' : `:${member.part}`}`
}

function containsMembers(
  outer: readonly ProcessGroupMember[],
  inner: readonly ProcessGroupMember[],
): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false
  for (let start = 0; start <= outer.length - inner.length; start++) {
    let matches = true
    for (let index = 0; index < inner.length; index++) {
      const left = outer[start + index]
      const right = inner[index]
      if (left === undefined || right === undefined
        || left.nodeKey !== right.nodeKey || left.part !== right.part) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}
