'use strict';

const { app, BrowserWindow, WebContentsView, Menu, dialog, session, desktopCapturer, nativeImage } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { buildCommit = null } = require('../package.json');
const canvas = require('./canvas');
const { createBridge } = require('./mcp-bridge');
const { loadProject, videoArgument, findVideoProject, schema: projectSchema } = require('./project');

app.setName('Production Canvas');
app.commandLine.appendSwitch('lang', 'en-US');
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const verifyOutput = argument('verify');
const verifyCapture = argument('capture');
const captureDir = argument('capture-dir');
const verifyWrite = argument('verify-write') === 'isolated-copy';
const profile = argument('profile');
if (profile) {
  fs.mkdirSync(path.resolve(profile), { recursive: true });
  app.setPath('userData', path.resolve(profile));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'ProductionCanvasEnglishPreview'));
}
const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const data = app.getPath('userData');
const settingsPath = path.join(data, 'canvas-settings.json');
const toolsPath = path.join(data, 'canvas-tools.json');
const appToken = randomBytes(32).toString('hex');
let settings;
let mainWindow;
let listener;
let origin;
let comfyView;
let comfyProject;
let mcpBridge;
const comfyOrigin = 'http://127.0.0.1:8188';

const mime = {
  'index.html': 'text/html; charset=utf-8', 'canvas.css': 'text/css; charset=utf-8',
  'canvas-ui.js': 'text/javascript; charset=utf-8', 'review-timeline.js': 'text/javascript; charset=utf-8',
  'note-location.js': 'text/javascript; charset=utf-8',
  'film-paper.webp': 'image/webp', 'studio-mark.png': 'image/png'
};

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = file + '.pending';
  fs.writeFileSync(pending, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(pending, file);
}

function initializeDemo() {
  const previous = path.join(data, 'sample-project-illustrated');
  if (fs.existsSync(path.join(previous, 'current-manifest.json'))) {
    settings.projects['demo-v1'] = { title: 'Earlier sample and annotations', root: previous, manifest: 'current-manifest.json', demo: true };
  }
  const root = path.join(data, 'sample-project-v2');
  if (!fs.existsSync(path.join(root, 'project.json'))) {
    const stage = fs.mkdtempSync(path.join(data, 'sample-staging-'));
    fs.cpSync(path.join(resources, 'demo'), stage, { recursive: true });
    fs.renameSync(stage, root);
  }
  return { title: 'Frame Annotation Lab', root, manifest: 'project.json', demo: true };
}

function validateBinding(id, binding) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || id === 'demo') throw new Error('Invalid project ID');
  const loaded = loadProject(binding);
  return { title: loaded.title, root: loaded.dir, manifest: loaded.manifestName };
}

function importWorkbench(file) {
  const document = read(file);
  if (document.schema === projectSchema) {
    const id = 'local-' + randomBytes(4).toString('hex');
    settings.projects[id] = validateBinding(id, { root: path.dirname(path.resolve(file)), manifest: path.basename(file) });
    settings.active = id;
    return;
  }
  const base = path.dirname(path.dirname(path.resolve(file)));
  for (const [id, binding] of Object.entries(document.projects || {})) {
    settings.projects[id] = validateBinding(id, { ...binding, root: path.resolve(base, binding.root) });
    settings.active = id;
  }
  const tools = {};
  if (typeof document.python === 'string' && path.isAbsolute(document.python)) tools.python = document.python;
  for (const name of ['kdenlive', 'comfy']) {
    const tool = document[name];
    if (!tool || typeof tool.command !== 'string' || !path.isAbsolute(tool.command)) continue;
    const entry = { command: tool.command };
    if (tool.cwd && path.isAbsolute(tool.cwd)) entry.cwd = tool.cwd;
    if (Array.isArray(tool.args) && tool.args.every(arg => typeof arg === 'string')) entry.args = tool.args;
    if (name === 'comfy') {
      const keys = ['COMFY_BIN', 'COMFY_NO_TELEMETRY', 'DO_NOT_TRACK', 'PYTHONUTF8', 'PYTHONIOENCODING'];
      entry.env = Object.fromEntries(keys.filter(key => typeof tool.env?.[key] === 'string').map(key => [key, tool.env[key]]));
      entry.env.COMFY_LOCAL_URL = 'http://127.0.0.1:8188';
    }
    tools[name] = entry;
  }
  if (Object.keys(tools).length) settings.tools = tools;
}

function applySettings(demo) {
  save(settingsPath, settings);
  save(toolsPath, settings.tools);
  canvas.configure({
    ...settings.tools, toolFile: toolsPath,
    worker: app.isPackaged ? path.join(resources, 'worker/canvas-worker.py') : path.join(__dirname, 'canvas-worker.py'),
    projects: { ...settings.projects, demo }
  });
}

function reply(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(encoded), 'X-Content-Type-Options': 'nosniff' });
  res.end(encoded);
}

async function readBody(req) {
  let length = 0;
  const buffers = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw Object.assign(new Error('Request exceeds 1 MB'), { status: 413 });
    buffers.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(buffers).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
  return value;
}

async function startServer() {
  listener = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (mcpBridge && await mcpBridge.handle(req, res, url, reply, readBody)) return;
      if (req.headers['x-canvas-desktop'] !== appToken || req.headers.host !== new URL(origin).host) {
        return reply(res, 403, { error: 'Access requires a desktop application session' });
      }
      if (url.origin !== origin) return reply(res, 403, { error: 'Unknown local address' });
      if (url.pathname === '/desktop/project-menu' && req.method === 'POST' && req.headers.origin === origin) {
        Menu.getApplicationMenu()?.items[0]?.submenu?.popup({ window: mainWindow });
        return reply(res, 200, { open: true });
      }
      if (url.pathname === '/desktop/review-selection' && req.method === 'POST' && req.headers.origin === origin) {
        const { project, view } = await readBody(req);
        if (typeof project !== 'string' || (project !== 'demo' && !Object.hasOwn(settings.projects, project)) ||
            !['s03', 'opening', 'battle'].includes(view)) {
          return reply(res, 400, { error: 'Invalid review project or version' });
        }
        const state = await mainWindow.webContents.executeJavaScript('mcpReviewState()');
        if (state.project_id !== project || state.current_view !== view) return reply(res, 200, { saved: false });
        if (settings.active !== project || settings.review?.project !== project || settings.review?.view !== view) {
          settings.active = project;
          settings.review = { project, view };
          save(settingsPath, settings);
        }
        return reply(res, 200, { saved: true });
      }
      if (url.pathname === '/desktop/comfy' && req.method === 'POST' && req.headers.origin === origin) {
        const { project, node } = await readBody(req);
        return reply(res, 200, await showComfy(project, node));
      }
      if (url.pathname.startsWith('/api/canvas/')) return await canvas.handle(req, res, url, reply, readBody);
      const file = url.pathname === '/canvas/' ? 'index.html' : url.pathname.slice('/canvas/'.length);
      if (!url.pathname.startsWith('/canvas/') || !Object.hasOwn(mime, file) || req.method !== 'GET') {
        return reply(res, 404, { error: 'Page not found' });
      }
      const body = fs.readFileSync(path.join(__dirname, 'public', file));
      res.writeHead(200, { 'Content-Type': mime[file], 'Content-Length': body.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(body);
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || 400, { error: error.message });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + listener.address().port;
}

function safeUrl(url) {
  try {
    const target = new URL(url);
    return target.origin === origin && (target.pathname === '/canvas/' || target.pathname.startsWith('/api/canvas/'));
  } catch {
    return false;
  }
}

function protect(contents) {
  contents.on('will-navigate', (event, target) => { if (!safeUrl(target)) event.preventDefault(); });
  contents.on('will-redirect', (event, target) => { if (!safeUrl(target)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => safeUrl(url) ? {
    action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }
  } : { action: 'deny' });
}

function resizeComfy() {
  if (!comfyView) return;
  const { width, height } = mainWindow.getContentBounds();
  comfyView.setBounds({ x: 0, y: 84, width, height: height - 84 });
}

async function centerComfyNode(view, node) {
  if (!Number.isSafeInteger(node) || node < 1) return;
  const source = function (id) {
    const app = window.comfyAPI?.app?.app;
    const target = app?.rootGraph?.getNodeById(id);
    const canvas = app?.canvas;
    if (!target || !canvas) return;
    if (typeof canvas.centerOnNode === 'function') canvas.centerOnNode(target);
    else if (canvas.ds) {
      canvas.ds.offset[0] = canvas.canvas.width / (2 * canvas.ds.scale) - target.pos[0] - target.size[0] / 2;
      canvas.ds.offset[1] = canvas.canvas.height / (2 * canvas.ds.scale) - target.pos[1] - target.size[1] / 2;
      canvas.setDirty(true, true);
    }
  };
  await view.webContents.executeJavaScript('(' + source.toString() + ')(' + node + ')');
}

async function showComfy(id, node) {
  if (!id) {
    comfyView?.setVisible(false);
    mainWindow.webContents.focus();
    return { open: false };
  }
  if (comfyView && comfyProject === id) {
    await centerComfyNode(comfyView, node);
    comfyView.setVisible(true);
    comfyView.webContents.focus();
    return { open: true };
  }
  const record = canvas.comfyWorkflow(id);
  const url = comfyOrigin + '/api/userdata/' + encodeURIComponent('workflows/' + record.filename);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }).catch(() => {
    throw new Error('Local ComfyUI is unavailable. Start it and try again.');
  });
  if (!response.ok) throw new Error('The project workspace was not found in ComfyUI');
  const graph = await response.json().catch(() => {
    throw new Error('Local ComfyUI could not read the workflow. Check the service and try again.');
  });
  if (graph.id !== record.id || !Array.isArray(graph.nodes)) throw new Error('The ComfyUI workspace does not match the project manifest');

  if (comfyView) {
    mainWindow.contentView.removeChildView(comfyView);
    comfyView.webContents.close();
  }
  comfyProject = null;
  const comfySession = session.fromPartition('production-comfy-inspection');
  comfySession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  comfySession.setPermissionCheckHandler(() => false);
  comfySession.webRequest.onBeforeRequest((details, done) => {
    const target = new URL(details.url);
    const local = target.origin === comfyOrigin || target.origin === comfyOrigin.replace('http:', 'ws:');
    done({ cancel: !local || !['GET', 'HEAD'].includes(details.method) });
  });
  const view = new WebContentsView({
    webPreferences: { session: comfySession, sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  comfyView = view;
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.key === '1') {
      event.preventDefault();
      void mainWindow.webContents.executeJavaScript("document.querySelector('#return-review').click()");
    }
  });
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const eventName of ['will-navigate', 'will-redirect']) {
    view.webContents.on(eventName, (event, target) => {
      if (new URL(target).origin !== comfyOrigin) event.preventDefault();
    });
  }
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  resizeComfy();
  try {
    await view.webContents.loadURL(comfyOrigin);
    const loaded = await view.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 150));
      const until = Date.now() + 18000;
      let app;
      while (Date.now() < until) {
        app = window.comfyAPI?.app?.app;
        if (app?.canvas && app.rootGraph && typeof app.loadGraphData === 'function' &&
          !document.getElementById('splash-loader')?.getClientRects().length) break;
        await wait();
      }
      if (!app?.canvas || document.getElementById('splash-loader')?.getClientRects().length) {
        throw Error('ComfyUI workspace load timed out');
      }
      const graph = ${JSON.stringify(graph)};
      await app.loadGraphData(graph);
      return { id: app.rootGraph.id, nodes: app.rootGraph._nodes.length };
    })()`);
    if (loaded.id !== record.id || loaded.nodes !== graph.nodes.length) throw new Error('Loaded ComfyUI nodes do not match the saved project');
    await centerComfyNode(view, node);
    comfyProject = id;
    view.setVisible(true);
    view.webContents.focus();
    return { open: true, nodes: loaded.nodes, revision: graph.revision };
  } catch (error) {
    mainWindow.contentView.removeChildView(view);
    view.webContents.close();
    comfyView = null;
    throw error;
  }
}

async function selectVideo(file, demo) {
  const projects = { ...settings.projects, demo };
  const registered = Object.entries(projects).sort(([a], [b]) =>
    Number(b === settings.active) - Number(a === settings.active));
  const target = findVideoProject(file, registered);
  if (mainWindow && await mainWindow.webContents.executeJavaScript(
    'typeof mcpReviewState === "function" && mcpReviewState().unsaved_direction'
  )) throw new Error('Save or discard the current annotation before reopening the video.');
  const id = target.id ?? 'local-' + randomBytes(4).toString('hex');
  if (!target.id) settings.projects[id] = target.binding;
  settings.active = id;
  return target.view;
}

async function showProject(view) {
  comfyView?.setVisible(false);
  const query = new URLSearchParams({ project: settings.active || 'demo' });
  if (!view && settings.review?.project === settings.active) view = settings.review.view;
  if (view) query.set('view', view);
  await mainWindow.loadURL(origin + '/canvas/?' + query);
}

function makeMenu(demo) {
  const withPicker = (options, apply) => async () => {
    try {
      const pick = await dialog.showOpenDialog(mainWindow, options);
      if (pick.canceled) return;
      const view = await apply(pick.filePaths[0]);
      applySettings(demo);
      await showProject(view);
    } catch (error) {
      dialog.showErrorBox('Unable to open project', error.message);
    }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Project', submenu: [
      { label: 'Open sample', click: () => { settings.active = 'demo'; applySettings(demo); void showProject(); } },
      { label: 'Open review video...', click: withPicker({ properties: ['openFile'], filters: [{ name: 'Review video', extensions: ['mp4'] }] },
        file => selectVideo(file, demo)) },
      { label: 'Open local film folder...', click: withPicker({ properties: ['openDirectory'] }, root => {
        const id = 'local-' + randomBytes(4).toString('hex');
        settings.projects[id] = validateBinding(id, { root });
        settings.active = id;
      }) },
      { label: 'Open project manifest...', click: withPicker({ properties: ['openFile'], filters: [{ name: 'Project manifest', extensions: ['json'] }] }, importWorkbench) },
      { label: 'Import project and local tool settings...', click: withPicker({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }, importWorkbench) },
      { type: 'separator' }, { role: 'quit', label: 'Quit' }
    ] },
    { label: 'View', submenu: [{ role: 'reload', label: 'Reload canvas' }, { role: 'togglefullscreen', label: 'Fullscreen' }] },
    { label: 'Edit', submenu: [
      { role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' },
      { type: 'separator' }, { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
      { role: 'selectAll', label: 'Select all' }
    ] }
  ]));
}

async function verify() {
  const contents = mainWindow.webContents;
  const evaluate = (fn, arg = null) => contents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);
  const assert = (value, label) => { if (!value) throw Error(label); };
  const captureModes = {};
  const capture = async (name, native = false) => {
    if (!captureDir && !(verifyCapture && name === 'review')) return;
    const destination = captureDir ? path.join(path.resolve(captureDir), name + '.png') : path.resolve(verifyCapture);
    if (captureDir) fs.mkdirSync(path.resolve(captureDir), { recursive: true });
    let image;
    if (native) {
      const size = mainWindow.getBounds();
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: size.width, height: size.height } });
        image = sources.find(item => item.id === mainWindow.getMediaSourceId())?.thumbnail;
      } catch (error) {
        console.warn('Native window capture failed:', error.message);
      }
    }
    captureModes[name] = image && !image.isEmpty() ? 'native-window' : 'window-content';
    if (captureModes[name] === 'window-content') {
      image = await contents.capturePage();
      if (name === 'comfy' && comfyView) {
        const child = await comfyView.webContents.capturePage();
        assert(!image.isEmpty() && !child.isEmpty(), 'ComfyUI window content screenshot unavailable');
        const { width, height } = image.getSize();
        const { x, y, width: childWidth, height: childHeight } = comfyView.getBounds();
        const windowSize = mainWindow.getContentBounds();
        const left = Math.round(x * width / windowSize.width);
        const top = Math.round(y * height / windowSize.height);
        const right = Math.min(width, Math.round((x + childWidth) * width / windowSize.width));
        const bottom = Math.min(height, Math.round((y + childHeight) * height / windowSize.height));
        const pixels = Buffer.from(image.toBitmap());
        const layer = child.resize({ width: right - left, height: bottom - top }).toBitmap();
        const stride = (right - left) * 4;
        for (let row = 0; row < bottom - top; row++) {
          layer.copy(pixels, ((top + row) * width + left) * 4, row * stride, (row + 1) * stride);
        }
        image = nativeImage.createFromBitmap(pixels, { width, height });
      }
    }
    assert(!image.isEmpty(), 'Window content screenshot unavailable');
    fs.writeFileSync(destination, image.toPNG());
    mainWindow.focus();
    contents.focus();
  };
  mainWindow.setContentSize(1280, 800);
  if (captureDir || verifyWrite) mainWindow.show();
  const layout = await evaluate(async () => {
    const wait = async predicate => {
      for (let i = 0; i < 240; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error(document.querySelector('#status').textContent || 'Review did not load');
    };
    await wait(() => typeof model !== 'undefined' && model && player?.readyState >= 2);
    if (!isTimelineView()) showSegment('s03');
    await wait(() => player?.readyState >= 2 && videoClock?.displayed != null && !videoClock.pending);
    if (model.mixUrl) await wait(() => Boolean(document.querySelector('.waveform')));
    if (model.wholeFilm) await Promise.race([thumbnailQueue, new Promise(resolve => setTimeout(resolve, 4500))]);
    const bounds = id => {
      const { x, y, width, height } = $(id).getBoundingClientRect();
      return { x, y, width, height };
    };
    return { title: model.title, width: innerWidth, height: innerHeight, duration: player.duration, fps: model.fps,
      frames: model.frames, tracks: model.tracks.map(track => ({ name: track.name, type: track.type, clips: track.clips.length })),
      viewer: bounds('player'), timeline: bounds('edit'), inspector: bounds('clip-panel'),
      noOverflow: document.documentElement.scrollWidth === innerWidth && document.documentElement.scrollHeight === innerHeight,
      placeholders: pictureClips().filter(clip => clip.placeholder).length,
      clusters: document.querySelectorAll('.cluster-button').length,
      waveform: Boolean(document.querySelector('.waveform')), chapters: chapters().length, comfyCanvas: model.comfyCanvas,
      version: versionName(), focusSeconds: model.focus ? model.focus.frames / model.fps : null,
      shortClip: pictureClips().filter(clip => clip.placeholder).sort((a, b) => (a.end - a.start) - (b.end - b.start))
        .map(clip => ({ shot: clip.shot, frame: clip.position, length: clip.end - clip.start }))[0] };
  });
  assert(layout.noOverflow && Math.abs(layout.timeline.height - 300) <= 1 && layout.inspector.width === 320, 'Standard layout failed: ' + JSON.stringify(layout));
  const outside = await fetch(origin + '/api/canvas/projects');
  assert(outside.status === 403, 'Desktop session gate failed');
  const checkpoints = {};
  checkpoints.englishInterface = await evaluate(() => {
    const text = [document.body.textContent, ...[...document.querySelectorAll('*')].flatMap(node =>
      ['title', 'aria-label', 'placeholder'].map(name => node.getAttribute(name) || ''))].join('\n');
    return document.documentElement.lang === 'en' && !/[\u3400-\u9fff]/u.test(text);
  });
  assert(checkpoints.englishInterface, 'The English sample contains non-English interface text');
  const play = await evaluate(async () => {
    const before = player.currentTime;
    $('play-toggle').click();
    for (let i = 0; i < 40 && player.currentTime <= before + .15; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const advanced = player.currentTime > before + .15;
    $('play-toggle').click();
    await pauseForNote();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { advanced, paused: player.paused };
  });
  assert(play.advanced && play.paused, 'Playback did not advance and pause');
  checkpoints.play = play;
  await capture('review', Boolean(captureDir));
  if (layout.placeholders) {
    const short = await evaluate(async () => {
      const wait = async predicate => {
        for (let i = 0; i < 150; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      throw Error('Short clip did not seek: ' + JSON.stringify({ frame: playFrame(), ready: player.readyState,
        seeking: player.seeking, target: videoClock.target, status: $('status').textContent }));
      };
      const clip = pictureClips().filter(clip => clip.placeholder).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      window.qaShortFrame = clip.position;
      [...$('inspector').querySelectorAll('.pending-shot')].find(node => node.dataset.shot === clip.shot).click();
      await wait(() => player.readyState >= 2 && !player.seeking && playFrame() === window.qaShortFrame);
      const actPixels = [...$('tracks').querySelectorAll('.edit-clip')].find(node => node.dataset.shot === clip.shot).getBoundingClientRect().width;
      $('zoom-selection').click();
      const selectedPixels = [...$('tracks').querySelectorAll('.edit-clip')].find(node => node.dataset.shot === clip.shot).getBoundingClientRect().width;
      const still = $('inspector').querySelector('img');
      await still.decode();
      return { shot: selectedClip().shot, frame: playFrame(), durationFrames: selectedClip().end - selectedClip().start,
        actPixels, selectedPixels, actualStill: still.naturalWidth > 0, viewport: { ...range } };
    });
    assert(short.shot === layout.shortClip.shot && short.frame === layout.shortClip.frame && short.durationFrames === layout.shortClip.length && short.actPixels >= 12 &&
      short.selectedPixels > short.actPixels && short.actualStill, 'Short shot selection failed');
    checkpoints.short = short;
    await capture('short-detail', Boolean(captureDir));
    await evaluate(() => zoomAct(selectedClip().position));
    await capture('short-shot', Boolean(captureDir));
    checkpoints.note = await evaluate(async write => {
      const checks = {};
      $('note-at-time').click();
      for (let i = 0; i < 100 && $('quick-note').hidden; i++) await new Promise(resolve => setTimeout(resolve, 25));
      checks.prefilled = !$('quick-note').hidden && $('inline-note-label').textContent.includes(timecode(window.qaShortFrame)) && player.paused;
      if (write) {
        const previous = new Set(model.tasks.map(task => task.id));
        const listBefore = previous.size;
        const form = $('quick-note');
        const noteText = ('isolated verification ' + 'This complete annotation must stay compact and must not obscure the timeline. '.repeat(8)).trim();
        $('inline-note').value = noteText;
        form.requestSubmit(form.querySelector('button[type=submit]'));
        for (let i = 0; i < 100 && model.tasks.length === listBefore; i++) await new Promise(resolve => setTimeout(resolve, 50));
        const note = model.tasks.find(task => !previous.has(task.id) && task.text === noteText);
        if (!note) throw Error('Note failed to save');
        const saved = await request(api('/tasks/' + note.id));
        checks.persisted = saved.anchor.frame === window.qaShortFrame && saved.anchor.view === 's03' && saved.anchor.version === versionName();
        const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
        let copiedHandoff = '';
        try {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true, value: async text => { copiedHandoff = text; }
          });
          renderTasks();
          [...document.querySelectorAll('#tasks [data-task="' + saved.id + '"] button')]
            .find(button => button.textContent === 'Copy for Codex').click();
          await Promise.resolve();
          checks.codexHandoff = copiedHandoff.includes(saved.text) &&
            copiedHandoff.includes(JSON.stringify(saved.anchor, null, 2)) &&
            copiedHandoff.includes('Current resolved location');
        } finally {
          if (clipboardDescriptor) Object.defineProperty(navigator.clipboard, 'writeText', clipboardDescriptor);
          else delete navigator.clipboard.writeText;
        }
        const marker = $('review-rows').querySelector('[data-note="' + saved.id + '"]');
        checks.timelineMarker = Boolean(marker);
        checks.compactMarker = /^\d+$/.test(marker?.textContent || '') && marker.textContent === marker.dataset.number &&
          marker.getBoundingClientRect().width <= 36;
        checks.matchingNumber = document.querySelector('#inspector [data-note="' + saved.id + '"] .note-number')?.textContent === marker.textContent;
        checks.originalTextPreserved = saved.text === noteText;
        seekFrame(window.qaShortFrame + 2);
        jumpNote(saved);
        for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== window.qaShortFrame); i++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        checks.jump = !videoClock.pending && playFrame() === window.qaShortFrame;
        checks.highlightedMarker = document.querySelector('.note-mark[data-note="' + saved.id + '"]')?.getAttribute('aria-current') === 'true';
        // Exercise the replacement against an isolated model without editing the fixture on disk.
        const original = model;
        try {
          model = structuredClone(original);
          model.revision += '-replacement';
          const replacement = selectedClip();
          replacement.bin += '-generated';
          replacement.placeholder = false;
          const location = resolveNote(saved);
          checks.replacement = location?.review === 'replacement' && location.frame === window.qaShortFrame;
          seekFrame(window.qaShortFrame + 2);
          jumpNote(saved);
          for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== window.qaShortFrame); i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          checks.replacementJump = !videoClock.pending && playFrame() === window.qaShortFrame;
          const { track, bin, sourceFrame } = saved.anchor.clip;
          const offset = Math.min(7, replacement.end - replacement.start - 1);
          const legacyFrame = window.qaShortFrame + offset;
          const legacy = { ...saved, anchor: { ...saved.anchor, frame: legacyFrame, clip: { track, bin, sourceFrame: sourceFrame + offset } } };
          const legacyLocation = resolveNote(legacy);
          jumpNote(legacy);
          for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== legacyFrame); i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          checks.legacyReplacement = legacyLocation?.review === 'replacement' && !videoClock.pending && playFrame() === legacyFrame;
          seekFrame(window.qaShortFrame);
          for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== window.qaShortFrame); i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        } finally {
          model = original;
          renderInspector();
          renderTimeline();
        }
        const previousRange = { ...range };
        try {
          model = structuredClone(original);
          const adjacent = structuredClone(saved);
          adjacent.id = 'f'.repeat(32);
          adjacent.anchor.frame += 1;
          if (adjacent.anchor.clip) {
            adjacent.anchor.clip.sourceFrame += 1;
            adjacent.anchor.clip.offset += 1;
          }
          model.tasks = [saved, adjacent];
          renderInspector();
          setRange(window.qaShortFrame - 10, laneWidth() / 20, 'custom', 1);
          let group = document.querySelector('.note-cluster');
          checks.compactCluster = group?.querySelector('.cluster-button').textContent === '2 notes' &&
            getComputedStyle(group.querySelector('.cluster-menu')).position === 'fixed';
          group.querySelector('[data-note="' + adjacent.id + '"]').click();
          for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== adjacent.anchor.frame); i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          checks.clusterJump = playFrame() === adjacent.anchor.frame;
          group = document.querySelector('.note-cluster');
          group.querySelector('.cluster-button').click();
          const markers = [...document.querySelectorAll('.note-mark')];
          checks.expandedMarkers = markers.length === 2 &&
            markers.every(mark => /^\d+$/.test(mark.textContent) && mark.textContent === mark.dataset.number &&
              mark.getBoundingClientRect().width <= 36);
          checks.highlightedAdjacent = document.querySelector('.note-mark[data-note="' + adjacent.id + '"]')?.getAttribute('aria-current') === 'true';
          const lane = document.querySelector('.notes-row .lane').getBoundingClientRect();
          checks.markersAligned = markers.every(mark => {
            const noteFrame = mark.dataset.note === saved.id ? saved.anchor.frame : adjacent.anchor.frame;
            const box = mark.getBoundingClientRect();
            return Math.abs(box.x + box.width / 2 - (lane.x + (noteFrame - range.start) * lane.width / range.span)) < 1;
          });
        } finally {
          model = original;
          range = previousRange;
          seekFrame(window.qaShortFrame);
          renderInspector();
          renderTimeline();
        }
      } else closeQuickNote();
      return checks;
    }, verifyWrite);
    assert(Object.values(checkpoints.note).every(Boolean), 'Director note check failed');
    await capture('compact-notes', Boolean(captureDir));
    if (verifyWrite) {
      mainWindow.focus();
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      checkpoints.note.spaceResumes = await evaluate(async () => {
        for (let i = 0; i < 80 && player.paused; i++) await new Promise(resolve => setTimeout(resolve, 25));
        const resumed = !player.paused && $('quick-note').hidden;
        seekFrame(window.qaShortFrame);
        for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== window.qaShortFrame); i++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return resumed && player.paused && !videoClock.pending && playFrame() === window.qaShortFrame;
      });
      assert(checkpoints.note.spaceResumes, 'Space did not resume playback after saving a note');
    }
    if (layout.comfyCanvas) {
      checkpoints.comfy = await evaluate(async () => {
        for (let i = 0; i < 80 && (player.seeking || player.readyState < 2); i++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const before = { player, frame: playFrame(), start: range.start, span: range.span, clip: selectedClip(), heightMode };
        await toggleComfy(true, before.clip.graphNode);
        window.qaReviewBefore = before;
        return { opened: document.body.dataset.view === 'comfy' && $('retry-comfy').hidden,
          graph: $('graph-info').textContent, paused: player.paused };
      });
      assert(checkpoints.comfy.opened && comfyProject === settings.active && checkpoints.comfy.paused, 'ComfyUI failed to open: ' + JSON.stringify(checkpoints.comfy));
      if (captureDir) {
        await new Promise(resolve => setTimeout(resolve, 950));
        await capture('comfy', true);
      }
      const embedded = await comfyView.webContents.executeJavaScript('({ id:window.comfyAPI.app.app.rootGraph.id, nodes:window.comfyAPI.app.app.rootGraph._nodes.length })');
      checkpoints.comfy.embedded = embedded;
      checkpoints.comfy.preserved = await evaluate(async () => {
        const before = window.qaReviewBefore;
        await toggleComfy(false);
        return document.body.dataset.view === 'review' && player === before.player && playFrame() === before.frame &&
          range.start === before.start && range.span === before.span && selectedClip() === before.clip && heightMode === before.heightMode;
      });
      assert(checkpoints.comfy.preserved, 'Review state did not survive ComfyUI round trip');
    }
    if (layout.focusSeconds) {
      checkpoints.focus = await evaluate(async () => {
        const before = playFrame();
        $('review-version').value = 'battle';
        $('review-version').dispatchEvent(new Event('change'));
        for (let i = 0; i < 100 && !(player.readyState >= 2 && !player.seeking && playFrame() === before); i++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return { duration: player.duration, frame: playFrame(), sameFrame: playFrame() === before,
          mappedFrame: model.focus.start + videoClock.displayed,
          version: versionName(), noteAvailable: !$('note-at-time').disabled };
      });
      assert(checkpoints.focus.sameFrame && Math.abs(checkpoints.focus.duration - layout.focusSeconds) < .1 && checkpoints.focus.noteAvailable,
        'Focus version did not map to the same full-film frame');
    }
  }
  checkpoints.shortcuts = [];
  for (const selector of ['#prev-frame', '#next-frame', '#prev-cut', '#next-cut', '.edit-clip', '.chapter', '[data-note]']) {
    const found = await evaluate(selector => {
      const control = document.querySelector(selector);
      if (!control) return false;
      control.focus();
      control.click();
      return true;
    }, selector);
    if (!found) continue;
    await evaluate(async () => {
      for (let i = 0; i < 120 && (player.readyState < 2 || videoClock.displayed === null || videoClock.pending); i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    });
    mainWindow.focus();
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    const playing = await evaluate(async () => {
      for (let i = 0; i < 80 && player.paused; i++) await new Promise(resolve => setTimeout(resolve, 25));
      return !player.paused;
    });
    if (!playing) {
      const state = await evaluate(() => ({ view: currentView, frame: playFrame(), ready: player.readyState,
        pending: Boolean(videoClock.pending), focus: document.activeElement?.outerHTML, status: $('status').textContent }));
      throw Error('Space did not play after ' + selector + ': ' + JSON.stringify(state));
    }
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    const paused = await evaluate(async () => {
      for (let i = 0; i < 120 && (!player.paused || videoClock.pending); i++) await new Promise(resolve => setTimeout(resolve, 25));
      return player.paused && !videoClock.pending;
    });
    assert(paused, 'Space did not pause after ' + selector);
    checkpoints.shortcuts.push({ selector, playing, paused });
  }
  checkpoints.height = await evaluate(() => {
    const height = () => $('edit').getBoundingClientRect().height;
    const scroller = $('timeline-scroll');
    const standard = height();
    const standardScroll = scroller.scrollHeight > scroller.clientHeight;
    $('collapse-tracks').click();
    const collapsed = height();
    $('expand-tracks').click();
    return { standard, standardScroll, collapsed, expanded: height(),
      tracks: $('tracks').querySelectorAll('.project-track').length,
      expandedScroll: scroller.scrollHeight > scroller.clientHeight };
  });
  assert(checkpoints.height.collapsed === 136 && Math.abs(checkpoints.height.expanded - 456) <= 1, 'Timeline height modes failed');
  assert(checkpoints.height.tracks === layout.tracks.length, 'Expanded timeline lost tracks');
  if (captureDir) await capture('expanded', true);
  if (await evaluate(() => model.demo && model.generic)) {
    checkpoints.thumbnailPixels = await evaluate(async () => {
      window.thumbnailQaRange = { ...range };
      setRange(480, 160);
      const inspect = async mode => {
        setHeight(mode);
        let thumb;
        for (let i = 0; i < 200; i++) {
          thumb = document.querySelector('[data-shot="S13"] canvas.clip-thumbnail');
          if (thumb?.dataset.frame) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!thumb?.dataset.frame) throw Error('S13 thumbnail did not render');
        const bounds = thumb.getBoundingClientRect();
        const expectedWidth = Math.min(model.video.width, Math.ceil(bounds.width * devicePixelRatio));
        const expectedHeight = Math.min(model.video.height, Math.ceil(bounds.height * devicePixelRatio));
        if (thumb.width < expectedWidth - 1 || thumb.height < expectedHeight - 1) {
          throw Error('Thumbnail is being enlarged from too few pixels');
        }
        const original = await thumbnailAt(Number(thumb.dataset.frame), model.video.width, model.video.height);
        if (!original) throw Error('Full-resolution frame is unavailable');
        const reference = document.createElement('canvas');
        reference.width = thumb.width;
        reference.height = thumb.height;
        const context = reference.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(original, 0, 0, reference.width, reference.height);
        const wanted = context.getImageData(0, 0, reference.width, reference.height).data;
        const actual = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data;
        let pictureFrame = 0;
        for (let bit = 0; bit < 10; bit++) {
          const x = Math.floor((34 + bit * 16) * thumb.width / model.video.width);
          const y = Math.floor(286 * thumb.height / model.video.height);
          if (actual[(y * thumb.width + x) * 4] > 128) pictureFrame += 2 ** bit;
        }
        if (pictureFrame !== Number(thumb.dataset.frame)) throw Error('Thumbnail contains the wrong picture frame');
        let difference = 0;
        for (let i = 0; i < actual.length; i++) difference += Math.abs(actual[i] - wanted[i]);
        const meanDifference = difference / actual.length;
        if (meanDifference > 1) throw Error('Thumbnail differs from the native-resolution frame: ' +
          JSON.stringify({ mode, frame: thumb.dataset.frame, width: thumb.width, height: thumb.height, meanDifference }));
        return { mode, frame: Number(thumb.dataset.frame), pictureFrame, width: thumb.width, height: thumb.height,
          displayWidth: bounds.width, displayHeight: bounds.height, meanDifference };
      };
      const standard = await inspect('standard');
      const expanded = await inspect('expanded');
      if (expanded.width <= standard.width) throw Error('Expanded timeline reused a smaller thumbnail');
      await thumbnailQueue;
      return { devicePixelRatio, standard, expanded };
    });
    await capture('thumbnail-detail', Boolean(captureDir));
    await evaluate(() => { range = window.thumbnailQaRange; delete window.thumbnailQaRange; renderTimeline(); });
  }
  checkpoints.narrowSizes = [];
  for (const width of [1024, 1179]) {
    mainWindow.setContentSize(width - 1, width === 1024 ? 699 : 799);
    const narrow = await evaluate(width => new Promise(resolve => {
    const check = async () => {
      if (Math.abs(innerWidth - width) > 2) return requestAnimationFrame(check);
      $('review').classList.remove('show-inspector');
      const closed = getComputedStyle($('clip-panel')).display === 'none';
      $('inspect-toggle').click();
      chooseClip(pictureTrack(), pictureClips()[0]);
      for (let i = 0; i < 120 && $('note-at-time').disabled; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await openQuickNote();
      const panel = $('clip-panel').getBoundingClientRect();
      const bar = document.querySelector('.player-bar').getBoundingClientRect();
      const reachable = element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return element === hit || element.contains(hit);
      };
      resolve({ width: innerWidth, height: innerHeight, noOverflow: document.documentElement.scrollWidth === innerWidth,
        closed, drawer: getComputedStyle($('clip-panel')).position === 'absolute' && getComputedStyle($('clip-panel')).display !== 'none',
        controlsClear: panel.bottom <= bar.top && [...document.querySelectorAll('.player-bar button')].every(reachable),
        quickNoteClear: reachable($('inline-note')) });
    };
    check();
    }), width);
    checkpoints.narrowSizes.push(narrow);
    assert(narrow.closed && narrow.drawer && narrow.noOverflow && narrow.controlsClear && narrow.quickNoteClear,
      'Narrow layout failed: ' + JSON.stringify(narrow));
    await capture('narrow-' + width, Boolean(captureDir));
    await evaluate(() => closeQuickNote());
  }
  checkpoints.narrow = checkpoints.narrowSizes[0];
  if (await evaluate(() => model.demo && model.generic)) {
    checkpoints.displayedFrames = await evaluate(async () => {
      showSegment('s03');
      const ready = async () => {
        for (let i = 0; i < 200 && (player.readyState < 2 || videoClock.displayed === null || videoClock.pending); i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (player.readyState < 2 || videoClock.displayed === null || videoClock.pending) throw Error('Sample frame did not settle');
      };
      await ready();
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
      for (let frame = 0; frame < model.frames; frame++) {
        seekFrame(frame);
        await ready();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const picture = pictureNumber();
        if (picture !== frame || playFrame() !== frame) {
          throw Error('Displayed sample frame mismatch: requested ' + frame + ', picture ' + picture + ', label ' + playFrame());
        }
      }
      for (let i = 0; i < 30; i++) {
        seekFrame(i * 19);
        await ready();
        await player.play();
        await new Promise(resolve => setTimeout(resolve, 60 + i % 5 * 13));
        await pauseForNote();
        await ready();
        const picture = pictureNumber();
        if (picture !== playFrame()) throw Error('Paused sample picture ' + picture + ' and label ' + playFrame() + ' differ');
      }
      return { scanned: model.frames, randomPauses: 30, source: 'decoded picture barcode' };
    });
  }
  if (verifyWrite && settings.projects['sample-alternate']) {
    checkpoints.projectSelection = await evaluate(async () => {
      const original = project;
      const until = async predicate => {
        for (let i = 0; i < 160; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw Error('Project selection did not settle');
      };
      const select = id => {
        $('project').value = id;
        $('project').dispatchEvent(new Event('change'));
      };
      $('brief').reset();
      await openQuickNote();
      $('inline-note').value = 'Unsaved direction must stay here';
      select('sample-alternate');
      const draftPreserved = project === original && $('project').value === original &&
        $('inline-note').value === 'Unsaved direction must stay here';
      closeQuickNote();
      select('sample-alternate');
      await until(() => project === 'sample-alternate' && mcpReviewState().ready);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { original, draftPreserved, switched: project, view: currentView };
    });
    assert(checkpoints.projectSelection.draftPreserved &&
      settings.active === 'sample-alternate' && settings.review?.project === 'sample-alternate',
    'Project selection failed to preserve the draft or persist its identity');
    const missing = await evaluate(async original => {
      const before = { project, model: model.project, source: player.src };
      let rejected = false;
      try { await boot(undefined, 'missing-project-for-verification', null); }
      catch { rejected = true; }
      const preserved = before.project === project && before.model === model.project && before.source === player.src;
      $('project').value = original;
      $('project').dispatchEvent(new Event('change'));
      for (let i = 0; i < 160 && (project !== original || !mcpReviewState().ready); i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return rejected && preserved && project === original;
    }, checkpoints.projectSelection.original);
    assert(missing, 'An unknown project silently selected another film');
    checkpoints.projectSelection.unknownProjectRejected = missing;
  }
  save(path.resolve(verifyOutput), { packaged: app.isPackaged, version: app.getVersion(), buildCommit, active: settings.active,
    localSessionGate: 'passed', layout, checkpoints, captureModes });
  app.quit();
}

const launchFiles = process.argv.slice(app.isPackaged ? 1 : 2);
const firstInstance = app.requestSingleInstanceLock({ files: launchFiles });
if (!firstInstance) app.quit();
const started = firstInstance && app.whenReady().then(async () => {
  fs.mkdirSync(data, { recursive: true });
  settings = fs.existsSync(settingsPath) ? read(settingsPath) : { projects: {}, tools: {}, active: 'demo' };
  const imported = argument('import-workbench');
  if (imported) importWorkbench(imported);
  if (!Object.hasOwn(settings.projects, settings.active)) settings.active = 'demo';
  const demo = initializeDemo();
  const launchVideo = videoArgument(launchFiles, process.cwd());
  const view = launchVideo ? await selectVideo(launchVideo, demo) : undefined;
  applySettings(demo);
  await startServer();
  const browserSession = session.fromPartition('production-canvas');
  const allowReviewFullscreen = (contents, permission, details) => permission === 'fullscreen' &&
    contents === mainWindow?.webContents && details.isMainFrame && details.requestingUrl?.startsWith(origin + '/canvas/');
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' || Boolean(allowReviewFullscreen(contents, permission, details)));
  });
  browserSession.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
    permission === 'clipboard-sanitized-write' || Boolean(allowReviewFullscreen(contents, permission, details)));
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (new URL(details.url).origin === origin) requestHeaders['X-Canvas-Desktop'] = appToken;
    callback({ requestHeaders });
  });
  mainWindow = new BrowserWindow({
    width: 1400, height: 930, minWidth: 390, minHeight: 620, autoHideMenuBar: true, show: false, title: 'Production Canvas',
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, 'public', 'studio-mark.png'),
    webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false }
  });
  protect(mainWindow.webContents);
  mainWindow.on('resize', resizeComfy);
  mainWindow.on('closed', () => {
    if (comfyView && !comfyView.webContents.isDestroyed()) comfyView.webContents.close();
  });
  mainWindow.webContents.on('did-create-window', child => protect(child.webContents));
  if (!verifyOutput) mainWindow.once('ready-to-show', () => mainWindow.show());
  makeMenu(demo);
  await showProject(view);
  mcpBridge = createBridge({
    origin, profile: data, version: app.getVersion(), buildCommit,
    registry: process.env.PRODUCTION_CANVAS_MCP_REGISTRY || path.join(app.getPath('appData'), 'ProductionCanvas', 'mcp-sessions'),
    getWindow: () => mainWindow,
    validateBinding,
    listProjects: () => Object.entries({ ...settings.projects, demo }).map(([id, value]) => ({ id, title: value.title })),
    openProject: async id => {
      settings.active = id;
      applySettings(demo);
      await showProject();
    },
    importProjects: async bindings => {
      settings.projects = { ...settings.projects, ...bindings };
      settings.active = Object.keys(bindings).at(-1);
      applySettings(demo);
      await showProject();
    },
  });
  try {
    mcpBridge.publish();
  } catch (error) {
    console.warn('Production Canvas MCP discovery unavailable: ' + error.message);
  }
  if (verifyOutput) await verify();
  return demo;
}).catch(error => {
  if (verifyOutput) {
    save(path.resolve(verifyOutput), { error: error.message, buildCommit });
    app.exit(1);
  } else {
    dialog.showErrorBox('Production Canvas could not start', error.message);
    app.quit();
  }
});

let videoOpens = Promise.resolve();
app.on('second-instance', (_event, _argv, cwd, { files = [] }) => {
  videoOpens = videoOpens.then(async () => {
    const demo = await started;
    if (!demo || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const video = videoArgument(files, cwd);
    if (!video) return;
    const view = await selectVideo(video, demo);
    applySettings(demo);
    await showProject(view);
  }).catch(error => dialog.showErrorBox('Unable to open review video', error.message));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  mcpBridge?.close();
  listener?.close();
});
