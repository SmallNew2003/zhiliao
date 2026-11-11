import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import LlmRuntime, { BlockAssembler, expandAssistantStream, type AssistantStreamRecord, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { assistantFixtureWorkspace, assistantReplayModel, assistantReplayScript, normalizeAssistantFixtureStream, withAssistantFixtureCleanup } from './assistant-follow-through-fixture.ts'
import { installLlmReplay, parseSessionLog, prepareSessionSnapshotFixtureForComparison, resolveScriptedEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFixtureInventory, assertSessionFixtureSnapshots, rawSessionLog, verifySessionFixtures,
  parseSeedFixture,
  recordedSessionFixturePath,
  selectedSessionFixture,
} from './scaffold.ts'

const corruptRecordWrite = vi.hoisted(() => ({ path: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>): Promise<void> {
      await actual.writeFile(...args)
      const target = args[0]
      if (typeof target !== 'string' || target !== corruptRecordWrite.path) return
      const content = await actual.readFile(target, 'utf8')
      const changed = content.split('\n').map((line) => {
        if (line === '') return line
        const record = JSON.parse(line) as { type: string; data: { title?: string } }
        return record.type === 'session/title'
          ? JSON.stringify({ ...record, data: { ...record.data, title: 'Corrupted recorded title' } }) : line
      }).join('\n')
      await actual.writeFile(target, changed)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  corruptRecordWrite.path = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web seed stream timing', () => {
  it.each([2, 3])('preserves embedded timestamps from format v%i and its current projection', async (version) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/skill-load/session.v${version}.jsonl`, import.meta.url), 'utf8')
    const current = prepareSessionSnapshotFixtureForComparison(fixture)
    const expected = parseSessionLog(current)

    expect(parseSeedFixture(fixture).events).toEqual(expected)
    expect(parseSeedFixture(current).events).toEqual(expected)
  })

  it.each(['session.jsonl', 'session.v1.jsonl'])('reconstructs positive stream intervals from %s', async (filename) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/text-turn/${filename}`, import.meta.url), 'utf8')
    const messages = parseSeedFixture(fixture).events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const stream = messages[0]!.data.stream
    expect(stream.length).toBeGreaterThan(1)

    let previousEnd = -1
    for (const record of stream) {
      const start = 'time' in record ? record.time : record.time0
      expect(start).toBeGreaterThan(previousEnd)
      previousEnd = 'time' in record ? record.time : record.time0 + record.dt.reduce((total, delta) => total + delta, 0)
    }
    expect(previousEnd).toBeGreaterThan(0)
  })
})

describe('Web snapshot generation filenames', () => {
  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const [name, version] of [
      ['session.jsonl', 0],
      ['session.v2.jsonl', 2],
      ['session.1.jsonl', 0],
      ['session.1.v1.jsonl', 1],
    ] as const) {
      await writeFile(join(root, name), `${JSON.stringify({
        type: 'session', version, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
      })}\n`)
    }

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl'), true))
      .resolves.toBe(join(root, 'session.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .rejects.toThrow('missing parent session fixture')
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})


describe('Web persisted Session comparison', () => {
  it('rejects a non-model title-event change in either recorded role', async () => {
    const fixture = await readFile(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url), 'utf8')
    let changed = false
    const mutated = fixture.split('\n').map((line) => {
      if (line === '') return line
      const record = JSON.parse(line) as { type: string; data: { title?: string } }
      if (changed || record.type !== 'session/title') return line
      changed = true
      return JSON.stringify({ ...record, data: { ...record.data, title: 'Unexpected persisted title' } })
    }).join('\n')
    expect(changed).toBe(true)
    const context = { sessionIds: [], cwd: '{{cwd}}' }
    expect(() => { assertSessionFixtureSnapshots([fixture, fixture], [fixture, fixture], context, context) })
      .not.toThrow()
    for (const role of [0, 1]) {
      const actual = [fixture, fixture]
      actual[role] = mutated
      expect(() => { assertSessionFixtureSnapshots(actual, [fixture, fixture], context, context) })
        .toThrow('persisted replay')
    }
  })
})


it('records, refreshes and replays exact assistant and worker roles when the assistant has no cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-multi-role-'))
  roots.push(root)
  await writeFile(join(root, 'snapshot.yml'), 'version: 1\nscenario: role-comparison\nprofile: web\n')
  const parent = Session.create(SessionId('parent-role'))
  const workerId = SessionId('worker-role')
  const worker = Session.create(workerId, undefined, { ...parent.header, id: workerId, cwd: join(root, 'workspace') })
  parent.append('session/title', { title: 'Assistant before refresh', messageSeqs: [], source: { kind: 'user' } })
  worker.append('session/title', { title: 'Worker before refresh', messageSeqs: [], source: { kind: 'user' } })
  const sessions = new Map([[parent.id, { session: parent }], [worker.id, { session: worker }]])
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => sessions.get(id) } as never)
  const world = { ctx, workspaceCwd: root, harnessHome: join(root, 'home') }
  const roles = [
    { sessionId: parent.id, fixturePath: join(root, 'session.v4.jsonl') },
    { sessionId: worker.id, fixturePath: join(root, 'session.1.v4.jsonl') },
  ]
  try {
    expect(parent.header.cwd).toBeUndefined()
    await verifySessionFixtures({ ...world, mode: 'record' }, roles)
    await verifySessionFixtures({ ...world, mode: 'replay' }, roles)
    parent.append('session/title', { title: 'Assistant after refresh', messageSeqs: [], source: { kind: 'user' } })
    worker.append('session/title', { title: 'Worker after refresh', messageSeqs: [], source: { kind: 'user' } })
    await expect(verifySessionFixtures({ ...world, mode: 'replay' }, roles)).rejects.toThrow('persisted replay')
    await verifySessionFixtures({ ...world, mode: 'refresh' }, roles)
    await verifySessionFixtures({ ...world, mode: 'replay' }, roles)
    for (const [index, role] of roles.entries()) {
      const expected = await readFile(role.fixturePath, 'utf8')
      expect(expected).toContain(index === 0 ? 'Assistant after refresh' : 'Worker after refresh')
    }
    expect(rawSessionLog(parent)).not.toContain('Worker after refresh')
  } finally {
    await ctx.fiber.dispose()
  }
})


it.each([0, 1])('rejects record immediately when role %i is corrupted during file write-back', async (corruptedRole) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-record-readback-'))
  roots.push(root)
  await writeFile(join(root, 'snapshot.yml'), 'version: 1\nscenario: record-readback\nprofile: web\n')
  const parent = Session.create(SessionId('record-parent'))
  const worker = Session.create(SessionId('record-worker'))
  for (const session of [parent, worker]) {
    session.append('session/title', { title: 'Live Session title', messageSeqs: [], source: { kind: 'user' } })
  }
  const sessions = new Map([[parent.id, { session: parent }], [worker.id, { session: worker }]])
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => sessions.get(id) } as never)
  const roles = [
    { sessionId: parent.id, fixturePath: join(root, 'session.v4.jsonl') },
    { sessionId: worker.id, fixturePath: join(root, 'session.1.v4.jsonl') },
  ]
  const corruptedPath = roles[corruptedRole]!.fixturePath
  corruptRecordWrite.path = corruptedPath
  try {
    await expect(verifySessionFixtures({
      ctx, mode: 'record', workspaceCwd: root, harnessHome: join(root, 'home'),
    }, roles)).rejects.toThrow('persisted replay')
    expect(await readFile(corruptedPath, 'utf8')).toContain('Corrupted recorded title')
    for (const session of [parent, worker]) expect(rawSessionLog(session)).not.toContain('Corrupted recorded title')
  } finally {
    corruptRecordWrite.path = undefined
    await ctx.fiber.dispose()
  }
})


// Exercise identity ranges across provider delta boundaries independently of tokenization in the latest recording.
async function fragmentedAssistantSource(workspace?: string, task?: string): Promise<string> {
  const raw = await readFile(new URL('../../../snapshots/web/assistant-follow-through/session.v4.jsonl', import.meta.url), 'utf8')
  const events = parseSessionLog(raw)
  const create = events.find(event => event.type === 'tool/call' && event.data.name === 'create_task')
  const notice = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .find(message => message.source.kind === 'assistant-task')
  if (create?.type !== 'tool/call' || notice?.source.kind !== 'assistant-task') throw new Error('missing recorded assistant task')
  const recorded = (JSON.parse(create.data.arguments) as { workspaceId: string }).workspaceId
  const source = raw.replaceAll(recorded, workspace ?? recorded).replaceAll(notice.source.taskId, task ?? notice.source.taskId)
  return source.split('\n').map((line) => {
    if (line === '') return line
    const event = JSON.parse(line) as { type: string; data: { stream: AssistantStreamRecord[] } }
    if (event.type !== 'assistant/message') return line
    for (const record of event.data.stream) {
      if (record.type !== 'chunk' || record.chunk.type !== 'block-end' || record.chunk.block.type !== 'tool-call') continue
      const block = record.chunk.block
      if (block.name !== 'create_task' && block.name !== 'get_task') continue
      const field = block.name === 'create_task' ? 'workspaceId' : 'id'
      const value = (JSON.parse(block.arguments) as Record<string, string>)[field]!
      const offset = block.arguments.lastIndexOf(value)
      const args = [block.arguments.slice(0, offset + 2), value.slice(2, -2), block.arguments.slice(offset + value.length - 2)]
      let replaced = false
      event.data.stream = event.data.stream.flatMap((item) => {
        if (item.type !== 'tool-call-chunks' || item.id !== block.id) return [item]
        if (replaced) return []
        replaced = true
        return [
          { ...item, args: args.slice(0, 1), dt: [] },
          { type: 'tool-call-chunks', time0: item.time0 + 1, index: item.index, id: item.id, args: args.slice(1), dt: [1] },
        ]
      })
    }
    return JSON.stringify(event)
  }).join('\n')
}

describe('assistant recorded model', () => {
  const primary = new URL('../../../snapshots/web/assistant-follow-through/session.v4.jsonl', import.meta.url)
  const child = new URL('../../../snapshots/web/assistant-follow-through/session.1.v4.jsonl', import.meta.url)

  it.each(['recorded', 'different defaults', 'caller effort'] as const)('prepares %s from both roles', async (variant) => {
    const [parentLog, childLog] = await Promise.all([readFile(primary, 'utf8'), readFile(child, 'utf8')])
    const alternateRoute = { provider: 'other-provider', model: 'other-model' }
    const alternateConfig = { ...alternateRoute, reasoningEffort: 'low', maxTokens: 12_345 }
    const alternateDefaults = variant === 'caller effort' ? { maxTokens: true } : { reasoningEffort: true, maxTokens: true }
    const alternateContext = { ...alternateRoute, contextWindow: 234_567 }
    const withAlternateModel = (source: string): string => variant === 'recorded' ? source : source.split('\n').map((line) => {
      if (line === '') return line
      const row = JSON.parse(line) as { type: string; data: { header?: object } }
      if (row.type === 'request/context') return JSON.stringify({ ...row, data: alternateContext })
      if (row.type !== 'request/header') return line
      return JSON.stringify({ ...row, data: { ...row.data,
        header: { ...row.data.header, config: alternateConfig, adapterDefaults: alternateDefaults },
      } })
    }).join('\n')
    const parent = withAlternateModel(parentLog)
    const worker = withAlternateModel(childLog)
    const header = parseSessionLog(parent).find(row => row.type === 'request/header')!.data.header
    const context = parseSessionLog(parent).find(row => row.type === 'request/context')!.data
    const pin = assistantReplayModel(parent, worker)
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      installLlmReplay(ctx, { file: fileURLToPath(primary), providers: pin.providers })
      const prepared = await ctx.llm.prepareCall(pin.selection)
      expect(prepared.config).toEqual(header.config)
      expect(prepared.adapterDefaults).toEqual(header.adapterDefaults)
      expect(prepared.context?.contextWindow).toBe(context.contextWindow)
      expect(prepared.systemPromptUpdate).toBe(context.systemPromptUpdate)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['capacity', 'default ownership'])('rejects a worker with conflicting %s on read and persisted comparison', async (field) => {
    const [parent, worker] = await Promise.all([readFile(primary, 'utf8'), readFile(child, 'utf8')])
    const stale = worker.split('\n').map((line) => {
      if (line === '') return line
      const row = JSON.parse(line) as { type: string; data: { header?: object } }
      if (field === 'capacity' && row.type === 'request/context') return JSON.stringify({ ...row, data: { ...row.data, contextWindow: 64 } })
      if (field === 'default ownership' && row.type === 'request/header') {
        return JSON.stringify({ ...row, data: { ...row.data, header: { ...row.data.header, adapterDefaults: { maxTokens: true } } } })
      }
      return line
    }).join('\n')
    expect(() => assistantReplayModel(parent, stale)).toThrow('model metadata')
    const context = { sessionIds: [], cwd: '{{cwd}}' }
    expect(() => { assertSessionFixtureSnapshots([parent, stale], [parent, worker], context, context) }).toThrow('persisted replay')
  })
})

describe('assistant replay identity bindings', () => {
  it.each(['raw', 'token'])('binds %s Workspace and task references to the actual request', async (form) => {
    const source = await fragmentedAssistantSource(form === 'raw' ? 'recorded-workspace' : '{{workspace:1}}',
      form === 'raw' ? 'assistant-task-recorded' : '{{id:1}}')
    const script = assistantReplayScript(source, 'workspace (sample)+', '/live')
    const messages = [
      createSystemMessage('Registered projects:\n- other-project: workspace (sample)+ extra (/other)\n- live-project: workspace (sample)+ (/live)'),
      createUserMessage({ content: [{ type: 'text', text: '{"taskId":"assistant-task-0123456789ab"}' }], source: { kind: 'user' } }),
    ]
    const calls = script.flatMap((entry) => {
      const resolved = resolveScriptedEntry(entry, messages)
      if (resolved.kind !== 'chunks') return []
      const assembler = new BlockAssembler()
      for (const chunk of resolved.chunks) {
        assembler.push(chunk)
        if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') continue
        const callId = chunk.block.id
        const streamed = resolved.chunks.flatMap(member => member.type === 'tool-call-delta' && member.id === callId
          ? [member.argumentsDelta] : []).join('')
        expect(streamed).toBe(chunk.block.arguments)
      }
      return assembler.blocks().filter(block => block.type === 'tool-call')
    })
    const created = calls.find(block => block.name === 'create_task')
    const queried = calls.find(block => block.name === 'get_task')
    expect(JSON.parse(created!.arguments)).toMatchObject({ workspaceId: 'live-project' })
    expect(JSON.parse(queried!.arguments)).toEqual({ id: 'assistant-task-0123456789ab' })
  })

  it('preserves stream times and unrelated arguments, and rejects contradictory deltas and task identities', async () => {
    const workspace = '11111111-2222-4333-8444-555555555555'
    const source = (await fragmentedAssistantSource(workspace, 'assistant-task-recorded')).replaceAll('Report assistant task result', workspace)
    const event = parseSessionLog(source).find(row => row.type === 'assistant/message'
      && row.data.message.content.some(block => block.type === 'tool-call' && block.name === 'create_task'))
    if (event?.type !== 'assistant/message') throw new Error('missing create_task stream')
    const original = expandAssistantStream(event.data.stream)
    const normalized = normalizeAssistantFixtureStream(event.data.stream, new Map([[workspace, '{{workspace:1}}']]))
    const members = expandAssistantStream(normalized)
    expect(members.map(({ time, chunk }) => [time, chunk.type])).toEqual(original.map(({ time, chunk }) => [time, chunk.type]))
    const joined = members.flatMap(({ chunk }) => chunk.type === 'tool-call-delta' ? [chunk.argumentsDelta] : []).join('')
    expect(JSON.parse(joined)).toMatchObject({ workspaceId: '{{workspace:1}}', title: workspace })
    const end = members.find(({ chunk }) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(end?.chunk).toMatchObject({ block: { arguments: joined } })
    const conflicting = event.data.stream.map(row => row.type === 'tool-call-chunks'
      ? { ...row, args: row.args.map(arg => arg === workspace.slice(2, -2) ? 'wrong identity' : arg) } : row)
    expect(() => normalizeAssistantFixtureStream(conflicting, new Map([[workspace, '{{workspace:1}}']]))).toThrow('stream differs')
    const wrongTask = source.replaceAll('"taskId":"assistant-task-recorded"', '"taskId":"other-attributed-task"')
    expect(() => assistantReplayScript(wrongTask, 'workspace', '/live')).toThrow('unexpected get_task.id')
  })

  it('rejects a missing or ambiguous exact project title', () => {
    const row = { id: WorkspaceId('live-project'), title: 'workspace', path: '/live' }
    expect(() => assistantFixtureWorkspace([], 'workspace', '/live')).toThrow('Workspace')
    expect(() => assistantFixtureWorkspace([row, { ...row, id: WorkspaceId('another-project') }], 'workspace', '/live'))
      .toThrow('ambiguous')
    expect(() => assistantFixtureWorkspace([row], 'workspace', '/wrong')).toThrow('Workspace')
    expect(assistantFixtureWorkspace([row, { ...row, id: WorkspaceId('other'), title: 'workspace extra' }], 'workspace', '/live'))
      .toEqual({ id: row.id, token: '{{workspace:1}}' })
  })

  it('retains the scenario failure and the close-consumption failure together', async () => {
    const scenario = new Error('worker binding assertion failed')
    const close = new Error('recorded worker script never bound')
    const outcome = withAssistantFixtureCleanup(
      () => Promise.reject(scenario), () => Promise.reject(close),
    )
    await expect(outcome).rejects.toBeInstanceOf(AggregateError)
    await expect(outcome).rejects.toMatchObject({ errors: [scenario, close] })
  })
})


it('normalizes registered Workspace identity consistently across both roles and leaves single-role defaults untouched', async () => {
  const worker = await readFile(new URL('../../../snapshots/web/assistant-follow-through/session.1.v4.jsonl', import.meta.url), 'utf8')
  const id = WorkspaceId('recorded-workspace-id')
  const actual = await fragmentedAssistantSource(id)
  const context = { sessionIds: [], cwd: '{{cwd}}' }
  const expected = await fragmentedAssistantSource('{{workspace:1}}')
  expect(() => { assertSessionFixtureSnapshots([actual], [expected], context, context) }).toThrow('persisted replay')
  expect(() => { assertSessionFixtureSnapshots([actual, worker], [expected, worker], context, context, undefined, {
    workspaces: [{ id, token: '{{workspace:1}}' }],
  }) }).not.toThrow()
})


declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'web-workspace-fixture': { kind: 'web-workspace-fixture'; workspaceId: WorkspaceId }
  }
}

it('round-trips two roles across new registered Workspace ids without competing generic id tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-workspace-roundtrip-'))
  roots.push(root)
  await writeFile(join(root, 'snapshot.yml'), 'version: 1\nscenario: workspace-roundtrip\nprofile: web\n')
  const oldId = WorkspaceId('11111111-2222-4333-8444-555555555555')
  const newId = WorkspaceId('66666666-7777-4888-8999-aaaaaaaaaaaa')
  const prose = 'Unrelated marker bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  function generation(id: WorkspaceId, name: string) {
    const parent = Session.create(SessionId(`assistant-${name}`))
    const worker = Session.create(SessionId(`worker-${name}`))
    for (const session of [parent, worker]) {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        source: { kind: 'web-workspace-fixture', workspaceId: id },
        content: [{ type: 'text', text: `${prose} ${JSON.stringify({ workspaceId: id })}` }],
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    return [parent, worker]
  }
  let sessions = generation(oldId, 'recorded')
  const ctx = new Context()
  ctx.provide('agents', { get: (id: ReturnType<typeof SessionId>) => {
    const session = sessions.find(item => item.id === id)
    return session === undefined ? undefined : { session }
  } } as never)
  const world = { ctx, workspaceCwd: root, harnessHome: join(root, 'home') }
  const roles = () => sessions.map((session, index) => ({
    sessionId: session.id, fixturePath: join(root, index === 0 ? 'session.v4.jsonl' : 'session.1.v4.jsonl'),
  }))
  const identities = (id: WorkspaceId) => ({ workspaces: [assistantFixtureWorkspace([{ id, title: 'workspace', path: root }], 'workspace', root)] })
  try {
    await verifySessionFixtures({ ...world, mode: 'record' }, roles(), identities(oldId))
    for (const role of roles()) {
      const content = await readFile(role.fixturePath, 'utf8')
      expect(content).toContain('"workspaceId":"{{workspace:1}}"')
      expect(content).not.toContain(oldId)
      expect(content).toContain(prose)
    }
    sessions = generation(newId, 'live')
    await expect(verifySessionFixtures({ ...world, mode: 'replay' }, roles())).rejects.toThrow('persisted replay')
    await verifySessionFixtures({ ...world, mode: 'replay' }, roles(), identities(newId))
    await verifySessionFixtures({ ...world, mode: 'refresh' }, roles(), identities(newId))
    await verifySessionFixtures({ ...world, mode: 'replay' }, roles(), identities(newId))
  } finally {
    await ctx.fiber.dispose()
  }
})


it('fails replay binding when the selected project is absent from the model request', async () => {
  const source = await fragmentedAssistantSource()
  const script = assistantReplayScript(source, 'missing project', '/live')
  expect(() => resolveScriptedEntry(script[0]!, [
    createSystemMessage('Registered projects:\n- live-project: workspace (/live)'),
  ])).toThrow('matched nothing')
})

it('closes an assistant fixture scope and preserves its single failure or successful result', async () => {
  let closed = false
  await expect(withAssistantFixtureCleanup(async () => 'result', async () => { closed = true })).resolves.toBe('result')
  expect(closed).toBe(true)
  const scenario = new Error('scenario only')
  await expect(withAssistantFixtureCleanup(() => Promise.reject(scenario), async () => {})).rejects.toBe(scenario)
  const cleanup = new Error('cleanup only')
  await expect(withAssistantFixtureCleanup(async () => 'result', () => Promise.reject(cleanup))).rejects.toBe(cleanup)
})


it('rejects an ambiguous selected project in the model catalog rather than binding the last match', async () => {
  const source = await fragmentedAssistantSource()
  const script = assistantReplayScript(source, 'workspace', '/first')
  expect(() => resolveScriptedEntry(script[0]!, [
    createSystemMessage('Registered projects:\n- first-project: workspace (/first)\n- second-project: workspace (/first)'),
  ])).toThrow('matched nothing')
})

it('selects the exact project path and title when a title ends with parentheses', async () => {
  const script = assistantReplayScript(await fragmentedAssistantSource(), 'workspace', '/project/new (local)')
  const archived = '- wrong: workspace (archived) (/project/old)'
  const sameTitle = '- other: workspace (/project/other)'
  const right = '- right: workspace (/project/new (local))'
  const resolve = (rows: string[]) => resolveScriptedEntry(script[0]!, [
    createSystemMessage(`Registered projects:\n${rows.join('\n')}`),
  ])
  expect(() => resolve([archived])).toThrow('matched nothing')
  expect(() => resolve([sameTitle])).toThrow('matched nothing')
  const entry = resolve([archived, sameTitle, right])
  expect(entry.kind).toBe('chunks')
  if (entry.kind !== 'chunks') throw new Error('missing create_task stream')
  const end = entry.chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  if (end?.type !== 'block-end' || end.block.type !== 'tool-call') throw new Error('missing create_task block')
  expect(JSON.parse(end.block.arguments)).toMatchObject({ workspaceId: 'right' })
})

it('keeps fresh provider signatures in finish and durable messages on repeated role writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-provider-signature-'))
  roots.push(root)
  await writeFile(join(root, 'snapshot.yml'), 'version: 1\nscenario: signatures\nprofile: web\n')
  const recordings = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl'].map(name =>
    readFile(new URL(`../../../snapshots/web/assistant-follow-through/${name}`, import.meta.url), 'utf8')))
  const oldId = '11111111-2222-4333-8444-555555555555'
  const newId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  const roles = [SessionId('parent'), SessionId('worker')].map((sessionId, index) => ({
    sessionId, fixturePath: join(root, index === 0 ? 'session.v4.jsonl' : 'session.1.v4.jsonl'),
  }))
  const generate = (signature: string) => roles.map(({ sessionId }, index) => {
    const rows = recordings[index]!.split('\n').map(line => line === '' ? line : JSON.stringify(JSON.parse(line),
      (key, value: unknown) => key === 'signature' ? signature : value))
    return Session.create(sessionId, parseSessionLog(rows.join('\n')))
  })
  let sessions = generate(oldId)
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => ({ session: sessions.find(session => session.id === id) }) } as never)
  const world = { ctx, workspaceCwd: root, harnessHome: join(root, 'home') }
  try {
    for (const mode of ['record', 'refresh'] as const) {
      sessions = generate(oldId)
      await verifySessionFixtures({ ...world, mode: 'record' }, roles)
      sessions = generate(newId)
      await expect(verifySessionFixtures({ ...world, mode: 'replay' }, roles)).rejects.toThrow('persisted replay')
      await verifySessionFixtures({ ...world, mode }, roles)
      for (const role of roles) {
        const log = await readFile(role.fixturePath, 'utf8')
        const event = parseSessionLog(log).find(row => row.type === 'assistant/message')!
        const finish = event.data.stream.find(row => row.type === 'chunk' && row.chunk.type === 'finish')
        if (finish?.type !== 'chunk' || finish.chunk.type !== 'finish') throw new Error('missing finish chunk')
        expect(finish.chunk.replayState?.blocks).toContainEqual({ type: 'reasoning', signature: newId })
        expect(event.data.message.source.replayState).toEqual(finish.chunk.replayState)
      }
      await verifySessionFixtures({ ...world, mode: 'replay' }, roles)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
