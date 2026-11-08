# English preview provenance

For the current Windows x64 ZIP and checksums, use the
[latest Production Canvas release](https://github.com/justinzyc271828-sys/production-canvas-public/releases/latest).
This page records the earlier English preview.

Release `v0.2.0-preview.1-english` contains plugin version `0.2.0-preview.1` and
desktop version `1.5.1-english.1`. Its ZIP SHA-256 is
`b1094b24486508a643dac19ae03ec0235dfc25c5e522e18196c5bca05ab44eb0`.

The desktop executable SHA-256 is
`0fe94a8ffea0970ac8d500a3c55436e759c8783ba18a922a8d52ab9950243d75`.
Its embedded identity is
`71fd9835c329b7cfab022822af9b1ce2b1275041+english.073cec8385f5`.

## Source correspondence

The executable was built from an isolated English snapshot before this source
commit was created. The release tag records the matching application sources,
sample, MCP adapter, plugin metadata, workflow skill, and launch scripts.

The historical build input fingerprint is
`073cec8385f52a06fedef70225a0ee7041d28b40ad5f86dab825fdaeaf08baaf`.
It hashes the original build recipe bytes first, followed by each path and file
content under `app`, `demo`, `package.json`, `package-lock.json`, `LICENSE`, and
`THIRD_PARTY_NOTICES.md`. Directory entries are sorted. Paths use `/` separators,
and each relative path is followed by one NUL byte before its file content.

The exact historical recipe is preserved as
`packaging/archive-build-recipe.cjs`. It records the original preparation-folder
layout and is provided for provenance. The Electron baseline can be rebuilt
with the pinned dependencies and `npm run pack:win` from a clean source commit.
The historical preview additionally included
only the `en-US` Electron locale and applied the equivalent Unicode escapes
listed in `packaging/source-normalization.json` to dependency sources.

`THIRD_PARTY_NOTICES.md` covers the desktop source dependencies. The complete
runtime notices distributed in the ZIP are also preserved as
`packaging/PLUGIN_THIRD_PARTY_NOTICES.md`.

The English preview ZIP included the portable binaries, isolated Python
runtime, and local plugin. The current package and its launch instructions
are listed in the [Windows guide](tauri-candidate.md).

## Verified scope

- 42 application tests and 10 MCP adapter tests passed.
- The desktop sample passed all 720 visual frame markers, 30 random pauses,
  annotation saving and exact-frame return, narrow layouts, and file-opening checks.
- All 15 MCP tools were discovered through the packaged stdio entry and an
  isolated local Codex installation. The 30-second sample played through frame 719.
- A note saved at frame 333 remained one record after an identical retry and
  returned to frame 333. Context images and the English screenshot were inspected.
- Package text, first-party sources, metadata, and synthetic media were checked
  for the documented privacy categories. The release retains public copyright
  attribution and repository links.

The executable is unsigned. Verification used isolated profiles on the development
Windows machine. Installation on a separate clean Windows machine remains
unverified. A Pydantic Settings startup warning was observed while the adapter
tests and live workflow passed.
