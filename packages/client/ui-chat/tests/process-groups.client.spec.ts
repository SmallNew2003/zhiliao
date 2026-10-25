import { describe, expect, it } from 'vitest'
import type { AssistantMessageNode, ConversationNode, ToolResultNode, UserMessageNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { processGroupTitle } from '../src/client/chat/process-group-title.ts'
import { en } from '../src/client/locale.ts'
import { projectProcessGroups } from '../src/client/conversation-nodes/process-groups.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

function user(seq: number): UserMessageNode {
  return {
    kind: 'user',
    seq,
    time: seq * 1_000,
    content: [{ type: 'text', text: `question ${String(seq)}` }],
    source: null,
  }
}

function assistant(seq: number, blocks: AssistantMessageNode['blocks']): AssistantMessageNode {
  return { kind: 'assistant', seq, time: seq * 1_000, turn: 1, step: seq, blocks }
}

function toolResult(seq: number, callId: string, isError = false): ToolResultNode {
  return {
    kind: 'tool-result',
    seq,
    time: seq * 1_000,
    callId,
    call: { name: 'bash', argsRaw: `{"command":"cmd-${callId}"}` },
    callTime: seq * 1_000 - 500,
    content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
    isError,
    subCalls: [],
  }
}

function truncatedToolResult(seq: number, callId: string, isError = false): ToolResultNode {
  return {
    kind: 'tool-result',
    seq,
    time: seq * 1_000,
    callId,
    call: null,
    callTime: null,
    content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
    isError,
    subCalls: [],
  }
}

function projection(nodes: readonly ConversationNode[], turnEnds = new Map<number, number>()) {
  const snapshot = chatSnapshotFixture({ nodes, turnEnds })
  const ordered = snapshot.order
    .map(key => snapshot.nodes.get(key))
    .filter((node): node is NonNullable<typeof node> => node !== undefined)
  return projectProcessGroups(ordered, snapshot.timeline)
}

describe('process groups', () => {
  it('keeps assistant responses outside the process groups they delimit', () => {
    const groups = projection([
      user(1),
      assistant(2, [{ kind: 'reasoning', text: 'inspect first' }]),
      toolResult(3, 'a'),
      assistant(4, [{ kind: 'text', text: 'first visible summary' }]),
      assistant(5, [{ kind: 'reasoning', text: 'inspect second' }]),
      toolResult(6, 'b'),
      assistant(7, [{ kind: 'text', text: 'final answer' }]),
    ], new Map([[1, 8]]))

    expect(groups.layout.map(entry => entry.kind)).toEqual(['node', 'group', 'node', 'group', 'node', 'node'])
    const first = groups.layout[1]
    const second = groups.layout[3]
    if (first?.kind !== 'group' || second?.kind !== 'group') throw new Error('expected process groups')
    expect(groups.get(first.groupKey)?.members.map(member => member.nodeKey)).toEqual([
      'fixture:assistant:2', 'fixture:tool:a',
    ])
    expect(groups.get(second.groupKey)?.members.map(member => member.nodeKey)).toEqual([
      'fixture:assistant:5', 'fixture:tool:b',
    ])
    expect(groups.layout[2]).toMatchObject({ kind: 'node', nodeKey: 'fixture:assistant:4', part: 'response' })
    expect(groups.layout[4]).toMatchObject({ kind: 'node', nodeKey: 'fixture:assistant:7', part: 'response' })
  })

  it('splits one assistant node into a reasoning group and a visible response seat', () => {
    const groups = projection([
      user(1),
      assistant(2, [
        { kind: 'reasoning', text: 'inspect the repository' },
        { kind: 'text', text: 'I will inspect the repository.' },
      ]),
    ], new Map([[1, 3]]))

    const groupEntry = groups.layout.find(entry => entry.kind === 'group')
    if (groupEntry?.kind !== 'group') throw new Error('expected a process group')
    expect(groups.get(groupEntry.groupKey)?.members).toEqual([
      { nodeKey: 'fixture:assistant:2', part: 'reasoning' },
    ])
    expect(groups.layout.filter(entry => entry.kind === 'node' && entry.nodeKey === 'fixture:assistant:2'))
      .toEqual([{ kind: 'node', key: 'node:fixture:assistant:2:response', nodeKey: 'fixture:assistant:2', part: 'response' }])
  })

  it('counts unique tool calls and failures in a completed group', () => {
    const groups = projection([
      user(1),
      assistant(2, [{ kind: 'reasoning', text: 'run tools' }]),
      toolResult(3, 'ok-call'),
      toolResult(4, 'failed-call', true),
      assistant(5, [{ kind: 'text', text: 'done' }]),
    ], new Map([[1, 6]]))

    const groupEntry = groups.layout.find(entry => entry.kind === 'group')
    if (groupEntry?.kind !== 'group') throw new Error('expected a process group')
    const group = groups.get(groupEntry.groupKey)
    expect(group?.closed).toBe(true)
    expect(group?.summary.failed).toBe(true)
    expect(group?.summary.counts).toEqual([{ kind: 'commands', count: 2 }])
  })

  it('keeps unknown truncated tool calls and their failure state in the summary', () => {
    const snapshot = chatSnapshotFixture({
      nodes: [
        user(1),
        toolResult(2, 'truncated-call'),
        assistant(3, [{ kind: 'text', text: 'done' }]),
      ],
      turnEnds: new Map([[1, 4]]),
    })
    const turnLocation = snapshot.nodes.get('fixture:assistant:3')?.location
    const nodes = snapshot.order.flatMap((key) => {
      const node = snapshot.nodes.get(key)
      if (node === undefined) return []
      return node.kind === 'tool-call'
        ? [{
          ...node,
          ...turnLocation === undefined ? {} : { location: turnLocation },
          data: { root: truncatedToolResult(2, 'truncated-call', true) },
        }]
        : [node]
    })
    const groups = projectProcessGroups(nodes, snapshot.timeline)

    const groupEntry = groups.layout.find(entry => entry.kind === 'group')
    if (groupEntry?.kind !== 'group') throw new Error('expected a process group')
    const group = groups.get(groupEntry.groupKey)
    expect(group?.summary.counts).toEqual([{ kind: 'tools', count: 1 }])
    expect(group?.summary.failed).toBe(true)
  })

  it('leaves the final process group open until the turn or a later response closes it', () => {
    const groups = projection([
      user(1),
      assistant(2, [{ kind: 'reasoning', text: 'still working' }]),
    ])

    const groupEntry = groups.layout.find(entry => entry.kind === 'group')
    if (groupEntry?.kind !== 'group') throw new Error('expected a process group')
    expect(groups.get(groupEntry.groupKey)?.closed).toBe(false)
  })

  it('assigns the earliest member timestamp as the group start time', () => {
    const groups = projection([
      user(1),
      assistant(2, [{ kind: 'reasoning', text: 'still working' }]),
      toolResult(3, 'a'),
    ])

    const groupEntry = groups.layout.find(entry => entry.kind === 'group')
    if (groupEntry?.kind !== 'group') throw new Error('expected a process group')
    expect(groups.get(groupEntry.groupKey)?.startTime).toBe(2_000)
  })
})

describe('process group snapshot projection', () => {
  it('closes a running group when a later assistant response is applied', async () => {
    const { ChatSnapshotBuilder } = await import('../src/client/conversation-nodes/chat-snapshot-builder.ts')
    const builder = new ChatSnapshotBuilder()
    const running = chatSnapshotFixture({
      nodes: [
        user(1),
        assistant(2, [{ kind: 'reasoning', text: 'still working' }]),
      ],
    })
    const first = builder.replace({ nodes: running.nodes.values(), timeline: running.timeline })
    const firstGroup = first.processGroups.layout.find(entry => entry.kind === 'group')
    if (firstGroup?.kind !== 'group') throw new Error('expected a running process group')
    expect(first.processGroups.get(firstGroup.groupKey)?.closed).toBe(false)

    const complete = chatSnapshotFixture({
      nodes: [
        user(1),
        assistant(2, [{ kind: 'reasoning', text: 'still working' }]),
        assistant(3, [{ kind: 'text', text: 'answer' }]),
      ],
      turnEnds: new Map([[1, 4]]),
    })
    const next = builder.apply({ upserts: complete.nodes.values(), timeline: complete.timeline })
    expect(next.processGroups.layout.map(entry => entry.kind)).toEqual(['node', 'group', 'node', 'node'])
    const completedGroup = next.processGroups.layout.find(entry => entry.kind === 'group')
    if (completedGroup?.kind !== 'group') throw new Error('expected a completed process group')
    expect(completedGroup.groupKey).toBe(firstGroup.groupKey)
    expect(next.processGroups.get(completedGroup.groupKey)?.closed).toBe(true)
  })

  it('keeps completed and later running groups distinct across a response boundary', async () => {
    const { ChatSnapshotBuilder } = await import('../src/client/conversation-nodes/chat-snapshot-builder.ts')
    const builder = new ChatSnapshotBuilder()
    const running = chatSnapshotFixture({
      nodes: [
        user(1),
        assistant(2, [{ kind: 'reasoning', text: 'first process' }]),
      ],
    })
    const first = builder.replace({ nodes: running.nodes.values(), timeline: running.timeline })
    const firstGroup = first.processGroups.layout.find(entry => entry.kind === 'group')
    if (firstGroup?.kind !== 'group') throw new Error('expected the first running process group')

    const withResponse = chatSnapshotFixture({
      nodes: [
        user(1),
        assistant(2, [{ kind: 'reasoning', text: 'first process' }]),
        assistant(3, [{ kind: 'text', text: 'summary' }]),
      ],
    })
    const middle = builder.apply({ upserts: withResponse.nodes.values(), timeline: withResponse.timeline })
    const middleGroup = middle.processGroups.layout.find(entry => entry.kind === 'group')
    if (middleGroup?.kind !== 'group') throw new Error('expected the completed process group')
    expect(middleGroup.groupKey).toBe(firstGroup.groupKey)
    expect(middle.processGroups.get(middleGroup.groupKey)?.closed).toBe(true)

    const next = chatSnapshotFixture({
      nodes: [
        user(1),
        assistant(2, [{ kind: 'reasoning', text: 'first process' }]),
        assistant(3, [{ kind: 'text', text: 'summary' }]),
        assistant(4, [{ kind: 'reasoning', text: 'second process' }]),
      ],
    })
    const repaired = builder.apply({ upserts: next.nodes.values(), timeline: next.timeline })
    const groups = repaired.processGroups.layout.filter(entry => entry.kind === 'group')
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map(entry => entry.key)).size).toBe(2)
    expect(groups[0]?.kind === 'group' ? repaired.processGroups.get(groups[0].groupKey)?.closed : undefined)
      .toBe(true)
    expect(groups[1]?.kind === 'group' ? repaired.processGroups.get(groups[1].groupKey)?.closed : undefined)
      .toBe(false)
  })
})

describe('process group titles', () => {
  it('describes the two main completed actions without counts and appends failure state', () => {
    const t = makeTranslate(en, commonEn)
    const group = {
      key: 'group',
      turn: 1,
      members: [],
      closed: true,
      summary: {
        counts: [
          { kind: 'commands' as const, count: 3 },
          { kind: 'read' as const, count: 1 },
        ],
        failed: true,
        running: undefined,
      },
    }
    expect(processGroupTitle(group, '', t)).toBe('ran commands, read files · some actions failed')
  })

  it('signals additional action types without showing counts', () => {
    const t = makeTranslate(en, commonEn)
    const group = {
      key: 'group',
      turn: 1,
      members: [],
      closed: true,
      summary: {
        counts: [
          { kind: 'commands' as const, count: 3 },
          { kind: 'read' as const, count: 2 },
          { kind: 'search' as const, count: 1 },
        ],
        failed: false,
        running: undefined,
      },
    }
    expect(processGroupTitle(group, '', t)).toBe('ran commands, read files, and more')
  })

  it('describes a reasoning-only completed group as analyzed', () => {
    const t = makeTranslate(en, commonEn)
    const group = {
      key: 'group',
      turn: 1,
      members: [],
      closed: true,
      summary: {
        counts: [],
        failed: false,
        running: undefined,
      },
    }
    expect(processGroupTitle(group, '', t)).toBe('analyzed the request')
  })

  it('uses a localized running activity and appends elapsed time', () => {
    const t = makeTranslate(en, commonEn)
    const group = {
      key: 'group',
      turn: 1,
      members: [],
      closed: false,
      summary: {
        counts: [],
        failed: false,
        running: 'search' as const,
      },
    }
    expect(processGroupTitle(group, '1m 26s', t)).toBe('Searching code · 1m 26s')
  })
})
