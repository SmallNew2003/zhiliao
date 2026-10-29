// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CICADA_BODY_PATH,
  CICADA_WING_LEFT_PATH,
  CICADA_WING_RIGHT_PATH,
  RunningCicada,
  RunningWhaleTail,
} from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('RunningCicada', () => {
  it('renders a decorative vector cicada with wings and body without inline styles', () => {
    const view = render(<RunningCicada />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    const svg = icon.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    const paths = svg.querySelectorAll('path')
    expect(paths).toHaveLength(3)

    expect(paths[0]?.getAttribute('d')).toBe(CICADA_WING_LEFT_PATH)
    expect(paths[0]?.getAttribute('stroke')).toBe('currentColor')
    expect(paths[1]?.getAttribute('d')).toBe(CICADA_WING_RIGHT_PATH)
    expect(paths[1]?.getAttribute('stroke')).toBe('currentColor')
    expect(paths[2]?.getAttribute('d')).toBe(CICADA_BODY_PATH)
    expect(paths[2]?.getAttribute('fill')).toBe('currentColor')

    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('RunningWhaleTail aliases to RunningCicada for backwards compatibility', () => {
    expect(RunningWhaleTail).toBe(RunningCicada)
    const view = render(<RunningWhaleTail />)
    expect(view.container.firstElementChild?.tagName).toBe('SPAN')
    expect(view.container.querySelectorAll('path')).toHaveLength(3)
  })
})
