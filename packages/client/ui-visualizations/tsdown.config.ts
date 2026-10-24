/** Bundle exact library bytes in kind-specific lazy browser chunks and retain notices. */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'
import { runtimeManifest } from './src/runtime-manifest.ts'

const require = createRequire(import.meta.url)
const bundle = clientBundle('@deepseek-ai/dsh-client-ui-visualizations', ['lib/types/index.js', 'lib/types/runtime-manifest.js'])
const sources = new Set([
  'bootstrap/dist/css/bootstrap.min.css?raw', 'bootstrap/dist/js/bootstrap.bundle.min.js?raw',
  'echarts/dist/echarts.min.js?raw', 'mermaid/dist/mermaid.min.js?raw',
])

/** Pin both build inputs and published third-party notices. */
const rawAssets: NonNullable<UserConfig['plugins']> = [{
  name: 'dsh-visualization-runtime-assets',
  buildStart() {
    mkdirSync('lib/licenses', { recursive: true })
    for (const [name, version] of Object.entries(runtimeManifest.libraries)) {
      const root = dirname(require.resolve(`${name}/package.json`))
      const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
      if (installed.version !== version) throw new Error(`Runtime asset ${name} requires ${version}, found ${installed.version}`)
      const notice = readFileSync(join(root, 'LICENSE'), 'utf8')
      writeFileSync(`lib/licenses/${name}.txt`, notice)
      if (name === 'echarts') {
        writeFileSync('lib/licenses/echarts-NOTICE.txt', readFileSync(join(root, 'NOTICE'), 'utf8'))
        for (const file of readdirSync(join(root, 'licenses'))) writeFileSync(`lib/licenses/echarts-${file}.txt`, readFileSync(join(root, 'licenses', file), 'utf8'))
      }
    }
    const bootstrapRequire = createRequire(require.resolve('bootstrap/package.json'))
    const popperRoot = dirname(bootstrapRequire.resolve('@popperjs/core/package.json'))
    writeFileSync('lib/licenses/popper.txt', readFileSync(join(popperRoot, 'LICENSE.md'), 'utf8'))
    const chartRequire = createRequire(require.resolve('echarts/package.json'))
    const zrenderRoot = dirname(chartRequire.resolve('zrender/package.json'))
    writeFileSync('lib/licenses/zrender.txt', readFileSync(join(zrenderRoot, 'LICENSE'), 'utf8'))
    // Mermaid's standalone distribution embeds its additional dependency notices.
    writeFileSync('lib/licenses/runtime-manifest.json', JSON.stringify(runtimeManifest, null, 2) + '\n')
  },
  resolveId(source) { return sources.has(source) ? `\0dsh-visualization:${source}` : null },
  load(id) {
    const source = id.replace(/^\0dsh-visualization:/u, '')
    if (!sources.has(source)) return null
    const path = require.resolve(source.slice(0, -4))
    this.addWatchFile(path)
    return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`
  },
}]

export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true ? { ...config, plugins: [config.plugins, rawAssets] } : config,
)
