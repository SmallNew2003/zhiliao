/** Source-plane plugin entry loading for a source launch. */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'

/** Both resolutions of one bare specifier, as the redirect decision reads them. */
export interface SourcePlaneResolution {
  /** URL the ambient module pipeline projects the specifier to. */
  readonly projected: string
  /** URL the plugin entry's own location resolves the specifier to. */
  readonly resolved: string
}

/**
 * Resolve one bare plugin specifier through the ambient module pipeline and
 * through the plugin entry's own location.
 * @param specifier - plugin module specifier to resolve.
 * @param parentURL - base URL the Loader resolves the specifier against.
 * @returns both resolutions.
 */
export type SourcePlaneResolver = (specifier: string, parentURL: string) => SourcePlaneResolution

/**
 * The ambient resolver: the tsconfig `paths` projection the rest of the graph
 * uses, and Node's own resolution from the entry's location, which the profile
 * resolution router owns during a launch and the ambient pipeline never touches.
 * The entry-side answer arrives as a file URL so a Windows path separator never
 * hides a `node_modules` segment from the decision.
 * @param specifier - plugin module specifier to resolve.
 * @param parentURL - base URL the Loader resolves the specifier against.
 * @returns both resolutions.
 */
export const resolveSourcePlane: SourcePlaneResolver = (specifier, parentURL) => ({
  projected: import.meta.resolve(specifier),
  resolved: pathToFileURL(createRequire(parentURL).resolve(specifier)).href,
})

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
 * @param resolve - resolution source; defaults to {@link resolveSourcePlane}.
 * @returns true when the specifier must load through the ambient pipeline.
 */
export function loadsFromSourcePlane(
  specifier: string,
  parentURL: string,
  resolve: SourcePlaneResolver = resolveSourcePlane,
): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':')) return false
  try {
    const { projected, resolved } = resolve(specifier, parentURL)
    return !projected.includes('/node_modules/') && !resolved.includes('/node_modules/')
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
 * @param resolve - resolution source the redirect decision reads; defaults to {@link resolveSourcePlane}.
 */
export function installSourcePlanePluginLoader(loader: Loader, resolve: SourcePlaneResolver = resolveSourcePlane): void {
  const internal = loader.internal
  if (internal === undefined) return
  const sourcePlane = Object.create(internal) as ModuleLoader
  sourcePlane.import = async (specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<unknown> =>
    loadsFromSourcePlane(specifier, parentURL, resolve)
      ? import(specifier)
      : internal.import(specifier, parentURL, importAttributes)
  loader.internal = sourcePlane
}
