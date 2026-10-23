/**
 * Install packed tarballs into a throwaway consumer outside the repository and
 * drive the installed executable with plain Node.
 *
 * Every tarball the installed tree needs comes from `--from`, so the only
 * registry traffic is for external dependencies. That matters beyond hermetic
 * verification: the harness packages declare the vendored framework as a peer,
 * those packages live in another release sequence, and this job must not depend
 * on the registry already carrying versions that match — one pull request may
 * bump both families before either publishes — so a dsh verification passes the
 * vendored family's pack output too, while publishing only its own
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * What this proves is that `files` selected a complete payload and that the
 * published dependency ranges resolve. A workspace link or a stale `lib/` in the
 * checkout cannot stand in for a missing file here.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'
import { verifyInstalledProductIsolation } from './installed-product-isolation.ts'

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
 * @param consumerRoot - the throwaway consumer directory.
 * @returns The child environment.
 */
function consumerEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = resolve(consumerRoot, '.dsh')
  environment.DSH_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.DSH_TELEMETRY_DISABLED = '1'
  return environment
}

/**
 * Every packed tarball in the given directories, as `file:` dependency entries.
 *
 * The directories are read by their contents rather than a pack order file: a
 * directory here can hold tarballs packed only to satisfy a cross-sequence
 * dependency, which no release order describes.
 * @param directories - absolute directories holding packed tarballs.
 * @returns Package name to tarball file URL, and the version each carries.
 */
function packedDependencies(directories: readonly string[]): Map<string, { url: string; version: string }> {
  const dependencies = new Map<string, { url: string; version: string }>()
  for (const directory of directories) {
    const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`${directory} holds no packed tarball`)
    for (const filename of tarballs) {
      const tarball = join(directory, filename)
      const { name, version } = packedIdentity(tarball)
      dependencies.set(name, { url: pathToFileURL(tarball).href, version })
    }
  }
  return dependencies
}

/**
 * Installed packages that another installed package lists under
 * `optionalDependencies`: the per-platform binary packages a consumer which
 * omits optional dependencies does not receive.
 * @param modulesRoot - the consumer's installed `node_modules` directory.
 * @returns Absolute paths of the installed matches, sorted.
 */
export function optionalPlatformPackagePaths(modulesRoot: string): string[] {
  const optionalNames = new Set<string>()
  for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const packages = entry.name.startsWith('@')
      ? readdirSync(join(modulesRoot, entry.name), { withFileTypes: true })
        .filter(child => child.isDirectory() && !child.name.startsWith('.'))
        .map(child => join(modulesRoot, entry.name, child.name))
      : [join(modulesRoot, entry.name)]
    for (const packageDirectory of packages) {
      const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
        optionalDependencies?: Record<string, string>
      }
      for (const name of Object.keys(manifest.optionalDependencies ?? {})) optionalNames.add(name)
    }
  }
  return [...optionalNames].map(name => join(modulesRoot, name)).filter(path => existsSync(path)).sort()
}

/** Install every tarball under `--from` and drive the `--family` entry. */
function main(): void {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string', multiple: true } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined || values.from.length === 0) {
    throw new Error('usage: verify-packed-install.ts --family <dsh|vendor> --from <packed directory> [--from ...]')
  }

  const family = releaseFamily(values.family)
  const entry = family.installedEntry
  if (entry === undefined) {
    console.log(`release verify-packed-install: family ${family.id} publishes no executable, nothing to drive`)
    return
  }

  const root = process.cwd()
  const packed = packedDependencies(values.from.map(directory => resolve(root, directory)))
  const expected = packed.get(entry.packageName)
  if (expected === undefined) throw new Error(`${entry.packageName} is not among the packed tarballs`)

  const consumerRoot = mkdtempSync(join(tmpdir(), `dsh-packed-${family.id}-`))
  try {
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: `dsh-packed-install-${family.id}`,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries([...packed].map(([name, entryPacked]) => [name, entryPacked.url])),
    }, null, 2)}\n`)

    const environment = consumerEnvironment(consumerRoot)
    console.log(`release verify-packed-install: installing ${String(packed.size)} tarball(s) into ${consumerRoot}`)
    // Optional dependencies stay installed: koffi resolves its binary through an
    // optional per-platform package and compiles from source without it, which
    // fails on any Node release newer than its published prebuilds. Removing
    // those packages afterwards leaves the tree an `--omit=optional` consumer
    // receives, which is what the checks below must survive. The Landlock entry
    // package is a plain dependency of dsh-sandbox-local, so its tarball is
    // supplied through --from while its platform packages come from the registry.
    capture('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--loglevel=http'],
      { cwd: consumerRoot, env: environment })

    const modulesRoot = join(consumerRoot, 'node_modules')
    const platformPackages = optionalPlatformPackagePaths(modulesRoot)
    for (const packageDirectory of platformPackages) rmSync(packageDirectory, { recursive: true, force: true })
    console.log(`release verify-packed-install: removed ${String(platformPackages.length)} optional platform package(s)`)

    const installedEntry = join(modulesRoot, entry.packageName)
    const packageCount = verifyInstalledProductIsolation(installedEntry)
    console.log(`release verify-packed-install: ${String(packageCount)} default-product packages exclude experimental packages`)
    const bin = join(consumerRoot, 'node_modules', ...entry.packageName.split('/'), entry.binPath)
    const version = capture(process.execPath, [bin, '--version'], { cwd: consumerRoot, env: environment })
    if (version !== expected.version) {
      throw new Error(`installed ${entry.packageName} --version reported ${JSON.stringify(version)}, expected ${expected.version}`)
    }
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) main()
