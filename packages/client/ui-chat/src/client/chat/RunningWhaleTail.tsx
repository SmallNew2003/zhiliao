/** Animated Zhiliao brand vector icon with smooth stroke stream flow for the running Chat status. */
import css from './ChatView.module.css'

/** Primary top horizontal-to-curve path of the Zhiliao '了' brand mark in 96x96 viewBox. */
export const ZHILIAO_MARK_TOP_PATH = 'M16 25 L76 25 C76 40 63 51 30 53'

/** Lower vertical hook path of the Zhiliao '了' brand mark in 96x96 viewBox. */
export const ZHILIAO_MARK_HOOK_PATH = 'M51 50 L51 62 C51 71 48 75.5 41.5 74.5'

/** Signature Zhiliao orange dot coordinates and radius. */
export const ZHILIAO_DOT_CX = 85.5
export const ZHILIAO_DOT_CY = 7.5
export const ZHILIAO_DOT_R = 7.5
export const ZHILIAO_ORANGE_COLOR = '#F28A2E'

/** Mint accent color from official Zhiliao brand palette. */
export const ZHILIAO_MINT_COLOR = '#3FBE9E'

/** Legacy path constants retained for backwards compatibility with existing consumers. */
export const CICADA_WING_LEFT_PATH = ZHILIAO_MARK_TOP_PATH
export const CICADA_WING_RIGHT_PATH = ZHILIAO_MARK_HOOK_PATH
export const CICADA_BODY_PATH = ''

/**
 * Render the decorative running Zhiliao brand icon with smooth stroke stream flow along '了' paths.
 * @returns vector Zhiliao logo svg with CSS path stream animation and static fallback under reduced motion.
 */
export function RunningCicada() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningMarkSvg} width="100%" height="100%" viewBox="0 0 96 96" fill="none">
        <g className={css.brandMarkGroup}>
          <path
            className={css.brandMarkTrack}
            d={ZHILIAO_MARK_TOP_PATH}
            stroke="currentColor"
            strokeWidth={12}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            className={css.brandMarkTrack}
            d={ZHILIAO_MARK_HOOK_PATH}
            stroke="currentColor"
            strokeWidth={12}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            className={css.brandMarkFlowTop}
            d={ZHILIAO_MARK_TOP_PATH}
            stroke={ZHILIAO_MINT_COLOR}
            strokeWidth={12}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            className={css.brandMarkFlowHook}
            d={ZHILIAO_MARK_HOOK_PATH}
            stroke={ZHILIAO_MINT_COLOR}
            strokeWidth={12}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            className={css.brandMarkDot}
            cx={ZHILIAO_DOT_CX}
            cy={ZHILIAO_DOT_CY}
            r={ZHILIAO_DOT_R}
            fill={ZHILIAO_ORANGE_COLOR}
          />
        </g>
      </svg>
    </span>
  )
}

/** Backwards-compatible alias for existing callers. */
export const RunningWhaleTail = RunningCicada
