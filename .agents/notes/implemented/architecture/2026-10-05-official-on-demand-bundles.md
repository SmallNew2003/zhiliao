# Agent Note: Discover Official bundles before profile installation

Status: implemented

English | [中文](2026-10-05-official-on-demand-bundles.zh.md)

## Problem

Native subagent integrations bring their own runtimes. Shipping those dependencies with every DSH installation charges that cost to people who never delegate to them, while requiring a package name hides the integrations from the Plugins page.

## Decision

`ON_DEMAND_BUNDLES` admits the Claude Code, Codex, and CUA bundles to an installation-owned catalog. The catalog embeds their package-owned localized metadata and icons, so discovery works offline without resolving or importing those packages. Official identifies project maintenance; optional delivery and experimental maturity remain independent properties.

Selection uses the ordinary third-party bundle installer, profile dependency, Host row patches, compatibility evaluation, progress, cancellation, and build-script approval. Native authentication and configuration remain provider-owned.

The [installation-carried delivery decision](2026-11-07-installation-carried-official-bundles.md) supersedes registry delivery and the exclusion of these runtimes from installation dependencies. It owns local target resolution, matching-version validation, and incomplete-installation errors. The running installation owns the target, never the current working directory or a prerelease suffix. Replacing an installed registry copy or another checkout's link compares the source as well as the version. Replacement is explicit, preserves selection, and reports required restarts; startup does not download providers. [Plugin Manager](../../../../packages/boot/plugin-manager/README.md#use-this-package) owns the operational details.

Every Official package remains in the DSH release family. Packed DSH dependencies, optional dependencies, and peers use the exact family version. Catalog verification rejects missing metadata, unsupported membership, and stale generated content.

The [shipped optional-bundle policy](../process/2026-09-15-shipped-optional-bundles.md) still owns lightweight installation-provided bundles. The [optional-composition decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns shared patch behavior and global optional tools. Native bundles insert ordinary Host rows, so any profile can select them; profiles that keep the package without its bundle mount the same rows explicitly. The [identity compatibility decision](2026-10-06-web-desktop-plugin-identity-compatibility.md) owns retained names, selectors, and deferred naming cleanup.

## Alternatives considered

**Ship the native runtimes with every installation.** This increases the default download for unused integrations. The [installation-carried delivery decision](2026-11-07-installation-carried-official-bundles.md) accepts that cost to distribute unreleased product versions without registry publication.

**Query the registry to build the discovery list.** This avoids embedded metadata, but makes discovery depend on network availability and does not bind the offered package version to the running application.

**Give Official packages a separate installer or activation registry.** A second path would duplicate package-operation and profile-composition behavior. Installation-owned discovery data can reuse the existing third-party mechanisms.

**Always install the registry package with the running version.** Version equality identifies a published release, but cannot identify unreleased source changes. It can deliver an older provider API and a provider-only patch to a development Host that expects current tool contributions.

**Build a separate development registry or artifact cache.** Ordinary local links already keep provider code and its dependencies in the running checkout. A second delivery system would add lifecycle and invalidation work without improving that development promise.

## Consequences

Local delivery requires a complete installation or a prepared, built checkout and normal rebuild/restart discipline. Equal source version strings do not certify identical build outputs. Off only deselects; Remove remains separate and refuses while the bundle's rows are in use. Removing a profile dependency does not delete the installation's copy. Activation failure can retain the saved dependency and selection; there is no rollback. Offline metadata and profile lifecycle remain owned here; installation-carried delivery and its verification belong to the linked decision. Native-provider authentication is not part of catalog discovery.
