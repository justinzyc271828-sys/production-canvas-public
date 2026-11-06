---
name: production-canvas
description: Collaborate with Codex on video using exact-frame annotations, original author intent, and surrounding visual context in Production Canvas. Use for reviewing local films, explaining annotations, planning revisions, and checking the next video version on Windows.
---

# Production Canvas

Use frame annotations to understand the author's intended video change.
Read the original words with the exact frame, shot, video version, and nearby
images before proposing an edit or generation prompt.

## Connect to the review

The English Windows desktop app and Python runtime are included. If no app
instance is running, launch `scripts/start-canvas.ps1` from the plugin root in
a separate desktop process. The adapter must not own its process lifetime.
The English preview has a dedicated profile and a numbered synthetic sample.

The host launches the adapter through `mcp.json`. A newly installed plugin
may need a new chat before its tools become available.

Call `list_instances` and select the intended English preview window. Inspect
`get_status`, then select the user's project with `list_projects`,
`open_project`, or `import_project`. Import an existing absolute JSON manifest
path. Read `get_review_state` before guarded operations.

## Understand the annotation

1. Call `read_direction_context` for the current project, timeline revision,
   and video hash. It returns the full original annotation text, original
   anchors, current resolved locations, and labelled frame contact sheets.
2. Match each annotation to its view and frame labels. Inspect the annotated
   frame, adjacent frames, and available shot boundaries. The image index is
   one-based. Read the original text before summarizing the request.
3. Explain what the author wants changed and which visual evidence supports
   that interpretation. Identify unresolved references or missing frames.
   Ask a focused question when the intended change remains ambiguous.
4. Turn the understood intent into a scoped plan for the separately connected
   editing or generation tools. Use those tools only within the user's
   authorization. On the next review version, return to the annotation and
   compare the result with the original request.

Contact sheets are sampled stills. They do not establish complete playback
or an audio review. Use playback and audio-capable tools when the request
depends on motion or sound.

## Capture and return to intent

Use `seek_frame` or `navigate_shot` to find the requested point, and
`capture_frame` to inspect the actual app window. `open_direction` pauses and
opens the normal annotation editor. Save only the user's requested text with
`save_direction`, using one new 32-character lowercase hexadecimal
`operation_id` for each annotation. Reuse it only for an identical retry.

Verify the saved record and use `jump_to_direction` to return to its anchor.
Preserve the original wording, source coordinates, and version identity.
Keep unlocated annotations visible when the edit no longer provides a target.

## Version and data boundaries

Carry `project_id`, `revision`, and `video_sha256` from the current review state
into guarded calls. Read the state again after changing project or view.
Preserve the distinction between the original anchor and its resolved
location in the current edit.

Requested project information, annotations, screenshots, and frames can be
returned to the connected AI client. Runtime session credentials stay local.
Technical test annotations belong in an isolated sample copy. An annotation
does not approve a finished video or authorize publication.
