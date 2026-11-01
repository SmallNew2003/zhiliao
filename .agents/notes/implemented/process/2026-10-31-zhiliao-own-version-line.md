# Agent Note: Zhiliao's own version line beside a recorded upstream baseline

Status: implemented

English | [中文](2026-10-31-zhiliao-own-version-line.zh.md)

## Problem

The workspace version arrived with each upstream synchronization: the root manifest and 374 released manifests carried `0.2.2-alpha.2`, the release tag prefix was `dsh-v`, and the `dsh` sequence published `@deepseek-ai/dsh-*` to npmjs.org. None of that line belongs to this product.

Three facts block renumbering it downward. Upstream publishes under the same package names and had already reached `0.2.2-alpha.2`, so a lower version cannot be published there at all — the registry holds a higher one. The `dsh-v*` tag namespace is upstream's, so a tag cut from this repository is indistinguishable from one of theirs. And the version number states nothing about which upstream commit the tree contains, which a reader comparing a defect report against upstream needs.

## Decision

### The version line starts at `0.1.0`

`release:dsh 0.1.0` writes one version across the publishable family, every private package under `packages/*/*`, the applications, and the workspace root. `verify-version-sync` already requires every released manifest to equal the root's, so the bump is one mechanical change over 374 manifests and the lockfile is untouched: it records dependency specifiers, not workspace versions.

`0.1.0` rather than `1.0.0`, because the public APIs are pre-stable and capability themes remain undecided, and a `1.0.0` would promise a stability the tree does not carry. `0.1.0` rather than `0.0.2`, which would continue this repository's own `0.0.x` line from August 2026, because that line described an initial monorepo and this tree is a complete product. `0.1.0` rather than a number above upstream's, because the product's version then tracks upstream's release cadence, which is the coupling being removed.

The first release carries a prerelease segment, `0.1.0-alpha.1`, while undecided themes and upstream absorption continue; `release:dsh` accepts it as an explicit version and `publish.ts` maps `alpha` to its matching npm dist-tag.

### The release tag prefix is `zhiliao-v`

`DshFamily.tagPrefix` returns `zhiliao-v`, replacing `dsh-v`. `bump.ts` reads the newest tag by prefix to derive the next version, so the new prefix makes the inherited upstream tags invisible and the line starts from the manifest version. `verifyTag` runs only under `RELEASE_PUBLISH`, which the pull-request `release.yml` does not set, so no PR check depends on the prefix.

### The `dsh` sequence stops publishing to npm

`.github/workflows/release-publish.yml` is deleted. `release.yml` keeps the credential-free `pack` and dependency-layout verification that runs on every pull request and master push, which is what proves the release set still packs and installs; publication was the only credentialed act in the sequence. `vendor` and `native` keep their own publish workflows, and `release:publish` stays because the `vendor` sequence calls it.

`@deepseek-ai/dsh-*` therefore stops receiving versions from this repository. The registry keeps upstream's publications and the four `0.0.1-rc.*` versions this repository published in August 2026; `latest` stays where the last publication left it.

### The upstream baseline is recorded beside the version

The version number no longer encodes which upstream commit the tree contains, so that value is recorded here and updated on each synchronization:

| Field | Value |
|---|---|
| Upstream version | `0.2.2-alpha.2` |
| Synchronization commit | `5dbcf33775` |
| Synchronization branch | `chore/upstream-sync-20261028` |

The desktop application's About dialog shows the upstream base beside the product version, so a reader can tell which upstream code a build contains without this record. The value it shows is `UPSTREAM_BASE_VERSION` in `apps/desktop/src/upstream-base.ts`; a synchronization updates that constant and the table above together.

### A synchronization restores the version line

An upstream synchronization carries upstream's own version bump, so the merged tree disagrees with the root version and `verify-version-sync` fails. Restoring `0.1.0` across the 374 manifests is therefore a step of the synchronization procedure, not a repair after a red check.

## Consequences

A reader cannot order this product's version against upstream's: `0.1.0` is lower than `0.2.2-alpha.2` while the tree contains it. The About dialog and this record carry the mapping.

`npm install @deepseek-ai/dsh-session` resolves to upstream's publication, not to this product's build. The desktop application, the installer, and the Web deployment are the distribution channels; nothing in the documentation directed readers to the registry for this product's packages, so no documented install path changes.

A tag reserves a version and identifies its commit. Cutting `zhiliao-v*` tags from this repository is now unambiguous, and the inherited `dsh-v*` tags stay upstream's.

## Alternatives considered

Keeping upstream's version line was rejected: the number then advances on upstream's schedule, and the tag namespace stays shared.

Renumbering to `0.3.0` to stay publishable under `@deepseek-ai/dsh-*` was rejected: it keeps the product's version tied to upstream's cadence and keeps the package names shared with a product that publishes independently.

Renaming the packages to a `@zhiliao/*` scope was rejected for this change: 374 manifests, every sibling `peerDependencies` entry, imports, snapshots, and documentation carry the current names, and the product does not need the registry to distribute.
