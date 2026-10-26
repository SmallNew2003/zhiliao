// Web e2e: declared model efforts and context presets share one composer panel.
// A scenario-owned provider exercises the shipped request and persistence path.
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let provider: Server
  const providerFailures: Error[] = []
  const requests: { model: string; reasoning_effort?: string; messages: unknown[] }[] = []
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    provider = createServer((request, response) => {
      let body = ''
      request.on('error', (error) => { providerFailures.push(error); response.destroy() })
      response.on('error', (error) => { providerFailures.push(error) })
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        let parsed: typeof requests[number]
        try { parsed = JSON.parse(body) as typeof requests[number] } catch (error) {
          providerFailures.push(error instanceof Error ? error : new Error(String(error)))
          response.writeHead(400)
          response.end()
          return
        }
        requests.push(parsed)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null) => JSON.stringify({
          id: 'context-window-response', object: 'chat.completion.chunk', created: 1, model: 'acme-think',
          choices: [{ index: 0, delta, finish_reason }],
        })
        response.end(`data: ${chunk({ role: 'assistant', content: 'Context selection received.' }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', () => { provider.off('error', reject); resolve() })
    })
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('context-window provider did not bind a TCP port')
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await scaffold.ctx.credentials.set(credentialRef('DSH_CONTEXT_WINDOW_FIXTURE_KEY'), 'context-window-fixture')
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the effort group leads with the provider-default entry.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: 'DSH_CONTEXT_WINDOW_FIXTURE_KEY',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            contextWindow: 320_000,
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
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        provider?.closeAllConnections()
        if (provider?.listening) {
          await new Promise<void>((resolve, reject) => {
            provider.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            })
          })
        }
      }
    }
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

  it('persists the context tier, sends it with a request, and restores it after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-context-window'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const contexts = page.getByRole('group', { name: '上下文窗口' })
    expect(await contexts.getByText('当前：320,000').count()).toBe(1)
    expect(await contexts.getByRole('menuitemradio', { name: '320K' }).getAttribute('aria-checked')).toBe('true')
    await contexts.getByRole('menuitemradio', { name: '640K' }).focus()
    await page.keyboard.press('Tab')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    const session = scaffold.ctx.sessions.list().find(candidate => candidate.header.parentSession === undefined)
    if (session === undefined) throw new Error('browser created no main session')
    const selected = { provider: 'acme-gateway', model: 'acme-think', reasoningEffort: 'high', contextWindow: 640_000 }
    await expect.poll(async () => (await readPersistedEvents(scaffold, session.id))
      .filter(event => event.type === 'model/selection').at(-1)?.data).toEqual(selected)

    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Confirm the selected context window.')
    await input.press('Enter')
    expect(await settled).toBe(session.id)
    expect(providerFailures).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: 'acme-think', reasoning_effort: 'high' })
    const events = await readPersistedEvents(scaffold, session.id)
    expect(events.filter(event => event.type === 'request/header').at(-1)?.data).toMatchObject({ header: { config: selected } })
    expect(events.filter(event => event.type === 'request/context').at(-1)?.data).toMatchObject({ provider: selected.provider, model: selected.model, contextWindow: 640_000 })
    await page.getByText('Context selection received.', { exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    expect(await page.getByRole('menuitemradio', { name: '640K' }).getAttribute('aria-checked')).toBe('true')
    expect(await page.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
    expect(await page.getByText('当前：640,000').count()).toBe(1)
    await page.getByRole('menuitemradio', { name: '320K', exact: true }).click()
    await page.getByText('已调小窗口，继续对话前将按需压缩上下文。', { exact: true }).waitFor()
    const smallerSettled = scaffold.whenTurnSettled()
    await input.fill('Continue within the smaller window.')
    await input.press('Enter')
    expect(await smallerSettled).toBe(session.id)
    expect(requests).toHaveLength(2)
    const smallerEvents = await readPersistedEvents(scaffold, session.id)
    expect(smallerEvents.filter(event => event.type === 'request/header').at(-1)?.data)
      .toMatchObject({ header: { config: { ...selected, contextWindow: 320_000 } } })
    expect(smallerEvents.filter(event => event.type === 'compaction/start')).toHaveLength(0)
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
          const last = menu.getByRole('menuitemradio', { name: '960K', exact: true })
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
