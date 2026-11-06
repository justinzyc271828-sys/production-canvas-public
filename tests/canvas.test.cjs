const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const canvas = require('../app/canvas');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-api-test-'));
  fs.cpSync(path.resolve(__dirname, '../demo'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  canvas.configure({ projects: { sample: { root, manifest: 'project.json' } }, kdenlive: { command: process.execPath } });
  return root;
}
async function call(suffix = '', body, host = '127.0.0.1') {
  let result;
  const req = { method: body === undefined ? 'GET' : 'POST', headers: { host, origin: 'http://127.0.0.1', 'content-type': 'application/json' } };
  await canvas.handle(req, {}, new URL('http://127.0.0.1/api/canvas/projects/sample' + suffix),
    (_res, status, value) => { result = { status, value }; }, async () => body);
  return result;
}
function note(summary) {
  return { id: 'a'.repeat(32), title: 'Review the short shot', text: 'Keep this frame for comparison.', target: 'S06',
    route: 'direction', anchor: { frame: 302, view: 's03', version: 'sequence.mp4', revision: summary.revision, shot: 'S06',
      clip: { track: 0, bin: '6', sourceFrame: 302, offset: 2, start: 300, end: 306 } } };
}

test('generic API returns project tracks, labels, editorial rows and waveform source', async t => {
  fixture(t);
  const { value } = await call();
  assert.equal(value.generic, true);
  assert.equal(value.frames, 720);
  assert.equal(value.focus.start, 264);
  assert.equal(value.viewLabels.battle, 'Short-shot practice');
  assert.equal(value.tracks[0].clips[5].shot, 'S06');
  assert.equal(value.tracks[0].clips[5].placeholder, true);
  assert.ok(value.tracks[0].clips[5].thumbnail);
  assert.equal(value.canEdit, false);
  assert.ok(value.mixUrl);
});

test('directions persist once and conflicting retries do not overwrite the brief', async t => {
  const root = fixture(t), summary = (await call()).value;
  const brief = note(summary);
  assert.equal((await call('/tasks', brief)).status, 201);
  assert.equal((await call('/tasks', brief)).value.id, brief.id);
  const file = path.join(root, '.production-canvas/tasks', brief.id, 'brief.json');
  const before = fs.readFileSync(file);
  await assert.rejects(call('/tasks', { ...brief, text: 'A conflicting retry' }), /ID/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await call()).value.tasks[0].anchor.frame, 302);
});

test('legacy anchors load and malformed new anchor fields are rejected', async t => {
  fixture(t);
  const brief = note((await call()).value);
  brief.anchor.clip = { track: 0, bin: '6', sourceFrame: 302 };
  assert.equal((await call('/tasks', brief)).value.anchor.clip.sourceFrame, 302);
  const malformed = { ...brief, id: 'b'.repeat(32), anchor: { ...brief.anchor, clip: { ...brief.anchor.clip, offset: -1 } } };
  await assert.rejects(call('/tasks', malformed), /anchor/);
});

test('candidate files remain hash-bound and separate from the original brief', async t => {
  const root = fixture(t), brief = note((await call()).value);
  await call('/tasks', brief);
  const candidate = path.join(root, 'candidate.md');
  fs.writeFileSync(candidate, 'First candidate');
  const sha256 = createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
  const result = await call('/tasks/' + brief.id + '/result', { path: 'candidate.md', sha256, note: 'For review' });
  assert.equal(result.value.result.status, 'candidate');
  fs.writeFileSync(candidate, 'Changed bytes');
  await assert.rejects(call('/media/task-' + brief.id), /Result changed/);
});

test('placeholder review decisions persist in generic projects', async t => {
  fixture(t);
  const summary = (await call()).value;
  await call('/review-decisions', { revision: summary.revision, track: 0, clip: 5, state: 'pass' });
  assert.equal((await call()).value.decisions['0:5'], 'pass');
  await assert.rejects(call('/review-decisions', { revision: 'wrong', track: 0, clip: 5, state: 'pass' }), /revision/);
});

test('native projects reject rendering mutations and nonlocal hosts', async t => {
  fixture(t);
  const summary = (await call()).value;
  await assert.rejects(call('/edits', { revision: summary.revision, track: 0, clip: 0, operation: 'trim', start: 0, end: 20 }), /Native/);
  await assert.rejects(call('', undefined, 'example.com'), /local/);
});

test('a final mix is not displayed as the waveform of separate audio sources', async t => {
  const root = fixture(t);
  const manifestFile = path.join(root, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.timeline = 'edit/sample.kdenlive-cli.json';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const editFile = path.join(root, manifest.timeline);
  const edit = JSON.parse(fs.readFileSync(editFile));
  edit.tracks.push({ ...structuredClone(edit.tracks[1]), id: 2, name: 'Second audio source' });
  fs.writeFileSync(editFile, JSON.stringify(edit));
  const summary = (await call()).value;
  assert.equal(summary.mixUrl, null);
  assert.equal(summary.tracks.length, 3);
  assert.equal(summary.assets[0].type, 'audio');
});
