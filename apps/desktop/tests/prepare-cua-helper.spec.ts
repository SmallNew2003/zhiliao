/** Desktop helper preparation never compiles or re-signs an installed application at runtime. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { CUA_APPLICATION, CUA_MANIFEST, readCuaApplication, sealCuaApplication } from '../../../scripts/cua-helper/payload.ts'
import { nativeExecutablePath } from '../../../packages/experimental/cua-macos/src/native-build.ts'
import { DESKTOP_CUA_PROVIDER, prepareDesktopCuaHelper, type DesktopCuaHelperPreparation } from '../scripts/prepare-cua-helper.ts'
import { verifyMacOSNotarizedApplication } from '../scripts/verify-macos-signature.mjs'

const command = vi.hoisted(() => vi.fn<(file: string, args: readonly string[], options?: object) => Promise<{ stdout: string }>>())
vi.mock('execa', () => ({ execa: command }))
vi.mock('../scripts/verify-macos-signature.mjs', () => ({ verifyMacOSNotarizedApplication: vi.fn() }))

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  command.mockReset().mockResolvedValue({ stdout: 'a'.repeat(40) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function application(directory: string): string {
  const app = join(directory, 'unsealed', CUA_APPLICATION)
  for (const [path, bytes] of Object.entries({
    'Contents/Info.plist': 'fixture identity', 'Contents/MacOS/dsh-cua-native': 'fixture executable',
    'Contents/Resources/DSHComputerUse.icns': 'fixture icon', 'Contents/_CodeSignature/CodeResources': 'fixture signature',
  })) {
    mkdirSync(join(app, path, '..'), { recursive: true })
    writeFileSync(join(app, path), bytes)
  }
  chmodSync(join(app, 'Contents/MacOS/dsh-cua-native'), 0o755)
  return sealCuaApplication(directory, app)
}

function fixture(): DesktopCuaHelperPreparation {
  const root = mkdtempSync(join(tmpdir(), 'desktop-cua-helper-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const spec: DesktopCuaHelperPreparation = {
    repository: join(root, 'source'), installation: join(root, 'installed'), runtime: join(root, 'copied'),
    scratch: join(root, 'swift'), version: '0.1.0-alpha.1', target: { platform: 'darwin', arch: 'arm64' }, unsigned: true,
    environment: { DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234' },
  }
  const provider = join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER)
  mkdirSync(provider, { recursive: true })
  writeFileSync(join(provider, 'package.json'), JSON.stringify({ name: DESKTOP_CUA_PROVIDER, version: spec.version }))
  return spec
}

it.each(['arm64', 'x64'] as const)('prepares a local %s receipt in copied resources without modifying the checkout', async (arch) => {
  const base = fixture()
  const spec = { ...base, target: { ...base.target, arch } }
  command.mockImplementation(async (_file, args) => {
    const output = args.indexOf('--output-directory')
    if (output !== -1) application(args[output + 1]!)
    return { stdout: '' }
  })
  const executable = await prepareDesktopCuaHelper(spec)
  const directory = join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER, 'native/bin', `darwin-${arch}`)
  expect(executable).toBe(await nativeExecutablePath(directory))
  expect(existsSync(join(spec.repository, 'packages/experimental/cua-macos/native/bin'))).toBe(false)
  expect(command).toHaveBeenCalledWith('/usr/bin/xcrun', [
    'python3', join(spec.repository, 'packages/experimental/cua-macos/native/build_app.py'),
    '--arch', arch === 'x64' ? 'x86_64' : 'arm64', '--scratch-path', spec.scratch,
    '--output-directory', directory, '--identity', '-',
  ], expect.objectContaining({ killDescendants: true }))
  expect(command).toHaveBeenCalledWith('/usr/bin/lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', executable], expect.any(Object))
})

it('fails local packaging when compilation fails instead of falling back to another helper', async () => {
  const spec = fixture()
  command.mockRejectedValueOnce(new Error('Swift compiler failed'))
  await expect(prepareDesktopCuaHelper(spec)).rejects.toThrow('Swift compiler failed')
  await expect(nativeExecutablePath(join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER, 'native/bin/darwin-arm64')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires a retained signed payload and never substitutes an ad hoc build', async () => {
  const spec = { ...fixture(), unsigned: false }
  await expect(prepareDesktopCuaHelper(spec)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(command.mock.calls.map(([file]) => file)).toEqual(['git'])
})

it.each(['valid', 'wrong-version', 'wrong-team', 'untrusted'] as const)('checks and preserves a %s retained signed application', async (state) => {
  const spec = { ...fixture(), unsigned: false }
  const source = join(spec.installation, 'node_modules', DESKTOP_CUA_PROVIDER)
  const applications = (['arm64', 'x64'] as const).map(architecture => ({ architecture,
    bundle: application(join(source, 'native/bin', `darwin-${architecture}`)) }))
  writeFileSync(join(source, CUA_MANIFEST), JSON.stringify({ schemaVersion: 1, commit: 'a'.repeat(40),
    version: state === 'wrong-version' ? 'other' : spec.version, teamId: state === 'wrong-team' ? 'OTHER12345' : 'TEAMID1234', applications }))
  if (state === 'untrusted') vi.mocked(verifyMacOSNotarizedApplication).mockImplementationOnce(() => { throw new Error('not notarized') })
  const result = prepareDesktopCuaHelper(spec)
  if (state !== 'valid') {
    await expect(result).rejects.toThrow(state === 'wrong-version' ? 'source and version' : state === 'wrong-team' ? 'another signing team' : 'not notarized')
    expect(existsSync(join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER, 'native/bin'))).toBe(false)
    return
  }
  await result
  const copied = join(spec.runtime, 'node_modules', DESKTOP_CUA_PROVIDER, 'native/bin/darwin-arm64')
  const installed = join(source, 'native/bin/darwin-arm64')
  expect(readCuaApplication(copied).bundle).toBe(readCuaApplication(installed).bundle)
  expect(readFileSync(join(copied, 'current.json'))).toEqual(readFileSync(join(installed, 'current.json')))
  expect(command.mock.calls.some(([, args]) => args.includes('--identity'))).toBe(false)
  expect(verifyMacOSNotarizedApplication).toHaveBeenCalledWith(readCuaApplication(installed).application,
    { signingIdentity: 'Example Company (TEAMID1234)', teamId: 'TEAMID1234' })
})

it('omits macOS-only helper preparation for Windows targets', async () => {
  const spec = fixture()
  await expect(prepareDesktopCuaHelper({ ...spec, target: { platform: 'win32', arch: 'x64' } })).resolves.toBeUndefined()
  expect(command).not.toHaveBeenCalled()
})
