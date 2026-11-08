# Production Canvas

Frame annotations that keep Codex aligned with the author's intent.

Pause on a video frame and describe the change you want. Codex can read your
original words together with the video version, frame anchor, shot position,
and surrounding images. Return to the annotation when reviewing the next edit.

[Download the English preview](https://github.com/justinzyc271828-sys/production-canvas-public/releases/tag/v0.2.0-preview.1-english)

![Frame annotations in the original synthetic sample](docs/sample-review.png)

## Try the complete package

1. Download and extract the complete English Windows x64 plugin ZIP. Run
   `scripts/start-canvas.ps1` from the extracted package.
2. Open `sample/project.json`. Press **Space** to play or pause, **N** to
   annotate, and **Enter** to save. Click a marker to return to its frame.
3. Install the extracted package as a local plugin in Codex, or register
   `scripts/start-mcp.ps1` as a stdio MCP server. Ask Codex to read the saved
   annotations and explain the intended changes using the neighboring images.

The package includes desktop version `1.5.1-english.1`, all 15 local MCP tools,
an isolated Python 3.12 runtime, and an original 30-second sample. Its executable
is unsigned. Compare the download with the release's `SHA256SUMS.txt`.

## Collaborate through frame annotations

`read_direction_context` returns saved text, original anchors, resolved positions,
and labelled contact sheets. **Copy for Codex** also carries the original frame
anchor and current resolved location. Use separately connected generation and
editing tools for the requested revision, then return to the annotations when
reviewing the updated video.

## Run from source

The source checkout contains the application and plugin sources. The portable
executable and isolated Python runtime are supplied in the release ZIP.
Use Node.js 24 and the dependencies pinned in `package-lock.json`.

```powershell
npm ci
npm run check
npm start
```

The [MCP reference](mcp/README.md) describes Python development setup, session
discovery, version guards, and safe retries. The [workflow skill](skills/production-canvas/SKILL.md)
describes the collaboration flow. Optional production tools are connected separately.

## Build the Rust/Tauri candidate

See the [Windows candidate guide](docs/tauri-candidate.md) for the standalone
packaging command, the bilingual launchers, and the local migration and
rollback procedure. The release link above points to the existing preview.

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

Run `npm run verify:sample` and `npm run verify:opening` on Windows. These use
isolated profiles and synthetic media. See [verification](docs/verification.md)
and [the English preview provenance](docs/english-preview.md) for the source
fingerprint, package identity, and tested scope.

The current preview passed 42 application tests and 10 MCP adapter tests,
720 visual frame-marker checks, and 30 random pauses. Testing also covered
saved annotations, exact-frame return, file opening, and local plugin installation.
A separate clean-machine installation remains unverified.

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
