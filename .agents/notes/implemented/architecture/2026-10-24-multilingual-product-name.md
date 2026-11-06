# Agent Note: Multilingual product name

Status: implemented

English | [中文](2026-10-24-multilingual-product-name.zh.md)

## Problem

This repository ships under its own name, yet every user-visible surface still carried the upstream product name "DeepSeek Harness": the Desktop About panel and update dialogs, the Windows installer strings, the browser title, the PWA install name, the CLI help, the plugin-safety and document-preview notices, the settings welcome notice, and the whole documentation tree. Upstream's brand guideline asks third-party projects not to put the full "DeepSeek Harness" trademark in a project name, so the mismatch was both a consistency defect and a trademark exposure.

## Decision

**The product name is 知了 in Chinese and Zhiliao in English.** Chinese prose renders 知了; English prose renders Zhiliao. Surfaces that hold one string for both languages — the packaged application name, artifact file names, the official client build title, and the PWA manifest name — use Zhiliao, the Latin form that stays safe for filesystems, installers, and code signing.

**The shallow layer covers names a user reads.** It spans the locale dictionaries, the Desktop shell and Windows installer, the browser and PWA titles, CLI help, the skill description, package READMEs, and the documentation tree. `dsh`, `DSH_*`, `@deepseek-ai/dsh-*`, `~/.dsh`, and `~/.deepseek-harness` keep their identifiers: they name the command, the environment, the packages, and the data roots, not the product. Prose that says "another DSH instance" still says DSH, because it names the running runtime.

**Verbatim source mirrors stay on the source wording.** `ts type-equiv` blocks and the generated catalogs quote source JSDoc, so this layer leaves those blocks unchanged until the source comments move; editing them alone would fail the pairing and type-equivalence gates.

**The terminology table carries the mapping.** `docs/i18n/terminology.md` records 知了/Zhiliao so translation and later edits stop re-deriving it.

## Alternatives considered

**Naming the product `dsh` everywhere.** Rejected: the abbreviation already names the CLI command and the running runtime, so one `dsh` would make "another DSH instance" and "the product itself" indistinguishable in the same sentence.

**Renaming the npm scope, the CLI, and the environment in the same pass.** Rejected for this layer: 294 package names, roughly 13,700 source references, every consumer lockfile, and the recorded-session fixtures move together, which is a separate change with its own verification cost.

**Localizing the packaged application name.** Deferred: electron-builder accepts one `productName`, so a per-locale bundle display name needs per-locale `InfoPlist.strings` on macOS and a localized installer name on Windows.

## Consequences

Chinese and English users now read one product name, and the fork no longer presents the upstream trademark as its own. The cost is a mixed inventory during the transition: source JSDoc, the system-prompt identity sentence, the SDK class names `DeepSeekHarness` and `HarnessClient`, SDK runtime error strings, the sidebar wordmark artwork, and the recorded session fixtures still say DeepSeek Harness, and each of those moves with its own gate — the system prompt with the snapshot re-record, the SDK names with an API review, the artwork with a design pass.
