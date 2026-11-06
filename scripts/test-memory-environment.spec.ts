/** Every Vitest lane and its children isolate memory from an ambient local daemon. */
import { execFile } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'

const run = promisify(execFile)
const isolatedUrl = 'http://127.0.0.1:0'
const root = fileURLToPath(new URL('../', import.meta.url))

describe('test memory endpoint isolation', () => {
  it('starts the Vitest worker with an unavailable memory endpoint', () => {
    expect(process.env.HINDSIGHT_API_URL).toBe(isolatedUrl)
  })

  it.each([undefined, 'http://127.0.0.1:9077'])('isolates a child config before dotenv loads (ambient=%s)', async (ambient) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-test-memory-env-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const envFile = join(directory, '.env')
    await writeFile(envFile, 'HINDSIGHT_API_URL=http://127.0.0.1:9077\nDSH_MEMORY_TEST_KEEP=from-file\n')
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_MEMORY_TEST_KEEP: 'preserved' }
    if (ambient === undefined) Reflect.deleteProperty(env, 'HINDSIGHT_API_URL')
    else env.HINDSIGHT_API_URL = ambient
    const code = [
      `await import(${JSON.stringify(new URL('../vitest.shared.ts', import.meta.url).href)});`,
      `process.loadEnvFile(${JSON.stringify(envFile)});`,
      'process.stdout.write(JSON.stringify({ endpoint: process.env.HINDSIGHT_API_URL, unrelated: process.env.DSH_MEMORY_TEST_KEEP }));',
    ].join('\n')
    const result = await run(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '-e', code], {
      cwd: root, env, timeout: 10_000,
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ endpoint: isolatedUrl, unrelated: 'preserved' })
  })

  it('keeps explicitly owned fixture endpoints overridable within a test', () => {
    const original = process.env.HINDSIGHT_API_URL
    try {
      process.env.HINDSIGHT_API_URL = 'http://127.0.0.1:12345'
      expect(process.env.HINDSIGHT_API_URL).toBe('http://127.0.0.1:12345')
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, 'HINDSIGHT_API_URL')
      else process.env.HINDSIGHT_API_URL = original
    }
  })

  it('wires the shared test environment into every Vitest configuration', () => {
    const configs = globSync('vitest*.config.ts', { cwd: root }).sort()
    expect(configs).toContain('vitest.web.config.ts')
    expect(configs).toContain('vitest.snapshot.config.ts')
    for (const config of configs) {
      expect(readFileSync(join(root, config), 'utf8'), config).toContain("from './vitest.shared.ts'")
    }
  })
})
