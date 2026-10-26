// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    expect(within(screen.getByRole('group', { name: '推理等级' })).getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    expect(within(screen.getByRole('group', { name: '推理等级' })).getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('group', { name: '推理等级' })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it.each([false, true])('announces rejected selections with ownership guidance only for held writers (%s)', async (sessionInUse) => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      const error = sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'session already contains images', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      directory.set(state({ groups, status: 'error', error: 'unrelated catalog refresh' }))
      return { ok: false as const, error }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : '模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('shows loading, partial-provider failures, and retries beside available models', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({
        status: 'loading',
        failures: [{ id: 'offline', name: 'Offline provider', message: 'unreachable' }],
      }))}
      load={load}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.getByText('正在刷新模型列表…')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.getByText('Offline provider 加载失败：unreachable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows an empty catalog without effort options', () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ current: null, groups: [] }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    expect(screen.queryByRole('group', { name: '推理等级' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect single-panel navigation', () => {
  function mountOpen(overrides: Partial<ModelDirectoryState> = {}) {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const directory = createSnapshotStore(state(overrides))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    return { trigger, select, directory }
  }

  it('opens the model list and current model efforts together', () => {
    mountOpen()
    expect(within(screen.getByRole('group', { name: 'DeepSeek' }))
      .getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }).getAttribute('aria-checked')).toBe('true')
    const efforts = within(screen.getByRole('group', { name: '推理等级' }))
    expect(efforts.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Off', 'High', 'Max'])
    expect(efforts.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
  })

  it('walks and wraps across model, effort, and context options without changing panels', () => {
    const { trigger } = mountOpen()
    const rows = screen.getAllByRole('menuitemradio')
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows.at(-1))
    fireEvent.keyDown(rows.at(-1)!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    expect(screen.getByRole('group', { name: 'DeepSeek' })).toBeTruthy()
  })

  it('settles a focused effort with Tab and restores the trigger focus', async () => {
    const { trigger, select } = mountOpen()
    const max = screen.getByRole('menuitemradio', { name: 'Max' })
    max.focus()
    expect(fireEvent.keyDown(max, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })

  it.each(['Escape', 'Shift+Tab'])('closes the single panel with one %s', async (key) => {
    const { trigger, select } = mountOpen()
    const high = screen.getByRole('menuitemradio', { name: 'High' })
    high.focus()
    fireEvent.keyDown(high, { key: key === 'Escape' ? key : 'Tab', shiftKey: key === 'Shift+Tab' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('enters at the selected model with Tab and at the last option with ArrowUp', () => {
    const { trigger } = mountOpen()
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '960K' }))
  })

  it.each([undefined, 640_000])('enters at the first model when the missing current model has context %s', (contextWindow) => {
    const { trigger } = mountOpen({
      current: { provider: 'gone', model: 'gone', ...contextWindow === undefined ? {} : { contextWindow } },
    })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', {
      name: contextWindow === undefined ? 'DeepSeek-V4-Flash' : '640K',
    }))
    expect(screen.queryByRole('group', { name: '推理等级' })).toBeNull()
  })

  it.each(['ready', 'selecting'] as const)('keeps empty-catalog Tab navigation usable while %s', (status) => {
    const { trigger } = mountOpen({
      current: { provider: 'gone', model: 'gone', contextWindow: 640_000 }, groups: [], status,
    })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(document.activeElement).toBe(status === 'selecting' ? trigger : screen.getByRole('menuitemradio', { name: '640K' }))
  })

  it('keeps a failed empty directory recoverable without entering a submenu', () => {
    const { trigger } = mountOpen({ current: null, groups: [], status: 'error', error: 'catalog down' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(trigger)
    const retry = screen.getByRole('button', { name: '重试' })
    retry.focus()
    expect(fireEvent.keyDown(retry, { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(retry, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['DeepSeek-V4-Flash', 'High'])('closes without writing the already selected %s', async (name) => {
    const { trigger, select } = mountOpen()
    fireEvent.click(screen.getByRole('menuitemradio', { name }))
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('prevents another submission while a selection is pending', () => {
    const { trigger, select } = mountOpen({ status: 'selecting' })
    for (const option of screen.getAllByRole('menuitemradio')) {
      expect((option as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(option)
    }
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(trigger)
    expect(select).not.toHaveBeenCalled()
  })
})


describe('ModelSelect context window', () => {
  function mount(current: ModelSelection | null = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, capacity?: number) {
    if (arguments.length < 2) capacity = 320_000
    const initial = state({ current })
    initial.groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning, ...capacity === undefined ? {} : { contextWindow: capacity } },
      { id: 'other', name: 'Other', contextWindow: 960_000 },
    ] }]
    const directory = createSnapshotStore(initial)
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...initial, current: selection })
      return { ok: true as const, value: undefined }
    })
    const props = { locked: false, available: true, directory, load: vi.fn(), select, t }
    const view = render(<ModelSelect {...props} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    return { ...view, props, directory, select, trigger, initial }
  }

  it.each([320_000, 131_072, undefined])('displays the inherited capacity %s without inventing an override', (capacity) => {
    const { trigger, select } = mount(undefined, capacity)
    const group = screen.getByRole('group', { name: '上下文窗口' })
    expect(within(group).getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['320K', '640K', '960K'])
    expect(within(group).getAllByRole('menuitemradio').map(row => row.getAttribute('aria-checked')))
      .toEqual(capacity === 320_000 ? ['true', 'false', 'false'] : ['false', 'false', 'false'])
    expect(within(group).getByText(capacity === undefined ? '当前：未知' : `当前：${capacity.toLocaleString('en-US')}`)).toBeTruthy()
    expect(trigger.textContent).not.toMatch(/320K|640K|960K/)
    expect(select).not.toHaveBeenCalled()
  })

  it('preserves effort when choosing a larger window and window when choosing effort', async () => {
    const { select, trigger } = mount()
    fireEvent.click(screen.getByRole('menuitemradio', { name: '640K' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: '640K' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Off' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off', contextWindow: 640_000 })
  })

  it('keeps inherited effort absent when selecting a window', async () => {
    const { select } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: '960K' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 960_000 })
  })

  it('retains context when returning to provider-default effort', async () => {
    const { props, rerender, directory, select } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    const next = directory.getSnapshot()
    directory.set({
      ...next,
      groups: [{ ...next.groups[0]!, models: [{ ...next.groups[0]!.models[0]!, reasoning: { efforts: reasoning.efforts } }] }],
    })
    rerender(<ModelSelect {...props} />)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 640_000 })
  })

  it('makes current window and same-model clicks no-ops and clears overrides on another model', async () => {
    const { select, trigger } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    fireEvent.click(screen.getByRole('menuitemradio', { name: '640K' }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'other' })
  })

  it.each(['selecting', 'locked'] as const)('disables context changes when %s', (status) => {
    const { props, directory, rerender, select, initial } = mount()
    if (status === 'selecting') directory.set({ ...initial, status: 'selecting' })
    rerender(<ModelSelect {...props} locked={status === 'locked'} />)
    const rows = within(screen.getByRole('group', { name: '上下文窗口' })).getAllByRole('menuitemradio')
    expect(rows.every(row => (row as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(rows[1]!)
    expect(select).not.toHaveBeenCalled()
  })

  it('announces a refused context change while retaining the current window', async () => {
    const { props, rerender, directory, initial } = mount()
    const select = vi.fn(async () => {
      directory.set({ ...initial, status: 'error', error: 'refused' })
      return { ok: false as const, error: new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') }) }
    })
    rerender(<ModelSelect {...props} select={select} />)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '640K' }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['error.sessionInUse'])
    expect(screen.getByRole('menuitemradio', { name: '320K' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('walks from efforts into context options and settles with Tab', async () => {
    const { select } = mount()
    const max = screen.getByRole('menuitemradio', { name: 'Max' })
    max.focus()
    fireEvent.keyDown(max, { key: 'ArrowDown' })
    const small = screen.getByRole('menuitemradio', { name: '320K' })
    expect(document.activeElement).toBe(small)
    fireEvent.keyDown(small, { key: 'ArrowDown' })
    const medium = screen.getByRole('menuitemradio', { name: '640K' })
    expect(document.activeElement).toBe(medium)
    fireEvent.keyDown(medium, { key: 'Tab' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
  })

  it('omits context selection until a current model is available', () => {
    mount(null)
    expect(screen.queryByRole('group', { name: '上下文窗口' })).toBeNull()
  })
})


describe('smaller context window feedback', () => {
  it.each([
    { previous: 960_000, accepted: true, notice: true },
    { previous: 320_000, accepted: true, notice: false },
    { previous: 960_000, accepted: false, notice: false },
  ])('shows the compression notice only after a successful decrease: $previous / $accepted', async ({ previous, accepted, notice }) => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: previous },
    }))
    const select = vi.fn(async () => accepted
      ? { ok: true as const, value: undefined }
      : {
        ok: false as const,
        error: new RemoteError('session/model-unavailable', 'unavailable', {
          provider: 'deepseek-official', model: 'deepseek-v4-flash',
        }),
      })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '640K' }))
    await waitFor(() => { expect(select).toHaveBeenCalledOnce() })
    await waitFor(() => {
      expect(screen.queryByText('已调小窗口，继续对话前将按需压缩上下文。') !== null).toBe(notice)
    })
  })
})
