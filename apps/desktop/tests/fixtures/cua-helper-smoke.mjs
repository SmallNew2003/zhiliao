/** Inspect the installed CUA application without starting its service or requesting permissions. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Check the packaged helper receipt, executable, signature, and execution architecture.
 * @param {string} runtime - Physical Desktop dsh directory.
 * @returns {Promise<string | undefined>} Selected executable, or undefined outside macOS.
 */
export async function checkCuaHelper(runtime) {
  if (process.platform !== 'darwin') return undefined
  const directory = join(runtime, 'node_modules/@deepseek-ai/dsh-experimental-cua-macos/native/bin', `darwin-${process.arch}`)
  const { bundle } = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'))
  assert.match(bundle, /^[a-f0-9]{64}$/u)
  const application = join(directory, bundle, 'DSH Computer Use.app')
  const executable = join(application, 'Contents/MacOS/dsh-cua-native')
  await access(executable, constants.X_OK)
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', application], { stdio: 'pipe' })
  execFileSync('/usr/bin/lipo', ['-verify_arch', process.arch === 'x64' ? 'x86_64' : 'arm64', executable], { stdio: 'pipe' })
  return executable
}
