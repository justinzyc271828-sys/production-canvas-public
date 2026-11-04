# Production Canvas repository guidelines

Read [README.md](README.md) for the product scope and launch instructions.
For an independent review, start with [the review prompt](docs/review-prompt-zh.md).
A request for review authorizes findings and suggestions. Ask the project owner before
making changes beyond the requested review.

## Product behavior

- Keep the review loop direct. The director should be able to pause, identify
  the current version and frame, save a direction, and return from that
  direction to its original position.
- Preserve version and timeline revision identity when changing timeline,
  playback, or review-note code. Test older notes and version changes where
  relevant. Keep approved media separate from drafts and review candidates.
- Keep the bundled sample usable in a fresh profile. For optional local
  integrations, verify the relevant adapter separately and record the fixture
  and environment used.

## Changes and verification

- Reuse the existing app structure. Work from the requested scope and keep
  changes small enough for the owner to review.
- Run npm run check for source changes and npm run verify:sample for review,
  project-format or timeline changes. Also
  open the bundled sample and verify the affected flow in the desktop UI.
  Use a separate profile and sample copy when writing test notes.
- In a review handoff, record the build or commit, reproduction steps, the
  observed result, and anything still unverified. For frame-linked feedback,
  include the relevant version, timecode, and frame where available.
- Keep production media, project workfiles, local profiles, generated jobs,
  and credentials out of source commits. Use the bundled sample for shared
  reproduction steps.
- Keep delivery actions tied to the owner-approved commit and asset. Verify
  repository visibility, the release tag, and the executable SHA-256 when
  publishing a new build.

## Project boundaries

- Keep the generic project format documented in docs/project-format.md.
  Preserve the existing manifest adapters and source-frame note anchors.
- The bundled sample is original synthetic material. Do not add production
  footage or owner-provided test clips to the repository.
- Delivery follows the owner's current instruction. Licensing, repository
  visibility and historical Git rewrites each require an explicit decision.
  No repository file grants standing publication authority.
