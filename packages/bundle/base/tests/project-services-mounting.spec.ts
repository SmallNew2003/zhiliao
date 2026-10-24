/**
 * Real-composition guard for the project-service rows the shipped base bundle
 * declares. The runtime is the package root's default export, but the provider
 * that actually registers services is a subpath default export, so a base patch
 * that names only the package root leaves `ctx.projectServices` with no
 * providers in every shipped profile — an empty service inventory and a
 * `Service provider unavailable` control failure — while each package's own
 * unit tests still pass. This test reads the shipped patch and boots exactly
 * the project-service rows it declares, so a dropped row or a module that stops
 * registering fails here instead of in a deployment.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceAccess, ServiceActorId, ServiceExecutionIdentity } from '@deepseek-ai/dsh-project-services'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The specifiers the base patch must declare for a working service layer. */
const REQUIRED_SPECIFIERS = [
  '@deepseek-ai/dsh-project-services-local',
  '@deepseek-ai/dsh-project-services-local/native',
  '@deepseek-ai/dsh-project-services-docker',
  '@deepseek-ai/dsh-tool-project-services',
]

/** The supporting services the project-service rows inject, with literal config. */
const SERVICE_ROWS = [
  '- id: storage',
  "  name: '@deepseek-ai/dsh-storage'",
  '- id: storage-json',
  "  name: '@deepseek-ai/dsh-storage-json'",
  '  config:',
  '    root: STORAGE_ROOT',
  '- id: storage-domain',
  "  name: '@deepseek-ai/dsh-storage-domain'",
  '  config:',
  '    backend: json',
  '- id: subprocess',
  "  name: '@deepseek-ai/dsh-subprocess-local'",
  '- id: tools',
  "  name: '@deepseek-ai/dsh-tools'",
  '- id: system-prompt',
  "  name: '@deepseek-ai/dsh-system-prompt'",
  '',
]

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

/** Every insert row of the shipped base patch, flattened out of its patch lists. */
function shippedRows(): Record<string, unknown>[] {
  const parsed = yaml.load(
    readFileSync(join(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
  return parsed.flatMap((patch): Record<string, unknown>[] =>
    typeof patch === 'object' && patch !== null
      ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
      : [],
  )
}

/** The project-service rows the shipped patch declares, keyed by specifier. */
function shippedProjectServiceRows(): Map<string, { id: string; name: string }> {
  const rows = new Map<string, { id: string; name: string }>()
  for (const row of shippedRows()) {
    const name = row.name
    if (typeof name !== 'string' || !name.includes('project-services')) continue
    if (typeof row.id !== 'string') throw new Error(`project-service row ${name} must carry an id`)
    rows.set(name, { id: row.id, name })
  }
  return rows
}

/** A read-only human caller; this guard asserts registration, not authorization. */
function readAccess(cwd: string): ServiceAccess {
  return {
    actorId: brandString<ServiceActorId>('composition-guard'),
    kind: 'human',
    cwd,
    executionIdentity: brandString<ServiceExecutionIdentity>('local'),
    canRead: () => Promise.resolve(true),
    revalidate: () => Promise.resolve(),
    authorize: () => Promise.resolve(),
  }
}

describe('base bundle project-service mounting', () => {
  it('declares the native provider subpath beside the runtime root', () => {
    // The runtime root alone registers no provider: the native provider is a
    // subpath default export, so this row is what makes the service layer work.
    expect([...shippedProjectServiceRows().keys()].sort()).toEqual([...REQUIRED_SPECIFIERS].sort())
  })

  it('registers native and Docker providers when the shipped rows boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'base-project-services-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const rows = [...shippedProjectServiceRows().values()]
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-project-services-local', await import('@deepseek-ai/dsh-project-services-local')],
      ['@deepseek-ai/dsh-project-services-local/native', await import('@deepseek-ai/dsh-project-services-local/native')],
      ['@deepseek-ai/dsh-project-services-docker', await import('@deepseek-ai/dsh-project-services-docker')],
      ['@deepseek-ai/dsh-tool-project-services', await import('@deepseek-ai/dsh-tool-project-services')],
      ['@deepseek-ai/dsh-storage', await import('@deepseek-ai/dsh-storage')],
      ['@deepseek-ai/dsh-storage-json', await import('@deepseek-ai/dsh-storage-json')],
      ['@deepseek-ai/dsh-storage-domain', await import('@deepseek-ai/dsh-storage-domain')],
      ['@deepseek-ai/dsh-subprocess-local', await import('@deepseek-ai/dsh-subprocess-local')],
      ['@deepseek-ai/dsh-tools', await import('@deepseek-ai/dsh-tools')],
      ['@deepseek-ai/dsh-system-prompt', await import('@deepseek-ai/dsh-system-prompt')],
    ])
    const missing = rows.map(row => row.name).filter(name => !modules.has(name))
    if (missing.length > 0) throw new Error(`shipped patch names modules this guard does not resolve: ${missing.join(', ')}`)

    const config = [
      ...SERVICE_ROWS.map(line => line === '    root: STORAGE_ROOT'
        ? `    root: ${JSON.stringify(join(dir, 'storages'))}`
        : line),
      ...rows.flatMap(row => [`- id: ${row.id}`, `  name: '${row.name}'`, '']),
    ].join('\n')
    await writeFile(join(dir, 'cordis.yml'), config)

    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
    })
    await ctx.loader.await()

    const inventory = await ctx.projectServices.list(readAccess(dir), {}, new AbortController().signal)
    expect(inventory.providers.map(provider => provider.id).sort()).toEqual(['docker', 'native'])
    // The three model-facing tools ride the same composition.
    expect(['service_list', 'service_logs', 'service_control']
      .map(name => ctx.tools.get(name)?.name))
  })
})
