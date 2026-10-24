/**
 * Launch preparation helpers shared by the executor families of this seam.
 * @module dsh-shell/launch
 */
import type { ShellExecSpec } from './types.ts'

/**
 * Snapshot a resolved spec for a launch that starts later. The snapshot drops
 * the caller's signal — the caller passes the launch signal when it starts the
 * process — and clones the sandbox policy and both environment maps, so a
 * caller mutation between preparation and launch cannot reach the published
 * process.
 * @param spec - Resolved execution spec.
 * @returns Signal-free snapshot with cloned policy and environment maps.
 */
export function captureLaunchSpec(spec: ShellExecSpec): ShellExecSpec {
  return {
    ...spec,
    signal: undefined,
    sandboxPolicy: spec.sandboxPolicy === undefined ? undefined : { ...spec.sandboxPolicy },
    env: spec.env === undefined ? undefined : { ...spec.env },
    dshEnv: spec.dshEnv === undefined ? undefined : { ...spec.dshEnv },
  }
}
