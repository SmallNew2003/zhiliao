import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSourcePlanePluginLoader, loadsFromSourcePlane } from '../src/source-plane.ts'

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-source-plane-'))
  tempRoots.push(dir)
  return dir
}

/** A config URL inside the repository, the shape a mounted include tree carries. */
const repoParentURL = (): string => import.meta.url

/** A config URL in a directory that owns no package manifest. */
const bareParentURL = (): string => pathToFileURL(join(tmp(), 'cordis.yml')).href

/**
 * A config project that keeps its own copy of a harness package under
 * `node_modules`, the shape a composition shadowing a harness package carries.
 */
const shadowingParentURL = (): string => {
  const dir = tmp()
  const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh-system-prompt')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-system-prompt',
    type: 'module',
    exports: './index.mjs',
  }))
  writeFileSync(join(pkg, 'index.mjs'), 'export default {}\n')
  return pathToFileURL(join(dir, 'cordis.yml')).href
}

describe('loadsFromSourcePlane', () => {
  it('leaves relative, absolute, import-map, and builtin specifiers on the internal loader', () => {
    expect(loadsFromSourcePlane('./plugin.mjs', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('/srv/plugin.mjs', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('#entry', repoParentURL())).toBe(false)
    expect(loadsFromSourcePlane('node:fs', repoParentURL())).toBe(false)
  })

  it('leaves a specifier the ambient pipeline cannot project on the internal loader', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-no-such-package', repoParentURL())).toBe(false)
  })

  it('leaves a dependency installed under node_modules on the internal loader', () => {
    expect(loadsFromSourcePlane('js-yaml', repoParentURL())).toBe(false)
  })

  it('redirects a workspace package the entry location also resolves outside node_modules', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-system-prompt', repoParentURL())).toBe(true)
  })

  it('redirects a workspace package when the entry location sits outside the repository', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-system-prompt', bareParentURL())).toBe(true)
  })

  it('keeps the copy a shadowing entry location owns under node_modules', () => {
    expect(loadsFromSourcePlane('@deepseek-ai/dsh-system-prompt', shadowingParentURL())).toBe(false)
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
    installSourcePlanePluginLoader(loader)
    const ambient = await import('@deepseek-ai/dsh-system-prompt')
    expect(await (loader.internal as ModuleLoader).import('@deepseek-ai/dsh-system-prompt', repoParentURL(), {})).toBe(ambient)
    expect(internal.import).not.toHaveBeenCalled()
  })

  it('delegates every other specifier to the internal loader', async () => {
    const sentinel = { delegated: true }
    const internal = { import: vi.fn(async () => sentinel) }
    const loader = { internal } as unknown as Loader
    installSourcePlanePluginLoader(loader)
    const importAttributes = {}
    expect(await (loader.internal as ModuleLoader).import('./plugin.mjs', repoParentURL(), importAttributes)).toBe(sentinel)
    expect(internal.import).toHaveBeenCalledWith('./plugin.mjs', repoParentURL(), importAttributes)
  })
})
