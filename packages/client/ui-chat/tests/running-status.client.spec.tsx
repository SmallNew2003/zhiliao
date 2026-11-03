// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RunningStatus, RUNNING_STATUS_VARIANTS, selectRunningStatusVariant } from '../src/client/chat/RunningStatus.tsx'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(5_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function statusHarness(startTime?: number, variantIndex?: number) {
  const view = render(<RunningStatus startTime={startTime} paused={false} variantIndex={variantIndex} t={t} />)
  return {
    ...view,
    content: () => view.container.querySelector('[data-chat-running] > :last-child'),
    set: (nextStartTime?: number, paused = false, nextVariant?: number) => {
      view.rerender(<RunningStatus startTime={nextStartTime} paused={paused} variantIndex={nextVariant} t={t} />)
    },
  }
}

describe('RunningStatus', () => {
  it('waits for an open Turn start before allocating its clock', () => {
    const view = statusHarness()
    expect(view.content()?.textContent).toBe('知了思考中')
    expect(vi.getTimerCount()).toBe(0)
    view.set(1_000)
    expect(view.content()?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(view.content()?.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.set()
    expect(view.content()?.textContent).toBe('知了思考中')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the indicator mounted while a continuous run moves to the next Turn', () => {
    const view = statusHarness(1_000)
    const content = view.content()
    const status = view.getByRole('status')
    const initialText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(initialText)
    view.set(7_000)
    expect(view.content()).toBe(content)
    expect(content?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(vi.getTimerCount()).toBe(1)
    const nextTurnText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(nextTurnText)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('知了思考中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the duration nonnegative when the start is ahead of the local clock', () => {
    const view = statusHarness(6_000)
    expect(view.content()?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(view.content()?.textContent).toMatch(/^知了思考中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
  })

  it('freezes the duration while paused and resumes from the Turn start', () => {
    const view = statusHarness(1_000)
    expect(view.content()?.textContent).toBe('知了思考中，用时 4秒 ···')
    view.set(1_000, true)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(view.content()?.textContent).toBe('知了思考中，用时 4秒 ···')
    view.set(1_000)
    expect(view.content()?.textContent).toBe('知了思考中，用时 9秒 ···')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('supports rotating through project copy variants deterministically', () => {
    expect(selectRunningStatusVariant(undefined)).toBe(0)
    expect(selectRunningStatusVariant(1_000)).toBe(0)
    expect(selectRunningStatusVariant(1_001)).toBe(1)
    expect(selectRunningStatusVariant(1_002)).toBe(2)
    expect(selectRunningStatusVariant(1_003)).toBe(3)
    expect(selectRunningStatusVariant(1_004)).toBe(4)
    expect(selectRunningStatusVariant(1_005)).toBe(0)
    expect(RUNNING_STATUS_VARIANTS).toHaveLength(5)

    const v1 = render(<RunningStatus startTime={1_001} paused={false} t={t} />)
    expect(v1.container.querySelector('[data-chat-running] > :last-child')?.textContent).toMatch(/^知了推演中，用时 \d+秒 ···$/)
    v1.unmount()

    const v2 = render(<RunningStatus startTime={1_002} paused={false} t={t} />)
    expect(v2.container.querySelector('[data-chat-running] > :last-child')?.textContent).toMatch(/^知了洞察中，用时 \d+秒 ···$/)
    v2.unmount()

    const v3 = render(<RunningStatus startTime={1_003} paused={false} t={t} />)
    expect(v3.container.querySelector('[data-chat-running] > :last-child')?.textContent).toMatch(/^知微见著，用时 \d+秒 ···$/)
    v3.unmount()

    const v4 = render(<RunningStatus startTime={1_004} paused={false} t={t} />)
    expect(v4.container.querySelector('[data-chat-running] > :last-child')?.textContent).toMatch(/^了然于胸，用时 \d+秒 ···$/)
    v4.unmount()
  })
})
