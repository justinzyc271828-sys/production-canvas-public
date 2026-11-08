'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launch, settings, session, connect, command, identity, stop, until, cleanScratch } = require('./desktop-probe.cjs');

const [electronExe, rustExe, output = 'release/tauri-sample.json'] = process.argv.slice(2);
if (!electronExe || !rustExe) {
  throw Error('Usage: node scripts/verify-desktop.cjs ELECTRON_EXE RUST_EXE [OUTPUT_JSON]');
}
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canvas-pilot-review-'));
const sample = path.resolve(__dirname, '../demo');
const project = path.join(root, 'sample');
fs.cpSync(sample, project, { recursive: true });

const profile = name => path.join(root, name);
const id = () => randomBytes(16).toString('hex');
const ready = app => until(async () => {
  const state = await command(app, 'state');
  return state.ready ? state : null;
});
const report = { mode: 'sample', checks: {} };
const rust = { kind: 'rust', executable: path.resolve(rustExe), runtime: process.env.CANVAS_PILOT_RUNTIME };

async function pictureCheck() {
  const image = document.createElement('canvas');
  image.width = 640;
  image.height = 360;
  const context = image.getContext('2d', { willReadFrequently: true });
  const pictureNumber = () => {
    context.drawImage(player, 0, 0, 640, 360);
    let value = 0;
    for (let bit = 0; bit < 10; bit++) {
      if (context.getImageData(34 + bit * 16, 286, 1, 1).data[0] > 128) value += 2 ** bit;
    }
    return value;
  };
  const settle = async () => {
    if (videoClock.pending && !await videoClock.pending) throw Error('Sample seek timed out');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  for (let frame = 0; frame < model.frames; frame++) {
    seekFrame(frame);
    await settle();
    if (pictureNumber() !== frame || playFrame() !== frame) {
      throw Error('Requested frame ' + frame + ', picture ' + pictureNumber() + ', label ' + playFrame());
    }
  }
  for (let i = 0; i < 30; i++) {
    seekFrame(i * 19);
    await settle();
    await player.play();
    await new Promise(resolve => setTimeout(resolve, 60 + i % 5 * 13));
    if (!await pauseForNote()) throw Error('Pause at ' + i + ' failed');
    await settle();
    if (pictureNumber() !== playFrame()) throw Error('Paused label and picture differ');
  }
  return { checkedFrames: model.frames, checkedPauses: 30 };
}

async function thumbCheck() {
  const until = async callback => {
    for (let n = 0; n < 300; n++) {
      const result = callback();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error('Thumbnail or waveform did not settle');
  };
  const sample = () => {
    const nodes = [...document.querySelectorAll('canvas.clip-thumbnail')];
    if (!nodes.length || nodes.some(canvas => canvas.dataset.frame === undefined)) return null;
    const thumb = document.querySelector('[data-shot="S13"] canvas.clip-thumbnail');
    return thumb && { count: nodes.length, width: thumb.width, frame: Number(thumb.dataset.frame) };
  };
  const standard = await until(sample);
  await until(() => document.querySelector('canvas.waveform'));
  setHeight('expanded');
  const expanded = await until(sample);
  if (expanded.width <= standard.width) throw Error('Expanded timeline reused a smaller thumbnail');
  const thumb = document.querySelector('[data-shot="S13"] canvas.clip-thumbnail');
  const original = await thumbnailAt(Number(thumb.dataset.frame), model.video.width, model.video.height);
  const reference = document.createElement('canvas');
  reference.width = thumb.width;
  reference.height = thumb.height;
  const target = reference.getContext('2d');
  target.imageSmoothingQuality = 'high';
  target.drawImage(original, 0, 0, reference.width, reference.height);
  const expected = target.getImageData(0, 0, reference.width, reference.height).data;
  const seen = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data;
  let meanError = 0;
  for (let i = 0; i < seen.length; i++) meanError += Math.abs(seen[i] - expected[i]) / seen.length;
  if (meanError > 3) throw Error('Thumbnail reference mismatch ' + meanError);
  setHeight('standard');
  return { standard, expanded, meanChannelError: meanError };
}

async function runSample() {
  settings(profile('electron'), project);
  settings(profile('rust'), project);
  const electron = await launch({ kind: 'electron', executable: path.resolve(electronExe), profile: profile('electron'), debug: false });
  let pilot, page;
  try {
    let oldState = await ready(electron);
    const frame = 363;
    oldState = await command(electron, 'seek_frame', { ...identity(oldState), frame });
    const legacyId = id();
    const text = 'Legacy direction created in Electron at sample frame 363.';
    const oldNote = await command(electron, 'save_direction', { ...identity(oldState), text, operation_id: legacyId });
    assert.equal(oldNote.direction.anchor.frame, frame);
    const legacyFile = path.join(project, '.production-canvas', 'tasks', legacyId, 'brief.json');
    const before = fs.readFileSync(legacyFile);

    pilot = await launch({ ...rust, profile: profile('rust') });
    const state = await ready(pilot);
    assert.notEqual(session(electron).instance_id, session(pilot).instance_id);
    assert.notEqual(session(electron).profile, session(pilot).profile);
    assert.notEqual(session(electron).pid, session(pilot).pid);
    assert.notEqual(session(electron).origin, session(pilot).origin);
    assert.deepEqual(identity(state), identity(await ready(electron)));
    report.builds = { electron: session(electron).build_commit, rust: session(pilot).build_commit };
    report.checks.parallelProfilesAndProjects = true;
    await assert.rejects(command(pilot, 'state', {}, { unauthorized: true }), { code: 'unauthorized', status: 403 });
    const desk = await fetch(session(pilot).origin + '/api/canvas/projects');
    assert.equal(desk.status, 403);
    await assert.rejects(command(pilot, 'seek_frame', { ...identity(state), frame: 24, expected_video_sha256: '0'.repeat(64) }),
      { code: 'version_changed', status: 409 });
    report.checks.mcpAuthenticationAndStaleIdentity = true;

    page = await connect(pilot);
    const found = state.directions.find(item => item.id === legacyId);
    assert.equal(found.resolved.frame, frame);
    const ui = await page.evaluate(async (directionId, frame) => {
      const mark = document.querySelector('#review-rows [data-note="' + directionId + '"]');
      if (!mark) throw Error('Legacy direction is missing on the timeline');
      mark.click();
      if (videoClock.pending && !await videoClock.pending) throw Error('Legacy direction did not settle');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { frame: playFrame(), active: activeNoteId === directionId, expected: frame };
    }, [legacyId, frame]);
    assert.deepEqual(ui, { frame, active: true, expected: frame });
    await command(pilot, 'seek_frame', { ...identity(state), frame: 197 });
    const jump = await command(pilot, 'jump_to_direction', { ...identity(state), direction_id: legacyId });
    assert.equal(jump.displayed_frame, frame);
    assert.deepEqual(fs.readFileSync(legacyFile), before);
    report.checks.legacyDirection = { frame, uiClick: true, mcpJump: true, originalRecordBytesPreserved: true };

    const captured = await command(pilot, 'capture_frame', identity(state));
    const png = Buffer.from(captured.png_base64, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(captured.state.displayed_frame, frame);
    const screenshot = path.join(path.dirname(path.resolve(output)), 'sample-review.png');
    fs.writeFileSync(screenshot, png);
    report.checks.mcpWindowCapture = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
    const context = await command(pilot, 'list_direction_context', identity(state));
    assert.ok(JSON.stringify(context).includes(legacyId));
    const frames = await command(pilot, 'capture_direction_frames', { ...identity(state), view: 's03', frames: [frame] });
    assert.equal(frames.tiles[0].status, 'verified'); assert.ok(frames.jpeg_base64);
    report.checks.mcpDirectionContextAndPicture = true;

    await command(pilot, 'play', identity(state));
    const paused = await command(pilot, 'pause', identity(state));
    assert.equal(paused.paused, true);
    await command(pilot, 'navigate_shot', { ...identity(state), shot: 'S13' });
    const operation = { ...identity(state), text: 'Rust trial direction.', operation_id: id() };
    const written = await command(pilot, 'save_direction', operation);
    const retry = await command(pilot, 'save_direction', operation);
    assert.equal(retry.direction_id, written.direction_id);
    assert.equal(retry.idempotent, true);
    report.checks.mcpPlaybackAndIdempotentSave = true;

    const unsaved = await page.evaluate(async () => {
      await openQuickNote();
      document.querySelector('#inline-note').value = 'Synthetic unsaved annotation';
      return mcpReviewState().unsaved_direction;
    });
    assert.equal(unsaved, true);
    const follow = spawn(rust.executable, ['--profile=' + profile('rust'), '--hidden', path.join(project, 'media', 'focus.mp4')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, PRODUCTION_CANVAS_MCP_REGISTRY: pilot.registry } });
    const [code] = await once(follow, 'exit');
    assert.equal(code, 1);
    const afterOpen = await command(pilot, 'state');
    assert.equal(afterOpen.current_view, 's03');
    assert.equal(afterOpen.unsaved_direction, true);
    await page.evaluate(() => closeQuickNote());
    report.checks.fileOpenProtectsUnsavedAnnotation = true;
    report.checks.thumbnailAndWaveform = await page.evaluate(thumbCheck);
    report.checks.decodedFrameScan = await page.evaluate(pictureCheck, [], 140000);
  } finally {
    page?.close();
    if (pilot) await stop(pilot);
    await stop(electron);
  }
}


(async () => {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  await runSample();
  fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  cleanScratch(root);
})().catch(error => {
  console.error(error.stack + '\nIsolated diagnostic files: ' + root);
  process.exitCode = 1;
});
