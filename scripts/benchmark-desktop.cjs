'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, settings, session, connect, stop, cleanScratch } = require('./desktop-probe.cjs');

const [electronExe, rustExe, projectRoot, output, repetitions = '5'] = process.argv.slice(2);
if (!electronExe || !rustExe || !projectRoot || !output || !/^[1-9]\d*$/.test(repetitions)) {
  throw Error('Usage: node scripts/benchmark.cjs ELECTRON_EXE RUST_EXE PROJECT_DIR OUTPUT_JSON [RUNS_PER_APP]');
}
const trialCount = Number(repetitions);
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canvas-pilot-benchmark-'));
const samples = [];

async function startup() {
  const time = () => performance.timeOrigin + performance.now();
  const untilPaint = async (condition, label) => {
    const deadline = performance.now() + 16000;
    while (!condition()) {
      if (performance.now() > deadline) throw Error('Missing ' + label);
      await new Promise(requestAnimationFrame);
    }
    return time();
  };
  const firstFrame = () => typeof player !== 'undefined' && player?.readyState >= 2 &&
    typeof videoClock !== 'undefined' && videoClock?.displayed != null && !videoClock.pending;
  const attachedAfterFirstFrame = firstFrame();
  const first = await untilPaint(firstFrame, 'first frame');
  const selectors = { all: 'canvas.clip-thumbnail', drawn: 'canvas.clip-thumbnail[data-frame]' };
  const thumbCount = () => document.querySelectorAll(selectors.all).length;
  const drawn = () => document.querySelectorAll(selectors.drawn).length;
  const thumbs = await untilPaint(() => thumbCount() > 0 && drawn() === thumbCount(), 'thumbnails');
  return {
    first, thumbs, attachedAfterFirstFrame, thumbnailCount: drawn(),
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    frames: model.frames, fps: model.fps, digest: model.video.actualSha256,
    timelineRevision: model.revision
  };
}

async function measureSeeks() {
  const positions = [0.11, 0.62, 0.19, 0.88, 0.31, 0.73, 0.07, 0.94, 0.26, 0.54, 0.34, 0.82,
    0.02, 0.45, 0.16, 0.98, 0.23, 0.68, 0.05, 0.78, 0.37, 0.86, 0.48, 0.58];
  const times = [];
  for (const position of positions) {
    const frame = Math.floor(model.frames * position);
    const started = performance.now();
    seekFrame(frame);
    if (videoClock.pending && !await videoClock.pending) throw Error('Seek timeout at frame ' + frame);
    if (playFrame() !== frame) throw Error('Incorrect seek frame ' + frame);
    times.push(performance.now() - started);
  }
  return times;
}

const round = value => Math.round(value * 10) / 10;
function percentile(values, p) {
  const sorted = values.toSorted((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
}

function describe(rows) {
  const seeks = rows.flatMap(row => row.seekMs);
  return {
    launches: rows.length,
    launchToFrameMedianMs: percentile(rows.map(row => row.launchToFrameMs), .5),
    launchToThumbnailsMedianMs: percentile(rows.map(row => row.launchToThumbnailsMs), .5),
    firstFrameToThumbnailsMedianMs: percentile(rows.map(row => row.firstFrameToThumbnailsMs), .5),
    seekCount: seeks.length,
    seekMedianMs: percentile(seeks, .5),
    seekP95Ms: percentile(seeks, .95)
  };
}

async function trial(kind, executable, index) {
  const profile = path.join(temp, kind + '-' + index);
  settings(profile, path.resolve(projectRoot));
  const app = await launch({ kind, executable: path.resolve(executable), profile, runtime: process.env.CANVAS_PILOT_RUNTIME, benchmark: true });
  let page;
  try {
    page = await connect(app);
    const startupResult = await page.evaluate(startup, [], 25000);
    const seekMs = await page.evaluate(measureSeeks, [], 30000);
    const row = {
      kind, version: session(app).version, build: session(app).build_commit, index,
      launchToFrameMs: round(startupResult.first - app.started),
      launchToThumbnailsMs: round(startupResult.thumbs - app.started),
      firstFrameToThumbnailsMs: round(startupResult.thumbs - startupResult.first),
      ...Object.fromEntries(Object.entries(startupResult).filter(([key]) => !['first', 'thumbs'].includes(key))),
      seekMs: seekMs.map(round)
    };
    assert.equal(row.digest, samples[0]?.digest ?? row.digest);
    assert.equal(row.timelineRevision, samples[0]?.timelineRevision ?? row.timelineRevision);
    assert.equal(row.frames, samples[0]?.frames ?? row.frames);
    assert.equal(row.dpr, samples[0]?.dpr ?? row.dpr);
    assert.equal(row.thumbnailCount, samples[0]?.thumbnailCount ?? row.thumbnailCount);
    assert.equal(row.attachedAfterFirstFrame, false, 'Probe attached after first frame');
    samples.push(row);
    console.log(JSON.stringify({ kind, index, frameMs: row.launchToFrameMs, thumbsMs: row.launchToThumbnailsMs,
      thumbnails: row.thumbnailCount, viewport: [row.width, row.height], seekMedianMs: percentile(seekMs, .5),
      seekP95Ms: percentile(seekMs, .95), attachedAfterFirstFrame: row.attachedAfterFirstFrame }));
  } finally {
    page?.close();
    await stop(app);
  }
}

(async () => {
  for (let index = 1; index <= trialCount; index++) {
    const order = index % 2 ? [['electron', electronExe], ['rust', rustExe]] : [['rust', rustExe], ['electron', electronExe]];
    for (const [kind, exe] of order) await trial(kind, exe, index);
  }
  const summaries = Object.fromEntries(['electron', 'rust'].map(kind => [kind, describe(samples.filter(row => row.kind === kind))]));
  const result = { project: path.basename(path.resolve(projectRoot)), method: 'Alternating fresh app profiles, same system DPI and thumbnail count, Chromium background throttling disabled in both, normal Windows filesystem cache, 24 identical settled seeks after thumbnails', summaries, samples };
  fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(summaries));
  cleanScratch(temp);
})().catch(error => {
  console.error(error.stack + '\nIsolated diagnostic files: ' + temp);
  process.exitCode = 1;
});
