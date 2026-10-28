// Slider: a horizontal slider over a fixed, ordered set of steps. The value is
// a step index, so every position a pointer or key can reach is a real choice —
// the track snaps, and `aria-valuetext` names the step rather than a number
// between ticks. `steps` carries at least one label; a render site with nothing
// to choose from renders its empty state instead of a slider.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import css from './Slider.module.css'

/**
 * Render a snapping slider over ordered steps.
 * @param props.steps - the step labels in track order, at least one; the value indexes them.
 * @param props.value - the selected step index; the control is fully controlled.
 * @param props.onChange - called with the step index a key or pointer asks for.
 * @param props.label - localized accessible name, owned by the render site.
 * @param props.disabled - whether the control refuses input; owners also set it
 * while a write is in flight, not only when a deployment locks the control.
 * @param props.className - extra class for layout placement.
 * @returns the slider element.
 */
export function Slider({ steps, value, onChange, label, disabled = false, className }: {
  steps: readonly string[]
  value: number
  onChange: (index: number) => void
  label: string
  disabled?: boolean
  className?: string | undefined
}) {
  const last = steps.length - 1
  // A value the owner does not hold (a stored selection the current steps no
  // longer carry, say) parks at the near end rather than off the track.
  const current = Math.min(Math.max(value, 0), last)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  // A drag keeps reporting after the pointer leaves the track, so the move and
  // release listeners live on the window for as long as the drag runs.
  useEffect(() => {
    if (!dragging) return
    const nearest = (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      /* v8 ignore next 3 -- the ref is attached for as long as a drag runs. */
      if (rect === undefined || rect.width === 0) return current
      return Math.min(Math.max(Math.round(((clientX - rect.left) / rect.width) * last), 0), last)
    }
    const onMove = (event: PointerEvent): void => {
      // An owner that locks the control mid-drag (a selection in flight) stops
      // the drag where it stands.
      if (disabled) return
      const next = nearest(event.clientX)
      if (next !== current) onChange(next)
    }
    const onUp = (): void => { setDragging(false) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, disabled, current, last, onChange])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      const next = current + step
      if (next < 0 || next > last) return
      onChange(next)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : last
      if (next !== current) onChange(next)
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    // The track itself is the hit surface: a press selects the step under the
    // pointer and starts a drag, so the keyboard follows the pointer.
    event.preventDefault()
    event.currentTarget.focus()
    const rect = event.currentTarget.getBoundingClientRect()
    const next = Math.min(Math.max(Math.round(((event.clientX - rect.left) / rect.width) * last), 0), last)
    if (next !== current) onChange(next)
    setDragging(true)
  }

  const position = (index: number): string => `${(index / last) * 100}%`

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={current}
      aria-valuetext={steps[current]}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={clsx(css.slider, className)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className={css.track}>
        <div className={css.fill} style={{ width: position(current) }} />
        {steps.map((step, index) => (
          <div key={step} className={clsx(css.tick, index === current && css.tickCurrent)} style={{ left: position(index) }} />
        ))}
        <div className={css.thumb} style={{ left: position(current) }} />
      </div>
      <div className={css.labels}>
        {steps.map((step, index) => (
          <span
            key={step}
            className={clsx(css.label, index === current && css.labelCurrent)}
            style={{ left: position(index) }}
            aria-current={index === current || undefined}
          >
            {step}
          </span>
        ))}
      </div>
    </div>
  )
}
