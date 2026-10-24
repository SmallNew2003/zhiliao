/** Deployment limits resolved before the Client registers previews. */
import z from '@deepseek-ai/schemastery'

/** Resolved limits shared by Host index injection and browser rendering. */
export interface Config {
  /** Maximum UTF-8 bytes of one authored source. */
  maxSourceBytes: number
  /** Maximum decoded bytes of one requested download. */
  maxExportBytes: number
  /** Maximum active iframe documents across this Client registration. */
  maxActiveFrames: number
  /** Minimum iframe height in CSS pixels. */
  minHeight: number
  /** Maximum iframe height in CSS pixels; larger content scrolls inside. */
  maxHeight: number
  /** Readiness and export-response deadline in milliseconds. */
  readinessTimeoutMs: number
}

/** Positive integral deployment bounds and an ordered height range. */
const limits: z<Partial<Config>, Config> = z.object({
  maxSourceBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(256 * 1024),
  maxExportBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
  maxActiveFrames: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(4),
  minHeight: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(180),
  maxHeight: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(640),
  readinessTimeoutMs: z.natural().min(1).max(2147483647).default(15000),
})

/** Validate the resolved height relationship after individual numeric bounds. */
export const Config: z<Partial<Config>, Config> = z.transform(limits, (resolved) => {
  // Schemastery's transform callback type describes input; its runtime receives validated output.
  const value = resolved as Config
  if (value.minHeight > value.maxHeight) throw new TypeError('minHeight must not exceed maxHeight')
  return value
}, true)
