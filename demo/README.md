# Offline review exercise

Open this directory in Production Canvas, or choose the bundled sample in the
project menu. The default entry is project.json.

The original 30-second video has 720 frames at 24 fps, 16 real picture clips,
one audio track, four chapters and three marked placeholder clips. Each frame
shows its own number. The sound is an original 120 BPM pulse with a simple
synthesized melody. The short review version covers full-film frames 264–419.

Try the following steps.

1. Play and pause, then move one frame with the arrow keys.
2. Click the short-clip group around 12.5 seconds. Select S06 in the pending
   list, loop the clip and compare the displayed frame with the counter.
3. Press N, write a direction and press Enter. Press Space to play again.
4. Click the direction marker to return to its frame. Use the square-bracket
   keys to move between directions.
5. Change the timeline height and switch between time and musical bars.
6. Select a placeholder and record a pass or redo decision.

The chapter, cue and sound-reference rows come from review.json. The V1 and
A1 clips come from edit/sample.kdenlive. Placeholder status is a declared
review exercise, while the displayed video contains the actual numbered
frames. Thumbnail images are extracted from those same frames.

The JSON timeline next to the native Kdenlive file is an equivalent
CLI-Anything example. It is not a second hidden edit. The legacy opening
media is retained for compatibility tests.

The sample has no external production service binding. A local ComfyUI
project can declare its own workflow in project.json.

Rebuild the synthetic assets with the repository's scripts/build-demo.cjs
and an installed FFmpeg. The provenance record identifies the generator.
Original sample media use the repository Production Canvas Source License 1.0.
