// Slider: a horizontal slider over a fixed, ordered set of steps. The value is
// a step index, so every position a pointer or key can reach is a real choice —
// the track snaps, and `aria-valuetext` names the step rather than a number
// between ticks. A pointer drag shows the step under the pointer from the press
// onward, whether or not the owner has taken it; a keyboard step shows the
// owner's value. `steps` carries at least one label; a render site with nothing
// to choose from renders its empty state instead of a slider.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import css from './Slider.module.css'

/** The track box a drag measures its steps against. */
interface TrackBox {
  left: number
  width: number
}

/**
 * The step nearest a pointer position on a measured track.
 * @param clientX - the pointer's viewport x.
 * @param box - the track box, or null before a press measures one.
 * @param last - the highest step index.
 * @param shown - the step in view, which a position over it names back as no move.
 * @returns the step to move to, or null when there is no move to make.
 */
function stepAt(clientX: number, box: TrackBox | null, last: number, shown: number): number | null {
  if (box === null || box.width === 0) return null
  const next = Math.min(Math.max(Math.round(((clientX - box.left) / box.width) * last), 0), last)
  return next === shown ? null : next
}

/**
 * Render a snapping slider over ordered steps.
 * @param props.steps - the step labels in track order, at least one; the value indexes them.
 * @param props.value - the selected step index; the control is fully controlled.
 * @param props.onChange - called with the step index a key or pointer asks for.
 * @param props.label - localized accessible name, owned by the render site.
 * @param props.disabled - whether the control refuses a press or key. Owners set it for a
 * deployment lock; a write the owner has not settled yet leaves the control live, so a
 * drag is not cut off halfway across the track.
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
  const [dragging, setDragging] = useState(false)
  // The step a press or move asked for, held while the owner's value still sits
  // where the drag started. Once that value moves the owner's own step shows
  // again, including one the owner settled somewhere other than the ask.
  const [asked, setAsked] = useState<{ from: number; to: number } | null>(null)
  const shown = asked !== null && asked.from === current ? asked.to : current
  // One measured box serves a whole drag: the track holds still while the pointer
  // travels it, so the move handler reads no layout per event.
  const boxRef = useRef<TrackBox | null>(null)
  // The window listeners read live props through this ref, which is what lets one
  // drag register them once instead of again at every step it reports.
  const liveRef = useRef({ current, shown, last, disabled, onChange })
  useEffect(() => {
    liveRef.current = { current, shown, last, disabled, onChange }
  })

  // A drag keeps reporting after the pointer leaves the track, so the move and
  // release listeners live on the window for as long as the drag runs.
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const state = liveRef.current
      // A deployment lock reached mid-drag stops the drag where it stands.
      if (state.disabled) return
      const next = stepAt(event.clientX, boxRef.current, state.last, state.shown)
      if (next === null) return
      setAsked({ from: state.current, to: next })
      state.onChange(next)
    }
    const stop = (): void => { setDragging(false) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging])

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
    const { left, width } = event.currentTarget.getBoundingClientRect()
    boxRef.current = { left, width }
    const next = stepAt(event.clientX, { left, width }, last, shown)
    if (next !== null) {
      setAsked({ from: current, to: next })
      onChange(next)
    }
    setDragging(true)
  }

  const position = (index: number): string => `${last === 0 ? 0 : (index / last) * 100}%`
  // The track's last step is the maximum; a single-step track has none, so the
  // accent stays reserved for a real full position.
  const atMax = last > 0 && shown === last

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={shown}
      aria-valuetext={steps[shown]}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={clsx(css.slider, className)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className={css.track}>
        <div className={clsx(css.fill, atMax && css.fillAtMax)} style={{ width: position(shown) }} />
        {steps.map((step, index) => (
          <div key={step} className={clsx(css.tick, index === shown && css.tickCurrent)} style={{ left: position(index) }} />
        ))}
        <div className={clsx(css.thumb, atMax && css.thumbAtMax)} style={{ left: position(shown) }} />
      </div>
      <div className={css.labels}>
        {steps.map((step, index) => (
          <span
            key={step}
            className={clsx(
              css.label,
              // The end labels hug the track ends rather than centering on their
              // tick, so a wide name cannot run off the card that clips it.
              index === 0 && css.labelFirst,
              index === last && last > 0 && css.labelLast,
              index === shown && css.labelCurrent,
              atMax && index === shown && css.labelAtMax,
            )}
            style={{ left: position(index) }}
            aria-current={index === shown || undefined}
          >
            {step}
          </span>
        ))}
      </div>
    </div>
  )
}
