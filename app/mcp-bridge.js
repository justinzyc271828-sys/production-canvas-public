'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const rendererActions = new Set(['state', 'select_view', 'seek_frame', 'navigate_shot', 'play', 'pause',
  'open_direction', 'save_direction', 'jump_to_direction']);
const commands = ['status', 'list_projects', 'open_project', 'import_project',
  ...rendererActions, 'capture_frame'];
const allowedFields = new Set(['command', 'project_id', 'expected_revision', 'expected_video_sha256',
  'view', 'frame', 'shot', 'shot_id', 'track', 'clip', 'text', 'operation_id', 'direction_id', 'manifest_path']);

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function createBridge(options) {
  const token = randomBytes(32).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const origin = options.origin;
  const descriptor = {
    schema: 'production-canvas/mcp-session/v1', instance_id: instanceId,
    pid: process.pid, origin, token, profile: options.profile,
    version: options.version, build_commit: options.buildCommit || null,
    started_at: new Date().toISOString(), capabilities: commands,
  };
  const sessionFile = path.join(options.registry, instanceId + '.json');
  let queue = Promise.resolve();

  function safeDescriptor() {
    const { token: _secret, ...safe } = descriptor;
    return safe;
  }

  function authorize(req, url) {
    const supplied = req.headers['x-canvas-mcp'];
    if (url.origin !== origin || req.headers.host !== new URL(origin).host || typeof supplied !== 'string' ||
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      throw failure('unauthorized', 'A valid local MCP session is required', 403);
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      throw failure('invalid_origin', 'MCP request origin does not match this session', 403);
    }
  }

  async function renderer(command) {
    const target = options.getWindow();
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
      throw failure('window_closed', 'The review window is closed', 409);
    }
    const payload = { ...command, action: command.command };
    const source = `(async () => {
      const until = Date.now() + 8000;
      while (typeof window.productionCanvasMcp !== 'function') {
        if (Date.now() >= until) return { __mcp_error: 'renderer_not_ready', message: 'The review controls are not ready' };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      try { return await window.productionCanvasMcp(${JSON.stringify(payload)}); }
      catch (error) { return { __mcp_error: error.code || 'renderer_error', message: error.message }; }
    })()`;
    const result = await target.webContents.executeJavaScript(source, true);
    if (result?.__mcp_error) throw failure(result.__mcp_error, result.message, 409);
    return result;
  }

  async function requireNoDraft() {
    const state = await renderer({ command: 'state' });
    if (state?.unsaved_direction || state?.quick_note?.has_text || state?.quick_note?.saving) {
      throw failure('unsaved_direction', 'Save or close the open direction before changing projects', 409);
    }
  }

  function imports(manifestPath) {
    if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath) ||
        path.extname(manifestPath).toLowerCase() !== '.json') {
      throw failure('invalid_manifest', 'An absolute local JSON manifest path is required');
    }
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw failure('invalid_manifest', 'The manifest must be a JSON file no larger than 1 MB');
    }
    const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!document || Array.isArray(document) || typeof document !== 'object') {
      throw failure('invalid_manifest', 'The manifest must contain a JSON object');
    }
    if (document.schema === 'production-canvas/v1') {
      const id = 'local-' + randomBytes(4).toString('hex');
      return { [id]: options.validateBinding(id, {
        root: path.dirname(manifestPath), manifest: path.basename(manifestPath),
      }) };
    }
    if (Object.keys(document).some(key => key !== 'projects') || !document.projects ||
        Array.isArray(document.projects) || typeof document.projects !== 'object') {
      throw failure('invalid_manifest', 'MCP imports accept project bindings only, without executable tool configuration');
    }
    const base = path.dirname(path.dirname(manifestPath));
    const result = {};
    for (const [id, binding] of Object.entries(document.projects)) {
      if (!binding || typeof binding.root !== 'string') {
        throw failure('invalid_binding', 'Each project binding requires a root');
      }
      result[id] = options.validateBinding(id, { ...binding, root: path.resolve(base, binding.root) });
    }
    if (!Object.keys(result).length) throw failure('invalid_manifest', 'The import contains no projects');
    return result;
  }

  function validateCommand(command) {
    if (!command || Array.isArray(command) || typeof command !== 'object' ||
        !commands.includes(command.command)) {
      throw failure('unknown_command', 'The requested MCP command is unavailable');
    }
    if (Object.keys(command).some(key => !allowedFields.has(key))) {
      throw failure('invalid_parameters', 'The command contains unsupported fields');
    }
  }

  async function execute(command) {
    validateCommand(command);
    if (command.command === 'status') return { ...safeDescriptor(), state: await renderer({ command: 'state' }) };
    if (command.command === 'list_projects') return options.listProjects();
    if (command.command === 'open_project') {
      await requireNoDraft();
      if (typeof command.project_id !== 'string' ||
          !options.listProjects().some(item => item.id === command.project_id)) {
        throw failure('unknown_project', 'The project is not registered', 404);
      }
      await options.openProject(command.project_id);
      return renderer({ command: 'state' });
    }
    if (command.command === 'import_project') {
      const bindings = imports(command.manifest_path);
      await requireNoDraft();
      await options.importProjects(bindings);
      return { projects: options.listProjects(), state: await renderer({ command: 'state' }) };
    }
    if (command.command === 'capture_frame') {
      const state = await renderer({ command: 'state' });
      if (command.project_id !== state.project_id || command.expected_revision !== state.revision ||
          command.expected_video_sha256 !== state.video_sha256) {
        throw failure('stale_identity', 'The active project or media version changed', 409);
      }
      const image = await options.getWindow().webContents.capturePage();
      const after = await renderer({ command: 'state' });
      if (state.project_id !== after.project_id || state.revision !== after.revision ||
          state.video_sha256 !== after.video_sha256 || state.displayed_frame !== after.displayed_frame) {
        throw failure('frame_changed', 'Pause playback before capturing an exact frame', 409);
      }
      return { png_base64: image.toPNG().toString('base64'), mime_type: 'image/png', state };
    }
    if (command.command !== 'state') {
      if (typeof command.project_id !== 'string' || !/^[a-f0-9]{64}$/.test(command.expected_revision || '') ||
          !/^[a-f0-9]{64}$/.test(command.expected_video_sha256 || '')) {
        throw failure('identity_required', 'Project, timeline revision and video SHA-256 are required', 409);
      }
    }
    const result = await renderer(command);
    if (command.command === 'play') {
      const window = options.getWindow();
      if (window.isMinimized?.()) window.restore();
      window.show?.();
      window.focus?.();
    }
    return result;
  }

  function enqueue(command) {
    const deadline = Date.now() + 20000;
    const running = queue.then(() => {
      if (Date.now() >= deadline) throw failure('command_expired',
        'The queued command expired without executing', 504);
      return execute(command);
    });
    queue = running.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('command_timeout',
        'The command has not completed. Read state before retrying a mutation.', 504)), 20000);
    });
    return Promise.race([running, timeout]).finally(() => clearTimeout(timer));
  }

  async function handle(req, res, url, reply, readBody) {
    if (!['/api/mcp/status', '/api/mcp/command'].includes(url.pathname)) return false;
    try {
      authorize(req, url);
      if (url.search) throw failure('invalid_parameters', 'MCP routes do not accept query parameters');
      if (url.pathname === '/api/mcp/status' && req.method === 'GET') {
        reply(res, 200, await enqueue({ command: 'status' }));
      } else if (url.pathname === '/api/mcp/command' && req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          throw failure('invalid_content_type', 'Use a JSON request body', 415);
        }
        reply(res, 200, await enqueue(await readBody(req)));
      } else throw failure('method_not_allowed', 'The request method is unavailable', 405);
    } catch (error) {
      reply(res, error.status || 400, { error: error.message, code: error.code || 'command_failed' });
    }
    return true;
  }

  function publish() {
    fs.mkdirSync(options.registry, { recursive: true, mode: 0o700 });
    const temporary = sessionFile + '.pending';
    fs.writeFileSync(temporary, JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, sessionFile);
    return safeDescriptor();
  }

  function close() {
    if (!fs.existsSync(sessionFile)) return;
    try {
      const current = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      if (current.instance_id === instanceId && current.pid === process.pid && current.token === token) {
        fs.unlinkSync(sessionFile);
      }
    } catch { /* A replaced or incomplete descriptor belongs to another writer. */ }
  }

  return { handle, publish, close };
}

module.exports = { createBridge };
