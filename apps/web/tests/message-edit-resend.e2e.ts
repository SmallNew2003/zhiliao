/** Latest input editing through the shipped Web composition and durable replay. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/message-edit-resend', import.meta.url))
const MODE = webSnapshotMode()
const INPUT_A = 'Earlier input A'
const INPUT_B = 'Original input B'
const EDIT_B = 'Revised input B'

function response(text: string) {
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }
}

describe.skipIf(MODE === 'record')('web e2e: latest message edit and resend', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let scratch: string
  let sessionId: SessionId
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
    const override = join(scratch, 'replay.override.json')
    await writeFile(override, JSON.stringify([response('Earlier answer A'), response('Original answer B'), response('Revised answer B')]))
    scaffold = await launchWebScaffold({ replayFixture: join(DIR, 'session.v3.jsonl'),
      ...MODE === 'refresh' ? { replayOverride: override } : {}, paceMs: 80 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'message-edit-e2e')
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }) }
    }
  })

  it('replaces only the latest input and answer, preserves cancellation and reconnect history', async () => {
    const composer = page.locator('[data-composer-input]').first()
    for (const text of [INPUT_A, INPUT_B]) {
      const settled = scaffold.whenTurnSettled()
      await composer.fill(text)
      await composer.press('Enter')
      sessionId = await settled
    }
    await page.getByText('Original answer B', { exact: true }).waitFor()
    const edit = page.getByRole('button', { name: 'Edit message', exact: true })
    await expect.poll(() => edit.count()).toBe(1)
    await edit.click()
    const editor = page.getByRole('textbox', { name: 'Message text', exact: true })
    await editor.fill('Cancelled draft')
    await editor.press('Escape')
    await page.getByText(INPUT_B, { exact: true }).waitFor()
    await page.getByText('Original answer B', { exact: true }).waitFor()
    await edit.click()
    await editor.fill(EDIT_B)
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Resend', exact: true }).click()
    await expect.poll(() => edit.getAttribute('aria-disabled')).toBe('true')
    await settled
    await page.getByText('Revised answer B', { exact: true }).waitFor()
    expect(await page.getByText(INPUT_B, { exact: true }).count()).toBe(0)
    expect(await page.getByText('Original answer B', { exact: true }).count()).toBe(0)
    await page.locator('[data-conversation-scroll]').getByText(INPUT_A, { exact: true }).waitFor()
    await page.getByText('Earlier answer A', { exact: true }).waitFor()
    const agent = scaffold.ctx.agents.get(sessionId)!
    const effective = agent.session.deriveMessages().map(message => message.content)
    expect(JSON.stringify(effective)).toContain(EDIT_B)
    expect(JSON.stringify(effective)).not.toContain(INPUT_B)
    expect(JSON.stringify(effective)).not.toContain('Original answer B')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message-edit')).toHaveLength(1)
    await page.reload()
    await page.getByText('Revised answer B', { exact: true }).waitFor()
    expect(await page.getByText(INPUT_B, { exact: true }).count()).toBe(0)
    await edit.focus()
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens a historical completed turn in a new chat with its inherited input editable', async () => {
    const original = scaffold.ctx.agents.get(sessionId)!.session.snapshotEvents()
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).first().click()
    await page.getByText('Earlier answer A', { exact: true }).waitFor()
    await expect.poll(() => page.getByText(EDIT_B, { exact: true }).count()).toBe(0)
    const edit = page.getByRole('button', { name: 'Edit message', exact: true })
    await edit.click()
    expect(await page.getByRole('textbox', { name: 'Message text', exact: true }).inputValue()).toBe(INPUT_A)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(scaffold.ctx.agents.get(sessionId)!.session.snapshotEvents()).toEqual(original)
  }, 30_000)
})
