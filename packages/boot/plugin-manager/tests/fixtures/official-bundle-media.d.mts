/** Test fixture API for the plain-Node official bundle media plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context { officialBundleMediaReady: true }
}

/** @param ctx - Scope owning the fixture and its readiness marker. */
export function exposeReadiness(ctx: Context): void
