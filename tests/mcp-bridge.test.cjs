'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridge } = require('../app/mcp-bridge');

function fixture(t) {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-bridge-test-'));
  t.after(() => fs.rmSync(registry, { recursive: true, force: true }));
  const state = { ready: true, project_id: 'first', revision: 'a'.repeat(64),
    video_sha256: 'b'.repeat(64), displayed_frame: 0, quick_note: null };
  const observations = { commands: [], imports: [], captures: 0 };
  const context = { state, observations, hold: null };
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      async executeJavaScript(source, userGesture) {
        assert.equal(userGesture, true);
        const payload = /return await window\.productionCanvasMcp\((.+)\); }/.exec(source)[1];
        const command = JSON.parse(payload);
        observations.commands.push(command);
        if (context.hold) await context.hold;
        if (command.action === 'state') return { ...state };
        if (command.expected_revision !== state.revision || command.expected_video_sha256 !== state.video_sha256 ||
            command.project_id !== state.project_id) return { __mcp_error: 'version_changed', message: 'stale' };
        if (command.action === 'seek_frame') state.displayed_frame = command.frame;
        return { ...state };
      },
      async capturePage() {
        observations.captures++;
        return { toPNG: () => Buffer.from('test-png') };
      },
    },
  };
  const bridge = createBridge({ origin: 'http://127.0.0.1:4001', profile: registry,
    registry, version: '1.5.0', buildCommit: 'test-build', getWindow: () => window,
    listProjects: () => [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }],
    validateBinding: (id, binding) => {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad binding');
      return binding;
    },
    async openProject(id) { state.project_id = id; },
    async importProjects(bindings) { observations.imports.push(bindings); },
  });
  const published = bridge.publish();
  const file = path.join(registry, published.instance_id + '.json');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  t.after(() => bridge.close());
  async function request(command, overrides = {}) {
    const req = { method: command ? 'POST' : 'GET', headers: {
      host: '127.0.0.1:4001', 'x-canvas-mcp': descriptor.token, 'content-type': 'application/json',
      ...(overrides.headers || {}),
    } };
    const url = new URL(overrides.url || (command ? '/api/mcp/command' : '/api/mcp/status'), 'http://127.0.0.1:4001');
    let response;
    assert.equal(await bridge.handle(req, {}, url, (_res, status, body) => { response = { status, body }; },
      async () => command), true);
    return response;
  }
  return { ...context, context, bridge, file, descriptor, published, request };
}

test('dedicated session status omits token and descriptor has scoped identity', async t => {
  const f = fixture(t);
  assert.match(f.descriptor.token, /^[a-f0-9]{64}$/);
  assert.equal(f.descriptor.pid, process.pid);
  assert.equal(f.published.token, undefined);
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.token, undefined);
  assert.equal(result.body.state.project_id, 'first');
});

test('wrong token, host, URL origin, and Origin are rejected before UI execution', async t => {
  const f = fixture(t);
  for (const overrides of [
    { headers: { 'x-canvas-mcp': 'x'.repeat(64) } },
    { headers: { host: 'localhost:4001' } },
    { url: 'http://other.invalid/api/mcp/status' },
    { headers: { origin: 'https://other.invalid' } },
  ]) assert.equal((await f.request(null, overrides)).status, 403);
  assert.equal(f.observations.commands.length, 0);
});

test('unknown commands and executable fields cannot reach the renderer', async t => {
  const f = fixture(t);
  assert.equal((await f.request({ command: 'execute_javascript', source: 'arbitrary' })).status, 400);
  assert.equal((await f.request({ command: 'state', source: 'arbitrary' })).status, 400);
  assert.equal(f.observations.commands.length, 0);
});

test('renderer mutations and screenshots require current media identity', async t => {
  const f = fixture(t);
  assert.equal((await f.request({ command: 'seek_frame', frame: 10 })).status, 409);
  const stale = { project_id: 'first', expected_revision: 'c'.repeat(64), expected_video_sha256: 'b'.repeat(64) };
  assert.equal((await f.request({ command: 'seek_frame', frame: 10, ...stale })).body.code, 'version_changed');
  assert.equal((await f.request({ command: 'capture_frame', ...stale })).body.code, 'stale_identity');
  assert.equal(f.observations.captures, 0);
  const current = { ...stale, expected_revision: 'a'.repeat(64) };
  assert.equal((await f.request({ command: 'seek_frame', frame: 10, ...current })).body.displayed_frame, 10);
  const image = await f.request({ command: 'capture_frame', ...current });
  assert.equal(image.body.png_base64, Buffer.from('test-png').toString('base64'));
});

test('project imports cannot configure executables or overwrite an open note', async t => {
  const f = fixture(t);
  const manifest = path.join(f.descriptor.profile, 'projects.json');
  fs.writeFileSync(manifest, JSON.stringify({ projects: { third: { root: '.' } }, python: 'C:/bad.exe' }));
  assert.equal((await f.request({ command: 'import_project', manifest_path: manifest })).status, 400);
  fs.writeFileSync(manifest, JSON.stringify({ projects: { third: { root: '.' } } }));
  f.state.quick_note = { has_text: true };
  assert.equal((await f.request({ command: 'import_project', manifest_path: manifest })).body.code, 'unsaved_direction');
  assert.equal(f.observations.imports.length, 0);
  f.state.quick_note = null;
  assert.equal((await f.request({ command: 'import_project', manifest_path: manifest })).status, 200);
  assert.equal(f.observations.imports.length, 1);
  f.state.unsaved_direction = true;
  assert.equal((await f.request({ command: 'open_project', project_id: 'second' })).body.code, 'unsaved_direction');
  f.state.unsaved_direction = false;
  f.state.quick_note = { has_text: false, saving: false };
  assert.equal((await f.request({ command: 'open_project', project_id: 'second' })).status, 200);
});

test('expired queued commands never execute after the earlier operation finishes', async t => {
  const f = fixture(t);
  const nativeNow = Date.now;
  let now = nativeNow();
  Date.now = () => now;
  t.after(() => { Date.now = nativeNow; });
  let release;
  f.context.hold = new Promise(resolve => { release = resolve; });
  const first = f.request({ command: 'state' });
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.request({ command: 'seek_frame', frame: 99, project_id: 'first',
    expected_revision: 'a'.repeat(64), expected_video_sha256: 'b'.repeat(64) });
  await new Promise(resolve => setImmediate(resolve));
  now += 20001;
  release();
  assert.equal((await first).status, 200);
  assert.equal((await queued).body.code, 'command_expired');
  assert.equal(f.state.displayed_frame, 0);
  assert.equal(f.observations.commands.length, 1);
});

test('closing removes only this instance descriptor', t => {
  const f = fixture(t);
  const changed = { ...f.descriptor, token: 'c'.repeat(64) };
  fs.writeFileSync(f.file, JSON.stringify(changed));
  f.bridge.close();
  assert.equal(fs.existsSync(f.file), true);
  fs.writeFileSync(f.file, JSON.stringify(f.descriptor));
  f.bridge.close();
  assert.equal(fs.existsSync(f.file), false);
});
