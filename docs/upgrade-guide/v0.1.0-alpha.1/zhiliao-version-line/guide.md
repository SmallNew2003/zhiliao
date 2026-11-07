---
kind: upgrade-guide
description: "Zhiliao uses independent product versions and product tags instead of inherited DSH release identifiers."
---

# Use the Zhiliao product version and release tags

English | [中文](guide.zh.md)

## Change

Zhiliao starts its own product line at `0.1.0`, with `0.1.0-alpha.1` as its first preview. The upstream `0.2.2-alpha.2` identifies the code baseline, not the application version. The About panel displays both values separately. The repository stops the DSH npm publication workflow; installing a same-named package from npm does not install this product's build.

New product tags use `zhiliao-v*`. Both Desktop packaging presets reject inherited `dsh-v*` source tags. Existing retained records remain readable; old test artifacts can still be verified and published, but production publication requires `master` or a Zhiliao product tag.

## Migration

1. Build this checkout or install its Desktop artifact. For a local Apple Silicon build, run `pnpm run package:desktop:mac:arm64:unsigned --build-version 0.1.0-alpha.1`. Keep existing user data when replacing the application; the version reset does not change the Session format.
2. Use `zhiliao-v<product-version>` for new release tags and source selections. Rebuild an old production artifact from an accepted source instead of republishing its inherited DSH tag.
3. In About, confirm the product version is `0.1.0-alpha.1` and the upstream baseline is `0.2.2-alpha.2`. See the [version-line decision](../../../../.agents/notes/implemented/process/2026-10-31-zhiliao-own-version-line.md) and [Desktop packaging guide](../../../../apps/desktop/packaging/README.md) for ownership and local build requirements.
