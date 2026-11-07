/** Verify physical Windows PE copies without changing their sealed bytes or signatures. */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reject absent, linked, or changed PE files in the assembled application's resources.
 * @param {string} sourceRoot - Original signed and sealed dsh directory.
 * @param {string} resourcesDir - Assembled application resources directory.
 * @param {string[]} files - PE paths relative to the prepared dsh directory.
 * @returns {Promise<void>} Resolves after every physical PE has identical bytes.
 */
export async function verifyWindowsRuntimeCopy(sourceRoot, resourcesDir, files) {
  for (const file of files) {
    const copied = join(resourcesDir, 'dsh', file)
    const stat = await lstat(copied)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Windows runtime: expected a real PE file: ${file}`)
    const [prepared, packaged] = await Promise.all([readFile(join(sourceRoot, file)), readFile(copied)])
    if (!prepared.equals(packaged)) throw new Error(`Windows runtime: PE bytes changed: ${file}`)
  }
}
