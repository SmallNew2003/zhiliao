// @vitest-environment jsdom
/** Embedded Conversation uses the production slot renderer and composer input machine. */
import './control-row-dom.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/apply.ts'
import type { InputHub } from '../src/client/input/hub.ts'
import type { IConversation } from '../src/client/service.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.assistant.conversation': {
      kind: 'single'
      scope: 'session'
      owner: { workspaceMode?: 'required' | 'optional' }
    }
  }
}

usePinnedBrowserLanguages('zh-CN')
const SID = 'global-assistant' as SessionId
const ORDINARY = 'ordinary-session' as SessionId
const runtimes: SlotTestRuntime[] = []
const observers: ResizeObserverStub[] = []
const rangeGeometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
class ResizeObserverStub {
  readonly targets = new Set<Element>()
  constructor() { observers.push(this) }
  observe(target: Element): void { this.targets.add(target) }
  disconnect(): void { this.targets.clear() }
}
function Embedded({ renderFactorySlot, workspaceMode }: PropsRuntime<'test.assistant.conversation'> & PropsRenderFactories) {
  return renderFactorySlot('conversation.embedded', workspaceMode === undefined ? {} : { workspaceMode })
}
function ModelPicker() { return <button type="button">Choose model</button> }

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
  }) })
})
afterEach(async () => {
  cleanup()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  observers.length = 0
  if (rangeGeometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  else Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeGeometry)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function bench(withMain = true, ordinaryMain = false) {
  const sessionId = ordinaryMain ? ORDINARY : SID
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  runtime.ctx.provide('uiWorkspace', { openWorkspace: vi.fn(), openSession: vi.fn() } as never)
  runtime.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  const prompt = vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } }))
  await runtime.sessions.add({
    id: sessionId,
    summary: { title: 'Assistant', displayTitle: 'Assistant', blank: true },
    snapshot: { blank: true },
    session: { prompt, loadOlder: vi.fn<ISession['loadOlder']>() },
  })
  const reference = runtime.sessions.retain(sessionId, { source: 'mainView' })
  const children = {
    ...(withMain ? { main: { kind: 'keyed' as const, scope: 'root' as const } } : {}),
    'test.assistant.conversation': { kind: 'single', scope: 'session' },
  } as const
  if (ordinaryMain) {
    await runtime.root.declare(children, ({ renderSlot, SessionProvider }) => (
      <SessionProvider session={reference}>{renderSlot('main', {}, { entryKey: 'conversation' })}</SessionProvider>
    ))
  } else await runtime.declare(children)
  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.slots.register({ name: 'test.assistant.conversation' }, Embedded)
  const main = ordinaryMain ? runtime.renderRoot() : undefined
  if (!ordinaryMain) runtime.renderSlot('test.assistant.conversation', {}, { session: reference })
  expect(runtime.factoryOf('conversation.embedded').scope).toBe('session')
  const conversation = runtime.ctx.get('conversation') as IConversation
  return { runtime, reference, prompt, conversation, feature, main, inputHub: conversation.input as InputHub }
}

describe('embedded Conversation', () => {
  it('accepts an ungrouped assistant draft and sends through the ordinary composer', async () => {
    const b = await bench(false)
    const view = b.runtime.renderSlot('test.assistant.conversation', { workspaceMode: 'optional' }, { session: b.reference })
    const editor = view.container.querySelector<HTMLElement>('[data-composer-input]')!
    expect(editor.getAttribute('contenteditable')).toBe('true')
    expect(view.view.queryByRole('button', { name: '选择工作区' })).toBeNull()
    act(() => { b.inputHub.shell(SID).setDraft('请帮我跟进任务') })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    expect(b.prompt.mock.calls[0]![0]).toEqual([{ type: 'text', text: '请帮我跟进任务' }])
  })

  it('keeps the default embedded Workspace prerequisite', async () => {
    const b = await bench()
    const embedded = b.runtime.renderSlot('test.assistant.conversation', {}, { session: b.reference })
    expect(embedded.container.querySelector('[data-composer-input]')?.getAttribute('contenteditable')).not.toBe('true')
    expect(embedded.view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    embedded.update({ workspaceMode: 'optional' })
    expect(embedded.container.querySelector('[data-composer-input]')?.getAttribute('contenteditable')).toBe('true')
    embedded.update({})
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it('requires a Workspace for a bound ordinary main Session before sending its retained draft', async () => {
    const b = await bench(true, true)
    const main = b.main!
    const body = main.container.querySelector('[data-conversation-content]')!
    expect(body.getAttribute('data-conversation-session')).toBe(ORDINARY)
    const editor = main.container.querySelector<HTMLElement>('[data-composer-input]')!
    act(() => { b.inputHub.shell(ORDINARY).setDraft('普通会话草稿') })
    expect(editor.getAttribute('contenteditable')).not.toBe('true')
    expect(main.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.inputHub.shell(ORDINARY).snapshot.draft).toBe('普通会话草稿')
    await b.runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'ordinary-workspace' as WorkspaceId, title: 'Workspace', path: '/workspace',
        sessionIds: [ORDINARY], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }]
    })
    expect(main.container.querySelector('[data-composer-input]')).toBe(editor)
    expect(editor.getAttribute('contenteditable')).toBe('true')
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    expect(b.prompt.mock.calls[0]![0]).toEqual([{ type: 'text', text: '普通会话草稿' }])
  })

  it('keeps model selection reachable while its block prevents input and submission', async () => {
    const b = await bench()
    b.runtime.slots.register({ name: 'conversation.input.model' }, ModelPicker)
    act(() => {
      b.inputHub.shell(SID).setDraft('模型选择完成后发送')
      b.conversation.blocks.set(SID, { reason: '请先选择模型' })
    })
    const view = b.runtime.renderSlot('test.assistant.conversation', { workspaceMode: 'optional' }, { session: b.reference })
    const editor = view.container.querySelector<HTMLElement>('[data-composer-input]')!
    expect(editor.getAttribute('contenteditable')).not.toBe('true')
    expect(view.view.getByRole('button', { name: 'Choose model' })).toBeTruthy()
    expect(editor.getAttribute('data-placeholder')).toBe('请先选择模型')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(b.prompt).not.toHaveBeenCalled()
    act(() => { b.conversation.blocks.set(SID, undefined) })
    expect(view.container.querySelector('[data-composer-input]')).toBe(editor)
    expect(editor.getAttribute('contenteditable')).toBe('true')
  })

  it('preserves focused draft identity across hero activation and releases measurements on disposal', async () => {
    const b = await bench()
    const view = b.runtime.renderSlot('test.assistant.conversation', { workspaceMode: 'optional' }, { session: b.reference })
    const editor = view.container.querySelector<HTMLElement>('[data-composer-input]')!
    act(() => { b.inputHub.shell(SID).setDraft('保留草稿'); editor.focus() })
    expect(document.activeElement).toBe(editor)
    await b.runtime.sessions.updateSessionSnapshot(SID, (draft) => { draft.blank = false })
    expect(view.container.querySelector('[data-conversation-content]')?.getAttribute('data-content-phase')).toBe('active')
    expect(view.container.querySelector('[data-composer-input]')).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.textContent).toBe('保留草稿')
    expect(observers.some(observer => observer.targets.size > 0)).toBe(true)
    await b.feature.dispose()
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true)
    expect(() => b.runtime.factoryOf('conversation.embedded')).toThrow()
  })
})
