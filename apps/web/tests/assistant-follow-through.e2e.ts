/** Assistant task creation, scoped reads, result notice and navigation through the real Web assembly. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import {
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts, normalizedToolSchemas,
} from '@deepseek-ai/dsh-session-snapshot'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-assistant-task'
import {
  launchWebScaffold, rawSessionLog, verifySessionFixtures, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { assistantFixtureWorkspace, assistantReplayModel, assistantReplayScript, withAssistantFixtureCleanup } from './assistant-follow-through-fixture.ts'
import { connectFreshWorkspace, newEnglishPage, revealNavigationDrawer, saveFailureShot, expandOwningTurnProcess, scrollIntoView } from './support.ts'

const MODE = webSnapshotMode()
const DIR = fileURLToPath(new URL('../../../snapshots/web/assistant-follow-through', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const WORKER_FIXTURE = join(DIR, 'session.1.v4.jsonl')
const TASK_TITLE = 'Report assistant task result'
const RESULT = 'ASSISTANT_TASK_RESULT'
const CREATE_PROMPT = `Create exactly one independent task titled "${TASK_TITLE}". Its entire instruction is: "Reply with exactly ${RESULT} and stop. Do not use tools." Use the registered project named workspace. After create_task returns, acknowledge creation briefly without ids. Do not call any other tools or wait for completion.`
const READ_PROMPT = 'Use list_tasks, then get_task with the id of the task you just created. Report its final status and result briefly without ids. Do not create another task.'

/** Pin the actual request headers for each recorded role, without copying them into its Session log. */
async function verifyHeaders(session: Session, role: number, scaffold: WebScaffold): Promise<void> {
  const context = { sessionIds: [String(session.id)], cwd: session.header.cwd ?? '\0no-cwd\0' }
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '')
  const raw = rawSessionLog(session)
  const workspaces = scaffold.ctx.workspaceRegistry.list()
  const prompts = normalizedSystemPrompts(raw, context).map(prompt => workspaces.reduce(
    (text, workspace, index) => text.split(workspace.id).join(`{{workspace:${index + 1}}}`),
    prompt.split(sourceRoot).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}')
      .split(scaffold.workspaceCwd).join('{{cwd}}').split(scaffold.harnessHome).join('{{harnessHome}}'),
  ))
  const schemas = normalizedToolSchemas(raw, context)
  if (prompts[0] === undefined || schemas[0] === undefined) throw new Error('assistant role made no model request')
  const suffix = role === 0 ? '' : `.${role}`
  const files = [
    [join(DIR, `system-prompt${suffix}.expected.md`), formatSystemPromptSnapshot(prompts[0], prompts.slice(1))],
    [join(DIR, `tool-schemas${suffix}.expected.json`), formatToolSchemasSnapshot(schemas[0], schemas.slice(1))],
  ] as const
  for (const [path, actual] of files) {
    if (MODE === 'record' || MODE === 'refresh') await writeFile(path, actual)
    else expect(actual, `${path}: live model request headers`).toBe(await readFile(path, 'utf8'))
  }
}

it('creates and follows an assistant task through the real page', async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), 'dsh-assistant-follow-through-'))
  let releaseWorker: (() => void) | undefined
  try {
    const readRole = async (path: string): Promise<string> => readFile(await selectedSessionFixture(path), 'utf8')
    const replay = MODE === 'record' ? undefined : await Promise.all([readRole(FIXTURE), readRole(WORKER_FIXTURE)])
      .then(([source, worker]) => ({ ...assistantReplayModel(source, worker), source }))
    const scaffold = await launchWebScaffold({
      // The two exact Session roles are compared jointly below.
      compareReplaySession: false,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      ...replay === undefined ? {} : {
        replayFixture: FIXTURE, replayChildFixtures: [WORKER_FIXTURE], replayProviders: replay.providers,
        replayOverride: async (workspaceCwd: string) => {
          const path = join(replayRoot, 'replay.override.json')
          await writeFile(path, JSON.stringify(assistantReplayScript(replay.source, 'workspace', join(workspaceCwd, 'workspace'))))
          return path
        },
      },
    })
    await withAssistantFixtureCleanup(async () => {
      if (replay !== undefined) await scaffold.ctx.agentDefaultModel.saveSelection(replay.selection)
      const browser = await chromium.launch()
      await withAssistantFixtureCleanup(async () => {
        const page = await newEnglishPage(browser)
        onTestFailed(() => saveFailureShot(page, 'assistant-follow-through'))
        const console = watchConsole(page)
        const events = new Map<SessionId, SessionEvent[]>()
        scaffold.ctx.on('session/event', (session, event) => {
          const rows = events.get(session.id) ?? []
          rows.push(event)
          events.set(session.id, rows)
        })
        await page.goto(scaffold.authenticatedUrl)
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        const workspace = assistantFixtureWorkspace(scaffold.ctx.workspaceRegistry.list(), 'workspace', join(scaffold.workspaceCwd, 'workspace'))
        const ordinary = await page.evaluate(() => localStorage.getItem('dsh.sessions.current'))
        await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Assistant', exact: true }).click()
        const conversation = page.getByRole('region', { name: 'Assistant conversation', exact: true })
        const tasks = page.getByRole('region', { name: 'Tasks', exact: true })
        const editor = conversation.locator('[data-composer-input][contenteditable="true"]')
        await editor.waitFor()
        expect(await conversation.getByRole('button', { name: 'Choose workspace', exact: true }).count()).toBe(0)
        const assistant = scaffold.ctx.assistantTasks.listAssistants({ kind: 'global' })[0]
        if (assistant === undefined) throw new Error('Assistant page did not register a global assistant')
        let workerStarted = false
        const workerGate = Promise.withResolvers<undefined>()
        releaseWorker = () => { workerGate.resolve(undefined) }
        const stopHolding = scaffold.ctx.on('llm/stream', async function* (options, next) {
          if (options.sessionId !== assistant.sessionId) {
            workerStarted = true
            await workerGate.promise
          }
          yield* next()
        })
        try {
          // Selection changes exercise the retained per-Session draft before any model call.
          await editor.fill(CREATE_PROMPT)
          await page.getByRole('button', { name: 'Choose an assistant · Global assistant' }).click()
          await page.getByRole('menuitem', { name: 'workspace', exact: true }).click()
          await expect.poll(() => conversation.locator('[data-conversation-content]').getAttribute('data-conversation-session'))
            .not.toBe(assistant.sessionId)
          await page.getByRole('button', { name: 'Choose an assistant · workspace' }).click()
          await page.getByRole('menuitem', { name: 'Global assistant', exact: true }).click()
          await expect.poll(() => editor.textContent()).toBe(CREATE_PROMPT)
          const creatorSettled = scaffold.whenTurnSettled(90_000)
          await editor.press('Enter')
          await expect.poll(() => workerStarted, { timeout: 90_000 }).toBe(true)
          expect(await creatorSettled).toBe(assistant.sessionId)
          const task = scaffold.ctx.assistantTasks.listTasks({ assistantId: assistant.id })[0]
          if (task === undefined) throw new Error('create_task did not persist an assistant task')
          expect(task.status).toBe('running')
          await tasks.getByText(TASK_TITLE, { exact: true }).waitFor()
          const createCall = (events.get(assistant.sessionId) ?? []).find(event =>
            event.type === 'tool/call' && event.data.name === 'create_task')
          if (createCall?.type !== 'tool/call') throw new Error('the assistant has no durable create_task call')
          const transcriptCall = conversation.locator(`[data-chat-call-id="${createCall.data.callId}"]`)
          await expandOwningTurnProcess(page, transcriptCall)
          const transcriptCard = transcriptCall.getByRole('article')
          await transcriptCard.getByText(TASK_TITLE, { exact: true }).waitFor()
          await transcriptCard.getByText('Running', { exact: true }).waitFor()
          expect(await transcriptCard.getByRole('button', { name: 'Open task', exact: true }).isVisible()).toBe(true)
          expect(await conversation.isVisible()).toBe(true)
          expect(await page.evaluate(() => localStorage.getItem('dsh.sessions.current'))).toBe(ordinary)
          workerGate.resolve(undefined)
          await expect.poll(() => scaffold.ctx.assistantTasks.listTasks({ assistantId: assistant.id })[0]?.status, { timeout: 90_000 }).toBe('done')
          await expect.poll(() => events.get(assistant.sessionId)?.filter(event => event.type === 'turn/end').length ?? 0, { timeout: 90_000 }).toBe(2)
          const agent = scaffold.ctx.agents.get(assistant.sessionId)
          const worker = scaffold.ctx.agents.get(task.sessionId)
          if (agent === undefined || worker === undefined) throw new Error('completed assistant task lost its live Session')
          await agent.whenIdle()
          await tasks.getByRole('heading', { name: /^Finished/ }).waitFor()
          await tasks.getByText(RESULT, { exact: true }).waitFor()
          await transcriptCard.getByText('Done', { exact: true }).waitFor()
          await transcriptCard.getByText(RESULT, { exact: true }).waitFor()
          expect(await transcriptCard.getByText('Running', { exact: true }).count()).toBe(0)
          const updated = scaffold.ctx.assistantTasks.listTasks({ assistantId: assistant.id })[0]
          expect(updated?.resultSummary).toBe(RESULT)
          const notices = (events.get(assistant.sessionId) ?? []).flatMap(event =>
            event.type === 'agent/inbox/spliced' ? event.data.inserted.filter(message => message.source.kind === 'assistant-task') : [])
          expect(notices).toHaveLength(1)
          expect(notices[0]?.source).toMatchObject({ kind: 'assistant-task', taskId: task.id, sessionId: task.sessionId })
          const readsSettled = scaffold.whenTurnSettled(90_000)
          await editor.fill(READ_PROMPT)
          await editor.press('Enter')
          expect(await readsSettled).toBe(assistant.sessionId)
          const calls = (events.get(assistant.sessionId) ?? []).flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
          expect(calls.filter(name => name === 'create_task')).toHaveLength(1)
          expect(calls).toContain('list_tasks')
          expect(calls).toContain('get_task')
          const results = (events.get(assistant.sessionId) ?? []).filter(event => event.type === 'tool/result')
          expect(results.every(event => !event.data.message.isError)).toBe(true)
          await tasks.getByRole('button', { name: 'Open task', exact: true }).click()
          await page.getByRole('button', { name: 'Back to assistant', exact: true }).waitFor()
          await page.getByRole('button', { name: 'Back to assistant', exact: true }).click()
          await editor.waitFor()
          expect(await conversation.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(assistant.sessionId)
          await page.setViewportSize({ width: 390, height: 844 })
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          expect(await conversation.isVisible()).toBe(true)
          expect(await tasks.isVisible()).toBe(true)
          const regions = await Promise.all([conversation.boundingBox(), tasks.boundingBox()])
          const [chatBox, tasksBox] = regions
          if (chatBox === null || tasksBox === null) throw new Error('a narrow-screen assistant region has no layout box')
          const overlapHeight = Math.min(chatBox.y + chatBox.height, tasksBox.y + tasksBox.height) - Math.max(chatBox.y, tasksBox.y)
          const overlapWidth = Math.min(chatBox.x + chatBox.width, tasksBox.x + tasksBox.width) - Math.max(chatBox.x, tasksBox.x)
          expect(Math.min(overlapWidth, overlapHeight)).toBeLessThanOrEqual(1)
          await editor.click()
          await editor.fill('Retained narrow-screen draft')
          expect(await editor.evaluate(element => element === document.activeElement)).toBe(true)
          const narrowOpen = tasks.getByRole('button', { name: 'Open task', exact: true })
          await scrollIntoView(narrowOpen)
          await narrowOpen.click()
          await page.getByRole('button', { name: 'Back to assistant', exact: true }).click()
          await expect.poll(() => editor.textContent()).toBe('Retained narrow-screen draft')
          await revealNavigationDrawer(page, 'en')
          expect(await page.getByRole('tree', { name: 'Sessions', exact: true }).getByText(TASK_TITLE, { exact: true }).count()).toBe(0)
          expect(console.pageErrors).toEqual([])
          await verifySessionFixtures(scaffold, [
            { sessionId: assistant.sessionId, fixturePath: FIXTURE },
            { sessionId: task.sessionId, fixturePath: WORKER_FIXTURE },
          ], { workspaces: [workspace] })
          await verifyHeaders(agent.session, 0, scaffold)
          await verifyHeaders(worker.session, 1, scaffold)
        } finally {
          workerGate.resolve(undefined)
          stopHolding()
        }
      }, async () => { await browser.close() })
    }, async () => { await scaffold.close() })
  } finally {
    releaseWorker?.()
    await rm(replayRoot, { recursive: true, force: true })
  }
}, 240_000)
