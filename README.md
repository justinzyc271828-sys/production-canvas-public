# Production Canvas

Frame annotations that keep Codex aligned with the author's intent.

Pause on a video frame and describe the change you want. Codex can read your
original words together with the video version, frame anchor, shot position,
and surrounding images. Return to the annotation when reviewing the next edit.

[Download Production Canvas 1.6.0 for Windows x64](https://github.com/justinzyc271828-sys/production-canvas-public/releases/download/v1.6.0/ProductionCanvas-1.6.0-windows-x64.zip)

![Frame annotations in the original synthetic sample](docs/sample-review.png)

## Try the complete package

1. Download and extract the complete Windows x64 ZIP. Open
   `desktop/production-canvas.exe` for the Chinese interface, or run
   `scripts/start-canvas.ps1` for the English interface.
2. Open `sample/project.json`. Press **Space** to play or pause, **N** to
   annotate, and **Enter** to save. Click a marker to return to its frame.
3. Install the extracted package as a local plugin in Codex, or register
   `scripts/start-mcp.ps1` as a stdio MCP server. Ask Codex to read the saved
   annotations and explain the intended changes using the neighboring images.

The Rust/Tauri desktop uses the Windows WebView2 Runtime. The package includes
Node.js, an isolated Python 3.12 runtime, all 15 local MCP tools, and an original
30-second sample. The executable is unsigned. Compare the download with the
[release checksums](https://github.com/justinzyc271828-sys/production-canvas-public/releases/download/v1.6.0/SHA256SUMS.txt).

## Collaborate through frame annotations

`read_direction_context` returns saved text, original anchors, resolved positions,
and labelled contact sheets. **Copy for Codex** also carries the original frame
anchor and current resolved location. Use separately connected generation and
editing tools for the requested revision, then return to the annotations when
reviewing the updated video.

## Run from source

Use Node.js 24 and the dependencies pinned in `package-lock.json`.

```powershell
npm ci
npm run check
```

The [MCP reference](mcp/README.md) describes Python development setup, session
discovery, version guards, and safe retries. The [workflow skill](skills/production-canvas/SKILL.md)
describes the collaboration flow. Optional production tools are connected separately.

## Build and migrate on Windows

See the [Windows guide](docs/tauri-candidate.md) for the Rust/Tauri packaging
command, the launchers, and local migration and rollback. The Electron host
provides the baseline for the Windows regression and performance checks.

## Review your own film

Keep a constant-frame-rate MP4 and its matching Kdenlive edit in one project
folder. Add a manifest and choose **Project → Open project manifest...**.

```json
{
  "schema": "production-canvas/v1",
  "title": "My film",
  "video": { "path": "media/review.mp4", "label": "Full review" },
  "timeline": "edit/film.kdenlive"
}
```

The [project format](docs/project-format.md) explains supported timelines,
chapters, shot markers, focus exports, and saved frame anchors. The
[source sample](demo/project.json) is an editable starting point.

## Verification and provenance

Run `npm run verify:sample`, `npm run verify:opening`, and the packaged Tauri
checks from the Windows guide. These use isolated profiles and synthetic media.
The release package includes `build-receipt.json` with the source commit and
executable checksums. See [verification](docs/verification.md) for the review
checks and reproduction steps.

## Privacy, license, and support

Project files and review records are local. Requested annotations, paths,
screenshots, and frame images are returned to the connected AI client under
that client's privacy settings. Read the [privacy information](privacy.md).

The Production Canvas Source License 1.0 permits free redistribution and
commercial creative work under its terms. Paid software distribution and
paid hosted access require separate permission. Third-party components retain
their own licenses. This community preview has OpenAI directory review pending.

[License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md) ·
[Report an issue](https://github.com/justinzyc271828-sys/production-canvas-public/issues)
