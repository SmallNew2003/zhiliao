// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's combined model and effort panel — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the effort group leads with the provider-default entry.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared levels and records the picked one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()

    // Declared levels, nothing else: the provider-default entry (the route
    // configures no `reasoning`), then Off/High/Max — minimal, low, medium,
    // and xhigh were not declared and must not be offered.
    const levels = page.getByRole('group', { name: '推理等级' }).getByRole('menuitemradio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual(['Default', 'Off', 'High', 'Max'])
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await expect.poll(() => page.getByRole('menuitemradio', { name: 'Acme Think' }).count()).toBe(1)
    await page.keyboard.press('Tab')
    await page.keyboard.press('ArrowDown')
    await expect.poll(
      () => levels.nth(0).evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect.poll(
      () => levels.nth(1).evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect.poll(
      () => levels.nth(2).evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)

    // Settling with Tab is the same gesture that saves the default selection, so
    // the effort lands in the Agent default Settings section beside provider/model.
    await page.keyboard.press('Tab')
    await expect.poll(() => levels.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')

    await trigger.click()
    const high = page.getByRole('menuitemradio', { name: 'High' })
    expect(await high.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps long model lists and efforts usable across locales, themes, and viewport sizes', async () => {
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [
            { id: 'acme-think', name: 'Acme Think with a deliberately long model display name', reasoningEfforts: { high: 'high', max: 'ultra' } },
            ...Array.from({ length: 16 }, (_, index) => ({ id: `model-${index}`, name: `Additional model ${index}` })),
          ],
        },
      },
    })
    for (const locale of ['zh', 'en']) {
      await scaffold.ctx.settings.update('locale', { preference: locale })
      for (const theme of ['light', 'dark']) {
        await scaffold.ctx.settings.update('ui-theme', { preference: theme })
        await expect.poll(() => page.locator('html').getAttribute('data-ds-theme-source')).toBe(theme)
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 850 })
          const trigger = page.getByRole('button', { name: locale === 'zh' ? /^选择模型/ : /^Select model/ })
          await trigger.click()
          const menu = page.getByRole('menu')
          const last = menu.getByRole('menuitemradio', { name: 'Max', exact: true })
          await last.scrollIntoViewIfNeeded()
          const geometry = await menu.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return {
              left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
              scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            }
          })
          expect(geometry.left).toBeGreaterThanOrEqual(0)
          expect(geometry.right).toBeLessThanOrEqual(width)
          expect(geometry.top).toBeGreaterThanOrEqual(0)
          expect(geometry.bottom).toBeLessThanOrEqual(850)
          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
          const lastRect = await last.boundingBox()
          expect(lastRect).not.toBeNull()
          expect(lastRect!.y).toBeGreaterThanOrEqual(geometry.top)
          expect(lastRect!.y + lastRect!.height).toBeLessThanOrEqual(geometry.bottom)
          await last.focus()
          await page.keyboard.press('Escape')
          await expect.poll(() => menu.count()).toBe(0)
          expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
        }
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
