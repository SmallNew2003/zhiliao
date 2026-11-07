/** Select Official bundle packages from the running installation without importing provider code. */
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { bundlePatchPaths, resolveBundleDir, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

interface WorkspaceManifest extends ProfileManifest {
  main?: string
}

function manifestAt(file: string): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

/**
 * Offer a validated local link from the running installation. Source installations are
 * identified by the real CLI manifest and its unpacked workspace dependencies, including Desktop's
 * development symlink. Missing or incomplete installation packages are errors, never registry fallbacks.
 * @param name - Official catalog package name.
 * @param installAnchor - Running application's DSH package.json, possibly reached through a symlink.
 * @param version - Running DSH version used by its release family.
 * @returns An ordinary package-manager spec and its package version.
 * @throws when the installation lacks its declared package, matching version, bundle patch, or built runtime.
 */
export function officialBundleInstallTarget(name: string, installAnchor: string, version: string): { spec: string; version: string } {
  const anchor = realpathSync(installAnchor)
  const installation = manifestAt(anchor)
  const source = installation.name === '@deepseek-ai/dsh'
    && Object.values(installation.dependencies ?? {}).some(value => value.startsWith('workspace:'))
  if (!source) {
    if (!Object.hasOwn(installation.dependencies ?? {}, name)) {
      throw new Error(`Official bundle ${name}: running installation does not declare this package; reinstall the application`)
    }
    let directory: string
    try {
      const logicalAnchor = resolve(installAnchor)
      directory = resolveBundleDir('dsh', name, logicalAnchor, dirname(logicalAnchor))
      const inside = relative(installationModules(logicalAnchor), directory)
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
        throw new Error(`resolved outside the running installation: ${directory}`)
      }
    } catch (error) {
      throw new Error(`Official bundle ${name}: running installation is incomplete; reinstall the application`, { cause: error })
    }
    validateBundle(name, directory, version, 'reinstall the application')
    return { spec: `link:${directory}`, version }
  }
  const root = resolve(dirname(anchor), '../..')
  if (anchor !== join(root, 'apps', 'cli', 'package.json')
    || !existsSync(join(root, 'package.json'))
    || manifestAt(join(root, 'package.json')).name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Official bundle ${name}: source DSH installation ${anchor} requires its complete workspace checkout`)
  }
  const matches = globSync('packages/*/*/package.json', { cwd: root })
    .map(file => ({ file: join(root, file), manifest: manifestAt(join(root, file)) }))
    .filter(entry => entry.manifest.name === name)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error(`Official bundle ${name}: expected one workspace package in ${root}, found ${matches.length}; restore the checkout and run pnpm install`)
  }
  const directory = realpathSync(dirname(selected.file))
  validateBundle(name, directory, version, `run pnpm install and pnpm run build in ${root}`)
  return { spec: `link:${directory}`, version }
}

/** Validate installation bytes without loading a provider module. */
function validateBundle(name: string, directory: string, version: string, repair: string): void {
  const file = join(directory, 'package.json')
  const manifest = manifestAt(file)
  if (manifest.name !== name || manifest.version !== version || manifest.private === true || manifest.dsh?.bundle === undefined) {
    throw new Error(`Official bundle ${name}: ${file} must declare a public bundle at DSH version ${version}; ${repair}`)
  }
  const main = typeof manifest.main === 'string' ? resolve(directory, manifest.main) : undefined
  if (main === undefined || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Official bundle ${name}: built runtime is missing in ${directory}; ${repair}`)
  }
  for (const patch of bundlePatchPaths(directory, manifest.dsh.bundle)) {
    if (!existsSync(patch) || !statSync(patch).isFile()) {
      throw new Error(`Official bundle ${name}: bundle patch ${patch} is missing; ${repair}`)
    }
  }
}

/** The logical node_modules tree owned by the running CLI package. */
function installationModules(anchor: string): string {
  const directory = dirname(anchor)
  for (let parent = directory; dirname(parent) !== parent; parent = dirname(parent)) {
    if (basename(parent) === 'node_modules') return parent
  }
  return join(directory, 'node_modules')
}
