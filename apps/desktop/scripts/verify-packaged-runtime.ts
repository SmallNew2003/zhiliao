/** Compare the physical application runtime with its sealed preparation inventory. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/**
 * Reject copied metadata, bytes, membership, links, or executable permissions that differ from preparation.
 * @param root - Physical dsh directory in the assembled application's resources.
 * @param expected - Sealed descriptor verified before packaging.
 * @returns Resolves after the complete copied tree matches preparation.
 */
export async function verifyPackagedRuntime(root: string, expected: DesktopRuntimeDescriptor): Promise<void> {
  const descriptor = await readFile(join(root, 'desktop-runtime.json'))
  if (!descriptor.equals(Buffer.from(`${JSON.stringify(expected, undefined, 2)}\n`))) {
    throw new Error('desktop runtime: packaged descriptor differs from preparation')
  }
  await verifyDesktopRuntime(root, expected.release.version, { platform: expected.platform, arch: expected.arch })
}
