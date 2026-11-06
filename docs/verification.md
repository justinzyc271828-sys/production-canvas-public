# Verification

## Automated checks

Use Node.js 24 on Windows.

```powershell
npm ci
npm run check
npm run verify:sample
npm run verify:opening
```

check parses the application and runs the Node test suite. The suite covers
native and JSON timelines, inclusive/exclusive frame boundaries, blanks,
invalid inputs, project path boundaries, editorial revision mismatches,
legacy manifests, direction persistence, idempotent retries, candidate hashes,
review decisions and direction relocation after edits.

verify:sample launches the actual Electron interface in a fresh temporary
profile. It uses the bundled synthetic project, writes test directions only
there and saves its result under release/sample-verification. The profile path
is printed with the result and can be retained for inspection.

The desktop check covers playback, short-shot selection, note creation and
return, replacement-note resolution, keyboard playback after focused controls,
the focus export, timeline heights, and accessible controls at 1024 x 700 and
1179 x 800. It also scans all 720 sample frames and pauses playback 30 times.
A ten-bit visual marker encoded in the picture is decoded independently of
the player's time and compared with the displayed frame label.
The S13 thumbnail is checked in standard and expanded timelines against a
native-resolution frame. Its backing pixels must cover its displayed size
at the current device scale, up to the source resolution. Set
CANVAS_DEVICE_SCALE=1 or CANVAS_DEVICE_SCALE=2 to exercise each scale explicitly.

The sample check also uses the project selector to verify saved selection,
unsaved-direction protection, and explicit failure for a missing project.
Long directions use compact numbered flags, including after zooming.
The number matches the inspector list, and the current direction is highlighted.
Numbers follow the resolved timeline order and are display labels. Saved
direction IDs and original text retain their existing meaning.
The sample check preserves the full text, groups neighboring marks by count,
and verifies flag alignment and a direct jump to the anchored frame.
Overview marks use muted ticks. Chapter and shot labels appear only when
their visible interval can fit the text.
verify:opening launches the app repeatedly in an isolated profile. It checks
cold startup with a file argument, same-named videos in different directories,
reuse of one window, focus exports, restart restoration, and returning to the
saved direction's exact frame. Its results go to release/opening-verification.
The fixtures contain only copies of the bundled synthetic media.
For a packaged EXE, this also opens a second isolated profile, closes it,
then reloads the first profile to check that portable extraction directories
are independent. The pinned builder uses `portable.unpackDirName: true`
for a per-launch directory.

Windows CI runs these commands for main-branch pushes and pull requests.
It uploads only the synthetic verification report. It has no production
project binding, account secret or ComfyUI service.

## Packaged verification

Packaging requires a clean committed source tree. The executable embeds the
full commit hash. Release artifacts include the repository license and third-party notices.

```powershell
npm run pack:win
$env:CANVAS_EXECUTABLE = (Resolve-Path ./dist/ProductionCanvas-1.5.1-english.1-win-x64.exe).Path
npm run verify:sample
npm run verify:opening
```

Set CANVAS_CAPTURE=1 to capture successful window checkpoints. Capture is
optional because some Windows desktop sessions return UnknownVizError.
The functional check remains available without captures.

npm run pack:win runs both desktop suites and npm run check before packaging,
then repeats both desktop suites against the produced EXE and verifies its
embedded commit. It also compares the Windows icons extracted from both
the portable launcher and the inner app EXE with the project icon.
A failed check makes the packaging command fail.
When changing Windows icons, also check an actual associated MP4 in Explorer.
Use the application's own DefaultIcon registration and a shell association
refresh. A correct desktop shortcut icon alone does not verify file icons.
After signing or any separate local build, run both suites again through
CANVAS_EXECUTABLE and set CANVAS_EXPECTED_BUILD to the expected embedded
identity before updating a shortcut, file association target or release asset.

The launcher disables Chromium background timer throttling for deterministic
automation. Normal application startup does not require those test switches.
Optional production-service checks use independent copied projects with
separate --profile directories.

## Manual acceptance

1. Open the bundled sample. Confirm all four chapter bands, the shot/cue rows,
   the 16-clip picture track and the real audio waveform.
2. Choose a short pending shot. Check the number in the picture and the frame
   label, loop it, press N, enter a direction and press Enter.
3. Press Space, pause again, then click the direction marker to return. Repeat
   with neighboring notes and the square-bracket shortcuts.
4. Open a copied project.json by file and by directory. Verify both paths
   locate the same edit, video, metadata and saved notes.
5. If configured, open the existing ComfyUI workflow and return. Confirm the
   frame, selection, viewport and timeline height.

The published English preview was built from a source-content fingerprint before
this source commit was created. Its embedded identity is documented in
[the English preview provenance](english-preview.md). New committed builds
use the normal commit identity described above.

For an independent review, use [the review prompt](review-prompt.md).
