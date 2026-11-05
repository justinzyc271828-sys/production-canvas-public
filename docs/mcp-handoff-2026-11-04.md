# Local MCP implementation handoff

Recorded 2026-11-04. This source snapshot adds a local MCP adapter to the
existing review application. The existing working-tree selection highlight
and dark select-menu fixes are retained in the same runtime snapshot.

## Review experience

An assistant can identify a running application, select a project and review
view, seek a frame, control playback, save a direction and return to its exact
anchor. The fourteen tools are documented in `mcp/README.md` and implemented
in `mcp/server.py`. Saved directions use the existing application store.

The application owns an authenticated loopback bridge and publishes a local
session descriptor. The adapter uses the official Python MCP SDK over stdio.
Project mutations carry the project ID, timeline revision and actual video
SHA-256. Direction retries carry a stable operation ID. The bridge serializes
commands and validates the exact command arguments and local origin.

## Verified scope

The tested local build identifies itself as
`71fd9835c329b7cfab022822af9b1ce2b1275041+local.mcp.be10c444afcb`.
Its portable executable SHA-256 is
`d59fe4f5b9ac6e5f456f810f3dc06593f8ecb727b0ebe72e4f9ccab9991f53bd`.

- 38 application tests and 8 adapter tests passed.
- The exact local portable build passed the synthetic desktop exercise with
  720 decoded picture-frame markers, 30 random pauses and seven shortcut checks.
- Four production review projects completed full playback through MCP.
  Frame navigation, stale-version rejection, pause, direction save,
  idempotent retry, jump-back and resume were verified in isolated copies.
  The normal desktop profile retained its previous projects and loaded the
  four delivered review bindings without technical test notes.

Production media, screenshots and detailed project receipts remain in the
private production repository. This public source snapshot contains generic
implementation, tests and documentation. The published v1.5.0 release remains
the earlier release. A new public executable has its own build and release
verification step.

## Operational findings

Start the desktop application independently of the stdio adapter. A GUI
process launched as a child of the Windows MCP client can inherit the client's
process-job lifetime and exit when the client disconnects. Connect to the
independently running application instead.

An early sample check run concurrently with long production playback timed
out. The sequential check of the same portable build passed. Run desktop
verification sequentially, using separate profiles and project copies for
test directions.

Install and run instructions are in `mcp/README.md`. General sample and release
verification instructions are in `docs/verification.md`.
