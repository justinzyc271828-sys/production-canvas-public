# Project format v1

## Start with a video and an edit

Create a directory containing the review video, its matching Kdenlive edit
and a project.json file. Choose **项目 → 打开项目清单…**, or select the directory
with **接入本地影片目录…**.

```json
{
  "schema": "production-canvas/v1",
  "title": "My film",
  "video": {
    "path": "media/review.mp4",
    "label": "Full review"
  },
  "timeline": "edit/film.kdenlive"
}
```

The video is the rendered picture and sound used for review. The timeline
supplies the actual clip positions, source in/out points, track names, frame
rate and dimensions. Export the video from that exact timeline at a constant
frame rate. The app displays the existing export and does not render native
Kdenlive effects during playback.

All paths in project.json and review.json are relative to the project
directory. File references must resolve inside that directory, including
symlink targets. The native Kdenlive file retains its own media-reference
convention. Keep its source media inside the project when using **看原素材**.

The bundled [sample](../demo/project.json) is a complete working example.
Copy the entire demo directory to another location before replacing its
files. It works without an account, a production service or Python.

## Supported timelines

- Native .kdenlive files use their MLT profile, main sequence, producer/chain
  records, playlists, blanks and Kdenlive track containers. Empty tracks are
  retained. Source filters are shown as metadata.
- Native nested sequence clips and timewarp producers are rejected with an
  explicit error. Flatten the edit for review or provide a supported
  CLI-Anything JSON timeline. This reader is not a complete Kdenlive renderer.
- .kdenlive-cli.json files use the existing CLI-Anything structure with
  profile, bin and tracks. Source paths in these files are project-relative.
  The [sample JSON edit](../demo/edit/sample.kdenlive-cli.json) illustrates it.
  Rendering an edited JSON draft still requires the optional local Kdenlive
  integration.

MLT out points are inclusive. The app converts them to exclusive end frames
once while reading. Frame counts and editorial records then use the same
zero-based coordinate system. [MLT XML format](https://www.mltframework.org/docs/mltxml/)

The native reader assigns numeric track IDs in main-sequence order, omitting
the editor's background producer. Audio tracks count in that order. Clip
indices are zero-based in timeline order within each track. Read these IDs
from the inspector when preparing optional per-clip records.

## Optional fields

| Field | Meaning |
| --- | --- |
| review | Project-relative JSON file containing editorial metadata |
| mix | WAV or MP3 available for audition, with a waveform when there is one nonempty audio track |
| notes | Markdown file opened by the project-notes link |
| focus | A separately exported portion of the main review video |
| comfy | An existing local ComfyUI workflow binding |

An optional focus export uses the same frame rate. Its start is inclusive
and end is exclusive in full-film frames. It must contain exactly end minus
start frames. The player and saved directions retain full-film coordinates.

```json
{
  "focus": {
    "path": "media/focus.mp4",
    "label": "Short-shot review",
    "start": 264,
    "end": 420
  },
  "comfy": {
    "path": "workflows/film.json",
    "canvas_id": "the-id-inside-the-saved-workflow"
  }
}
```

The ComfyUI workflow must also be available under the same filename in the
local server's workflows directory. The app checks its identity, opens it
read-only and blocks saving or queueing from the embedded view.

## Editorial data

The following is a minimal review.json. All time values are integer frames.
Chapters and point markers describe review information. They never add,
remove or split an actual project track.

```json
{
  "chapters": [
    { "title": "Opening", "start": 0, "end": 216, "color": "#526c80" }
  ],
  "shots": [
    { "frame": 0, "title": "S01" }
  ],
  "cues": [
    { "frame": 300, "title": "Transition accent" }
  ],
  "sounds": [
    { "frame": 360, "title": "Music change" }
  ],
  "clips": [
    { "track": 0, "clip": 5, "shot": "S06", "placeholder": true }
  ],
  "music": {
    "bpm": 120,
    "beatsPerBar": 4,
    "start": 0,
    "end": 720
  }
}
```

Shot IDs can contain ASCII letters, digits, dots, underscores and hyphens,
with a maximum of 64 characters. A per-clip shot ID enables directions to
follow a replacement source. Update the clip mappings when reordering an edit.
The optional native entry property production_canvas:shot also supplies a
shot ID directly from the edit.

A clip can supply a thumbnail with a project-relative path and SHA-256.
The server verifies its bytes before displaying it.

```json
{
  "track": 0,
  "clip": 5,
  "shot": "S06",
  "placeholder": true,
  "thumbnail": {
    "path": "media/shot-6.png",
    "sha256": "replace-with-the-file-sha256"
  }
}
```

Add timelineRevision to bind the editorial file to one exact edit. Calculate
it from the edit file, for example with PowerShell's Get-FileHash -Algorithm
SHA256 and convert the result to lowercase. A mismatch produces a warning
and excludes those editorial records. It does not hide saved directions.
Without this optional hash, the metadata is the owner's declaration for the
current edit. Validate its clip indices whenever the edit changes.

The sample's review.json contains a revision binding. To try the equivalent
JSON timeline instead, update the timeline path and this hash together.

## Local records

Generic projects save directions, candidate receipts and review decisions in
.production-canvas inside the selected project directory. Add that directory
to the film project's .gitignore before sharing the film.

Directions store a rendered version, timeline revision, full-film frame and,
where available, a shot ID and source-frame anchor. Resolution is calculated
at display time. Original brief.json records remain unchanged.

Source-frame matches take priority. If the source has been replaced, a known
shot ID can preserve a saved clip-relative offset. Old directions without an
offset retain their original full-film frame if it is still inside the
replacement. Otherwise they use the first frame. Old directions without
source in/out information cannot establish every historical trim.

## Existing project adapters

Existing opening/storyboard manifests and battle-review manifests remain
supported. Their records stay in edit/production-canvas. Existing workbench
binding files can still be imported.

Project-owned editorial data can be declared in an old manifest using
production_canvas.review. A battle-review adapter also checks the conventional
edit/production-canvas/review-data.json path. No film-specific editorial JSON
is bundled with the application.

The old sample folder is preserved when upgrading. It remains available as
**旧版示例与指令** when present. The new complete sample uses a different folder,
so initializing it does not overwrite earlier sample notes.
