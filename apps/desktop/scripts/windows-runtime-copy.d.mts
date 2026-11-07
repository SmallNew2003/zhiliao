/**
 * Reject absent, linked, or changed PE files in the assembled application's resources.
 * @param sourceRoot - Original signed and sealed dsh directory.
 * @param resourcesDir - Assembled application resources directory.
 * @param files - PE paths relative to the prepared dsh directory.
 * @returns Resolves after every physical PE has identical bytes.
 */
export function verifyWindowsRuntimeCopy(sourceRoot: string, resourcesDir: string, files: string[]): Promise<void>
