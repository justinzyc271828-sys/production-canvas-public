'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { randomBytes } = require('node:crypto');
const canvas = require('./canvas');
const { createBridge } = require('./mcp-bridge');
const { initializeDemo, localTools } = require('./desktop-support');
const { comfyOrigin, readGraph, centerNodeScript, loadGraphScript } = require('./comfy-inspection');
const { findVideoProject, loadProject, read, schema } = require('./project');

const profile = process.env.CANVAS_PROFILE;
const settingsPath = path.join(profile, 'canvas-settings.json');
const toolsPath = path.join(profile, 'canvas-tools.json');
const launchPath = path.join(profile, 'tauri-launch.json');
const initialFile = process.env.CANVAS_OPEN_FILE;
const resources = path.join(__dirname, '..');
const registry = process.env.PRODUCTION_CANVAS_MCP_REGISTRY ||
  path.join(process.env.APPDATA, 'ProductionCanvas', 'mcp-sessions');
const inspectionOrigin = process.env.CANVAS_COMFY_INSPECTION_ORIGIN || comfyOrigin;
if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(inspectionOrigin) || !new URL(inspectionOrigin).port) {
  throw Error('ComfyUI inspection requires a literal IPv4 loopback origin and port');
}
const zh = process.env.CANVAS_LANGUAGE === 'zh-CN';
const label = (en, cn) => zh ? cn : en;
const desktopToken = randomBytes(32).toString('hex');
const launchToken = randomBytes(32).toString('hex');
const pending = new Map();
let origin, settings, demo, bridge, comfyProject;
let page = Promise.withResolvers();

const staticFiles = {
  'index.html': 'text/html; charset=utf-8',
  'canvas.css': 'text/css; charset=utf-8',
  'canvas-ui.js': 'text/javascript; charset=utf-8',
  'review-timeline.js': 'text/javascript; charset=utf-8',
  'note-location.js': 'text/javascript; charset=utf-8',
  'film-paper.webp': 'image/webp',
  'studio-mark.png': 'image/png'
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function finishHost({ id, value, error }) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  if (error) request.reject(new Error(error));
  else request.resolve(value);
}

function callHost(type, fields = {}, timeout = 16000) {
  return new Promise((resolve, reject) => {
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => finishHost({ id, error: label('Desktop operation timed out', '桌面操作超时') }), timeout);
    pending.set(id, { resolve, reject, timer });
    send({ type, id, ...fields });
  });
}

async function evaluate(script) {
  let timer;
  try {
    await Promise.race([page.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label('Review page is unavailable', '审片页面尚未就绪'))), 12000);
    })]);
  } finally { clearTimeout(timer); }
  return callHost('evaluate', { script });
}

const state = () => evaluate('typeof mcpReviewState === "function" ? mcpReviewState() : { ready: false }');

function save(file, data) {
  const staging = file + '.pending';
  fs.writeFileSync(staging, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(staging, file);
}

const projects = () => ({ ...settings.projects, demo });

function toolSettings() {
  const tools = settings.tools || {};
  const packagedPython = process.env.CANVAS_BUNDLED_PYTHON;
  return !tools.python && packagedPython ? { ...tools, python: packagedPython } : tools;
}

function configure() {
  canvas.configure({ ...toolSettings(), projects: projects(), toolFile: toolsPath,
    worker: path.join(__dirname, 'canvas-worker.py'),
    mediaHash: file => callHost('hash', { file }, 120000) });
}

function persist() {
  save(settingsPath, settings);
  save(toolsPath, toolSettings());
}

function binding(id, value) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || id === 'demo') throw Error(label('Invalid project ID', '项目 ID 无效'));
  const loaded = loadProject(value);
  return { title: loaded.title, root: loaded.dir, manifest: loaded.manifestName };
}

function chooseFolder(root, manifest) {
  const id = 'local-' + randomBytes(4).toString('hex');
  const project = binding(id, { root, manifest });
  const already = Object.entries(projects()).find(([, value]) =>
    value.root === project.root && (value.manifest || project.manifest) === project.manifest);
  return already ? { id: already[0] } : { id, bindings: { [id]: project } };
}

function chooseManifest(file) {
  const manifest = path.basename(file);
  const document = read(file);
  if (document.schema === schema || document.active_s01_s02_revision || document.current_battle_revision) {
    return chooseFolder(path.dirname(file), manifest);
  }
  const base = path.dirname(path.dirname(path.resolve(file)));
  const entries = Object.entries(document.projects || {}).map(([id, project]) =>
    [id, binding(id, { ...project, root: path.resolve(base, project.root) })]);
  const tools = localTools(document);
  if (!entries.length && !Object.keys(tools).length) throw Error(label('No project or local tool settings found', '清单里没有项目或本地工具配置'));
  return { id: entries.at(-1)?.[0] ?? settings.active, bindings: Object.fromEntries(entries),
    ...(Object.keys(tools).length ? { tools } : {}) };
}

function chooseVideo(file) {
  const registered = Object.entries(projects()).sort(([a], [b]) =>
    Number(b === settings.active) - Number(a === settings.active));
  const target = findVideoProject(file, registered);
  if (target.id) return { id: target.id, view: target.view };
  const id = 'local-' + randomBytes(4).toString('hex');
  return { id, view: target.view, bindings: { [id]: target.binding } };
}

function chooseFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp4') return chooseVideo(file);
  if (ext === '.json') return chooseManifest(file);
  throw Error(label('Choose a project manifest or an MP4', '请选择项目清单或 MP4 审片视频'));
}

function select({ id, view, bindings, tools }) {
  if (bindings) settings.projects = { ...settings.projects, ...bindings };
  if (tools) settings.tools = tools;
  settings.active = id;
  if (view) settings.review = { project: id, view };
}

let changing = Promise.resolve();
function open(target) {
  const next = changing.then(async () => {
    await inspecting;
    const review = await state();
    if (review.unsaved_direction || review.quick_note?.saving) throw Error(label('Save or discard the current annotation first', '请先保存或放弃当前批注'));
    const previous = { projects: settings.projects, active: settings.active, review: settings.review, tools: settings.tools };
    const chosen = target();
    select(chosen);
    configure();
    try {
      const view = settings.review?.project === chosen.id ? settings.review.view : null;
      const args = [view, chosen.id, null].map(value => JSON.stringify(value)).join(',');
      await evaluate('(async () => { if (document.body.dataset.view === "comfy") await toggleComfy(false); await boot(' + args + '); })()');
    } catch (error) {
      Object.assign(settings, previous);
      configure();
      throw error;
    }
    persist();
  });
  changing = next.catch(() => {});
  return next;
}

let inspecting = Promise.resolve();
function inspectComfy(project, node) {
  const next = inspecting.then(async () => {
    if (!project) {
      await callHost('comfy-hide');
      return { open: false };
    }
    if (project !== (await state()).project_id) throw Error(label('The active project changed', '当前项目已变化'));
    const center = centerNodeScript(node);
    if (comfyProject === project) {
      if (center) await callHost('comfy-evaluate', { script: center });
      await callHost('comfy-show');
      return { open: true };
    }
    const record = canvas.comfyWorkflow(project);
    const graph = await readGraph(record, inspectionOrigin);
    comfyProject = null;
    try {
      await callHost('comfy-open', { url: inspectionOrigin }, 20000);
      const loaded = await callHost('comfy-evaluate', { script: loadGraphScript(graph) }, 24000);
      if (loaded.id !== record.id || loaded.nodes !== graph.nodes.length) {
        throw Error(label('Loaded ComfyUI nodes do not match the saved project', '加载的 ComfyUI 节点与项目记录不一致'));
      }
      if (center) await callHost('comfy-evaluate', { script: center });
      await callHost('comfy-show');
      comfyProject = project;
      return { open: true, nodes: loaded.nodes, revision: graph.revision };
    } catch (error) {
      await callHost('comfy-close').catch(() => {});
      throw error;
    }
  });
  inspecting = next.catch(() => {});
  return next;
}

function reply(res, status, data) {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(bytes);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error(label('Request is too large', '请求体过大')), { status: 413 });
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(label('Expected a JSON object', '需要 JSON 对象'));
  return value;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || req.headers.host !== url.host) return reply(res, 403, { error: 'Invalid loopback origin' });
    if (await bridge.handle(req, res, url, reply, readBody)) return;
    if (url.pathname === '/desktop/open-file' && req.method === 'POST') {
      if (req.headers['x-canvas-launch'] !== launchToken || req.headers.origin || url.search) {
        return reply(res, 403, { error: 'A local launch token is required' });
      }
      const { file } = await readBody(req);
      if (file !== undefined) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) return reply(res, 400, { error: 'Expected an absolute file path' });
        try { await open(() => chooseFile(file)); }
        catch (error) { return reply(res, 409, { error: error.message }); }
      }
      send({ type: 'show' });
      return reply(res, 200, { opened: true });
    }
    if (req.headers['x-canvas-desktop'] !== desktopToken) {
      return reply(res, 403, { error: 'Access requires a desktop application session' });
    }
    if (req.method === 'POST' && req.headers.origin !== origin) {
      return reply(res, 403, { error: 'Request origin does not match the desktop session' });
    }
    if (req.method === 'POST' && url.pathname === '/desktop/host-result') {
      finishHost(await readBody(req, 48 * 1024 * 1024));
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/desktop/project-menu') {
      send({ type: 'menu' });
      return reply(res, 200, { open: true });
    }
    if (req.method === 'POST' && url.pathname === '/desktop/review-selection') {
      const { project, view } = await readBody(req);
      if (!Object.hasOwn(projects(), project) || !['s03', 'opening', 'battle'].includes(view)) {
        return reply(res, 400, { error: label('Invalid review project or version', '无效的审片项目或版本') });
      }
      const review = await state();
      if (review.project_id !== project || review.current_view !== view) return reply(res, 200, { saved: false });
      if (settings.active !== project || settings.review?.project !== project || settings.review?.view !== view) {
        settings.active = project;
        settings.review = { project, view };
        save(settingsPath, settings);
      }
      return reply(res, 200, { saved: true });
    }
    if (req.method === 'POST' && url.pathname === '/desktop/comfy') {
      const { project, node } = await readBody(req);
      return reply(res, 200, await inspectComfy(project, node));
    }
    if (req.method === 'POST' && url.pathname === '/desktop/storyboard') {
      const { project } = await readBody(req);
      if (!Object.hasOwn(projects(), project) || project !== (await state()).project_id) {
        return reply(res, 409, { error: label('The active project changed', '当前项目已变化') });
      }
      const address = origin + '/api/canvas/projects/' + encodeURIComponent(project) + '/media/storyboard';
      await callHost('storyboard', { url: address });
      return reply(res, 200, { opened: true });
    }
    if (url.pathname.startsWith('/api/canvas/')) return await canvas.handle(req, res, url, reply, readBody);
    const file = url.pathname === '/canvas/' ? 'index.html' : url.pathname.slice('/canvas/'.length);
    if (!url.pathname.startsWith('/canvas/') || !Object.hasOwn(staticFiles, file) || req.method !== 'GET') {
      return reply(res, 404, { error: 'Page not found' });
    }
    const localized = path.join(__dirname, 'public-zh-CN', file);
    const filePath = zh && fs.existsSync(localized) ? localized : path.join(__dirname, 'public', file);
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': staticFiles[file],
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(content);
  } catch (error) {
    if (!res.headersSent) reply(res, error.status || 400, { error: error.message });
    else res.destroy();
  }
});

const nativeWindow = {
  isDestroyed: () => false,
  show: () => send({ type: 'show' }),
  webContents: {
    isDestroyed: () => false,
    executeJavaScript: evaluate,
    capturePage: async () => {
      const bytes = await callHost('capture');
      return { toPNG: () => Buffer.from(bytes, 'base64') };
    }
  }
};

function stop(code = 0) {
  bridge?.close();
  try {
    if (read(launchPath).token === launchToken) fs.unlinkSync(launchPath);
  } catch { /* The launch descriptor may not have been published. */ }
  server.closeAllConnections();
  server.close();
  process.exit(code);
}

async function dispatch() {
  const deadline = Date.now() + 12000;
  let response;
  while (Date.now() < deadline) {
    try {
      const record = read(launchPath);
      if (/^http:\/\/127\.0\.0\.1:\d+$/.test(record.origin) && /^[a-f0-9]{64}$/.test(record.token)) {
        response = await fetch(record.origin + '/desktop/open-file', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
          headers: { 'Content-Type': 'application/json', 'X-Canvas-Launch': record.token },
          body: JSON.stringify(initialFile ? { file: initialFile } : {})
        });
        break;
      }
    } catch { /* The first process may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!response) throw Error(label('The existing review window did not answer', '现有审片窗口没有响应'));
  if (!response.ok) throw Error((await response.json()).error);
}

async function start() {
  settings = fs.existsSync(settingsPath) ? read(settingsPath) : { projects: {}, tools: {}, active: 'demo' };
  demo = initializeDemo(profile, resources, settings, zh ?
    { earlier: '旧版示例与指令', sample: '示例影片 · 审片练习' } : {});
  if (initialFile) select(chooseFile(initialFile));
  if (!Object.hasOwn(projects(), settings.active)) throw Error(label('The selected project is not registered', '已选项目未登记'));
  configure();
  persist();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  const buildFile = path.join(resources, 'build.json');
  const build = fs.existsSync(buildFile) ? read(buildFile) : { version: '1.6.0-rc.1', commit: null };
  bridge = createBridge({
    origin, registry, profile, pid: Number(process.env.CANVAS_HOST_PID), version: build.version, buildCommit: build.commit,
    getWindow: () => nativeWindow,
    validateBinding: binding,
    listProjects: () => Object.entries(projects()).map(([id, value]) => ({ id, title: value.title || id })),
    openProject: id => open(() => ({ id })),
    importProjects: bindings => open(() => ({ id: Object.keys(bindings).at(-1), bindings }))
  });
  bridge.publish();
  save(launchPath, { origin, token: launchToken });
  const query = new URLSearchParams({ project: settings.active });
  if (settings.review?.project === settings.active) query.set('view', settings.review.view);
  send({ type: 'ready', origin, token: desktopToken, url: origin + '/canvas/?' + query });
}

if (process.argv[2] === '--dispatch') {
  dispatch().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on('close', () => stop());
  input.on('line', line => {
    void (async () => {
      const message = JSON.parse(line);
      switch (message.type) {
        case 'reply': finishHost(message); break;
        case 'page-ready': page.resolve(); break;
        case 'manifest':
        case 'video': await open(() => chooseFile(message.file)); break;
        case 'folder': await open(() => chooseFolder(message.file)); break;
        case 'demo': await open(() => ({ id: 'demo' })); break;
        case 'reload':
          if ((await state()).unsaved_direction) throw Error(label('Save or discard the current annotation first', '请先保存或放弃当前批注'));
          await inspectComfy(null);
          page = Promise.withResolvers();
          send({ type: 'reload' });
          break;
        case 'shutdown': stop(); break;
        default: throw Error('Unknown desktop operation');
      }
    })().catch(error => send({ type: 'error', message: error.message }));
  });
  start().catch(error => process.stderr.write(error.message + '\n', () => stop(1)));
}
