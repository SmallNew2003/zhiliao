/**
 * hindsight HTTP memory provider for the DeepSeek Harness. Registers a
 * `MemoryProvider` backed by a local hindsight daemon into the `ctx.memory` registry.
 *
 * The daemon answers recall and search by running inference, so both are given their own
 * (generous) timeout knobs here; deployments pointing at a remote daemon can raise them
 * and point `baseUrl` elsewhere without touching code.
 *
 * @module @deepseek-ai/dsh-memory-hindsight-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-memory'
import { HindsightMemoryProvider } from './provider.ts'
import type { HindsightProviderLimits } from './provider.ts'

export {
  HINDSIGHT_PROVIDER_ID,
  HindsightMemoryProvider,
} from './provider.ts'
export type { HindsightProviderLimits } from './provider.ts'

/** Default daemon URL. hindsight's daemon mode listens here unless reconfigured. */
export const DEFAULT_HINDSIGHT_BASE_URL = 'http://127.0.0.1:9077'

/** Default bank suffix for a workspace that is not a recognisable checkout. */
export const DEFAULT_BANK_SUFFIX = 'main'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-hindsight-http'

/** The memory seam this provider registers into. */
export const inject = ['memory']

/**
 * Plugin config. Every field is deployment-varying and therefore configurable rather than
 * a constant: which daemon to talk to, and how long each class of request may take.
 */
export interface Config {
  /** Base URL of the hindsight daemon, without a trailing slash. */
  baseUrl?: string
  /** Bank id suffix used when a workspace has no resolvable project name. */
  defaultBankSuffix?: string
  /** Timeout for cheap metadata endpoints such as health and bank listing. */
  metadataTimeoutMs?: number
  /** How long a health-probe answer is reused before memory re-checks the daemon. */
  probeTtlMs?: number
  /** Timeout for recall and search, which run inference server-side. */
  recallTimeoutMs?: number
  /** Timeout for retaining a transcript. */
  retainTimeoutMs?: number
  /** Maximum transcript characters sent in one retention request. */
  maxRetainChars?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(DEFAULT_HINDSIGHT_BASE_URL),
  defaultBankSuffix: z.string().default(DEFAULT_BANK_SUFFIX),
  metadataTimeoutMs: z.number().default(5_000),
  probeTtlMs: z.number().default(30_000),
  // hindsight answers recall by running inference; the default is generous on purpose
  // because the agent tolerates waiting, but not unboundedly.
  recallTimeoutMs: z.number().default(120_000),
  retainTimeoutMs: z.number().default(30_000),
  maxRetainChars: z.number().default(200_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`memory-hindsight-http: ${name} must be a positive finite number`)
  }
}

/** Register the hindsight memory provider with `ctx.memory`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('metadataTimeoutMs', resolved.metadataTimeoutMs)
  assertPositiveFinite('probeTtlMs', resolved.probeTtlMs)
  assertPositiveFinite('recallTimeoutMs', resolved.recallTimeoutMs)
  assertPositiveFinite('retainTimeoutMs', resolved.retainTimeoutMs)
  assertPositiveFinite('maxRetainChars', resolved.maxRetainChars)
  const limits: HindsightProviderLimits = {
    baseUrl: resolved.baseUrl.replace(/\/+$/, ''),
    defaultBankSuffix: resolved.defaultBankSuffix,
    metadataTimeoutMs: resolved.metadataTimeoutMs,
    probeTtlMs: resolved.probeTtlMs,
    recallTimeoutMs: resolved.recallTimeoutMs,
    retainTimeoutMs: resolved.retainTimeoutMs,
    maxRetainChars: resolved.maxRetainChars,
  }
  ctx.memory.registerProvider(new HindsightMemoryProvider(limits))
}
