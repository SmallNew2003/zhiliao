/** Historical generated-plugin cards remain readable after their tool APIs are removed. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, readPersistedEvents, parseSeedFixture, realizeSeedFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/cordis-tool-round/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/cordis-history/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'cordis-history'

describe.skipIf(MODE === 'record')('web e2e: historical Cordis cards', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders recorded definition source and lifecycle results without registering retired tools', async () => {
    const persisted = await readPersistedEvents(scaffold, SessionId(SEED_ID))
    const expected = parseSeedFixture(realizeSeedFixture(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)).events
    const tools = (events: typeof persisted) => events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      .map(event => ({ type: event.type, data: event.data }))
    expect(tools(persisted)).toEqual(tools(expected))
    const names = scaffold.ctx.tools.schemas().map(tool => tool.name)
    expect(names).not.toEqual(expect.arrayContaining(['cordis_define']))
    const define = page.locator('[data-tool="cordis_define"]').first()
    await expandOwningTurnProcess(page, define)
    await define.locator('[aria-expanded]').first().click()
    await define.getByRole('tab', { name: 'Host' }).click()
    await expect.poll(() => define.textContent()).toContain('snapshot-noop')
    const stop = page.locator('[data-tool="cordis_stop"]').first()
    await expandOwningTurnProcess(page, stop)
    await expect.poll(() => stop.getAttribute('data-state')).toBe('ok')
    // The golden pins the scrolled-up state, where the Back-to-bottom control
    // is present. Establish that state instead of inheriting whatever scroll
    // position the expansions left behind: settle fonts first, then scroll up
    // off the bottom and wait for the control to appear.
    await page.evaluate(async () => { await document.fonts.ready })
    const scrollport = page.locator('[data-conversation-scroll]')
    const backToBottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
    await expect.poll(async () => {
      const distance = await scrollport.evaluate((host) => {
        host.scrollTop = Math.max(0, host.scrollTop - 200)
        return host.scrollHeight - host.clientHeight - host.scrollTop
      })
      return distance > 1 && await backToBottom.count() === 1
    }, { timeout: 10_000 }).toBe(true)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  })
})
