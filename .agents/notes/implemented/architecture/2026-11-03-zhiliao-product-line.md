# Agent Note: Zhiliao product line

Status: implemented

English | [中文](2026-11-03-zhiliao-product-line.zh.md)

## Problem

This repository was maintained as a fork that follows `upstream/master`: each round merged or rebased the whole upstream branch onto local brand and interaction work. The upstream CI topology (native Windows lanes, the master-only Wine gate, the Windows packaging chain) has no verifiable environment here, so those gates stayed red and demanded continuous adaptation, and a whole-branch sync turns every review into thousands of commits whose conflicts are settled by re-recording goldens. The product needs one mainline it can schedule and version.

## Decision

The `upstream` remote is reference-only. `git fetch upstream` reads upstream commits; the product never rebases shipped branches onto it, never performs whole-branch syncs, and keeps no long-lived `chore/upstream-sync-*` branch. `master` is the single mainline, versioned by product tags (`zhiliao-v0.1.0-alpha.1` is the first baseline, matching the Zhiliao release line's tag prefix), with the upstream release recorded only as the baseline's origin.

Three classes of upstream change are still absorbed selectively:

- **Security and correctness fixes** — credential handling, sandbox escapes, path traversal, injection, crashes, and data corruption.
- **Provider protocols and model catalog** — new model ids, request and response fields, and streaming event changes.
- **Format and persistence migrations** — `SESSION_FORMAT_VERSION` evolution, SQLite schema, and compatible reads of released sessions.

Absorption criteria: absorb an upstream commit when it can be picked alone, leaves brand assets and client copy untouched, changes no CI or publication topology, and assumes no Windows environment; otherwise reject it or rewrite it before absorbing. Absorb by fetching upstream, picking the commit onto a short-lived branch, running that package's minimal verification surface (its vitest target, `build:check`, `doc-sync`), and opening a separate pull request into `master`.

The upstream Windows structure is withdrawn: `ci-windows.yml`, `windows-package.yml`, `scripts/wine-windows-gates.sh`, `scripts/windows-package-workflow.spec.ts`, the three `check:ci:windows-*` entrypoints plus `check:windows-wine`, the `ci-master.yml` windows job and its Wine gate call, and the `ci.yml` comment lines that name the Windows verdict are deleted; `ci-python.yml` keeps only the `node24-linux-x64` target, and desktop publication keeps only `mac-arm64` and `mac-x64`. That withdrawal supersedes the Windows material in the [cross-platform CI reference](../process/2026-07-21-serial-cross-platform-ci-reference.md), [native Windows pull-request CI](../process/2026-08-08-native-windows-pull-request-ci.md), [hosted Windows Python runtime](../process/2026-09-06-python-runtime-windows-hosted.md), and [Blacksmith failover leg](../process/2026-09-09-blacksmith-failover-leg.md); their remaining content — master platform scheduling, Linux failover, and the release chain — still holds. Windows runtime source and signing documentation stay outside the withdrawal: the `apps/desktop` packaging and signing READMEs still describe the Windows flow, and their cleanup belongs to a separate change.

## Alternatives considered

**Keep syncing the whole upstream branch.** It minimizes divergence and inherits upstream fixes for free, but every round re-runs the entire gate set over thousands of commits, and Windows-class changes keep adding failures this repository cannot verify.

**Keep the Windows jobs but make them non-blocking.** It preserves the signal with a small conflict surface, yet the jobs still run and consume capacity, and their failures would never be acted on — pure noise.

**Mirror upstream and ship the product as an overlay.** It keeps the fork identical to upstream, but brand, interaction, and publication changes would live outside the build and tests, which would then stop covering real product behavior.

## Consequences

The mainline no longer carries future upstream commits; absorbing any of them becomes an explicit pick with its own verification, so each sync round costs a human decision. In exchange, gates cover only platforms the product actually runs, goldens stop being re-recorded whenever upstream refactors, and release cadence belongs to the product. Upstream stays readable: `upstream/master` remains a read-only reference.

## Related

- Baseline merge: `master` takes in the upstream `master` HEAD through one merge commit whose second parent is that HEAD; the HEAD sits 351 commits past upstream's last release tag `dsh-v0.2.2-alpha.2`. The baseline tag is `zhiliao-v0.1.0-alpha.1`. The sync branch's pull request #45 remains unmerged.
- Withdrawal record: the Windows removal shipped in `chore(ci): 移除 Windows 门禁与打包工作流`.
- Outstanding item: `apps/desktop/README.md` still carries 49 Windows mentions untouched; `apps/desktop/packaging/README.md` dropped from 37 to 21 mentions with this withdrawal (the removed sections linked the now-deleted `windows-package.yml`), and its remainder plus the Windows flow described in `apps/desktop/publishing/ci/README.md` belong to a separate change.
- No upgrade guide: this product line has no published tag on `origin`, and `windows-package.yml` was a manual workflow on the self-hosted `dsh-win-package-trial` label, so no published surface was broken.
