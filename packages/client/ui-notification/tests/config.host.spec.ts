import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { Config, DEFAULT_SETTINGS, apply } from '../src/index.ts'

describe('ui-notification Host preferences', () => {
  it('validates and updates the live notification preferences', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual(DEFAULT_SETTINGS)
    await configuration.update({ enabled: false, awaitingInput: false })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toMatchObject({ enabled: false, awaitingInput: false })
    await expect(configuration.update({ enabled: 'yes' })).rejects.toThrow()
    await configuration.fiber.dispose()
  })
})
