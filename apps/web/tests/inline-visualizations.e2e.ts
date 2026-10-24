/** Web e2e regression: sandboxed inline previews, lifecycle, and exports. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SEED_ID = 'inline-visualizations-web-e2e'
const DONE = 'INLINE_VISUALIZATIONS_DONE'

/** Assistant reply containing HTML, ECharts, Mermaid, ordinary code, and invalid preview metadata. */
function visualizationsFixture(): string {
  const session = Session.create(SessionId('inline-visualizations-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Generate an interactive dashboard, a performance chart, and an architecture diagram.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Inline Visualizations',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '# Dashboard and Architecture',
          '',
          'Here is the interactive HTML dashboard with Bootstrap components:',
          '',
          '```html preview runtime=dsh-v1',
          '<section class="card" id="demo-card">',
          '  <div class="card-body">',
          '    <h5 class="card-title">System Metrics</h5>',
          '    <p class="card-text text-body-secondary">Real-time status</p>',
          '    <button type="button" class="btn btn-primary" id="btn-counter">Clicks: 0</button>',
          '  </div>',
          '</section>',
          '<script>',
          '  let count = 0;',
          '  const btn = document.getElementById("btn-counter");',
          '  btn.addEventListener("click", () => {',
          '    btn.textContent = "Clicks: " + (++count);',
          '  });',
          '</script>',
          '```',
          '',
          'Here is the monthly performance chart using ECharts:',
          '',
          '```html preview runtime=dsh-v1 libs=echarts',
          '<div id="chart-mount" style="width: 100%; height: 280px;"></div>',
          '<script>',
          '  const container = document.getElementById("chart-mount");',
          '  const chart = dsh.chart(container, {',
          '    title: { text: "Monthly Throughput" },',
          '    xAxis: { type: "category", data: ["Jan", "Feb", "Mar"] },',
          '    yAxis: { type: "value" },',
          '    series: [{ type: "bar", data: [120, 200, 150] }]',
          '  });',
          '</script>',
          '```',
          '',
          'Here is the architecture flow diagram using Mermaid:',
          '',
          '```mermaid preview runtime=dsh-v1',
          'flowchart LR',
          '  Client[Client UI] --> Gateway[API Gateway]',
          '  Gateway --> Backend[Service Runtime]',
          '```',
          '',
          'Here is an ordinary un-marked code block that must NOT render as preview:',
          '',
          '```html',
          '<div class="ordinary-code">Standard Code Example</div>',
          '```',
          '',
          'Here is a preview block with an unsupported runtime that must display diagnostic:',
          '',
          '```html preview runtime=dsh-unsupported',
          '<div>Should fail cleanly</div>',
          '```',
          '',
          DONE,
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: inline visualizations in assistant replies', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, visualizationsFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders sandboxed HTML, ECharts and Mermaid previews alongside ordinary code', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-inline-visualizations'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // 4 visualization containers rendered (3 valid + 1 invalid runtime diagnostic)
    const previewRegions = page.locator('[data-visualization]')
    await expect.poll(() => previewRegions.count(), { timeout: 15_000 }).toBe(4)

    // Ordinary code block remains standard code and has no data-visualization wrapper
    const ordinaryCode = page.locator('pre code').filter({ hasText: 'Standard Code Example' })
    await ordinaryCode.waitFor({ state: 'visible' })
    expect(await ordinaryCode.locator('xpath=ancestor::*[@data-visualization]').count()).toBe(0)

    // The first preview (HTML) renders an allow-scripts sandboxed iframe
    const htmlRegion = previewRegions.nth(0)
    await htmlRegion.scrollIntoViewIfNeeded()
    const htmlFrame = htmlRegion.locator('iframe')
    await htmlFrame.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await htmlFrame.getAttribute('sandbox')).toBe('allow-scripts')

    // Wait for the HTML preview iframe to load its button and interact
    const frameContent = htmlFrame.contentFrame()
    const counterBtn = frameContent.locator('#btn-counter')
    await counterBtn.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await counterBtn.textContent()).toBe('Clicks: 0')
    await counterBtn.click()
    await expect.poll(() => counterBtn.textContent()).toBe('Clicks: 1')

    // Test Source / Preview toggle without losing state
    const sourceBtn = htmlRegion.getByRole('button', { name: 'Source', exact: true })
    const previewBtn = htmlRegion.getByRole('button', { name: 'Preview', exact: true })
    await sourceBtn.click()
    await htmlRegion.locator('pre code').waitFor({ state: 'visible' })
    await htmlFrame.waitFor({ state: 'hidden' })

    await previewBtn.click()
    await htmlFrame.waitFor({ state: 'visible' })
    // Counter state preserved because same iframe remains mounted
    expect(await counterBtn.textContent()).toBe('Clicks: 1')

    // Test Enlarge modal dialog and close
    const enlargeBtn = htmlRegion.getByRole('button', { name: 'Enlarge', exact: true })
    await enlargeBtn.click()
    expect(await htmlRegion.getAttribute('role')).toBe('dialog')
    expect(await htmlRegion.getAttribute('aria-modal')).toBe('true')

    const closeBtn = htmlRegion.getByRole('button', { name: 'Close', exact: true })
    await closeBtn.click()
    expect(await htmlRegion.getAttribute('role')).toBe('region')
    expect(await counterBtn.textContent()).toBe('Clicks: 1')

    // The second preview (ECharts) becomes ready and renders canvas
    const echartsRegion = previewRegions.nth(1)
    const echartsFrame = echartsRegion.locator('iframe')
    await echartsFrame.waitFor({ state: 'attached', timeout: 15_000 })
    const echartsContent = echartsFrame.contentFrame()
    await expect.poll(() => echartsContent.locator('canvas').count(), { timeout: 15_000 }).toBeGreaterThan(0)

    // The third preview (Mermaid) renders svg diagram
    const mermaidRegion = previewRegions.nth(2)
    const mermaidFrame = mermaidRegion.locator('iframe')
    await mermaidFrame.waitFor({ state: 'attached', timeout: 15_000 })
    const mermaidContent = mermaidFrame.contentFrame()
    await expect.poll(() => mermaidContent.locator('svg').count(), { timeout: 15_000 }).toBeGreaterThan(0)

    // The fourth preview (invalid runtime) shows diagnostic alert and readable source
    const diagnosticRegion = previewRegions.nth(3)
    const alert = diagnosticRegion.locator('[role="alert"]')
    await alert.waitFor({ state: 'visible' })
    expect(await alert.textContent()).toContain('unavailable')
    expect(await diagnosticRegion.locator('pre code').textContent()).toContain('Should fail cleanly')

    // Verify download buttons exist for the valid blocks
    expect(await htmlRegion.getByRole('button', { name: 'Download HTML', exact: true }).count()).toBe(1)
    await expect.poll(() => mermaidRegion.getByRole('button', { name: 'Download SVG', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => echartsRegion.getByRole('button', { name: 'Download PNG', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)

    // Verify no untracked console errors leaked
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
