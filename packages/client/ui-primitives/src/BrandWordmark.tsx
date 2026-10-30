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
  /** Explicit language code or override text. */
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
    : (typeof document !== 'undefined'
      ? (document.documentElement.lang ? document.documentElement.lang.startsWith('zh') : true)
      : true)

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
        <text
          x="106"
          y="62"
          fontFamily="'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif"
          fontSize="52"
          fontWeight="600"
          letterSpacing="4"
          fill="currentColor"
        >
          知了
        </text>
      ) : (
        <text
          x="104"
          y="56"
          fontFamily="'Avenir Next', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif"
          fontSize="44"
          fontWeight="600"
          letterSpacing="0.5"
          fill="currentColor"
        >
          zhiliao
        </text>
      )}
    </svg>
  )
}
