/** Prepare the copied macOS provider's immutable helper before the Desktop inventory is sealed. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { nativeExecutablePath } from '../../../packages/experimental/cua-macos/src/native-build.ts'
import { readCuaApplication, stageCuaHelperPayload, verifyCuaHelperPayload } from '../../../scripts/cua-helper/payload.ts'
import { resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { verifyMacOSNotarizedApplication } from './verify-macos-signature.mjs'

/** Provider package whose installed activation requires a prebuilt application. */
export const DESKTOP_CUA_PROVIDER = '@deepseek-ai/dsh-experimental-cua-macos'

/** Build-owned locations and release mode for one Desktop helper preparation. */
export interface DesktopCuaHelperPreparation {
  readonly repository: string
  readonly installation: string
  readonly runtime: string
  readonly scratch: string
  readonly version: string
  readonly target: { readonly platform: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' }
  readonly unsigned: boolean
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Prepare only the copied provider: local builds compile ad hoc; signed builds require the retained notarized payload.
 * This runs after general native signing, which would change the helper's content-addressed generation and receipt.
 * @param spec - Build-owned directories, target, product version, and signing mode.
 * @returns The verified target executable, or undefined for a Windows target.
 * @throws When compilation, payload identity, signature, notarization, receipt, or architecture checks fail.
 */
export async function prepareDesktopCuaHelper(spec: DesktopCuaHelperPreparation): Promise<string | undefined> {
  if (spec.target.platform !== 'darwin') return undefined
  if (process.platform !== 'darwin') throw new Error('desktop CUA helper: macOS preparation requires the Apple toolchain')
  const provider = join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER)
  const manifest = JSON.parse(await readFile(join(provider, 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (manifest.name !== DESKTOP_CUA_PROVIDER || manifest.version !== spec.version) {
    throw new Error('desktop CUA helper: copied provider does not match the Desktop release')
  }
  const directory = join(provider, 'native/bin', `darwin-${spec.target.arch}`)
  if (spec.unsigned) {
    await execa('/usr/bin/xcrun', ['python3', join(spec.repository, 'packages/experimental/cua-macos/native/build_app.py'),
      '--arch', spec.target.arch === 'x64' ? 'x86_64' : 'arm64', '--scratch-path', spec.scratch,
      '--output-directory', directory, '--identity', '-'], {
      cwd: spec.repository, env: spec.environment, extendEnv: false, stdio: 'inherit', killDescendants: true,
    })
  } else {
    const source = join(spec.installation, 'node_modules', DESKTOP_CUA_PROVIDER)
    const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: spec.repository, env: spec.environment, extendEnv: false })
    const identity = { version: spec.version, commit: stdout.trim() }
    const payload = verifyCuaHelperPayload(source, identity)
    const signing = resolveMacOSSigningEnvironment(spec.environment)
    if (payload.teamId !== signing.teamId) throw new Error('desktop CUA helper: retained payload belongs to another signing team')
    for (const { architecture } of payload.applications) {
      const { application } = readCuaApplication(join(source, 'native/bin', `darwin-${architecture}`))
      verifyMacOSNotarizedApplication(application, signing)
    }
    stageCuaHelperPayload(source, provider, identity)
  }
  const executable = await nativeExecutablePath(directory)
  const { application } = readCuaApplication(directory)
  await execa('/usr/bin/codesign', ['--verify', '--strict', application], {
    env: spec.environment, extendEnv: false, killDescendants: true,
  })
  await execa('/usr/bin/lipo', ['-verify_arch', spec.target.arch === 'x64' ? 'x86_64' : 'arm64', executable], {
    env: spec.environment, extendEnv: false, killDescendants: true,
  })
  return executable
}
