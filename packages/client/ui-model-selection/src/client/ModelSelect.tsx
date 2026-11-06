/**
 * Composer model, reasoning-effort, and context-window selection over the shared ModelDirectory.
 * Provider-grouped models and the current model's advertised efforts share one
 * panel, with a snapping slider over the effort levels and one over the context
 * presets. The two sliders stay pinned below the model list, which is what
 * scrolls. Arrow keys traverse the model rows; Tab selects, while Escape and Shift+Tab
 * close and restore the trigger. A focused slider keeps the arrow keys itself, so
 * the row traversal never pulls the keyboard off it. A slider step applies its
 * selection in place and leaves the menu open, so the pointer can keep travelling
 * the track; one write runs at a time, and a step the pointer reaches during
 * another replaces the step still waiting. Choosing a model row settles and
 * closes. Catalog errors offer Retry and Configuration in
 * the panel; rejected selections use the composer-anchored Toast.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseFillRegular,
  IconDataOutlineRegular, IconSearchOutlineRegular,
  IconWarningOutlineRegular, Slider, Toast, Tag, MenuSurface, MenuGroup, observeStickyMenuGroups, StateDot, rankByName,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected, ModelLabelOwner } from './slots.ts'
import css from './ModelSelect.module.css'
import { orderModelProviders } from './provider-order.ts'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** A step the pointer or keyboard asks a slider for. */
type SliderStep = { kind: 'effort'; effort: string | undefined } | { kind: 'window'; value: number }

/** Context budgets offered as presets, in tokens. */
const CONTEXT_WINDOW_PRESETS = [320_000, 640_000, 960_000]

/** Storage key for recent model selections. */
const RECENT_MODELS_STORAGE_KEY = 'dsh.model.recents'
const MAX_RECENT_MODELS = 3

interface RecentModelItem {
  provider: string
  model: string
}

function isRecentModelItem(item: unknown): item is RecentModelItem {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as Record<string, unknown>
  return typeof candidate.provider === 'string' && typeof candidate.model === 'string'
}

function readRecentModels(): RecentModelItem[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(RECENT_MODELS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentModelItem)
  } catch (_error) {
    // Unavailable browser storage leaves the recent list empty.
    return []
  }
}

function recordRecentModel(selection: ModelSelection): void {
  if (typeof localStorage === 'undefined') return
  try {
    const existing = readRecentModels().filter(
      r => !(r.provider === selection.provider && r.model === selection.model),
    )
    const updated = [
      { provider: selection.provider, model: selection.model },
      ...existing,
    ].slice(0, MAX_RECENT_MODELS)
    localStorage.setItem(RECENT_MODELS_STORAGE_KEY, JSON.stringify(updated))
  } catch (_error) {
    // Browser storage may be unavailable; the model selection remains active.
  }
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the combined model, effort, and context menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, resolveText, t, renderSlot }:
  ModelSelectInjected & Pick<PropsRuntime<'conversation.input.model'>, 'locked'> & PropsLocale<'model'>
    & Omit<PropsRenderSlots<'conversation.input.model.label'>, 'SessionProvider'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  // Whether a model row's own write is open: the rows refuse a second one while
  // it is, and nothing else dims them.
  const [rowWrite, setRowWrite] = useState(false)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // A slider write runs one at a time, and a step the pointer reaches while one
  // is in flight replaces the step still waiting: a drag submits where it ends.
  const writingRef = useRef(false)
  const queuedStep = useRef<SliderStep | null>(null)
  const id = useId()

  const groups = useMemo(() => orderModelProviders(state.groups).map(group => ({
    ...group,
    provider: { id: group.id, name: group.id === 'deepseek-account' ? t('provider.account') : group.name },
  })), [state.groups, t])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const contextWindow = state.current?.contextWindow ?? currentChoice?.model.contextWindow
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const contextStepLabel = (value: number): string => CONTEXT_WINDOW_PRESETS.includes(value)
    ? t('context.preset', { value: value / 1000 })
    : value.toLocaleString('en-US')
  // A window the catalog carries but the presets do not (a model's own
  // default, say) stays on the track as an extra step, so the thumb never
  // claims a preset the session is not using.
  const contextSteps = contextWindow !== undefined && !CONTEXT_WINDOW_PRESETS.includes(contextWindow)
    ? [...CONTEXT_WINDOW_PRESETS, contextWindow].sort((a, b) => a - b)
    : CONTEXT_WINDOW_PRESETS
  const effortLabel = currentChoice === undefined
    ? undefined
    : reasoning === undefined
      ? state.retainedEffort
      : effectiveEffort === undefined
        ? t('effort.providerDefault')
        : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const pending = state.pending
  const busy = pending !== null || state.status === 'selecting'

  const showSearch = choices.length > 4

  const isReasoningQuery = /^(think|reason|思考|推理)/i.test(query.trim())
  const isVisionQuery = /^(vision|vl|视觉|看图)/i.test(query.trim())

  const matchesQuery = (model: ModelCatalogModel, group: ModelProviderGroup, q: string): boolean => {
    if (q === '') return true
    const lowerQ = q.toLowerCase()
    if (rankByName([model], q).length > 0) return true
    if (model.id.toLowerCase().includes(lowerQ)) return true
    if (group.name.toLowerCase().includes(lowerQ)) return true
    if (isReasoningQuery && model.reasoning !== undefined) return true
    if (isVisionQuery && /(vision|vl|omni|4o)/i.test(`${model.id} ${model.name}`)) return true
    return false
  }

  const filteredGroups = useMemo(() => {
    const q = query.trim()
    if (q === '') return groups
    return groups.map(group => ({
      ...group,
      models: [
        ...rankByName(group.models, q),
        ...group.models.filter(model => matchesQuery(model, group, q) && rankByName([model], q).length === 0),
      ],
    })).filter(group => group.models.length > 0)
  }, [groups, query])

  const showRecents = choices.length > 4 && query.trim() === ''
  const recentChoices = useMemo(() => {
    if (!showRecents) return []
    const recents = readRecentModels()
    const list: typeof choices = []
    for (const r of recents) {
      const found = choices.find(c => c.selection.provider === r.provider && c.selection.model === r.model)
      if (found && !list.some(item => item.selection.provider === r.provider && item.selection.model === r.model)) {
        list.push(found)
      }
    }
    return list
  }, [choices, showRecents, open])

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // The portal aligns above the trigger and remains inside the viewport as
  // catalog refreshes, scrolling, or resizing change its measured dimensions.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      // A place that lands where the card already sits publishes nothing, so a
      // selection settling mid-drag does not spend a render on no movement.
      setMenuPos(placed => placed !== null && placed.left === x && placed.top === y ? placed : { left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : undefined
    if (menuRef.current !== null) observer?.observe(menuRef.current)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, state])
  /* jscpd:ignore-end */

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport !== null) return observeStickyMenuGroups(viewport)
  }, [open, filteredGroups])

  if (!available) return null

  const show = (): void => {
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setQuery('')
    setHighlightedIndex(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (query !== '') {
        setQuery('')
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      close(true)
      return
    }
    if (!open) return
    if (showSearch && event.target === searchRef.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
      if (items.length === 0) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = highlightedIndex === null
        ? (direction > 0 ? 0 : items.length - 1)
        : (highlightedIndex + direction + items.length) % items.length
      setHighlightedIndex(nextIndex)
      items[nextIndex]?.focus()
      return
    }
    if (showSearch && event.target === searchRef.current && event.key === 'Enter') {
      event.preventDefault()
      const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
      const target = highlightedIndex !== null ? items[highlightedIndex] : items[0]
      target?.click()
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // A focused slider keeps the vertical keys: the option traversal must
      // not pull the keyboard off the control it sits on.
      if (event.target instanceof Element && event.target.closest('[role="slider"]') !== null) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>, stayOpen = false): void => {
    setRowWrite(false)
    if (result === undefined) return
    if (result.ok) {
      // A slider applies its step in place and leaves the menu open, so the
      // pointer can keep travelling the track; a row settles and closes.
      if (!stayOpen && rootRef.current !== null) close(true)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const choose = (selection: ModelSelection): void => {
    recordRecentModel(selection)
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    setRowWrite(true)
    void select(selection).then(settleSelection)
  }

  /**
   * Run one step immediately when the writer is idle, or remember the latest
   * one to run once the in-flight write returns. Mid-drag pointer movements
   * replace the waiting step instead of queuing alongside it.
   */
  const drainSteps = (step: SliderStep): void => {
    const current = directory.getSnapshot().current
    if (current === null) return
    if (writingRef.current) {
      queuedStep.current = step
      return
    }
    writingRef.current = true
    const selection: ModelSelection = step.kind === 'effort'
      ? {
        provider: current.provider,
        model: current.model,
        ...step.effort === undefined ? {} : { reasoningEffort: step.effort },
        ...current.contextWindow === undefined ? {} : { contextWindow: current.contextWindow },
      }
      : { ...current, contextWindow: step.value }
    lastActionRef.current = 'select'
    const smaller = step.kind === 'window' && contextWindow !== undefined && step.value < contextWindow
    void select(selection).then((result) => {
      settleSelection(result, true)
      if (result?.ok === true && smaller && rootRef.current !== null) {
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text: t('context.smaller') })
      }
    }).finally(() => {
      writingRef.current = false
      const next = queuedStep.current
      queuedStep.current = null
      if (next !== null) drainSteps(next)
    })
  }

  const chooseStep = (step: SliderStep): void => {
    if (state.current === null) return
    const inUse = step.kind === 'effort' ? effectiveEffort === step.effort : contextWindow === step.value
    if (inUse) return
    drainSteps(step)
  }

  const waiting = currentChoice === undefined && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : currentChoice === undefined
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  const renderModelLabel = (
    provider: ModelLabelOwner['provider'], model: ModelLabelOwner['model'],
    placement: ModelLabelOwner['placement'], selected: boolean,
  ) => (
    <span data-provider-id={provider.id} data-model-id={model.id}>
      {renderSlot('conversation.input.model.label', {
        provider, model, placement, selected,
      }, {
        fallback: model.badge === undefined ? model.name : (
          <span className={css.badgedName}>
            {placement === 'trigger' ? <><Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag>{' '}</> : null}
            <span className={css.badgedNameText}>{model.name}</span>
            {placement === 'trigger' ? null : <>{' '}<Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag></>}
          </span>
        ),
      })}
    </span>
  )
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  const renderFailureActions = () => (
    <div className={css.errorActions}>
      <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
    </div>
  )

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <>{busy ? <StateDot state="ongoing" /> : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}</>
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={clsx(css.menu, 'scrollable')}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {showSearch && (
            <div className={css.searchRow}>
              <div className={css.search}>
                <span className={css.searchIcon} aria-hidden>
                  <IconSearchOutlineRegular size={14} />
                </span>
                <input
                  ref={searchRef}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  placeholder={t('search.placeholder')}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setHighlightedIndex(null)
                  }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    onClick={() => {
                      setQuery('')
                      setHighlightedIndex(null)
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
          {state.status === 'loading' && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              {renderFailureActions()}
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              {renderFailureActions()}
            </div>
          ))}
          <div ref={groupsRef} className={clsx(css.groups, 'scrollable')}>
            {recentChoices.length > 0 && (
              <MenuGroup label={t('group.recent')} key="recent">
                {recentChoices.map(({ group, model }) => {
                  const selected = state.current?.provider === group.id && state.current.model === model.id
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      aria-label={`${model.name} (${t('group.recent')})`}
                      className={clsx(css.option, selected && css.selected)}
                      key={`recent-${group.id}-${model.id}`}
                      title={model.name}
                      disabled={rowWrite || locked}
                      onClick={() => { choose({ provider: group.id, model: model.id }) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{renderModelLabel(group.provider, model, 'option', selected)}</span>
                      </span>
                      <span className={css.check}>
                        {pending?.provider === group.id && pending.model === model.id ? <StateDot state="ongoing" /> : selected ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  )
                })}
              </MenuGroup>
            )}
            {filteredGroups.map((group) => {
              return (
                <MenuGroup label={group.provider.name} key={group.id}>
                  {group.models.map((model) => {
                    const selected = state.current?.provider === group.id && state.current.model === model.id
                    return (
                      <button
                        ref={itemRef()}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={clsx(css.option, selected && css.selected)}
                        key={model.id}
                        title={model.name}
                        disabled={rowWrite || locked}
                        onClick={() => { choose({ provider: group.id, model: model.id }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{renderModelLabel(group.provider, model, 'option', selected)}</span>
                        </span>
                        <span className={css.check}>
                          {pending?.provider === group.id && pending.model === model.id ? <StateDot state="ongoing" /> : selected ? <IconCheckOutlineRegular /> : null}
                        </span>
                      </button>
                    )
                  })}
                </MenuGroup>
              )
            })}
          </div>
          {state.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>{t('empty.models')}</div>
          )}
          {state.status === 'ready' && choices.length > 0 && filteredGroups.length === 0 && (
            <div className={css.empty}>{t('search.empty')}</div>
          )}
          {(reasoning !== undefined || state.current !== null) && (
            <div className={css.controls}>
              {reasoning !== undefined && (
                <section role="group" aria-labelledby={`${id}-effort`} className={css.control}>
                  <div className={css.controlTitle}>
                    <span id={`${id}-effort`}>{t('menu.effort')}</span>
                  </div>
                  {effortChoices.length === 0
                    ? <div className={css.empty}>{t('empty.efforts')}</div>
                    : (
                      <div className={css.sliderPane}>
                        <Slider
                          steps={effortChoices.map(choice => choice.label)}
                          value={Math.max(0, effortChoices.findIndex(choice => choice.effort === effectiveEffort))}
                          label={t('menu.effort')}
                          disabled={locked}
                          onChange={(index) => {
                            const choice = effortChoices[index]
                            if (choice === undefined) return
                            chooseStep({ kind: 'effort', effort: choice.effort })
                          }}
                        />
                      </div>
                    )}
                </section>
              )}
              {state.current !== null && (
                <section role="group" aria-labelledby={`${id}-context`} className={css.control}>
                  <div className={css.controlTitle}>
                    <span id={`${id}-context`}>{t('menu.contextWindow')}</span>
                    <span>{t('context.current', { value: contextWindow === undefined ? t('context.unknown') : contextWindow.toLocaleString('en-US') })}</span>
                  </div>
                  <div className={css.sliderPane}>
                    <Slider
                      steps={contextSteps.map(contextStepLabel)}
                      value={Math.max(0, contextSteps.indexOf(contextWindow ?? -1))}
                      label={t('menu.contextWindow')}
                      disabled={locked}
                      onChange={(index) => {
                        const next = contextSteps[index]
                        if (next === undefined) return
                        chooseStep({ kind: 'window', value: next })
                      }}
                    />
                  </div>
                </section>
              )}
            </div>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
