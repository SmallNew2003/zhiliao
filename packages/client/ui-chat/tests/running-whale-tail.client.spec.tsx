// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RunningCicada,
  RunningWhaleTail,
  ZHILIAO_DOT_CX,
  ZHILIAO_DOT_CY,
  ZHILIAO_DOT_R,
  ZHILIAO_MARK_HOOK_PATH,
  ZHILIAO_MARK_TOP_PATH,
  ZHILIAO_ORANGE_COLOR,
} from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('RunningCicada', () => {
  it('renders a decorative vector Zhiliao brand icon with paths and orange dot without inline styles', () => {
    const view = render(<RunningCicada />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    const svg = icon.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('viewBox')).toBe('0 0 96 96')

    const paths = svg.querySelectorAll('path')
    expect(paths).toHaveLength(2)
    expect(paths[0]?.getAttribute('d')).toBe(ZHILIAO_MARK_TOP_PATH)
    expect(paths[0]?.getAttribute('stroke')).toBe('currentColor')
    expect(paths[1]?.getAttribute('d')).toBe(ZHILIAO_MARK_HOOK_PATH)
    expect(paths[1]?.getAttribute('stroke')).toBe('currentColor')

    const circles = svg.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    expect(circles[0]?.getAttribute('cx')).toBe(String(ZHILIAO_DOT_CX))
    expect(circles[0]?.getAttribute('cy')).toBe(String(ZHILIAO_DOT_CY))
    expect(circles[0]?.getAttribute('r')).toBe(String(ZHILIAO_DOT_R))
    expect(circles[0]?.getAttribute('fill')).toBe(ZHILIAO_ORANGE_COLOR)

    expect(circles[1]?.getAttribute('cx')).toBe(String(ZHILIAO_DOT_CX))
    expect(circles[1]?.getAttribute('cy')).toBe(String(ZHILIAO_DOT_CY))
    expect(circles[1]?.getAttribute('r')).toBe(String(ZHILIAO_DOT_R))
    expect(circles[1]?.getAttribute('fill')).toBe(ZHILIAO_ORANGE_COLOR)

    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('RunningWhaleTail aliases to RunningCicada for backwards compatibility', () => {
    expect(RunningWhaleTail).toBe(RunningCicada)
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.tagName).toBe('SPAN')
    expect(view.container.querySelectorAll('path')).toHaveLength(2)
    expect(view.container.querySelectorAll('circle')).toHaveLength(2)
  })
})
