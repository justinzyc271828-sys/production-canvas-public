# Production Canvas MCP

This local adapter connects Codex to the running Production Canvas application.
It uses the existing official Python MCP SDK and the application's dedicated,
authenticated loopback bridge. The desktop UI's separate session gate remains
active.

## Local entry point

Use Python 3.11 or newer with the official Python MCP SDK. The verified SDK
version is pinned in `mcp/requirements.txt`. From this repository, prepare an
environment and start the adapter.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r mcp/requirements.txt
.\.venv\Scripts\python.exe -X utf8 ./mcp/server.py
```

The process uses MCP over standard input and output. Logs go to standard error.
The default registry is `%APPDATA%/ProductionCanvas/mcp-sessions`. Set
`PRODUCTION_CANVAS_MCP_REGISTRY` to an absolute directory to use another
registry for isolated testing. Each updated app instance writes a fresh session
descriptor there. Session credentials are consumed locally and omitted from
MCP results.

Example Codex registration, after replacing `C:/Projects/production-canvas`
with the absolute path to your checkout

```powershell
codex mcp add production_canvas -- 'C:/Projects/production-canvas/.venv/Scripts/python.exe' -X utf8 'C:/Projects/production-canvas/mcp/server.py'
```

Start the updated local Production Canvas application through its desktop
entry before connecting. Existing packaged builds made before this bridge need
the updated application code. The MCP adapter connects to running windows and
never owns their process lifetime. Project imports pass through the guarded
project-only import route.

## Review workflow

1. Start the updated desktop app, call `list_instances`, then select an exact
   `instance_id`.
2. Call `list_projects`, `open_project` or `import_project`, then
   `get_review_state`.
3. Carry `project_id`, `revision` and `video_sha256` from that state into
   `set_review_view`, `seek_frame`, `navigate_shot`, `set_playback` and note
   operations. `set_review_view` selects the full film, opening or registered
   focus export, including older supported project formats.
4. Use `open_direction` to pause and open the normal quick-note form.
   `save_direction` uses that same form and the application's existing
   frame-anchor logic. Supply a new 32-character lowercase hex `operation_id`
   for each new note. Reuse that identifier for a retry of the exact same note.
5. Call `jump_to_direction` with its saved identifier. `capture_frame` returns
   a real app-window PNG and the corresponding displayed-frame state.
6. For batch review, call `read_direction_context` with the same active project,
   revision and video hash. One tool call returns all saved direction text,
   the original anchors, current resolved locations, and JPEG contact sheets.
   Match each note's frames to sheet tiles by view and frame number. The
   `image_index` counts image blocks from one. Group by the resolved shot and
   keep unanchored and unlocated directions in a separate group.

The tools cover instance discovery, project selection,
playback, shot and frame navigation, capture and frame-linked directions.
They do not expose arbitrary JavaScript, shell commands, review approval,
publication or paid generation. Saved directions remain in the selected
project's normal `.production-canvas` store. Use a separate project copy when
writing technical verification notes.

Batch review samples the marked frame, two frames on each side, and the
previous shot's last frame and next shot's first frame where supported.
It uses the registered review video for each resolved view and reports that
video's hash. Adjacent shots come from the picture track and any project shot
markers within it. Frames outside the view's bounds are omitted. The opening
view has no shot ranges. A relocated direction keeps its original anchor and
reports context from the resolved location in the current edit. Unverified
frames are marked unavailable. Contact sheets contain still images. The
foreground player and any open direction draft stay in place.

The app serializes bridge commands and rejects stale project, revision and
video identities before changing playback or notes. HTTP redirects are rejected.
Session descriptors must be ordinary files inside the configured registry and
must name a literal `http://127.0.0.1` endpoint. Their access follows the local
user-profile permissions, with mode `0600` requested when the app writes them.
On Windows, the desktop app is launched separately from the MCP server and
remains open across MCP disconnections. The MCP client's own process-job
cleanup is retained.

## Verification

```powershell
.\.venv\Scripts\python.exe -X utf8 ./mcp/test_server.py -v
```

These adapter tests cover descriptor validation, authenticated requests,
credential-free results, version guards, capture content and guarded imports.
They do not establish desktop playback success. The separate live integration
check must open a real review project, seek, play, pause, save a technical note
in an isolated copy and jump back to it through the MCP protocol.
