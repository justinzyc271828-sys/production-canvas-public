'use strict';

const { app, BrowserWindow, WebContentsView, Menu, dialog, session, desktopCapturer, nativeImage } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { buildCommit = null } = require('../package.json');
const canvas = require('./canvas');
const { loadProject, schema: projectSchema } = require('./project');

app.setName('Production Canvas');
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const verifyOutput = argument('verify');
const verifyCapture = argument('capture');
const captureDir = argument('capture-dir');
const verifyWrite = argument('verify-write') === 'isolated-copy';
const profile = argument('profile');
if (profile) {
  fs.mkdirSync(path.resolve(profile), { recursive: true });
  app.setPath('userData', path.resolve(profile));
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
    settings.projects['demo-v1'] = { title: '旧版示例与指令', root: previous, manifest: 'current-manifest.json', demo: true };
  }
  const root = path.join(data, 'sample-project-v2');
  if (!fs.existsSync(path.join(root, 'project.json'))) {
    const stage = fs.mkdtempSync(path.join(data, 'sample-staging-'));
    fs.cpSync(path.join(resources, 'demo'), stage, { recursive: true });
    fs.renameSync(stage, root);
  }
  return { title: '示例影片 · 审片练习', root, manifest: 'project.json', demo: true };
}

function validateBinding(id, binding) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || id === 'demo') throw new Error('项目 ID 无效');
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
    if (length > 1024 * 1024) throw Object.assign(new Error('请求超过 1 MB'), { status: 413 });
    buffers.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(buffers).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('需要 JSON 对象');
  return value;
}

async function startServer() {
  listener = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-canvas-desktop'] !== appToken || req.headers.host !== new URL(origin).host) {
        return reply(res, 403, { error: '仅桌面应用会话可访问' });
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return reply(res, 403, { error: '未知的本地地址' });
      if (url.pathname === '/desktop/project-menu' && req.method === 'POST' && req.headers.origin === origin) {
        Menu.getApplicationMenu()?.items[0]?.submenu?.popup({ window: mainWindow });
        return reply(res, 200, { open: true });
      }
      if (url.pathname === '/desktop/comfy' && req.method === 'POST' && req.headers.origin === origin) {
        const { project, node } = await readBody(req);
        return reply(res, 200, await showComfy(project, node));
      }
      if (url.pathname.startsWith('/api/canvas/')) return await canvas.handle(req, res, url, reply, readBody);
      const file = url.pathname === '/canvas/' ? 'index.html' : url.pathname.slice('/canvas/'.length);
      if (!url.pathname.startsWith('/canvas/') || !Object.hasOwn(mime, file) || req.method !== 'GET') {
        return reply(res, 404, { error: '找不到页面' });
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
    throw new Error('本机 ComfyUI 未连接。请启动 ComfyUI 后重试。');
  });
  if (!response.ok) throw new Error('ComfyUI 中找不到此项目的画布');
  const graph = await response.json().catch(() => {
    throw new Error('本机 ComfyUI 未能读取工作流文件，请检查服务后重试。');
  });
  if (graph.id !== record.id || !Array.isArray(graph.nodes)) throw new Error('ComfyUI 画布身份与项目清单不一致');

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
        throw Error('ComfyUI 画布加载超时');
      }
      const graph = ${JSON.stringify(graph)};
      await app.loadGraphData(graph);
      return { id: app.rootGraph.id, nodes: app.rootGraph._nodes.length };
    })()`);
    if (loaded.id !== record.id || loaded.nodes !== graph.nodes.length) throw new Error('ComfyUI 节点加载结果与保存工程不符');
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

async function showProject() {
  comfyView?.setVisible(false);
  const url = origin + '/canvas/?project=' + encodeURIComponent(settings.active || 'demo');
  await mainWindow.loadURL(url);
}

function makeMenu(demo) {
  const withPicker = (options, apply) => async () => {
    try {
      const pick = await dialog.showOpenDialog(mainWindow, options);
      if (pick.canceled) return;
      apply(pick.filePaths[0]);
      applySettings(demo);
      await showProject();
    } catch (error) {
      dialog.showErrorBox('无法接入', error.message);
    }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '项目', submenu: [
      { label: '打开示例', click: () => { settings.active = 'demo'; applySettings(demo); void showProject(); } },
      { label: '接入本地影片目录…', click: withPicker({ properties: ['openDirectory'] }, root => {
        const id = 'local-' + randomBytes(4).toString('hex');
        settings.projects[id] = validateBinding(id, { root });
        settings.active = id;
      }) },
      { label: '打开项目清单…', click: withPicker({ properties: ['openFile'], filters: [{ name: '项目清单', extensions: ['json'] }] }, importWorkbench) },
      { label: '导入项目与本地工具配置…', click: withPicker({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }, importWorkbench) },
      { type: 'separator' }, { role: 'quit', label: '退出' }
    ] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新画布' }, { role: 'togglefullscreen', label: '全屏' }] },
    { role: 'editMenu', label: '编辑' }
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
        $('inline-note').value = 'isolated verification';
        form.requestSubmit(form.querySelector('button[type=submit]'));
        for (let i = 0; i < 100 && model.tasks.length === listBefore; i++) await new Promise(resolve => setTimeout(resolve, 50));
        const note = model.tasks.find(task => !previous.has(task.id) && task.title === 'isolated verification');
        if (!note) throw Error('Note failed to save');
        const saved = await request(api('/tasks/' + note.id));
        checks.persisted = saved.anchor.frame === window.qaShortFrame && saved.anchor.view === 's03' && saved.anchor.version === versionName();
        checks.timelineMarker = Boolean($('review-rows').querySelector('[data-note="' + saved.id + '"]'));
        seekFrame(window.qaShortFrame + 2);
        jumpNote(saved);
        for (let i = 0; i < 100 && (videoClock.pending || playFrame() !== window.qaShortFrame); i++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        checks.jump = !videoClock.pending && playFrame() === window.qaShortFrame;
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
      } else closeQuickNote();
      return checks;
    }, verifyWrite);
    assert(Object.values(checkpoints.note).every(Boolean), 'Director note check failed');
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
  save(path.resolve(verifyOutput), { packaged: app.isPackaged, version: app.getVersion(), buildCommit, active: settings.active,
    localSessionGate: 'passed', layout, checkpoints, captureModes });
  app.quit();
}

app.whenReady().then(async () => {
  fs.mkdirSync(data, { recursive: true });
  settings = fs.existsSync(settingsPath) ? read(settingsPath) : { projects: {}, tools: {}, active: 'demo' };
  const imported = argument('import-workbench');
  if (imported) importWorkbench(imported);
  if (!Object.hasOwn(settings.projects, settings.active)) settings.active = 'demo';
  const demo = initializeDemo();
  applySettings(demo);
  await startServer();
  const browserSession = session.fromPartition('production-canvas');
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  browserSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (new URL(details.url).origin === origin) requestHeaders['X-Canvas-Desktop'] = appToken;
    callback({ requestHeaders });
  });
  mainWindow = new BrowserWindow({
    width: 1400, height: 930, minWidth: 390, minHeight: 620, autoHideMenuBar: true, show: false, title: 'Production Canvas',
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, 'public', 'studio-mark.png'),
    webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  protect(mainWindow.webContents);
  mainWindow.on('resize', resizeComfy);
  mainWindow.on('closed', () => {
    if (comfyView && !comfyView.webContents.isDestroyed()) comfyView.webContents.close();
  });
  mainWindow.webContents.on('did-create-window', child => protect(child.webContents));
  if (!verifyOutput) mainWindow.once('ready-to-show', () => mainWindow.show());
  makeMenu(demo);
  await showProject();
  if (verifyOutput) await verify();
}).catch(error => {
  if (verifyOutput) {
    save(path.resolve(verifyOutput), { error: error.message, buildCommit });
    app.exit(1);
  } else {
    dialog.showErrorBox('制作画布无法启动', error.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => listener?.close());
