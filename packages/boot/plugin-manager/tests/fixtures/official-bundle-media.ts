/** Give the real manager an application-owned profile and offline installation media. */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { getDshRuntimeVersion, initProfile } from '@deepseek-ai/dsh-app-boot'
import { ON_DEMAND_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import PluginManager from '../../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { officialBundleMediaReady: true }
}

export const name = 'official-bundle-media'
export const inject = ['profileContext']

/**
 * Mount production package management against a packaged tree with no workspace checkout.
 * @param ctx - The shipped profile's context; the fixture isolates only its profile locations.
 */
export function apply(ctx: Context): void {
  const home = realpathSync(ctx.profileContext.home)
  const runtime = join(home, 'official-runtime')
  const version = getDshRuntimeVersion()
  const installAnchor = join(runtime, 'package.json')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh', version,
    dependencies: Object.fromEntries(ON_DEMAND_BUNDLES.map(name => [name, version])) }))
  for (const name of ON_DEMAND_BUNDLES) {
    const directory = join(runtime, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(directory, 'index.js'), 'throw new Error("Official catalog reads must not import providers")\n')
    writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  }
  const dir = join(home, 'official-profile')
  initProfile(dir, [])
  const scoped = ctx.isolate('profileContext')
  scoped.provide('profileContext', { ...ctx.profileContext, dir, installAnchor,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [], overlays: [] })
  scoped.plugin(PluginManager)
  exposeReadiness(ctx)
}

/** Publish readiness only while the manager tool is registered.
 * @param ctx - Scope owning the fixture and its readiness marker.
 */
export function exposeReadiness(ctx: Context): void {
  ctx.inject(['tools'], (scope) => {
    let release: (() => void) | undefined
    const update = () => {
      if (scope.tools.get('plugin_manager') !== undefined) release ??= scope.provide('officialBundleMediaReady', true)
      else { release?.(); release = undefined }
    }
    const stop = scope.on('tools/change', update)
    update()
    scope.effect(() => () => { stop(); release?.() })
  })
}
