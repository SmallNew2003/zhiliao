import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import {
  installSourcePlanePluginLoader, loadsFromSourcePlane, resolveSourcePlane,
  type SourcePlaneResolution, type SourcePlaneResolver,
} from '../src/source-plane.ts'

/** A config URL inside the repository, the shape a mounted include tree carries. */
const repoParentURL = (): string => import.meta.url

/** A resolver answering with one fixed pair of resolutions. */
const resolverReturning = (resolution: SourcePlaneResolution): SourcePlaneResolver => () => resolution

const checkout = (file: string): SourcePlaneResolution => ({ projected: `file:///repo/${file}/src/index.ts`, resolved: `/repo/${file}/lib/index.js` })
const installed = (file: string): SourcePlaneResolution => ({ projected: `file:///repo/${file}/src/index.ts`, resolved: `/repo/node_modules/${file}/index.mjs` })
const dependency = (name: string): SourcePlaneResolution => ({ projected: `file:///repo/node_modules/.pnpm/${name}/index.mjs`, resolved: `/repo/node_modules/.pnpm/${name}/index.js` })

describe('loadsFromSourcePlane', () => {
  it('leaves relative, absolute, import-map, and builtin specifiers on the internal loader', () => {
    expect(loadsFromSourcePlane('./plugin.mjs', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('/srv/plugin.mjs', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('#entry', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('node:fs', repoParentURL())).toBe(false)
  })

  it('redirects a specifier both planes resolve outside node_modules', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-tools', repoParentURL(), resolverReturning(checkout('packages/core/tools')))).toBe(true)
  })

  it('keeps the copy the entry location owns under node_modules', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-system-prompt', repoParentURL(), resolverReturning(installed('@deepseek-ai/dsh-system-prompt')))).toBe(false)
  })

  it('leaves a dependency installed under node_modules on the internal loader', () => {
    expect(loadsFromSourcePlane('js-yaml', repoParentURL(), resolverReturning(dependency('js-yaml')))).toBe(false)
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-tools', repoParentURL(), resolverReturning({
      projected: 'file:///repo/node_modules/@deepseek-ai/dsh-tools/src/index.ts',
      resolved: '/repo/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    }))).toBe(false)
  })

  it('leaves a specifier either plane cannot resolve on the internal loader', () => {
    const throwing: SourcePlaneResolver = () => { throw new Error('Cannot find module') }
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-no-such-package', repoParentURL(), throwing)).toBe(false)
  })

  it('reads the ambient planes by default', () => {
    expect(loadsFromSourcePlane('js-yaml', repoParentURL())).toBe(false)
    const { projected, resolved } = resolveSourcePlane('js-yaml', repoParentURL())
    expect(projected).toContain('/node_modules/')
    expect(resolved).toContain('/node_modules/')
  })
})

describe('installSourcePlanePluginLoader', () => {
  it('leaves a loader without reachable internals untouched', () => {
    const loader = { internal: undefined } as unknown as Loader
    installSourcePlanePluginLoader(loader)
    expect(loader.internal).toBeUndefined()
  })

  it('loads a source-plane plugin entry through the ambient pipeline', async () => {
    const internal = { import: vi.fn() }
    const loader = { internal } as unknown as Loader
    installSourcePlanePluginLoader(loader, resolverReturning(checkout('packages/core/tools')))
    const ambient = await import('@deepseek-ai/dsh-system-prompt')
    expect(await (loader.internal as ModuleLoader).import('@deepseek-ai/dsh-system-prompt', repoParentURL(), {})).toBe(ambient)
    expect(internal.import).not.toHaveBeenCalled()
  })

  it('delegates every other specifier to the internal loader', async () => {
    const sentinel = { delegated: true }
    const internal = { import: vi.fn(async () => sentinel) }
    const loader = { internal } as unknown as Loader
    installSourcePlanePluginLoader(loader, resolverReturning(installed('@deepseek-ai/dsh-system-prompt')))
    const importAttributes = {}
    expect(await (loader.internal as ModuleLoader).import('./plugin.mjs', repoParentURL(), importAttributes)).toBe(sentinel)
    expect(internal.import).toHaveBeenCalledWith('./plugin.mjs', repoParentURL(), importAttributes)
  })

  it('reads the ambient planes by default', () => {
    const internal = { import: vi.fn() }
    const loader = { internal } as unknown as Loader
    installSourcePlanePluginLoader(loader)
    expect(loader.internal).not.toBe(internal)
  })
})
