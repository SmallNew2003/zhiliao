/** A failed immutable-asset read permits an explicit later retry. */
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.doUnmock('../src/client/runtime/html-assets.ts'); vi.resetModules() })
it('retires a rejected asset cache entry without retaining authored state', async () => {
  vi.resetModules()
  let attempts = 0
  vi.doMock('../src/client/runtime/html-assets.ts', () => {
    if (++attempts === 1) throw new Error('chunk unavailable')
    return { assets: Object.freeze({ css: [], scripts: [] }) }
  })
  const { loadRuntimeAssets } = await import('../src/client/runtime/assets.ts')
  await expect(loadRuntimeAssets('html', [])).rejects.toMatchObject({ cause: { message: 'chunk unavailable' } })
  vi.doUnmock('../src/client/runtime/html-assets.ts')
  // Vite caches a rejected module evaluation; a replacement module models a recovered chunk load.
  vi.doMock('../src/client/runtime/html-assets.ts', () => ({ assets: Object.freeze({ css: [], scripts: [] }) }))
  expect(await loadRuntimeAssets('html', [])).toEqual({ css: [], scripts: [] })
})
