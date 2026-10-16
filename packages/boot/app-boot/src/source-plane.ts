/** Source-plane plugin entry loading for a source launch. */

import { createRequire } from 'node:module'
import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'

/**
 * Whether a bare plugin specifier must load through the ambient module pipeline
 * during a source launch.
 *
 * A source launch projects workspace and vendored imports to `src` through
 * tsconfig `paths`, while the Loader resolves a plugin entry through its
 * published `exports` to `lib`; the two produce distinct module instances whose
 * `unique symbol` service keys do not match across the plugin boundary.
 * Redirecting stays safe only while the plugin entry's own location resolves the
 * specifier to the same package: a composition that shadows a harness package
 * with its own `node_modules` copy keeps that copy, and a specifier the ambient
 * pipeline cannot project stays on the Loader's own resolution.
 * @param specifier - plugin module specifier to classify.
 * @param parentURL - base URL the Loader resolves the specifier against.
 * @returns true when the specifier must load through the ambient pipeline.
 */
export function loadsFromSourcePlane(specifier: string, parentURL: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':')) return false
  try {
    const projected = import.meta.resolve(specifier)
    if (projected.includes('/node_modules/')) return false
    // Node's own resolution from the entry's location: the profile resolution
    // router owns it during a launch and the ambient pipeline never touches it.
    // A copy under node_modules belongs to the composition and outranks the
    // harness source projection.
    return !createRequire(parentURL).resolve(specifier).includes('/node_modules/')
  } catch {
    // The ambient pipeline cannot project this specifier, or the entry's own
    // location cannot resolve it; the Loader owns it either way.
    return false
  }
}

/**
 * During a source launch, load workspace and vendored plugin entries through
 * the ambient module pipeline so each package keeps one module instance shared
 * with the rest of the graph. Specifiers the ambient pipeline cannot project,
 * specifiers the entry's own location resolves under `node_modules`, and every
 * relative or builtin specifier stay on Node's internal ESM loader. Packaged
 * runtimes pass a `bareModuleBaseUrl` and keep the internal loader for every
 * bare specifier.
 * @param loader - Loader service whose internal ESM loader the wrapper replaces.
 */
export function installSourcePlanePluginLoader(loader: Loader): void {
  const internal = loader.internal
  if (internal === undefined) return
  const sourcePlane = Object.create(internal) as ModuleLoader
  sourcePlane.import = async (specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<unknown> =>
    loadsFromSourcePlane(specifier, parentURL)
      ? import(specifier)
      : internal.import(specifier, parentURL, importAttributes)
  loader.internal = sourcePlane
}
