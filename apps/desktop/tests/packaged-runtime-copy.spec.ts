/** Builder resource copies retain the complete sealed runtime outside ASAR. */
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { getFileMatchers, type FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { expect, it, onTestFinished } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { verifyPackagedRuntime } from '../scripts/verify-packaged-runtime.ts'
import { verifyWindowsRuntimeCopy } from '../scripts/windows-runtime-copy.mjs'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

// The locked builder exports its resource copier without a declaration.
const { copyFiles } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js') as {
  copyFiles: (matchers: FileMatcher[]) => Promise<void>
}

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'desktop-resource-copy-'))
  onTestFinished(() => rm(temporary, { recursive: true, force: true }))
  const source = join(temporary, 'prepared', 'dsh')
  const resources = join(temporary, 'application', 'resources')
  const descriptor = runtimeFixture(source)
  const executable = 'node_modules/@deepseek-ai/dsh/tool.exe'
  await writeFile(join(source, executable), 'sealed PE bytes')
  const nested = join(source, 'node_modules/@deepseek-ai/dsh/node_modules/nested')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'nested', version: '1.0.0' }))
  await writeFile(join(nested, 'index.js'), 'export const nested = true\n')
  const metadata = join(source, 'node_modules/@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(await readFile(metadata, 'utf8')) as Record<string, unknown>
  manifest.scripts = { retained: 'not a build-time rewrite' }
  await writeFile(metadata, JSON.stringify(manifest))
  const expected = writeDesktopRuntime(source, descriptor.release, descriptor.sharedPackages.map(entry => entry.name))
  const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.runtime', DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com', DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }), DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64', source)
  const mappings = config.extraResources.filter(resource => resource.to === 'dsh' || resource.to === 'dsh/node_modules')
  expect(mappings).toHaveLength(2)
  const matchers = getFileMatchers({ extraResources: mappings.map(mapping => ({ ...mapping, filter: [...mapping.filter] })) }, 'extraResources', resources, {
    defaultSrc: temporary, globalOutDir: join(temporary, 'output'), customBuildOptions: {}, macroExpander: value => value,
  })!
  await copyFiles(matchers)
  const root = join(resources, 'dsh')
  return { temporary, source, resources, root, expected, executable, config }
}

it('copies nested packages and manifests through the shipping builder resource matcher without transformations', async () => {
  const { source, root, expected, config } = await fixture()
  expect(config.files.every(file => typeof file === 'string')).toBe(true)
  expect((await lstat(root)).isDirectory()).toBe(true)
  await expect(verifyPackagedRuntime(root, expected)).resolves.toBeUndefined()
  expect(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json')))
    .toEqual(await readFile(join(source, 'node_modules/@deepseek-ai/dsh/package.json')))
})

it.each(['sharedPackages', 'release', 'files'] as const)('rejects changed physical descriptor %s', async (field) => {
  const { root, expected } = await fixture()
  await writeFile(join(root, 'desktop-runtime.json'), JSON.stringify({ ...expected, [field]: [] }))
  await expect(verifyPackagedRuntime(root, expected)).rejects.toThrow('packaged descriptor differs')
})

it.each(['missing', 'extra', 'changed'] as const)('rejects %s copied runtime bytes', async (state) => {
  const { root, expected } = await fixture()
  const file = join(root, 'package.json')
  if (state === 'missing') await rm(file)
  else await writeFile(state === 'extra' ? join(root, 'extra.json') : file, '{}')
  await expect(verifyPackagedRuntime(root, expected)).rejects.toThrow('integrity verification failed')
})

it.skipIf(process.platform === 'win32')('rejects linked runtime files and changed executable permissions', async () => {
  const { root, source, expected, executable } = await fixture()
  await chmod(join(root, executable), 0o755)
  await expect(verifyPackagedRuntime(root, expected)).rejects.toThrow('integrity verification failed')
  await chmod(join(root, executable), 0o644)
  await rm(join(root, executable))
  await symlink(join(source, executable), join(root, executable))
  await expect(verifyPackagedRuntime(root, expected)).rejects.toThrow('unsupported filesystem entry')
})

it.each(['unchanged', 'changed', 'missing', 'directory'] as const)('checks %s physical Windows PE files against preparation', async (state) => {
  const { root, source, resources, executable } = await fixture()
  if (state === 'changed') { await rm(join(root, executable)); await writeFile(join(root, executable), 'changed') }
  if (state === 'missing' || state === 'directory') await rm(join(root, executable))
  if (state === 'directory') await mkdir(join(root, executable))
  const verification = verifyWindowsRuntimeCopy(source, resources, [executable])
  if (state === 'unchanged') await expect(verification).resolves.toBeUndefined()
  else await expect(verification).rejects.toThrow(state === 'changed' ? 'PE bytes changed' : state === 'directory' ? 'real PE file' : 'ENOENT')
})
