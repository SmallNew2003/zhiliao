// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
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
    pending: null,
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    // The effort section is one slider over the effort names, descriptions dropped.
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByText('Max')).toBeTruthy()
    expect(screen.queryByText('Largest budget')).toBeNull()

    // The keyboard steps the slider: High → Max.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    // No adapter default: the provider-default step leads the track.
    expect(slider.getAttribute('aria-valuetext')).toBe('Default')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByText('Standard')).toBeTruthy()
  })

  it('hides a saved route absent from the current catalog', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '请选择模型' })
    expect(trigger.textContent).not.toContain('removed-model')
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
      const { container } = render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
      locked={false}
      available
      directory={createSnapshotStore(state({ current: null, groups: [] }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '请选择模型' }))
    expect(screen.getByText(t('empty.models'))).toBeTruthy()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    expect(screen.queryByRole('group', { name: '推理等级' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
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
    // The efforts are one slider over the advertised levels, on the step in use.
    expect(within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider').getAttribute('aria-valuetext')).toBe('High')
  })

  it('walks and wraps across the model rows, leaving the sliders their own keys', () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const twoModels = state()
    twoModels.groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
      ],
    }]
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
      locked={false}
      available
      directory={createSnapshotStore(twoModels)}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    // Only the model rows take the row traversal; the effort and context
    // sections hold sliders, which keep the arrow keys themselves.
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(row => row.textContent)).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows.at(-1))
    fireEvent.keyDown(rows.at(-1)!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    expect(screen.getByRole('group', { name: 'DeepSeek' })).toBeTruthy()

    // A focused slider consumes the vertical keys instead of walking.
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    slider.focus()
    expect(fireEvent.keyDown(slider, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(slider)
    expect(fireEvent.keyDown(slider, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(slider)
  })

  it('leaves Tab native on a focused slider, so the browser moves focus out', () => {
    const { select } = mountOpen()
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    slider.focus()
    // A slider is not a row to settle: the keystroke stays unconsumed, and the
    // focus leaving the card closes it through the blur path.
    expect(fireEvent.keyDown(slider, { key: 'Tab' })).toBe(true)
    expect(select).not.toHaveBeenCalled()
  })

  it.each(['Escape', 'Shift+Tab'])('closes the single panel with one %s', async (key) => {
    const { trigger, select } = mountOpen()
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    slider.focus()
    fireEvent.keyDown(slider, { key: key === 'Escape' ? key : 'Tab', shiftKey: key === 'Shift+Tab' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('enters at the selected model with Tab and at the last model row with ArrowUp', () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const twoModels = state()
    twoModels.groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
      ],
    }]
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
      locked={false}
      available
      directory={createSnapshotStore(twoModels)}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    // The context section holds a slider, not a row: the last row is a model.
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro' }))
  })

  it.each([undefined, 640_000])('enters at the first model when the missing current model has context %s', (contextWindow) => {
    const { trigger } = mountOpen({
      current: { provider: 'gone', model: 'gone', ...contextWindow === undefined ? {} : { contextWindow } },
    })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    // No row is checked (the current model is gone) and the context section
    // holds a slider, not a row: the keyboard enters at the first model row.
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    expect(screen.queryByRole('group', { name: '推理等级' })).toBeNull()
  })

  it.each(['ready', 'selecting'] as const)('keeps empty-catalog Tab navigation usable while %s', (status) => {
    const { trigger } = mountOpen({
      current: { provider: 'gone', model: 'gone', contextWindow: 640_000 }, groups: [], status,
    })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    // No model rows and no effort section: the context section's slider is not
    // a row, so the trigger keeps the keyboard and the card's keys still land.
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('slider', { name: '上下文窗口' })).toBeTruthy()
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

  it('closes without writing the already selected model', async () => {
    const { trigger, select } = mountOpen()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('selects the effort step under the pointer on the track', async () => {
    const { select } = mountOpen()
    const slider = within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider')
    // jsdom has no layout: stub the track box so the position math runs.
    slider.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 4, right: 300, bottom: 4, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(slider, { clientX: 10, pointerId: 1 })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off',
      })
    })
    // The step applies in place: the menu stays open so the pointer can keep
    // travelling the track.
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('leaves the rows and sliders usable while a slider write is open', () => {
    const { trigger, select } = mountOpen({ status: 'selecting' })
    // A write the sliders have open spans the drag itself; dimming every model row
    // behind it is what read as the panel stuttering.
    for (const option of screen.getAllByRole('menuitemradio')) {
      expect((option as HTMLButtonElement).disabled).toBe(false)
    }
    for (const slider of screen.getAllByRole('slider')) {
      expect(slider.getAttribute('aria-disabled')).toBeNull()
    }
    // The card still reports the write: aria-busy carries it, not the rows.
    expect(screen.getByRole('menu').getAttribute('aria-busy')).toBe('true')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[0])
    expect(select).not.toHaveBeenCalled()
  })

  it('refuses a second model row while the first row is still writing', async () => {
    /** What the seat's `select` verb settles with. */
    type Settled = { ok: true; value: undefined } | { ok: false; error: RemoteError<'session/writer-held'> }
    let release: ((result: Settled) => void) | undefined
    const select = vi.fn(() => new Promise<Settled>((resolve) => { release = resolve }))
    const opened = state()
    opened.groups = [{
      ...opened.groups[0]!,
      models: [opened.groups[0]!.models[0]!, { id: 'other', name: 'Other' }],
    }]
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
      locked={false}
      available
      directory={createSnapshotStore(opened)}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other' }))
    expect(select).toHaveBeenCalledTimes(1)
    const second = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
    expect((second as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(second)
    expect(select).toHaveBeenCalledTimes(1)
    release?.({ ok: false, error: new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') }) })
    // A refused row write leaves the panel open with every row usable again.
    await waitFor(() => { expect((second as HTMLButtonElement).disabled).toBe(false) })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(select).toHaveBeenCalledTimes(1)
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
    const view = render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    return { ...view, props, directory, select, trigger, initial }
  }

  it.each([320_000, 131_072, undefined])('displays the inherited capacity %s without inventing an override', (capacity) => {
    const { trigger, select } = mount(undefined, capacity)
    const group = screen.getByRole('group', { name: '上下文窗口' })
    // The presets are the slider's steps; an off-preset capacity joins them as
    // its own step, so the thumb never claims a preset the session is not using.
    const steps = capacity === undefined || capacity === 320_000
      ? ['320K', '640K', '960K']
      : ['131,072', '320K', '640K', '960K']
    for (const step of steps) expect(within(group).getByText(step)).toBeTruthy()
    const expectedText = capacity === undefined ? '320K' : capacity === 320_000 ? '320K' : '131,072'
    expect(within(group).getByRole('slider').getAttribute('aria-valuetext')).toBe(expectedText)
    expect(within(group).getByText(capacity === undefined ? '当前：未知' : `当前：${capacity.toLocaleString('en-US')}`)).toBeTruthy()
    expect(trigger.textContent).not.toMatch(/320K|640K|960K/)
    expect(select).not.toHaveBeenCalled()
  })

  it('preserves effort when choosing a larger window and window when choosing effort', async () => {
    const { select } = mount()
    const contextSlider = within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider')
    fireEvent.keyDown(contextSlider, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    })
    // Neither step closes the menu, so the second slider is reached in place.
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(contextSlider.getAttribute('aria-valuetext')).toBe('640K')
    fireEvent.keyDown(within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider'), { key: 'Home' })
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off', contextWindow: 640_000 })
    })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('keeps inherited effort absent when selecting a window', async () => {
    const { select } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    fireEvent.keyDown(within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider'), { key: 'End' })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 960_000 })
    })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('retains context when returning to provider-default effort', async () => {
    const { props, rerender, directory, select } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    const next = directory.getSnapshot()
    directory.set({
      ...next,
      groups: [{ ...next.groups[0]!, models: [{ ...next.groups[0]!.models[0]!, reasoning: { efforts: reasoning.efforts } }] }],
    })
    rerender(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} />)
    // Home jumps to the provider-default step, the track's first step.
    fireEvent.keyDown(within(screen.getByRole('group', { name: '推理等级' })).getByRole('slider'), { key: 'Home' })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 640_000 })
    })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('makes same-model clicks no-ops and clears overrides on another model', async () => {
    const { select, trigger } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    // The slider holds 640K and never re-emits the step in use, so there is no
    // same-window write to make; the model rows keep their own no-op.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'other' })
  })

  it('disables context changes when locked', () => {
    const { props, rerender, select } = mount()
    rerender(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} locked />)
    const slider = within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider')
    expect(slider.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.pointerDown(slider, { clientX: 290, pointerId: 1 })
    expect(select).not.toHaveBeenCalled()
  })

  it('submits the step a drag ends on once an earlier window write settles', async () => {
    const { props, directory, rerender, initial } = mount()
    const calls: ModelSelection[] = []
    let release: (() => void) | undefined
    // The first write stays open, the way a slow Host does, so the steps a drag
    // crosses after it queue rather than pile up as requests.
    const deferred = vi.fn((selection: ModelSelection) => new Promise<{ ok: true; value: undefined }>((resolve) => {
      calls.push(selection)
      const settle = (): void => {
        directory.set({ ...initial, current: selection })
        resolve({ ok: true, value: undefined })
      }
      if (calls.length === 1) release = settle
      else settle()
    }))
    rerender(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} select={deferred} />)
    const slider = within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider')
    slider.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 6, right: 300, bottom: 6, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(slider, { clientX: 150, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 290, pointerId: 1 })
    expect(calls).toHaveLength(1)
    // The step in view is the one the pointer holds, write open or not.
    expect(slider.getAttribute('aria-valuetext')).toBe('960K')
    release?.()
    await waitFor(() => { expect(calls).toHaveLength(2) })
    expect(calls[1]).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 960_000,
    })
  })

  it('preserves the accepted window when an effort change waits for it', async () => {
    const { props, directory, rerender, initial } = mount()
    let release: (() => void) | undefined
    const calls: ModelSelection[] = []
    const select = (selection: ModelSelection) => new Promise<{ ok: true; value: undefined }>((resolve) => {
      calls.push(selection)
      const settle = () => {
        directory.set({ ...initial, current: selection })
        resolve({ ok: true, value: undefined })
      }
      if (calls.length === 1) release = settle
      else settle()
    })
    rerender(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en}
      renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} select={select} />)
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('slider', { name: '推理等级' }), { key: 'ArrowLeft' })
    release?.()
    await waitFor(() => { expect(calls).toHaveLength(2) })
    expect(calls[1]).toMatchObject({ contextWindow: 640_000, reasoningEffort: 'high' })
  })

  it('announces a refused context change while retaining the current window', async () => {
    const { props, rerender, directory, initial } = mount()
    const select = vi.fn(async () => {
      directory.set({ ...initial, status: 'error', error: 'refused' })
      return { ok: false as const, error: new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') }) }
    })
    rerender(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} {...props} select={select} />)
    fireEvent.keyDown(within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider'), { key: 'ArrowRight' })
    expect((await screen.findByRole('alert')).textContent).toBe(zh['error.sessionInUse'])
    // The refused change leaves the thumb on the step in use.
    expect(within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider').getAttribute('aria-valuetext')).toBe('320K')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('steps the context slider with the keyboard and applies the step in place', async () => {
    const { select } = mount()
    const slider = within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider')
    // The slider opens on the step in use.
    expect(slider.getAttribute('aria-valuetext')).toBe('320K')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    })
    // The menu stays open, and the thumb travels with the settled value.
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(slider.getAttribute('aria-valuetext')).toBe('640K')
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
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    // A decrease steps left, an increase steps right; both land on 640K.
    fireEvent.keyDown(within(screen.getByRole('group', { name: '上下文窗口' })).getByRole('slider'), {
      key: previous === 960_000 ? 'ArrowLeft' : 'ArrowRight',
    })
    await waitFor(() => { expect(select).toHaveBeenCalledOnce() })
    await waitFor(() => {
      expect(screen.queryByText('已调小窗口，继续对话前将按需压缩上下文。') !== null).toBe(notice)
    })
  })
})

describe('ModelSelect enhancements: search, recents, and action links', () => {
  const fiveModelsState = () => state({
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
          { id: 'o1-preview', name: 'o1-preview', reasoning },
        ],
      },
    ],
  })

  it('filters models by model name and provider name and clears search query', () => {
    const directory = createSnapshotStore(fiveModelsState())
    render(
      <ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
        locked={false}
        available
        directory={directory}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))

    const searchBox = screen.getByRole('searchbox')
    expect(searchBox).toBeTruthy()

    // Filter by provider name
    fireEvent.change(searchBox, { target: { value: 'openai' } })
    expect(screen.getByRole('menuitemradio', { name: 'GPT-4o' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeNull()

    // Clear search
    const clearBtn = screen.getByRole('button', { name: '清除搜索' })
    fireEvent.click(clearBtn)
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'GPT-4o' })).toBeTruthy()
  })

  it('keeps catalog retry available after a provider failure', () => {
    const directory = createSnapshotStore(state({
      failures: [{ id: 'openai', name: 'OpenAI', message: 'invalid key' }],
    }))
    const load = vi.fn()
    render(
      <ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null}
        locked={false}
        available
        directory={directory}
        load={load}
        select={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))

    load.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(load).toHaveBeenCalledOnce()
  })

  it('records recent selections and renders recent models section when catalog has > 4 models', async () => {
    localStorage.clear()
    const directory = createSnapshotStore(fiveModelsState())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection, groups: fiveModelsState().groups }))
      return { ok: true as const, value: undefined }
    })
    const { unmount } = render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    // Initially no recent group
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.queryByRole('group', { name: '最近使用' })).toBeNull()

    // Select GPT-4o
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-4o' }))
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-4o' }))
    unmount()

    // Reopen menu: recent group is displayed
    render(<ModelSelect resolveText={text => typeof text === 'string' ? text : text.en} renderSlot={(_name, _owner, options) => options?.fallback ?? null} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.getByRole('group', { name: '最近使用' })).toBeTruthy()
  })
})


const renderLabel: ComponentProps<typeof ModelSelect>['renderSlot'] = (_name, _owner, options) => options?.fallback ?? null
const resolveText: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.en
describe('ModelSelect label slot', () => {
  it('distinguishes identical model names and ids by provider across all placements and restores labels on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const sessionId = SessionId('model-label')
    await runtime.sessions.add({ id: sessionId })
    const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
    const groups = ['trusted', 'external'].map(id => ({
      id, name: `${id} gateway`, models: [{ id: 'same-model', name: 'Same model' }],
    }))
    const directory = createSnapshotStore(state({ groups, current: { provider: 'trusted', model: 'same-model' } }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((snapshot) => { snapshot.current = selection })
      return { ok: true as const, value: undefined }
    })
    await runtime.root.declare({
      'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
    }, ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      <ModelSelect locked={false} available directory={directory} load={vi.fn()}
        resolveText={resolveText} select={select} t={t} renderSlot={renderSlot} />
    </SessionProvider>)
    runtime.renderRoot()
    const trigger = screen.getByRole('button', { name: '选择模型，当前 Same model' })
    expect(trigger.textContent).toBe('Same model')
    const plugin = await runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
      }, ({ provider, model, placement, selected }) => <span
        data-testid={`${placement}-${provider.id}`}
        data-selected={selected}
        title={provider.name}
      >{provider.id}: {model.name}</span>))
    } })
    expect(screen.getByTestId('trigger-trusted').textContent).toBe('trusted: Same model')
    expect(screen.getByTestId('trigger-trusted').title).toBe('trusted gateway')
    expect(trigger.querySelector('div')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByTestId('option-trusted').getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('option-external').getAttribute('data-selected')).toBe('false')
    const external = screen.getByRole('menuitemradio', { name: 'external: Same model' })
    expect(external.querySelector('[data-provider-id="external"][data-model-id="same-model"]')).toBeTruthy()
    expect(external.querySelector('div')).toBeNull()
    screen.getByRole('menuitemradio', { name: 'trusted: Same model' }).focus()
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'trusted: Same model' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(external)
    fireEvent.keyDown(external, { key: 'Tab' })
    await waitFor(() => { expect(screen.getByTestId('trigger-external')).toBeTruthy() })
    expect(select).toHaveBeenCalledWith({ provider: 'external', model: 'same-model' })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    await act(async () => { await plugin.dispose() })
    expect(runtime.slots.entries('conversation.input.model.label')).toHaveLength(0)
    expect(trigger.textContent).toBe('Same model')
    expect(trigger.querySelector('[data-provider-id="external"][data-model-id="same-model"]')).toBeTruthy()
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Same model', 'Same model'])
  })

  it('does not decorate loading or missing selections with a stale provider', () => {
    const directory = createSnapshotStore(state({ groups: [], status: 'loading' }))
    const renderSlot = vi.fn(() => null)
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()}
      resolveText={resolveText} select={vi.fn()} t={t} renderSlot={renderSlot} />)
    expect(renderSlot).not.toHaveBeenCalled()
    expect(document.querySelector('[data-provider-id]')).toBeNull()
    act(() => { directory.set(state({ groups: [] })) })
    expect(screen.getByRole('button', { name: '请选择模型' })).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalled()
  })
})

describe('ModelSelect catalog badges', () => {
  const BADGE = { text: { en: 'New', zh: '新' }, tone: 'info' } as const
  const badged = () => state({
    current: { provider: 'deepseek-official', model: 'deepseek-flash' },
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', badge: BADGE },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }],
  })
  const chinese: ComponentProps<typeof ModelSelect>['resolveText'] = text => typeof text === 'string' ? text : text.zh ?? text.en

  it('places the badge before the trigger name and after names in the menus', () => {
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(badged())}
      load={vi.fn()} resolveText={chinese} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4.1-Flash' })
    expect(trigger.textContent).toBe('新 DeepSeek-V4.1-Flash')
    expect(screen.getByText('新').getAttribute('data-tone')).toBe('info')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['DeepSeek-V4.1-Flash 新', 'DeepSeek-V4-Pro'])
  })

  it('hands the badge to a label contribution, which replaces the default rendering', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const sessionId = SessionId('model-badge')
    await runtime.sessions.add({ id: sessionId })
    const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
    await runtime.root.declare({
      'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
    }, ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      <ModelSelect locked={false} available directory={createSnapshotStore(badged())} load={vi.fn()} resolveText={chinese}
        select={vi.fn()} t={t} renderSlot={renderSlot} />
    </SessionProvider>)
    runtime.renderRoot()
    await runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
      }, ({ model }) => <span>{model.name} [{model.badge?.tone ?? 'none'}]</span>))
    } })
    expect(screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4.1-Flash' }).textContent).toBe('DeepSeek-V4.1-Flash [info]')
    expect(screen.queryByText('新')).toBeNull()
  })
})
