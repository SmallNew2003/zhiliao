/** Packed-install verification removes the platform packages an `--omit=optional` consumer lacks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { optionalPlatformPackagePaths } from './verify-packed-install.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packed-optional-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  return root
}

function writeInstalled(root: string, key: string, manifest: Record<string, unknown>): void {
  const directory = join(root, 'node_modules', key)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: key, ...manifest })}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('optional platform package discovery', () => {
  it('lists installed scoped packages that another installed package marks optional', () => {
    const root = fixture()
    writeInstalled(root, 'koffi', { optionalDependencies: { '@koromix/koffi-darwin-arm64': '3.3.3' } })
    writeInstalled(root, '@koromix/koffi-darwin-arm64', {})
    writeInstalled(root, 'plain', { dependencies: { helper: '1.0.0' } })
    writeInstalled(root, 'helper', {})

    expect(optionalPlatformPackagePaths(join(root, 'node_modules')))
      .toEqual([join(root, 'node_modules', '@koromix/koffi-darwin-arm64')])
  })

  it('ignores optional names npm did not install and entries without a package', () => {
    const root = fixture()
    writeInstalled(root, '@deepseek-ai/node-addon-system', {
      optionalDependencies: { '@deepseek-ai/node-addon-system-linux-x64': '0.1.2', absent: '1.0.0' },
    })
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(root, 'node_modules', '@empty-scope'), { recursive: true })

    expect(optionalPlatformPackagePaths(join(root, 'node_modules'))).toEqual([])
  })
})
