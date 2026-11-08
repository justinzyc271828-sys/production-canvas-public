'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = () => performance.timeOrigin + performance.now();

async function until(callback, budget = 15000, pause = 25) {
  const limit = Date.now() + budget;
  let last;
  do {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(pause);
  } while (Date.now() < limit);
  throw Error('Timed out' + (last ? ': ' + last.message : ''));
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function settings(profile, projectRoot) {
  fs.mkdirSync(profile, { recursive: true });
  const projects = projectRoot ? { fixture: { root: projectRoot, manifest: 'project.json', title: 'Verification fixture' } } : {};
  fs.writeFileSync(path.join(profile, 'canvas-settings.json'), JSON.stringify({ projects, tools: {}, active: projectRoot ? 'fixture' : 'demo' }));
}

async function launch({ kind, executable, profile, registry = path.join(profile, 'sessions'), file, runtime, debug = true, benchmark = false, language = 'en', environment = {} }) {
  const port = debug ? await unusedPort() : null;
  const flags = ['--profile=' + profile];
  const timingFlags = benchmark ? ['--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'] : [];
  const env = { ...process.env, ...environment, PRODUCTION_CANVAS_MCP_REGISTRY: registry };
  if (kind === 'electron') {
    flags.push(...timingFlags);
    if (port) flags.push('--remote-debugging-port=' + port);
  } else if (kind === 'rust') {
    flags.push('--language=' + language);
    if (runtime) flags.push('--runtime=' + runtime);
    const browser = [...timingFlags];
    if (port) browser.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port);
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = browser.join(' ');
  } else throw Error('Unknown application ' + kind);
  if (file) flags.push(file);
  const started = clock();
  const child = spawn(executable, flags, { windowsHide: true, stdio: 'ignore', env });
  await once(child, 'spawn');
  return { kind, executable, process: child, profile, registry, port, started };
}

function session(app) {
  if (app.descriptor) return app.descriptor;
  if (!fs.existsSync(app.registry)) return null;
  for (const name of fs.readdirSync(app.registry)) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const row = JSON.parse(fs.readFileSync(path.join(app.registry, name), 'utf8'));
    if (path.relative(row.profile, app.profile) === '' && /^http:\/\/127\.0\.0\.1:\d+$/.test(row.origin)) {
      app.descriptor = row;
      return row;
    }
  }
  return null;
}

async function command(app, name, fields = {}, { unauthorized = false } = {}) {
  const row = await until(() => session(app));
  const headers = { 'Content-Type': 'application/json' };
  if (!unauthorized) headers['X-Canvas-MCP'] = row.token;
  const response = await fetch(row.origin + '/api/mcp/command', {
    method: 'POST', headers, body: JSON.stringify({ command: name, ...fields }), signal: AbortSignal.timeout(22000)
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value.error), { code: value.code, status: response.status });
  return value;
}

function identity(state) {
  return { project_id: state.project_id, expected_revision: state.revision, expected_video_sha256: state.video_sha256 };
}

async function connect(app, select = url => url.includes('/canvas/')) {
  const target = await until(async () => {
    const descriptor = session(app);
    if (!descriptor) return null;
    const targets = await fetch('http://127.0.0.1:' + app.port + '/json/list', { signal: AbortSignal.timeout(250) }).then(response => response.json());
    return targets.find(target => target.type === 'page' && target.url.startsWith(descriptor.origin + '/') && select(target.url));
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await until(() => socket.readyState === WebSocket.OPEN, 5000);
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const action = pending.get(result.id);
    if (!action) return;
    pending.delete(result.id);
    clearTimeout(action.timer);
    if (result.error) action.reject(Error(result.error.message));
    else action.resolve(result.result);
  });
  return {
    async evaluate(fn, args = [], timeout = 20000) {
      const id = ++next;
      const expression = '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')';
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Browser evaluation timed out')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close: () => socket.close()
  };
}

async function stop(app) {
  const exited = () => app.process.exitCode !== null || app.process.signalCode !== null;
  if (exited()) return;
  const pid = app.kind === 'electron' ? session(app)?.pid : app.process.pid;
  if (Number.isSafeInteger(pid) && pid > 0) {
    const closer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }'],
    { windowsHide: true, stdio: 'ignore' });
    await once(closer, 'exit');
  }
  try {
    await until(exited, 2500);
  } catch {
    if (app.kind === 'electron' && pid) {
      try { process.kill(pid); } catch { /* Already stopped. */ }
    }
    if (!exited()) app.process.kill();
    await until(exited, 3500);
  }
}

function cleanScratch(root, parentDirectory = require('node:os').tmpdir()) {
  const resolved = fs.realpathSync(root);
  const parent = fs.realpathSync(parentDirectory);
  assert.equal(path.dirname(resolved), parent);
  assert.match(path.basename(resolved), /^canvas-pilot-/);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

module.exports = { launch, settings, session, command, identity, connect, stop, until, delay, cleanScratch };
