# Agent Note: Carry Official on-demand bundles with the installation

Status: implemented

English | [中文](2026-11-07-installation-carried-official-bundles.zh.md)

## Problem

Zhiliao has its own release line and does not publish the DSH family to npm. Offering an Official bundle as an exact registry dependency therefore asks for a product version that the registry does not contain. Offline discovery alone cannot make that bundle installable. Source and packaged installations also need to distinguish their own provider code from another installation with the same version.

## Decision

The CLI installation carries every `ON_DEMAND_BUNDLES` member as a runtime dependency, including Codex, Claude Code, and CUA. No shipped profile selects these bundles by default. Their metadata remains discoverable without importing provider modules; installing one creates an ordinary profile-owned dependency and uses the existing selection and removal lifecycle.

`officialBundleInstallTarget` resolves a local `link:` target from the running installation. A packaged installation must declare the bundle and resolve it within its own logical `node_modules` tree. The saved link retains the logical installation path, so replacing a runtime behind that path does not bind the profile to a retired physical directory. A source installation resolves the named workspace package from the CLI's complete checkout. Neither current working directory nor version suffix selects the source.

Desktop copies the complete sealed dsh tree through electron-builder `extraResources` to `process.resourcesPath/dsh` (`Contents/Resources/dsh` on macOS). JavaScript, native modules, and Office dependencies share its physical `node_modules` tree. An `app.asar/dsh` directory is virtual to Electron and is not a usable `pnpm link` source: the standalone package manager reports `ENOTDIR`. Native files therefore do not use a separate `app.asar.unpacked/dsh` tree. The shell remains in `app.asar`; package links point to physical application resources. Replacing the application at the same path preserves these stable link destinations and leaves user data and profile files outside the application. Moving the application or switching installations requires explicit link replacement.

Both paths validate package identity, the exact running product version, public bundle metadata, built entry, and bundle patches without importing the provider. Missing or inconsistent files fail visibly and require repairing the checkout or reinstalling the application; neither path falls back to npm. Removing the profile dependency leaves the installation copy available for a later installation.

Experimental isolation exempts only the CLI installation's declared `dependencies` edges to admitted on-demand bundles. Runtime imports, other dependency sections or consumers, and default profile compositions retain their isolation checks. Carrying CUA does not select or load its experimental runtime in the default product.

The [on-demand catalog decision](2026-10-05-official-on-demand-bundles.md) retains offline discovery, metadata ownership, explicit replacement, and profile lifecycle. This decision supersedes its registry delivery and installation-dependency exclusion. The [shipped optional-bundle decision](../process/2026-09-15-shipped-optional-bundles.md) retains its distinct policy: `OPTIONAL_BUNDLES` are installation-owned and cannot be removed from a profile; on-demand bundles have removable profile dependencies.

## Alternatives considered

**Keep exact-version registry delivery.** It requires publishing the product's package versions, contrary to the [independent version-line policy](../process/2026-10-31-zhiliao-own-version-line.md), and cannot supply this unreleased product build.

**Use another release's package when the product version is absent.** A matching package name does not establish compatible provider APIs or bundle patches. The installation's own validated bytes avoid that mismatch.

**Keep the dsh tree in ASAR.** Electron can read archived modules, but the standalone package manager cannot use the virtual directory as a link source. Extracting only native files leaves the same failure for JavaScript bundle installation.

**Treat carried bundles as non-removable optional bundles.** Shipping bytes and owning a profile selection are separate decisions. Keeping the ordinary profile dependency preserves explicit installation, replacement, and removal.

## Consequences

Installations carry dependencies even for integrations a person never selects. In return, Official selection does not require an npm publication of the product release. The local package operation can still fail, and provider authentication and external services retain their own requirements; local delivery does not promise offline provider operation. Source installations require prepared dependencies and current build output. Existing profile links need replacement when switching installations.

`official-install-target.spec.ts` covers source and packaged targets, logical paths, incomplete installations, and real offline pnpm profile operations. The Official catalog generator requires every advertised member to be a direct CLI dependency and rejects default runtime imports of on-demand providers. Installed-product isolation tests reject experimental runtime edges outside the declared installation exception. Desktop packaging verifies the copied descriptor, file inventory, native files, and Host smoke against physical resources; source-level tests alone do not establish an assembled application or installed-update qualification. Plugin Manager's package README owns operational behavior; the [upgrade guide](../../../../docs/upgrade-guide/v0.1.0-alpha.1/installation-carried-official-bundles/guide.md) owns user migration.
