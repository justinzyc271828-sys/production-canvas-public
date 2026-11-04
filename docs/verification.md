# Verification

## Automated checks

Use Node.js 24 on Windows.

```powershell
npm ci
npm run check
npm run verify:sample
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

Windows CI runs these commands for main-branch pushes and pull requests.
It uploads only the synthetic verification report. It has no production
project binding, account secret or ComfyUI service.

## Packaged verification

Packaging requires a clean committed source tree. The executable embeds the
full commit hash. Release artifacts include the repository license and third-party notices.

```powershell
npm run pack:win
$env:CANVAS_EXECUTABLE = (Resolve-Path ./dist/ProductionCanvas-1.5.0-win-x64.exe).Path
npm run verify:sample
```

Set CANVAS_CAPTURE=1 to capture successful window checkpoints. Capture is
optional because some Windows desktop sessions return UnknownVizError.
The functional check remains available without captures.

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

For an independent review, use [the Chinese review prompt](review-prompt-zh.md).
