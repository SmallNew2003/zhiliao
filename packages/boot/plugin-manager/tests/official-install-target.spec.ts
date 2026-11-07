/** Official installation targets follow the actual CLI installation and its workspace packages. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ON_DEMAND_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { initProfile, loadProfileDirectory, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { runProfilePnpm } from '../src/operations.ts'
import { officialBundleInstallTarget } from '../src/official-install-target.ts'

const name = '@deepseek-ai/dsh-subagent-codex'
const version = '0.1.0-alpha.1'

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'official-target-'))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = realpathSync(temporary)
  const anchor = join(root, 'apps', 'cli', 'package.json')
  mkdirSync(dirname(anchor), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': 'workspace:*' } }))
  const directory = join(root, 'packages', 'relocated', 'native-provider')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(directory, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  return { root, anchor, directory }
}

function packagedFixture(packageName = name) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'official-packaged-')))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const installation = join(temporary, 'runtime')
  const anchor = join(installation, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const directory = join(installation, 'node_modules', packageName)
  mkdirSync(dirname(anchor), { recursive: true })
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { [packageName]: version } }))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: packageName, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(directory, 'lib/index.js'), 'throw new Error("provider must not be imported")\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  return { temporary, installation, anchor, directory }
}

it.each(ON_DEMAND_BUNDLES)('offers the packaged local copy of %s without a source checkout', (packageName) => {
  const { anchor, directory } = packagedFixture(packageName)
  expect(officialBundleInstallTarget(packageName, anchor, version)).toEqual({ spec: `link:${directory}`, version })
})

it('retains the logical installation path across runtime replacement', () => {
  const { temporary, installation, directory } = packagedFixture()
  const stable = join(temporary, 'current')
  symlinkSync(installation, stable, process.platform === 'win32' ? 'junction' : 'dir')
  const anchor = join(stable, 'node_modules/@deepseek-ai/dsh/package.json')
  const target = officialBundleInstallTarget(name, anchor, version)
  expect(target).toEqual({ spec: `link:${join(stable, 'node_modules', name)}`, version })
  expect(target.spec).not.toContain(directory)
})

it.each(['undeclared', 'missing', 'wrong-name', 'version', 'main', 'patch'])('rejects a packaged bundle with invalid %s instead of using npm', (kind) => {
  const { anchor, directory } = packagedFixture()
  const manifest = join(directory, 'package.json')
  if (kind === 'undeclared') writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  if (kind === 'missing') rmSync(directory, { recursive: true })
  if (kind === 'wrong-name' || kind === 'version') {
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), [kind === 'wrong-name' ? 'name' : 'version']: 'different' }))
  }
  if (kind === 'main') rmSync(join(directory, 'lib/index.js'))
  if (kind === 'patch') rmSync(join(directory, 'cordis.patch.yml'))
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow(/Official bundle/)
})

it('rejects a matching package outside the running installation instead of borrowing an ancestor copy', () => {
  const { temporary, anchor, directory } = packagedFixture()
  const foreign = join(temporary, 'node_modules', name)
  mkdirSync(dirname(foreign), { recursive: true })
  renameSync(directory, foreign)
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow(/Official bundle/)
})

it('installs and removes a packaged target offline without importing its provider or removing installation media', async () => {
  const { temporary, anchor, directory } = packagedFixture()
  const profile = join(temporary, 'profile')
  initProfile(profile, [])
  const target = officialBundleInstallTarget(name, anchor, version)
  const result = await runProfilePnpm({ profile: 'test', dir: profile, installAnchor: anchor, cwd: temporary, home: temporary },
    ['add', target.spec, '--offline', '--ignore-scripts', '--registry=http://127.0.0.1:1', '--config.auto-install-peers=false'], {
      execution: 'service', outputBytes: 16_384, env: { npm_config_update_notifier: 'false' },
    })
  expect(result, result.output).toMatchObject({ exitCode: 0 })
  expect(result.timedOut).not.toBe(true)
  const saved = readProfileManifest('test', profile).dependencies?.[name]
  expect(saved?.startsWith('link:')).toBe(true)
  expect(resolve(profile, saved?.slice(5) ?? '')).toBe(directory)
  expect(loadProfileDirectory('test', profile, anchor).layers.map(layer => layer.packageName)).toEqual([name])
  const removed = await runProfilePnpm({ profile: 'test', dir: profile, installAnchor: anchor, cwd: temporary, home: temporary },
    ['remove', name, '--config.offline=true', '--config.registry=http://127.0.0.1:1'], { execution: 'service', outputBytes: 16_384 })
  expect(removed, removed.output).toMatchObject({ exitCode: 0 })
  expect(removed.timedOut).not.toBe(true)
  expect(readProfileManifest('test', profile).dependencies?.[name]).toBeUndefined()
  expect(readProfileManifest('test', profile).dsh?.profile?.bundles).toEqual([])
  expect(loadProfileDirectory('test', profile, anchor).layers).toEqual([])
  expect(readFileSync(join(directory, 'lib/index.js'), 'utf8')).toContain('provider must not be imported')
})

it('finds the package by manifest name rather than assuming its workspace directory', () => {
  const { anchor, directory } = fixture()
  expect(officialBundleInstallTarget(name, anchor, version)).toEqual({ spec: `link:${directory}`, version })
})

it('follows the CLI directory link used by an unpackaged Desktop application', () => {
  const { root, anchor, directory } = fixture()
  const link = join(root, 'desktop-runtime', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(dirname(anchor), link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officialBundleInstallTarget(name, join(link, 'package.json'), version)).toEqual({ spec: `link:${directory}`, version })
})

it.each(['missing', 'wrong-name', 'wrong-location'])('refuses a source CLI with a %s workspace root', (kind) => {
  const { root, anchor } = fixture()
  if (kind === 'missing') rmSync(join(root, 'package.json'))
  if (kind === 'wrong-name') writeFileSync(join(root, 'package.json'), '{"name":"unrelated"}')
  const selected = kind === 'wrong-location' ? join(root, 'package.json') : anchor
  if (kind === 'wrong-location') writeFileSync(selected, readFileSync(anchor))
  expect(() => officialBundleInstallTarget(name, selected, version)).toThrow('requires its complete workspace checkout')
})

it.each(['missing', 'duplicate'])('refuses a %s workspace package without offering a registry fallback', (kind) => {
  const { root, anchor, directory } = fixture()
  if (kind === 'missing') rmSync(directory, { recursive: true })
  else {
    const duplicate = join(root, 'packages', 'elsewhere', 'duplicate')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'package.json'), readFileSync(join(directory, 'package.json')))
  }
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('expected one workspace package')
})

it.each([
  { version: '0.1.0' }, { private: true }, { dsh: {} },
])('refuses a workspace package with invalid release or bundle metadata: %j', (changes) => {
  const { anchor, directory } = fixture()
  const file = join(directory, 'package.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...changes }))
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('must declare a public bundle at DSH version')
})

it.each(['missing-main', 'missing-output', 'directory-output'])('refuses an unbuilt workspace package: %s', (kind) => {
  const { anchor, directory } = fixture()
  if (kind === 'missing-main') {
    const file = join(directory, 'package.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), main: undefined }))
  } else {
    const output = join(directory, 'lib', 'index.js')
    rmSync(output)
    if (kind === 'directory-output') mkdirSync(output)
  }
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('run pnpm install and pnpm run build')
})

it.each(['missing', 'directory'])('refuses an unavailable bundle patch: %s', (kind) => {
  const { anchor, directory } = fixture()
  const patch = join(directory, 'cordis.patch.yml')
  rmSync(patch)
  if (kind === 'directory') mkdirSync(patch)
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('bundle patch')
})
