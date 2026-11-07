/** Give the real manager an application-owned profile and offline installation media. */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { getDshRuntimeVersion, initProfile } from '@deepseek-ai/dsh-app-boot'
import { ON_DEMAND_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import PluginManager from '../../src/index.ts'

export const name = 'official-bundle-media'
export const inject = ['profileContext']

/**
 * Mount production package management against a packaged tree with no workspace checkout.
 * @param ctx - The shipped profile's context; the fixture isolates only its profile locations.
 */
export async function apply(ctx: Context): Promise<void> {
  const home = await realpath(ctx.profileContext.home)
  const runtime = join(home, 'official-runtime')
  const version = getDshRuntimeVersion()
  const installAnchor = join(runtime, 'package.json')
  await mkdir(runtime, { recursive: true })
  await writeFile(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh', version,
    dependencies: Object.fromEntries(ON_DEMAND_BUNDLES.map(name => [name, version])) }))
  for (const name of ON_DEMAND_BUNDLES) {
    const directory = join(runtime, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(directory, 'index.js'), 'throw new Error("Official catalog reads must not import providers")\n')
    await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  }
  const dir = join(home, 'official-profile')
  initProfile(dir, [])
  const scoped = ctx.isolate('profileContext')
  scoped.provide('profileContext', { ...ctx.profileContext, dir, installAnchor,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [], overlays: [] })
  await scoped.plugin(PluginManager)
}
