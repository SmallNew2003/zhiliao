import type { IconProps } from './icons/props.ts'

/** Top horizontal-to-curve path of the Zhiliao '了' brand mark in 96x96 viewBox. */
export const ZHILIAO_MARK_TOP_PATH = 'M16 25 L76 25 C76 40 63 51 30 53'

/** Vertical hook path of the Zhiliao '了' brand mark in 96x96 viewBox. */
export const ZHILIAO_MARK_HOOK_PATH = 'M51 50 L51 62 C51 71 48 75.5 41.5 74.5'

/** Center X coordinate of the brand accent dot (Cicada head / completion dot). */
export const ZHILIAO_DOT_CX = 85.5

/** Center Y coordinate of the brand accent dot. */
export const ZHILIAO_DOT_CY = 7.5

/** Radius of the brand accent dot in 96x96 coordinates. */
export const ZHILIAO_DOT_R = 6.5

/** Signature Cicada orange brand color for the accent dot. */
export const ZHILIAO_ORANGE_COLOR = '#F28A2E'

/** Native viewBox of the brand mark (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 96, height: 96 }

/**
 * Legacy fish silhouette path data, preserved as an alias to the primary stroke
 * for backwards compatibility with existing consumers.
 */
export const FISH_LOGO_PATH = ZHILIAO_MARK_TOP_PATH

/**
 * Render the official Zhiliao brand mark.
 * @param props.size - width and height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the brand logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={ZHILIAO_MARK_TOP_PATH}
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={ZHILIAO_MARK_HOOK_PATH}
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={ZHILIAO_DOT_CX}
        cy={ZHILIAO_DOT_CY}
        r={ZHILIAO_DOT_R}
        fill={ZHILIAO_ORANGE_COLOR}
      />
    </svg>
  )
}

export { FishLogo as BrandLogo, FishLogo as ZhiliaoLogo }
