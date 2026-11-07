/** The diagnostic Worker remains part of the Electron shell archive. */
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { expect, it, onTestFinished } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
const require = createRequire(import.meta.url)
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js') as {
  AsarPackager: new (packager: object, configuration: object) => {
    pack(files: { src: string; destination: string; files: string[]; metadata: Map<string, Stats> }[]): Promise<void>
  }
}
function unsignedWindowsConfig(appId: string, source: string) {
  return createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: appId, DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com', DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }), DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64', source)
}

it('includes the diagnostic worker in the archive selected by the shipping file rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-worker-asar-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const appDir = join(root, 'app')
  const resources = join(root, 'resources')
  const destination = join(resources, 'app')
  await mkdir(join(appDir, 'lib'), { recursive: true })
  await mkdir(resources)
  const worker = join(appDir, 'lib', 'operation-report-worker.js')
  const excluded = join(appDir, 'lib', 'not-shipped.js')
  await writeFile(worker, 'export {}')
  await writeFile(excluded, 'export {}')
  const config = unsignedWindowsConfig('com.example.diagnostics', join(root, 'dsh'))
  const filesConfig = [...config.files]
  const matchers = getFileMatchers({ files: filesConfig }, 'files', destination, {
    defaultSrc: appDir, globalOutDir: root, customBuildOptions: {}, macroExpander: value => value,
  })!
  const matcher = matchers.find(entry => entry.from === appDir)!
  const filter = matcher.createFilter()
  const files: string[] = []
  const metadata = new Map<string, Stats>()
  for (const file of [worker, excluded]) {
    const stat = await lstat(file)
    if (filter(file, stat)) {
      files.push(file)
      metadata.set(file, stat)
    }
  }
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: destination, resourcePath: resources, options: {}, unpackPattern: () => false,
  }).pack([{ src: appDir, destination, files, metadata }])
  const archive = await readAsar(join(resources, 'app.asar'))
  expect(archive.getFile('lib/operation-report-worker.js').size).toBe(Buffer.byteLength('export {}'))
  expect(() => archive.getFile('lib/not-shipped.js')).toThrow()
})
