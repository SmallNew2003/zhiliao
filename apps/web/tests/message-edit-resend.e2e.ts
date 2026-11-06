/** Keyless editing through the real Web client, Session API, loop, and recorded model. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, readPersistedEvents, renderSeedFixture, seedSession, selectedSessionFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/message-edit-resend', import.meta.url))
const SOURCE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/message-edit-resend/ui.expected.md', import.meta.url))
const SEED_ID = SessionId('message-edit-resend-web-e2e')
const MODE = webSnapshotMode()

/** Keep historical tool identities distinct from the replayed turn's recorded identities. */
function seedHistory(source: string): string {
  const decoded = parseSeedFixture(source)
  const ids = decoded.events.flatMap(event => event.type === 'tool/call' ? [event.data.callId] : [])
  const anchored = renderSeedFixture(JSON.stringify({ ...decoded.header, createdAt: 0 }), decoded.events)
  return ids.reduce((text, id) => text.split(id).join(`seed:${id}`), anchored)
}

describe.skipIf(MODE === 'record')('web e2e: edit and resend the latest input', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let prompt: string
  let hostClock: ReturnType<typeof pinHostClock> | undefined
  const requests: GenerateOptions[] = []
  const appended: SessionEvent[] = []

  beforeAll(async () => {
    const fixture = await selectedSessionFixture(SOURCE)
    const raw = await readFile(fixture, 'utf8')
    const prompts = fixtureUserPrompts(raw)
    expect(prompts).toHaveLength(1)
    prompt = prompts[0]!
    scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: false, paceMs: 15 })
    await seedSession(scaffold, seedHistory(raw), SEED_ID, 'standard', { createdAt: WEB_FIXTURE_TIME - 60_000 })
    hostClock = pinHostClock()
    scaffold.ctx.on('agent/request-preflight', async ({ request }) => { requests.push(request) })
    scaffold.ctx.on('session/event', (session, event) => { if (session.id === SEED_ID) appended.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator(`[data-row-key="session:${SEED_ID}"]`).click()
    await page.getByText('DONE', { exact: true }).waitFor({ state: 'visible' })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() }
      finally { hostClock?.mockRestore() }
    }
  })

  it('resends unchanged text, replaces the old answer, and records the edit before the new request', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-edit-resend'))
    const previous = await readPersistedEvents(scaffold, SEED_ID)
    const target = previous.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (target?.type !== 'user/message') throw new Error('The shared fixture has no human input')
    const oldReply = await page.getByText('DONE', { exact: true }).elementHandle()
    if (oldReply === null) throw new Error('The original answer is not rendered')
    const edit = page.getByRole('button', { name: 'Edit message', exact: true })
    await expect.poll(() => edit.count()).toBe(1)
    await edit.click()
    const editor = page.getByRole('textbox', { name: 'Message text', exact: true })
    expect(await editor.inputValue()).toBe(prompt)
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Resend', exact: true }).click()
    expect(await settled).toBe(SEED_ID)
    await expect.poll(() => oldReply.evaluate(node => node.isConnected)).toBe(false)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count()).toBe(1)
    await expect.poll(() => editor.count()).toBe(0)
    await expect.poll(() => page.locator('[data-streaming="true"]').count()).toBe(0)
    expect(await page.getByText(prompt, { exact: true }).count()).toBe(1)

    const events = await readPersistedEvents(scaffold, SEED_ID)
    const edits = events.filter(event => event.type === 'user/message-edit')
    expect(edits).toHaveLength(1)
    const change = edits[0]
    if (change?.type !== 'user/message-edit') throw new Error('The edit event is missing')
    expect(change.data.targetSeq).toBe(target.seq)
    expect(change.data.message.content).toEqual(target.data.content)
    expect(events.slice(0, previous.length)).toEqual(previous)
    expect(appended.findIndex(event => event.type === 'user/message-edit')).toBeLessThan(
      appended.findIndex(event => event.type === 'request/header'),
    )
    expect(requests).toHaveLength(2)
    const first = requests[0]
    expect(first?.messages.filter(message => message.role === 'assistant' || message.role === 'tool')).toEqual([])
    expect(first?.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)).toEqual([prompt])
  })

  it('pins the edited transcript and keeps the browser error-free', async () => {
    await page.mouse.move(0, 0)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
