---
kind: upgrade-guide
description: "Official on-demand bundles use installation-carried local links instead of exact registry pins."
---

# Official on-demand bundles use the running installation

English | [中文](guide.zh.md)

## Change

Codex, Claude Code, and CUA installations from the Official catalog now use packages carried by the running application. A profile records a local `link:` dependency instead of requesting the product version from npm. Existing registry dependencies or links to another installation can require explicit replacement even when their version matches. Third-party registry installation and provider authentication keep their existing behavior.

Desktop places the complete runtime in physical `resources/dsh` (`Contents/Resources/dsh` on macOS), alongside `app.asar`. Native modules and Office dependencies share `resources/dsh/node_modules`; links do not point inside ASAR. Replacing an application at the same installation path preserves these stable destinations. User data and profile files remain outside the application.

An incomplete packaged installation reports an error instead of falling back to npm. Source installations require a complete, built checkout. Removing an Official on-demand bundle removes the profile dependency; its supplied installation files remain available.

## Migration

1. Install the complete updated application. For source Web or development Desktop, prepare the running CLI's checkout with `pnpm install` and `pnpm run build`; selecting a different working directory does not select another provider source.
2. Open Plugins and inspect the Official entry's offered installation target. Use Install for an uninstalled bundle, or its explicit Update operation to replace an existing registry dependency or another installation's link. If an existing link points inside `app.asar/dsh`, or the application moved to a different path, replace that link through the same operation. Restart when requested. A failed replacement can leave the bundle uninstalled; correct the reported error and install it again.
3. Confirm that the profile's `package.json` records the bundle as a `link:` dependency to the running installation or checkout, and that the selected bundle starts without a loading error. Reinstallation of the application, rather than a manually chosen npm version, repairs missing packaged provider files. External authentication and provider access still need separate configuration. Complete packaging and installed-update qualification remain required; source tests alone do not verify an installed application.

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md#use-this-package) documents selection and removal; the [delivery decision](../../../../.agents/notes/implemented/architecture/2026-11-07-installation-carried-official-bundles.md) records installation ownership.
