/**
 * Host-half lifecycle: the durable notification namespace is registered with
 * its fiber, validated on write, and removed on disposal.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { DEFAULT_SETTINGS, NOTIFICATION_SETTINGS_NAMESPACE, apply } from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-notification host', () => {
  it('registers, validates, and disposes the durable notification namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = NOTIFICATION_SETTINGS_NAMESPACE
    expect(ctx.settings.get(ns)).toEqual(DEFAULT_SETTINGS)
    await ctx.settings.update(ns, { enabled: false, awaitingInput: false })
    expect(ctx.settings.get(ns)).toMatchObject({ enabled: false, awaitingInput: false })
    await expect(ctx.settings.update(ns, { enabled: 'yes' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('resolves the schema defaults when no settings provider is composed', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(ctx.get('settings')).toBeUndefined()
  })
})
