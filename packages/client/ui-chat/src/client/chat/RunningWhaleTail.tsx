/** Animated cicada vector icon with flutter motion for the running Chat status. */
import css from './ChatView.module.css'

/** Left cicada wing path data in 16x16 viewBox. */
export const CICADA_WING_LEFT_PATH = 'M7.2 4.8C5.2 5.0 2.2 7.2 2.0 9.8C1.9 11.5 3.8 13.8 5.2 14.6C6.0 13.2 6.8 10.0 7.2 4.8Z'

/** Right cicada wing path data in 16x16 viewBox. */
export const CICADA_WING_RIGHT_PATH = 'M8.8 4.8C10.8 5.0 13.8 7.2 14.0 9.8C14.1 11.5 12.2 13.8 10.8 14.6C10.0 13.2 9.2 10.0 8.8 4.8Z'

/** Central cicada body path data in 16x16 viewBox. */
export const CICADA_BODY_PATH = 'M8 2.2C7.1 2.2 6.4 2.8 6.2 3.5C6 4.2 6.5 5 7 5.5L7 12.5C7 13.8 8 14.8 8 14.8C8 14.8 9 13.8 9 12.5L9 5.5C9.5 5 10 4.2 9.8 3.5C9.6 2.8 8.9 2.2 8 2.2Z'

/**
 * Render the decorative running cicada icon with animated wing flutter.
 * @returns vector cicada svg with CSS keyframe wing vibration and static fallback under reduced motion.
 */
export function RunningCicada() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningCicadaSvg} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <g className={css.cicadaCreature}>
          <path
            className={css.cicadaWingLeft}
            d={CICADA_WING_LEFT_PATH}
            fill="currentColor"
            fillOpacity={0.55}
            stroke="currentColor"
            strokeWidth={0.75}
          />
          <path
            className={css.cicadaWingRight}
            d={CICADA_WING_RIGHT_PATH}
            fill="currentColor"
            fillOpacity={0.55}
            stroke="currentColor"
            strokeWidth={0.75}
          />
          <path
            className={css.cicadaBody}
            d={CICADA_BODY_PATH}
            fill="currentColor"
          />
        </g>
      </svg>
    </span>
  )
}

/** Backwards-compatible alias for existing callers. */
export const RunningWhaleTail = RunningCicada
