// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Slider } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

/**
 * A controlled host that applies every change, the way a render site does: the
 * slider reads its value back, so a second step starts from the first one's
 * result instead of the initial render's.
 */
function Harness({ steps, initial, onChange }: {
  steps: readonly string[]
  initial: number
  onChange: (index: number) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Slider
      steps={steps}
      value={value}
      label="Context window"
      onChange={(index) => { onChange(index); setValue(index) }}
    />
  )
}

/** The track element: the pointer surface the steps sit on. */
function track(): HTMLElement {
  return screen.getByRole('slider')
}

/** A tick's label, found by its text under the track. */
function stepLabel(text: string): HTMLElement {
  return screen.getByText(text)
}

describe('Slider', () => {
  it('exposes the selected step to assistive technology', () => {
    render(<Slider steps={['Off', 'High', 'Max']} value={1} label="Reasoning effort" onChange={() => {}} />)
    const control = track()
    expect(control.getAttribute('aria-valuemin')).toBe('0')
    expect(control.getAttribute('aria-valuemax')).toBe('2')
    expect(control.getAttribute('aria-valuenow')).toBe('1')
    expect(control.getAttribute('aria-valuetext')).toBe('High')
    expect(control.getAttribute('aria-label')).toBe('Reasoning effort')
  })

  it('renders one tick label per step and marks the selected one', () => {
    render(<Slider steps={['320K', '640K', '960K']} value={1} label="Context window" onChange={() => {}} />)
    expect(stepLabel('320K')).toBeTruthy()
    expect(stepLabel('640K')).toBeTruthy()
    expect(stepLabel('960K')).toBeTruthy()
    expect(stepLabel('640K').getAttribute('aria-current')).toBe('true')
    expect(stepLabel('320K').getAttribute('aria-current')).toBeNull()
  })

  it('keeps the end names inside the track', () => {
    render(<Slider steps={['320K', '640K', '960K']} value={1} label="Context window" onChange={() => {}} />)
    expect(stepLabel('320K').className).toMatch(/labelFirst/)
    expect(stepLabel('960K').className).toMatch(/labelLast/)
    // A middle name stays centered on its own tick.
    expect(stepLabel('640K').className).not.toMatch(/labelFirst|labelLast/)
    // A lone step has no far end to pull in.
    cleanup()
    render(<Slider steps={['Only']} value={0} label="Context window" onChange={() => {}} />)
    expect(stepLabel('Only').className).toMatch(/labelFirst/)
    expect(stepLabel('Only').className).not.toMatch(/labelLast/)
  })

  it('steps with the arrow keys and clamps at both ends', () => {
    const onChange = vi.fn()
    render(<Harness steps={['Off', 'High', 'Max']} initial={1} onChange={onChange} />)
    fireEvent.keyDown(track(), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith(2)
    onChange.mockClear()
    fireEvent.keyDown(track(), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith(1)
    onChange.mockClear()
    fireEvent.keyDown(track(), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith(0)
    onChange.mockClear()
    fireEvent.keyDown(track(), { key: 'ArrowLeft' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('jumps to the ends with Home and End', () => {
    const onChange = vi.fn()
    render(<Harness steps={['Off', 'High', 'Max']} initial={1} onChange={onChange} />)
    fireEvent.keyDown(track(), { key: 'End' })
    expect(onChange).toHaveBeenCalledWith(2)
    onChange.mockClear()
    fireEvent.keyDown(track(), { key: 'Home' })
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('stays silent when a key asks for the step already in use', () => {
    const onChange = vi.fn()
    const first = render(<Harness steps={['Off', 'High', 'Max']} initial={2} onChange={onChange} />)
    fireEvent.keyDown(track(), { key: 'End' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(track(), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    first.unmount()
    render(<Harness steps={['Off', 'High', 'Max']} initial={0} onChange={onChange} />)
    fireEvent.keyDown(track(), { key: 'Home' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects the nearest step from a pointer position on the track', () => {
    const onChange = vi.fn()
    render(<Harness steps={['320K', '640K', '960K']} initial={0} onChange={onChange} />)
    const control = track()
    // jsdom has no layout: stub the track box so the position math runs.
    control.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 4, right: 300, bottom: 4, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(control, { clientX: 290, pointerId: 1 })
    expect(onChange).toHaveBeenCalledWith(2)
    onChange.mockClear()
    // A move inside the step already in use reports nothing.
    fireEvent.pointerMove(control, { clientX: 280, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(control, { clientX: 10, pointerId: 1 })
    expect(onChange).toHaveBeenCalledWith(0)
    onChange.mockClear()
    fireEvent.pointerMove(control, { clientX: 160, pointerId: 1 })
    expect(onChange).toHaveBeenCalledWith(1)
  })

  it('ignores pointer movement once the pointer is released', () => {
    const onChange = vi.fn()
    render(<Harness steps={['320K', '640K', '960K']} initial={0} onChange={onChange} />)
    const control = track()
    control.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 4, right: 300, bottom: 4, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(control, { clientX: 10, pointerId: 1 })
    fireEvent.pointerUp(control, { clientX: 10, pointerId: 1 })
    onChange.mockClear()
    fireEvent.pointerMove(control, { clientX: 290, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stays silent while disabled', () => {
    const onChange = vi.fn()
    render(<Slider steps={['Off', 'High', 'Max']} value={1} label="Effort" disabled onChange={onChange} />)
    const control = track()
    fireEvent.keyDown(control, { key: 'ArrowRight' })
    fireEvent.pointerDown(control, { clientX: 290, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('parks a value the steps no longer carry at the near end', () => {
    render(<Slider steps={['320K', '640K', '960K']} value={9} label="Context window" onChange={() => {}} />)
    expect(track().getAttribute('aria-valuenow')).toBe('2')
    expect(track().getAttribute('aria-valuetext')).toBe('960K')
  })

  it('stops reporting once the owner disables the control mid-drag', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Slider steps={['320K', '640K', '960K']} value={0} label="Context window" onChange={onChange} />)
    const control = track()
    control.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 4, right: 300, bottom: 4, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(control, { clientX: 290, pointerId: 1 })
    onChange.mockClear()
    rerender(<Slider steps={['320K', '640K', '960K']} value={2} label="Context window" disabled onChange={onChange} />)
    fireEvent.pointerMove(control, { clientX: 10, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('holds the step the pointer asked for until the owner settles one', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Slider steps={['320K', '640K', '960K']} value={0} label="Context window" onChange={onChange} />)
    const control = track()
    control.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 300, height: 6, right: 300, bottom: 6, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(control, { clientX: 160, pointerId: 1 })
    // Nothing has come back from the owner yet, and the thumb reads the ask.
    expect(onChange).toHaveBeenCalledWith(1)
    expect(control.getAttribute('aria-valuenow')).toBe('1')
    expect(control.getAttribute('aria-valuetext')).toBe('640K')
    fireEvent.pointerMove(control, { clientX: 290, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith(2)
    expect(control.getAttribute('aria-valuenow')).toBe('2')
    // Once the owner's value leaves where the drag started, the owner's step shows.
    rerender(<Slider steps={['320K', '640K', '960K']} value={1} label="Context window" onChange={onChange} />)
    expect(control.getAttribute('aria-valuenow')).toBe('1')
  })

  it('reports nothing to a track with no measured width', () => {
    const onChange = vi.fn()
    render(<Slider steps={['320K', '640K', '960K']} value={0} label="Context window" onChange={onChange} />)
    const control = track()
    // jsdom lays nothing out: the press cannot name a step it cannot measure.
    fireEvent.pointerDown(control, { clientX: 290, pointerId: 1 })
    fireEvent.pointerMove(control, { clientX: 290, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
    expect(control.getAttribute('aria-valuenow')).toBe('0')
  })

  it('marks the maximum step with the success accent, and a lone step has no maximum', () => {
    const { container } = render(
      <Slider steps={['320K', '640K', '960K']} value={2} label="Context window" onChange={() => {}} />,
    )
    expect(container.querySelector('[class*="fillAtMax"]')).toBeTruthy()
    expect(container.querySelector('[class*="thumbAtMax"]')).toBeTruthy()
    expect(container.querySelector('[class*="labelAtMax"]')).toBeTruthy()
    // A step short of the maximum carries no accent.
    const { container: middle } = render(
      <Slider steps={['320K', '640K', '960K']} value={1} label="Context window" onChange={() => {}} />,
    )
    expect(middle.querySelector('[class*="fillAtMax"]')).toBeNull()
    expect(middle.querySelector('[class*="thumbAtMax"]')).toBeNull()
    // A single-step track has no maximum position to accent.
    const { container: single } = render(
      <Slider steps={['Only']} value={0} label="Context window" onChange={() => {}} />,
    )
    expect(single.querySelector('[class*="fillAtMax"]')).toBeNull()
  })

  it('keeps a caller class alongside its own so a render site can place it', () => {
    render(<Slider steps={['Off', 'High', 'Max']} value={1} label="Effort" className="placed" onChange={() => {}} />)
    expect(track().classList.contains('placed')).toBe(true)
    expect(track().classList.length).toBeGreaterThan(1)
  })
})
