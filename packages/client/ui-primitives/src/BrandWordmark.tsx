import type { IconProps } from './icons/props.ts'
import {
  ZHILIAO_DOT_CX,
  ZHILIAO_DOT_CY,
  ZHILIAO_DOT_R,
  ZHILIAO_MARK_HOOK_PATH,
  ZHILIAO_MARK_TOP_PATH,
  ZHILIAO_ORANGE_COLOR,
} from './FishLogo.tsx'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading brand mark; defaults to true. */
  includeMark?: boolean | undefined
  /** Language code; defaults to the host document's language. */
  locale?: string | undefined
}

/**
 * Render the official Zhiliao brand wordmark.
 * @param props - Display options including size, layout class, mark inclusion, and locale.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({
  size = 24,
  className,
  includeMark = true,
  locale,
}: BrandWordmarkProps) {
  const isZh = locale !== undefined
    ? locale.startsWith('zh')
    : (document.documentElement.lang ? document.documentElement.lang.startsWith('zh') : true)

  const width = includeMark
    ? (isZh ? 248 : 308)
    : (isZh ? 152 : 212)

  const viewBox = includeMark
    ? (isZh ? '0 0 248 96' : '0 0 308 96')
    : (isZh ? '96 0 152 96' : '96 0 212 96')

  return (
    <svg
      width={Math.round((size * width) / 96)}
      height={size}
      className={className}
      viewBox={viewBox}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <g>
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
        </g>
      )}
      {isZh ? (
        <g
          stroke="currentColor"
          strokeWidth={6.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          {/* 知: 矢 */}
          <path d="M125 21 L116 35" />
          <path d="M111 37 L138 37" />
          <path d="M106 51 L143 51" />
          <path d="M124 37 L124 51 C124 64 117 73 107 77" />
          <path d="M130 57 L141 74" />
          {/* 知: 口 */}
          <rect x="151" y="36" width="26" height="30" rx="4" />
          {/* 了 */}
          <path d="M192 29 L232 29 C232 42 220 50 204 52" />
          <path d="M213 51 L213 63 C213 72 208 77 200 76" />
        </g>
      ) : (
        <g
          stroke="currentColor"
          strokeWidth={6.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          {/* z */}
          <path d="M108 38 H126 L110 62 H126" />
          {/* h */}
          <path d="M138 22 V62" />
          <path d="M138 44 C138 38 143 37.5 148 37.5 C154 37.5 158 41 158 46.5 V62" />
          {/* i */}
          <path d="M175 38 V62" />
          <circle cx="175" cy="27" r="3.25" fill="currentColor" stroke="none" />
          {/* l */}
          <path d="M193 22 V62" />
          {/* i */}
          <path d="M211 38 V62" />
          <circle cx="211" cy="27" r="3.25" fill="currentColor" stroke="none" />
          {/* a */}
          <path d="M246 43 C243 38 236 37.5 231 41 C226 45 226 54 231 58.5 C236 62.5 243 62.5 246 58 M246 38 V62" />
          {/* o */}
          <circle cx="272" cy="50" r="12" />
        </g>
      )}
    </svg>
  )
}
