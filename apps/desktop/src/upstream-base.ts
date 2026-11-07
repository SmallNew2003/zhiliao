/** Upstream baseline recorded for one Zhiliao build. */

/**
 * Upstream release whose code this Electron shell and its bundled dsh runtime are
 * built from.
 *
 * The About dialog shows it beside the product version, so a reader can tell which
 * upstream code a build contains without consulting the release record.
 *
 * The upstream synchronization procedure updates this value together with the
 * recorded baseline in
 * `.agents/notes/implemented/process/2026-10-31-zhiliao-own-version-line.md`.
 */
export const UPSTREAM_BASE_VERSION = '0.2.2-alpha.2'
