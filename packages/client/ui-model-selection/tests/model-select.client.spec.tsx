// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    // The pane is one slider over the effort names, descriptions dropped.
    const slider = screen.getByRole('slider', { name: '推理等级' })
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
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const slider = screen.getByRole('slider', { name: '推理等级' })
    // No adapter default: the provider-default step leads the track.
    expect(slider.getAttribute('aria-valuetext')).toBe('Default')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByText('Standard')).toBeTruthy()
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
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
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

describe('ModelSelect keyboard walk', () => {
  function mountOpen() {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    return select
  }

  it('↑↓ walk the rows of the shown pane, wrapping, and stay open', () => {
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
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(twoModels)}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    // The trigger holds focus while the menu opens: the first forward step
    // enters at the first cell instead of skipping it. false = preventDefault ran.
    const cells = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(cells[0]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(cells[0])

    // The model pane keeps its rows, and the walk wraps there.
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    // The pane opens on its checked row, so walking starts from the current model.
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' }) // wraps to the top
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' }) // wraps to the bottom
    expect(document.activeElement).toBe(rows[1])

    // The effort pane is a slider, not rows: it opens on the slider and the
    // vertical keys stay with it instead of walking anywhere.
    fireEvent.keyDown(rows[1]!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const slider = screen.getByRole('slider', { name: '推理等级' })
    expect(document.activeElement).toBe(slider)
    expect(fireEvent.keyDown(slider, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(slider)
    expect(fireEvent.keyDown(slider, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(slider)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Tab settles the focused row like Enter and closes the menu', async () => {
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
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(twoModels)}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }) // current model → the other one
    expect(fireEvent.keyDown(rows[1]!, { key: 'Tab' })).toBe(false)
    // A model row submits the model; the host applies the model's own default
    // effort from there.
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('leaves Tab native on a focused slider, so the browser moves focus out of the card', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const slider = screen.getByRole('slider', { name: '推理等级' })
    // A slider is not a row to settle: the keystroke stays unconsumed, and the
    // focus leaving the card closes it through the blur path.
    expect(fireEvent.keyDown(slider, { key: 'Tab' })).toBe(true)
  })

  it('Shift+Tab leaves a drilled pane and then closes, like Escape', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const slider = screen.getByRole('slider', { name: '推理等级' })
    expect(fireEvent.keyDown(slider, { key: 'Tab', shiftKey: true })).toBe(false)
    // Back on the drilled cell, then closed on the second press.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(cells[1]!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Tab with the keyboard still on the trigger enters the menu at the value in use', () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    // A real click focuses the trigger first; jsdom's does not.
    trigger.focus()
    fireEvent.click(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
    // The root pane's first cell carries the current selection.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('a backward step from outside the list enters at the last row, and a closed menu leaves Tab native', () => {
    mountOpen()
    const cells = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(cells[0]!, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(cells.at(-1))
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('hands a drilled pane the focus its unmounted cell left behind, on the value in use', () => {
    const select = mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const slider = screen.getByRole('slider', { name: '推理等级' })
    // The fixture's model defaults to the High effort: the slider opens on the
    // step in use, not the first step.
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(document.activeElement).toBe(slider)
    // The keyboard steps from there.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
  })

  it('keeps the card navigable when a pane has no rows, and leaves a retry its Tab', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [], failures: [], status: 'error', error: 'catalog down',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    // A real click focuses the trigger first; jsdom's does not.
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    // No rows to hand the keyboard to: the trigger keeps it, so the card's
    // keys still reach the menu.
    expect(document.activeElement).toBe(trigger)

    const retry = screen.getByRole('button', { name: '重试' })
    retry.focus()
    // A control that is not a row keeps the browser's traversal.
    expect(fireEvent.keyDown(retry, { key: 'Tab' })).toBe(true)
    // Escape still backs out of the pane and then closes the card.
    fireEvent.keyDown(retry, { key: 'Escape' })
    // Back on the root pane, whose only cell remains (no model means no effort row).
    const cell = screen.getAllByRole('menuitem')[0]!
    fireEvent.keyDown(cell, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('drills into the model list on the selected model', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(rows[0])
  })

  it('Escape returns to the root pane with the keyboard on the cell that drilled in', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    fireEvent.keyDown(screen.getByRole('slider', { name: '推理等级' }), { key: 'Escape' })
    // The root pane is back with its three cells.
    const cells = screen.getAllByRole('menuitem')
    // Back on the drilled cell, so the next keystroke still reaches the menu.
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    // A second Escape closes back to the trigger.
    fireEvent.keyDown(cells[1]!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape from the model list lands back on the model cell', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0]!, { key: 'Escape' })
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
  })

  it('a pane whose rows mark no current value opens on its first row', () => {
    // The session runs a model the catalog no longer lists: no row is checked.
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ current: { provider: 'gone', model: 'gone' } }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(document.activeElement).toBe(rows[0])
  })
})

describe('ModelSelect context window', () => {
  function mount(current: ModelSelection | null = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, capacity?: number) {
    if (arguments.length < 2) capacity = 320_000
    const initial = state({ current })
    initial.groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        reasoning,
        ...capacity === undefined ? {} : { contextWindow: capacity },
      }, {
        id: 'other',
        name: 'Other',
        contextWindow: 960_000,
      }],
    }]
    const directory = createSnapshotStore(initial)
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...initial, current: selection })
      return { ok: true as const, value: undefined }
    })
    const props = { locked: false, available: true, directory, load: vi.fn(), select, t }
    const view = render(<ModelSelect {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    return { ...view, props, directory, select, initial }
  }

  /** Open the context pane from the root cell. */
  function drillContext(): void {
    fireEvent.click(screen.getByRole('menuitem', { name: /上下文窗口/ }))
  }

  it('summarizes the effective capacity on the root cell and drills into the presets', () => {
    mount()
    const cell = screen.getByRole('menuitem', { name: /上下文窗口/ })
    // The catalog capacity is a preset value, so the cell spells it short.
    expect(cell.textContent).toContain('320K')
    drillContext()
    // The presets are the slider's steps; the one in use carries the thumb.
    const slider = screen.getByRole('slider', { name: '上下文窗口' })
    expect(slider.getAttribute('aria-valuetext')).toBe('320K')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByText('320K')).toBeTruthy()
    expect(screen.getByText('640K')).toBeTruthy()
    expect(screen.getByText('960K')).toBeTruthy()
  })

  it('shows a non-preset capacity as its exact value without checking a preset', () => {
    mount(undefined, 262_144)
    expect(screen.getByRole('menuitem', { name: /上下文窗口/ }).textContent).toContain('262,144')
    drillContext()
    // The off-preset capacity stays on the track as its own step, so the thumb
    // never claims a preset the session is not using.
    const slider = screen.getByRole('slider', { name: '上下文窗口' })
    expect(slider.getAttribute('aria-valuetext')).toBe('262,144')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByText('320K')).toBeTruthy()
    expect(screen.getByText('960K')).toBeTruthy()
  })

  it('shows an unknown capacity when neither the selection nor the catalog advertises one', () => {
    mount(undefined, undefined)
    expect(screen.getByRole('menuitem', { name: /上下文窗口/ }).textContent).toContain('未知')
  })

  it('keeps the effort when choosing a window', async () => {
    const { select } = mount()
    drillContext()
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), { key: 'ArrowRight' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
  })

  it('keeps the explicit window when choosing Default effort', async () => {
    const { directory, select, initial } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    directory.set({ ...initial, groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 640_000, reasoning: { efforts: reasoning.efforts } },
    ] }] })
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    // Home jumps to the provider-default step, the track's first step.
    fireEvent.keyDown(screen.getByRole('slider', { name: '推理等级' }), { key: 'Home' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 640_000 })
  })

  it('makes current-window and same-model clicks no-ops and clears overrides on another model', async () => {
    const { select } = mount({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    // The slider holds 640K and never re-emits the step in use, so there is no
    // same-window write to make; the model rows keep their own no-op.
    drillContext()
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), { key: 'ArrowRight' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledTimes(1)
    select.mockClear()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'other' })
  })

  it('disables context changes while a selection is in flight', () => {
    const { props, directory, rerender, select, initial } = mount()
    directory.set({ ...initial, status: 'selecting' })
    rerender(<ModelSelect {...props} />)
    drillContext()
    const slider = screen.getByRole('slider', { name: '上下文窗口' })
    expect(slider.getAttribute('aria-disabled')).toBe('true')
    expect(slider.getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.pointerDown(slider, { clientX: 290, pointerId: 1 })
    expect(select).not.toHaveBeenCalled()
  })

  it('announces a refused context change while retaining the current window', async () => {
    const { props, rerender, directory, initial } = mount()
    const select = vi.fn(async () => {
      directory.set({ ...initial, status: 'error', error: 'refused' })
      return { ok: false as const, error: new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') }) }
    })
    rerender(<ModelSelect {...props} select={select} />)
    drillContext()
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), { key: 'ArrowRight' })
    expect((await screen.findByRole('alert')).textContent).toBe(zh['error.sessionInUse'])
    // The refused change leaves the thumb on the step in use.
    expect(screen.getByRole('slider', { name: '上下文窗口' }).getAttribute('aria-valuetext')).toBe('320K')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('steps the context slider with the keyboard and closes on the settled value', async () => {
    const { select } = mount()
    drillContext()
    // The pane opens on the step in use.
    const slider = screen.getByRole('slider', { name: '上下文窗口' })
    expect(document.activeElement).toBe(slider)
    expect(slider.getAttribute('aria-valuetext')).toBe('320K')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 640_000 })
  })

  it('Escape from the context pane lands back on the context cell', () => {
    mount()
    drillContext()
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), { key: 'Escape' })
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[2])
    fireEvent.keyDown(cells[2]!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('omits the context cell until a current model is available', () => {
    mount(null)
    expect(screen.queryByRole('menuitem', { name: /上下文窗口/ })).toBeNull()
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
    fireEvent.click(screen.getByRole('menuitem', { name: /上下文窗口/ }))
    // A decrease steps left, an increase steps right; both land on 640K.
    fireEvent.keyDown(screen.getByRole('slider', { name: '上下文窗口' }), {
      key: previous === 960_000 ? 'ArrowLeft' : 'ArrowRight',
    })
    await waitFor(() => { expect(select).toHaveBeenCalledOnce() })
    await waitFor(() => {
      expect(screen.queryByText('已调小窗口，继续对话前将按需压缩上下文。') !== null).toBe(notice)
    })
  })
})
