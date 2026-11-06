'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release', 'opening-verification'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-opening-test-'));
const registry = path.join(profile, 'sessions');
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const launcherArgs = process.env.CANVAS_EXECUTABLE ? [] : [root];
const children = [];
const checkpoints = {};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let session;

function fixture(name, differentBytes) {
  const directory = path.join(profile, name);
  fs.cpSync(path.join(root, 'demo'), directory, { recursive: true });
  const file = path.join(directory, 'media', 'sequence.mp4');
  // A valid trailing MP4 free box changes the file identity without new footage.
  if (differentBytes) fs.appendFileSync(file, Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'project.json')));
  manifest.title = name;
  manifest.video.sha256 = hash(file);
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(manifest));
  return { directory, file, sha256: hash(file) };
}

function launch(file) {
  const child = spawn(executable, [...launcherArgs, '--profile=' + profile, ...(file ? [file] : [])], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PRODUCTION_CANVAS_MCP_REGISTRY: registry }
  });
  children.push(child);
  return child;
}

async function command(row, body) {
  const response = await fetch(row.origin + '/api/mcp/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-MCP': row.token, Origin: row.origin },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000)
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  return value;
}

async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw Error('Opening verification timed out');
}

async function stateFor(sha256, view) {
  return until(async () => {
    const live = [];
    for (const name of fs.existsSync(registry) ? fs.readdirSync(registry) : []) {
      if (!name.endsWith('.json')) continue;
      const row = JSON.parse(fs.readFileSync(path.join(registry, name)));
      assert.equal(row.profile, profile);
      try { live.push({ row, state: await command(row, { command: 'state' }) }); }
      catch { /* The stopped test instance can leave a stale descriptor. */ }
    }
    assert.ok(live.length <= 1, 'Opening a file created a second instance in the same profile');
    const current = live[0];
    if (!current?.state.ready || current.state.video_sha256 !== sha256 || current.state.current_view !== view) return null;
    session = current.row;
    if (process.env.CANVAS_EXPECTED_BUILD) assert.equal(session.build_commit, process.env.CANVAS_EXPECTED_BUILD);
    assert.ok(current.state.paused);
    return current.state;
  });
}

function guard(state) {
  return { project_id: state.project_id, expected_revision: state.revision, expected_video_sha256: state.video_sha256 };
}

async function stop() {
  const records = session ? [session] : (fs.existsSync(registry) ? fs.readdirSync(registry) : [])
    .filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(registry, name))));
  for (const record of records) {
    assert.equal(record.profile, profile);
    try { await command(record, { command: 'state' }); }
    catch { continue; }
    try { process.kill(record.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  session = null;
  await sleep(500);
}

async function main() {
  const older = fixture('older-film', false);
  const newer = fixture('newer-film', true);
  fs.writeFileSync(path.join(profile, 'canvas-settings.json'), JSON.stringify({
    projects: { older: { root: older.directory }, newer: { root: newer.directory } }, tools: {}, active: 'older'
  }));
  launch(newer.file);
  let state = await stateFor(newer.sha256, 's03');
  assert.equal(state.project_id, 'newer');
  const instance = session.instance_id;
  checkpoints.coldOpenOverridesPreviousProject = true;

  if (process.env.CANVAS_EXECUTABLE) {
    const otherProfile = path.join(profile, 'parallel-profile');
    const otherRegistry = path.join(profile, 'parallel-sessions');
    fs.mkdirSync(otherProfile);
    const child = spawn(executable, ['--profile=' + otherProfile], {
      cwd: root, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PRODUCTION_CANVAS_MCP_REGISTRY: otherRegistry }
    });
    children.push(child);
    let other;
    try {
      other = await until(async () => {
        for (const name of fs.existsSync(otherRegistry) ? fs.readdirSync(otherRegistry) : []) {
          if (!name.endsWith('.json')) continue;
          const row = JSON.parse(fs.readFileSync(path.join(otherRegistry, name)));
          assert.equal(row.profile, otherProfile);
          const value = await command(row, { command: 'state' });
          if (value.ready) return row;
        }
        return null;
      });
    } finally {
      if (other) process.kill(other.pid);
    }
    await until(() => child.exitCode !== null);
    await command(session, { command: 'open_project', project_id: state.project_id });
    state = await stateFor(newer.sha256, 's03');
    assert.equal(session.instance_id, instance);
    checkpoints.parallelProfileDoesNotAffectReview = true;
  }

  await command(session, { command: 'seek_frame', ...guard(state), frame: 302 });
  state = await command(session, { command: 'state' });
  await command(session, { command: 'save_direction', ...guard(state),
    operation_id: '1'.repeat(32), text: 'Keep this exact frame in the newer film.' });
  const brief = path.join(newer.directory, '.production-canvas', 'tasks', '1'.repeat(32), 'brief.json');
  const briefHash = hash(brief);

  launch(older.file);
  state = await stateFor(older.sha256, 's03');
  assert.equal(state.project_id, 'older');
  assert.equal(session.instance_id, instance);
  checkpoints.sameNameInAnotherDirectory = true;

  const focus = path.join(newer.directory, 'media', 'focus.mp4');
  launch(focus);
  state = await stateFor(hash(focus), 'battle');
  assert.equal(state.project_id, 'newer');
  assert.equal(state.displayed_frame, 264);
  assert.equal(session.instance_id, instance);
  checkpoints.focusUsesMatchingProject = true;
  await until(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'canvas-settings.json')));
    return saved.active === 'newer' && saved.review?.project === 'newer' && saved.review?.view === 'battle';
  });

  await stop();
  launch();
  state = await stateFor(hash(focus), 'battle');
  assert.equal(state.project_id, 'newer');
  checkpoints.restartRestoresSelectedProjectAndVersion = true;
  await command(session, { command: 'jump_to_direction', ...guard(state), direction_id: '1'.repeat(32) });
  state = await stateFor(newer.sha256, 's03');
  assert.equal(state.displayed_frame, 302);
  assert.equal(hash(brief), briefHash);
  checkpoints.noteReturnsToItsOriginalFrame = true;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    result: 'passed', profile, buildCommit: session.build_commit, checkpoints
  }, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'passed', profile, checkpoints }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await stop();
  for (const child of children) if (child.exitCode === null) child.kill();
});
