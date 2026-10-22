/** Latest-message editing through a real browser, shipped Host and live DeepSeek rounds. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

const LIVE = webSnapshotMode() === 'record'
const CREDENTIAL_PATH = process.env.DSH_E2E_CREDENTIALS_PATH
const ARTIFACT_ROOT = process.env.DSH_E2E_ARTIFACT_ROOT
const RUN_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '')
const INPUT_A = '请使用工具在当前工作目录创建 edit-proof.txt，内容为 EFFECT_KEEP。完成后只回复 BASE_A_OK。'
const INPUT_B = '只回复 ORIGINAL_B_OK，不调用工具。'
const EDIT_B = '只回复 EDITED_B_OK，不调用工具。'

describe.skipIf(!LIVE)('真实模型端到端：最新消息编辑', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let parentId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const serverErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      ...CREDENTIAL_PATH === undefined ? {} : { credentialStorePath: resolve(CREDENTIAL_PATH) },
    })
    scaffold.ctx.on('agent/error', (payload) => {
      serverErrors.push(payload.error instanceof Error ? payload.error.message : String(payload.error))
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    page.setDefaultTimeout(15_000)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'message-edit-live')
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  async function send(text: string): Promise<SessionId> {
    const input = page.locator('[data-composer-input]').first()
    await input.fill(text)
    const sendButton = page.getByRole('button', { name: '发送消息', exact: true })
    await expect.poll(() => sendButton.isEnabled(), { timeout: 15_000 }).toBe(true)
    const settled = scaffold.whenTurnSettled()
    await sendButton.click()
    const id = await settled
    await expect.poll(() => page.getByRole('button', { name: '编辑消息', exact: true }).getAttribute('aria-disabled'))
      .toBeNull()
    return id
  }

  async function capture(name: string): Promise<void> {
    if (ARTIFACT_ROOT === undefined) return
    await mkdir(ARTIFACT_ROOT, { recursive: true })
    await page.screenshot({ path: join(ARTIFACT_ROOT, `${name}_${RUN_DATE}.png`) })
  }

  async function saveEvidence(name: string, evidence: unknown): Promise<void> {
    if (ARTIFACT_ROOT === undefined) return
    await mkdir(ARTIFACT_ROOT, { recursive: true })
    await writeFile(join(ARTIFACT_ROOT, `${name}_${RUN_DATE}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  }

  it('编辑重发保留附件，刷新恢复有效历史，分支与外部文件互不回滚', async () => {
    onTestFailed(() => capture('失败现场'))
    console.info('实时端到端：发送原始消息 A')
    parentId = await send(INPUT_A)
    console.info('实时端到端：A 已结束，检查回答和文件')
    await page.getByText('BASE_A_OK', { exact: true }).waitFor()
    const workspace = join(scaffold.workspaceCwd, 'message-edit-live')
    expect((await readFile(join(workspace, 'edit-proof.txt'), 'utf8')).trim()).toBe('EFFECT_KEEP')
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('FIRST_ATTACHMENT') },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('SECOND_ATTACHMENT') },
    ])
    console.info('实时端到端：已选中两个附件，等待上传展示')
    await page.getByTitle('first.txt').waitFor()
    await page.getByTitle('second.txt').waitFor()
    parentId = await send(INPUT_B)
    console.info('实时端到端：B 已结束，检查编辑入口')
    await page.getByText('ORIGINAL_B_OK', { exact: true }).waitFor()
    const parent = scaffold.ctx.agents.get(parentId)!
    const original = parent.session.snapshotEvents().findLast(event => event.type === 'user/message')!
    expect(original.type).toBe('user/message')
    if (original.type !== 'user/message') throw new Error('Missing original user input')
    const attachments = original.data.content.filter(block => block.type !== 'text')
    expect(attachments).toHaveLength(2)
    const edit = page.getByRole('button', { name: '编辑消息', exact: true })
    expect(await edit.count()).toBe(1)
    await edit.click()
    const editor = page.getByRole('textbox', { name: '消息文本', exact: true })
    expect(await editor.inputValue()).toBe(INPUT_B)
    await editor.fill('应取消的草稿')
    await editor.press('Escape')
    expect(parent.session.snapshotEvents().filter(event => event.type === 'user/message-edit')).toHaveLength(0)
    await page.getByText('ORIGINAL_B_OK', { exact: true }).waitFor()
    await edit.click()
    await editor.fill(EDIT_B)
    await page.getByText('原附件保持不变。', { exact: true }).waitFor()
    await capture('编辑器与原附件')
    const settled = scaffold.whenTurnSettled()
    await editor.press('Control+Enter')
    await expect.poll(() => edit.getAttribute('aria-disabled')).toBe('true')
    await settled
    console.info('实时端到端：重发已结束')
    await page.getByText('EDITED_B_OK', { exact: true }).waitFor()
    const events = parent.session.snapshotEvents()
    const edited = events.filter(event => event.type === 'user/message-edit')
    expect(edited).toHaveLength(1)
    expect(edited[0]!.data.message.content.filter(block => block.type !== 'text')).toEqual(attachments)
    const effective = JSON.stringify(parent.session.deriveMessages())
    expect(effective).toContain(INPUT_A)
    expect(effective).toContain(EDIT_B)
    expect(effective).not.toContain(INPUT_B)
    expect(effective).not.toContain('ORIGINAL_B_OK')
    expect(await page.getByText(INPUT_B, { exact: true }).count()).toBe(0)
    expect(await page.getByText('ORIGINAL_B_OK', { exact: true }).count()).toBe(0)
    await capture('重发完成')
    await page.reload()
    await page.getByText('EDITED_B_OK', { exact: true }).waitFor()
    expect(await page.getByText(INPUT_B, { exact: true }).count()).toBe(0)
    await capture('刷新恢复')
    const parentBeforeFork = parent.session.snapshotEvents()
    await page.getByRole('button', { name: '在新对话中分支', exact: true }).first().click()
    await page.getByText('BASE_A_OK', { exact: true }).waitFor()
    await expect.poll(() => page.getByText(EDIT_B, { exact: true }).count()).toBe(0)
    await edit.click()
    expect(await editor.inputValue()).toBe(INPUT_A)
    await editor.fill('只回复 BRANCH_EDIT_OK，不调用工具。')
    const branchSettled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: '重新发送', exact: true }).click()
    const childId = await branchSettled
    await page.getByText('BRANCH_EDIT_OK', { exact: true }).waitFor()
    expect(childId).not.toBe(parentId)
    expect(parent.session.snapshotEvents()).toEqual(parentBeforeFork)
    expect((await readFile(join(workspace, 'edit-proof.txt'), 'utf8')).trim()).toBe('EFFECT_KEEP')
    await capture('历史分支编辑完成')
    expect(tripwire.pageErrors).toEqual([])
    expect(serverErrors).toEqual([])
    await saveEvidence('附件与分支证据', {
      result: '通过', providerMode: scaffold.mode, parentId, childId,
      model: parent.session.snapshotEvents().filter(event => event.type === 'request/context').map(event => event.data),
      originalAttachments: attachments,
      editedAttachments: edited[0]!.data.message.content.filter(block => block.type !== 'text'),
      parentUnchanged: true, originalInputExcluded: true, originalAnswerExcluded: true,
      persistedFile: { name: 'edit-proof.txt', content: 'EFFECT_KEEP' }, pageErrors: tripwire.pageErrors,
    })
  })

  it('运行中禁用编辑，手动停止后恢复编辑并生成真实新回答', async () => {
    onTestFailed(() => capture('停止场景失败现场'))
    await page.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' }).click()
    let stoppedId: SessionId | undefined
    const off = scaffold.ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user') stoppedId = session.id
    })
    onTestFailed(() => { off() })
    const input = page.locator('[data-composer-input][data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]')
    await input.waitFor({ state: 'visible' })
    await input.fill('请输出一篇五千字的中文技术文章，逐段解释数据库索引，不调用工具。')
    const sendButton = page.getByRole('button', { name: '发送消息', exact: true })
    await expect.poll(() => sendButton.isEnabled()).toBe(true)
    await sendButton.click()
    const stop = page.getByRole('button', { name: '停止生成', exact: true })
    await stop.waitFor()
    await expect.poll(() => stoppedId, { timeout: 15_000 }).toBeDefined()
    const edit = page.getByRole('button', { name: '编辑消息', exact: true })
    await expect.poll(() => edit.getAttribute('aria-disabled')).toBe('true')
    await capture('运行中编辑禁用')
    console.info('实时端到端：运行状态已验证，点击停止')
    await stop.click()
    console.info('实时端到端：停止操作已发出，等待回合结束')
    await expect.poll(() => stoppedId === undefined ? undefined : scaffold.ctx.agents.get(stoppedId)?.status,
      { timeout: 30_000 }).toBe('idle')
    off()
    if (stoppedId === undefined) throw new Error('Stopped input was not committed')
    await saveEvidence('停止生命周期诊断', {
      events: scaffold.ctx.agents.get(stoppedId)!.session.snapshotEvents().map(event => ({ seq: event.seq, type: event.type })),
      serverErrors,
    })
    expect(scaffold.ctx.agents.get(stoppedId)!.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind)
      .toBe('aborted')
    console.info('实时端到端：停止回合已结束，等待编辑恢复')
    await expect.poll(() => edit.getAttribute('aria-disabled')).toBeNull()
    await edit.click()
    const editor = page.getByRole('textbox', { name: '消息文本', exact: true })
    await editor.fill('只回复 AFTER_STOP_EDIT_OK，不调用工具。')
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: '重新发送', exact: true }).click()
    expect(await settled).toBe(stoppedId)
    await page.getByText('AFTER_STOP_EDIT_OK', { exact: true }).waitFor()
    await capture('停止后编辑成功')
    expect(tripwire.pageErrors).toEqual([])
    expect(serverErrors).toEqual([])
    await saveEvidence('停止与重发证据', {
      result: '通过', providerMode: scaffold.mode, sessionId: stoppedId,
      model: scaffold.ctx.agents.get(stoppedId)!.session.snapshotEvents()
        .filter(event => event.type === 'request/context').map(event => event.data),
      runningEditDisabled: true, stoppedEditEnabled: true, newResponse: 'AFTER_STOP_EDIT_OK',
      pageErrors: tripwire.pageErrors,
    })
  })
})
