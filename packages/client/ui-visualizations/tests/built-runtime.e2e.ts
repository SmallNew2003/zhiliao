/** Artifact-plane checks; run after this package's compiler faces and bundle. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'vitest'
import { Script } from 'node:vm'
import assert from 'node:assert/strict'


const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const { runtimeManifest } = require('../lib/runtime-manifest.js') as { runtimeManifest: { id: string; libraries: Record<string, string> } }
const read = (name: string) => readFile(new URL(name, root), 'utf8')

function assetFactory(source: string) {
  let registration: {
    id: string
    factory: (require: () => never) => { assets: { css: readonly string[]; scripts: readonly string[] } }
  } | undefined
  new Script(source).runInNewContext({
    window: { __ModuleLoader__: { load(value: NonNullable<typeof registration>) { registration = value } } },
  })
  assert.ok(registration)
  assert.equal(registration.id, '@deepseek-ai/dsh-client-ui-visualizations')
  return registration.factory(() => { throw new Error('Raw runtime assets must have no external dependency') }).assets
}

test('publishes exact manifest versions, classic standalone bytes, and all retained licenses', async () => {
  assert.deepEqual(runtimeManifest, { id: 'dsh-v1', libraries: { bootstrap: '5.3.8', echarts: '6.1.0', mermaid: '11.16.0' } })
  for (const [name, version] of Object.entries(runtimeManifest.libraries)) {
    assert.equal((require(`${name}/package.json`) as { version: string }).version, version)
    assert.ok((await read(`lib/licenses/${name}.txt`)).length > 100)
  }
  for (const name of ['popper', 'zrender', 'echarts-NOTICE', 'echarts-LICENSE-d3']) assert.ok((await read(`lib/licenses/${name}.txt`)).length > 100)
  assert.deepEqual(JSON.parse(await read('lib/licenses/runtime-manifest.json')), runtimeManifest)
  const html = assetFactory(await read('lib/client.html-assets.js'))
  const charts = assetFactory(await read('lib/client.echarts-assets.js'))
  const diagrams = assetFactory(await read('lib/client.mermaid-assets.js'))
  assert.equal(html.css.length, 1); assert.equal(html.scripts.length, 1)
  assert.equal(charts.scripts.length, 1); assert.equal(diagrams.scripts.length, 1)
  for (const script of [...html.scripts, ...charts.scripts, ...diagrams.scripts]) {
    assert.doesNotThrow(() => new Script(script))
    assert.doesNotMatch(script, /\bimport\s*\(/u)
  }
  assert.match(html.scripts[0] ?? '', /Bootstrap v5\.3\.8/u)
  assert.match(charts.scripts[0] ?? '', /version="6\.1\.0"/u)
  assert.match(diagrams.scripts[0] ?? '', /Bundled license information/u)
  assert.ok(Object.isFrozen(html)); assert.ok(Object.isFrozen(charts.scripts))
})

test('keeps library source bytes out of startup and publishes its declared artifacts', async () => {
  const startup = await read('lib/client.js')
  assert.ok(startup.length < 150000)
  assert.doesNotMatch(startup, /Bootstrap v5\.3\.8|Licensed to the Apache Software Foundation|__esbuild_esm_mermaid_nm/u)
  for (const name of ['html-assets', 'echarts-assets', 'mermaid-assets']) assert.ok(startup.includes(`require.async("./client.${name}.js")`))
  const manifest = JSON.parse(await read('package.json')) as { files: string[]; exports: Record<string, { default: string }> }
  assert.ok(manifest.files.includes('lib/client.*.js')); assert.ok(manifest.files.includes('lib/licenses/*'))
  assert.equal(manifest.exports['./runtime-manifest']?.default, './lib/runtime-manifest.js')
})
