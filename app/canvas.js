'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadProject, reviewVideoPaths, readTimeline, readReview, shotPattern, read, hash, inside, existing } = require('./project');

let config;

function configure(settings) {
  config = settings;
}
const idPattern = /^[a-f0-9]{32}$/;
const terminal = new Set(['completed', 'failed', 'attention']);
const crafts = {
  direction: 'Direction / storyboard', blender: 'Blender MCP', image: 'Codex imagegen',
  music: 'Suno official MCP', video: 'Runway review queue', edit: 'Kdenlive / REAPER'
};
const mediaTypes = {
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8',
  '.kdenlive': 'application/octet-stream'
};

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function revision(file) {
  return hash(fs.readFileSync(file));
}

function writeNew(file, data) {
  const temp = file + '.' + randomUUID() + '.pending';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  try {
    fs.linkSync(temp, file);
  } finally {
    fs.unlinkSync(temp);
  }
}

function project(id) {
  if (!Object.hasOwn(config.projects, id)) throw problem(404, 'Canvas project not found');
  const binding = config.projects[id];
  return { id, demo: Boolean(binding.demo), ...loadProject(binding) };
}

function folder(p, kind, id = '') {
  if (id && !idPattern.test(id)) throw problem(404, 'Record not found');
  const parent = path.join(p.store, kind);
  const target = path.join(parent, id);
  for (const item of [parent, target]) {
    if (fs.existsSync(item) && !inside(p.store, fs.realpathSync(item))) throw problem(403, 'Record is outside the project');
  }
  return target;
}

function ids(p, kind, receipt) {
  const dir = folder(p, kind);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter(row => row.isDirectory() && idPattern.test(row.name) && fs.existsSync(path.join(dir, row.name, receipt)))
    .map(row => row.name) : [];
}

function job(p, id) {
  const dir = folder(p, 'runs', id);
  const { source, scene, edits, ...request } = read(existing(dir, 'request.json'));
  const stateFile = path.join(dir, 'status.json');
  let state = fs.existsSync(stateFile) ? read(existing(dir, 'status.json')) : { status: 'queued', stage: 'start' };
  if (request.kind === 'edit' && ['running', 'attention'].includes(state.status) && state.job_path) {
    const receipt = read(existing(dir, state.job_path));
    if (receipt.state === 'completed' && receipt.full_decode === 'passed') {
      const preview = existing(dir, 'preview.mp4');
      const draft = existing(dir, 'draft.kdenlive-cli.json');
      if (path.resolve(receipt.output) !== preview || revision(draft) !== receipt.source_revision || revision(preview) !== receipt.sha256) {
        throw problem(409, 'Render file does not match its receipt');
      }
      state = { ...state, status: 'completed', stage: 'review', revision: receipt.source_revision, preview_sha256: receipt.sha256 };
    } else if (receipt.state === 'failed') {
      state = { ...state, status: 'failed', error: receipt.error || 'Rendering failed. Check the job receipt.' };
    }
  }
  if (!terminal.has(state.status) && Date.now() - Date.parse(state.updated_at || request.created) > 480_000) {
    state = { ...state, status: 'attention', error: 'Job status is stale. Check the existing receipt.' };
  }
  return { id, ...request, ...state };
}

function task(p, id) {
  const dir = folder(p, 'tasks', id);
  const brief = read(existing(dir, 'brief.json'));
  const result = fs.existsSync(path.join(dir, 'result.json')) ? read(existing(dir, 'result.json')) : null;
  if (result) result.url = '/api/canvas/projects/' + p.id + '/media/task-' + id;
  return { ...brief, result, receiptPath: path.join(dir, 'brief.json') };
}

function timeline(p, draft) {
  let source;
  if (draft) {
    const run = job(p, draft);
    if (run.kind !== 'edit' || run.status !== 'completed') throw problem(409, 'This draft has no completed render');
    source = existing(folder(p, 'runs', draft), 'draft.kdenlive-cli.json');
    if (revision(source) !== run.revision) throw problem(409, 'The draft changed externally. Check its version');
  } else if (p.review) {
    source = existing(p.dir, p.review.timeline);
  } else if (p.battle) {
    source = existing(p.dir, p.battle.working_project);
  } else {
    const native = p.manifest.active_s03_storyboard?.editable_project?.path;
    if (typeof native !== 'string' || !native.endsWith('.kdenlive')) throw problem(409, 'The manifest has no editable S03 version');
    source = existing(p.dir, native.replace(/\.kdenlive$/, '.kdenlive-cli.json'));
  }
  return readTimeline(source);
}

function videoInfo(record, root) {
  return { version: path.basename(record.path), sha256: record.sha256,
    actualSha256: root ? revision(existing(root, record.path)) : record.sha256,
    width: record.width, height: record.height, frames: record.frames };
}

function summary(p, draft) {
  const t = timeline(p, draft);
  const base = '/api/canvas/projects/' + p.id + '/media/';
  const opening = p.manifest.active_s01_s02_revision;
  const s03 = p.manifest.active_s03_storyboard;
  const ready = name => Boolean(config.python && config[name]?.command &&
    fs.existsSync(config.python) && fs.existsSync(config[name].command));
  const assets = p.review ? (p.review.mix ? [{ title: 'Mix', type: 'audio', url: base + 'sound' }] : []) : p.battle ? [
    { title: 'Action sequence - 23 s', type: 'video', url: base + 'battle-focus' },
    { title: 'Action-sequence full mix', type: 'audio', url: base + 'sound' }
  ] : p.demo ? [
    { key: 'cartoon', title: 'Sample picture source', type: 'video', url: base + 'cartoon' },
    { key: 'sound', title: 'Sample audio source', type: 'audio', url: base + 'sound' }
  ] : [
    { key: 'reference-compare', title: 'Three-angle corridor reference', type: 'video', url: base + 'reference-compare' },
    { key: 'cartoon', title: 'Animation and original audio', type: 'video', url: base + 'cartoon' },
    { key: 'sound', title: 'S03 source mix', type: 'audio', url: base + 'sound' }
  ];
  const film = p.review?.video || p.battle?.current_candidate || s03.preview;
  const short = p.battle?.short_review;
  const interval = short?.original_interval_seconds;
  let focus = Array.isArray(interval) && interval.length === 2 &&
    interval.every(Number.isFinite) && interval[0] >= 0 && interval[1] > interval[0] &&
    Math.round((interval[1] - interval[0]) * t.fps) === short.frames
    ? { ...videoInfo(short, p.dir), start: Math.round(interval[0] * t.fps),
        end: Math.round(interval[1] * t.fps), url: base + 'battle-focus' } : null;
  if (p.review?.focus && !draft) {
    const record = p.review.focus;
    if (record.end > t.frames) throw problem(422, 'Focus range is outside the timeline');
    focus = { ...videoInfo(record, p.dir), start: record.start, end: record.end, frames: record.end - record.start,
      width: record.width || t.width, height: record.height || t.height, label: record.label, url: base + 'battle-focus' };
  }
  let graph = p.battle?.canvas;
  if (p.review?.comfy) {
    const saved = read(existing(p.dir, p.review.comfy.path));
    if (saved.id !== p.review.comfy.canvas_id || !Array.isArray(saved.nodes)) throw problem(422, 'Invalid project workspace identity');
    graph = { ...p.review.comfy, revision: saved.revision, nodes: saved.nodes.length };
  }
  const annotations = draft ? { data: null } : readReview(p, t);
  if (p.battle) {
    for (const track of t.tracks) for (const clip of track.clips) {
      const shot = clip.name.match(/^([0-9]+[a-z-]*)[｜|]/)?.[1];
      const still = shot && Object.hasOwn(p.battle.first_frames || {}, shot) &&
        (clip.name.includes('First-frame placeholder') || clip.name.includes('\u9996\u5e27\u5360\u4f4d'));
      clip.shot = shot || null;
      clip.placeholder = Boolean(still);
      if (still) clip.thumbnail = base + 'still-' + shot;
      clip.graphNode = graph?.shot_nodes?.find(node => node.shot === shot)?.image_node;
    }
  }
  for (const row of annotations.data?.clips || []) {
    const clip = t.tracks.find(track => track.id === row.track).clips[row.clip];
    if (row.shot) clip.shot = row.shot;
    clip.placeholder = Boolean(row.placeholder);
    if (row.thumbnail) clip.thumbnail = base + 'thumb-' + row.track + '-' + row.clip;
    if (Number.isSafeInteger(row.graphNode) && row.graphNode > 0) clip.graphNode = row.graphNode;
  }
  return {
    title: p.title, project: p.id, draft, tracks: t.tracks, fps: t.fps, frames: t.frames,
    transitions: t.transitions, revision: t.revision, timelineFile: path.relative(p.dir, t.source),
    mediaBase: base, opening: opening ? { ...videoInfo(opening.video, p.dir), seconds: opening.seconds, markers: opening.review_markers,
      version: path.basename(opening.video.path), revision: hash(JSON.stringify(opening.video)),
      approved: opening.status === 'OWNER_APPROVED_FINAL', url: base + 'opening' } : null,
    segment: { status: p.review ? 'REVIEW' : p.battle?.status || s03.status, version: draft || path.basename(film.path),
      url: draft ? base + 'preview?draft=' + draft : base + 's03' },
    video: { ...videoInfo(film, p.dir), width: film.width || t.width, height: film.height || t.height }, focus,
    reviewData: annotations.data, warnings: annotations.warning ? [annotations.warning] : [],
    decisions: p.battle || p.review ? reviewDecisions(p, t.revision) : {},
    mixUrl: (p.battle?.lossless_mix || p.review?.mix) &&
      t.tracks.filter(track => track.type === 'audio' && track.clips.length).length === 1 ? base + 'sound' : null,
    graph: graph ? { name: path.basename(graph.path, '.json'), revision: graph.revision, nodes: graph.nodes } : null,
    wholeFilm: Boolean(p.battle || p.review),
    generic: Boolean(p.review), viewLabels: { s03: p.review?.video.label || (p.battle ? 'Full-film candidate' : p.demo ? 'Sample edit' : 'S03 - current candidate'),
      battle: focus?.label || 'Action focus', opening: 'S01-S02 - opening' },
    hasStoryboard: !p.review || Boolean(p.review.notes),
    comfyCanvas: Boolean(graph?.canvas_id),
    assets, demo: p.demo,
    canEdit: !p.demo && !p.battle && !t.native && ready('kdenlive'),
    canReferences: !p.demo && Boolean(p.manifest.corridor_three_camera_previs) && ready('comfy'),
    jobs: ids(p, 'runs', 'request.json').map(id => job(p, id)).sort((a, b) => b.created.localeCompare(a.created)),
    tasks: ids(p, 'tasks', 'brief.json').map(id => task(p, id)).sort((a, b) => b.created.localeCompare(a.created)),
    crafts
  };
}

function reviewDecisions(p, revision) {
  const dir = folder(p, 'reviews');
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
  const rows = files.map(file => read(existing(dir, file))).filter(row => row.revision === revision)
    .sort((a, b) => a.created.localeCompare(b.created));
  return Object.fromEntries(rows.map(row => [row.track + ':' + row.clip, row.state]));
}

function reviewDecision(p, draft, body) {
  const t = timeline(p, draft);
  if ((!p.battle && !p.review) || t.revision !== body.revision) throw problem(409, 'Edit revision has changed');
  const track = t.tracks.find(row => row.id === body.track);
  if (!Number.isSafeInteger(body.clip) || !track?.clips[body.clip] || !['pass', 'redo'].includes(body.state)) {
    throw problem(422, 'Invalid shot review status');
  }
  const row = { revision: t.revision, track: body.track, clip: body.clip, state: body.state,
    created: new Date().toISOString() };
  const dir = folder(p, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  writeNew(path.join(dir, randomUUID().replaceAll('-', '') + '.json'), row);
  return row;
}

function bodyText(data, key, max) {
  const value = typeof data[key] === 'string' ? data[key].trim() : '';
  if (!value || value.length > max) throw problem(422, 'Invalid field length: ' + key);
  return value;
}

function createTask(p, body) {
  if (!Object.hasOwn(crafts, body.route) || !idPattern.test(body.id || '')) throw problem(422, 'Invalid task type or ID');
  const dir = folder(p, 'tasks', body.id);
  const anchor = body.anchor;
  if (anchor !== undefined && (!anchor || !['s03', 'opening', 'battle'].includes(anchor.view) ||
    typeof anchor.version !== 'string' || anchor.version.length > 160 ||
    typeof anchor.revision !== 'string' || !/^[a-f0-9]{64}$/.test(anchor.revision) ||
    !Number.isSafeInteger(anchor.frame) || anchor.frame < 0 ||
    (anchor.shot !== undefined && (typeof anchor.shot !== 'string' || !shotPattern.test(anchor.shot))) ||
    (anchor.clip !== undefined && (!anchor.clip || Array.isArray(anchor.clip) ||
      !Object.keys(anchor.clip).every(key => ['track', 'bin', 'sourceFrame', 'offset', 'start', 'end'].includes(key)) ||
      !Number.isSafeInteger(anchor.clip.track) || anchor.clip.track < 0 ||
      typeof anchor.clip.bin !== 'string' || !anchor.clip.bin.trim() || anchor.clip.bin.length > 128 ||
      !Number.isSafeInteger(anchor.clip.sourceFrame) || anchor.clip.sourceFrame < 0 ||
      (anchor.clip.offset !== undefined && (!Number.isSafeInteger(anchor.clip.offset) ||
        anchor.clip.offset < 0 || anchor.clip.offset > anchor.clip.sourceFrame)) ||
      ((anchor.clip.start !== undefined || anchor.clip.end !== undefined) &&
        (!Number.isSafeInteger(anchor.clip.start) || !Number.isSafeInteger(anchor.clip.end) ||
          !Number.isSafeInteger(anchor.clip.offset) || anchor.clip.start < 0 ||
          anchor.clip.sourceFrame !== anchor.clip.start + anchor.clip.offset ||
          anchor.clip.sourceFrame >= anchor.clip.end)))))) {
    throw problem(422, 'Invalid annotation time anchor');
  }
  const message = { id: body.id, title: bodyText(body, 'title', 100), target: bodyText(body, 'target', 120),
    text: bodyText(body, 'text', 16000), route: body.route, ...(anchor ? { anchor } : {}) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'brief.json');
  if (fs.existsSync(file)) {
    const current = task(p, body.id);
    if (Object.keys(message).some(key => JSON.stringify(current[key]) !== JSON.stringify(message[key]))) throw problem(409, 'Task ID is already assigned to another annotation');
    return current;
  }
  writeNew(file, { ...message, created: new Date().toISOString(), status: 'prepared_for_codex' });
  return task(p, body.id);
}

function receiveTask(p, id, body) {
  if (task(p, id).result) throw problem(409, 'This task has a result. Create another record for revisions');
  const file = existing(p.dir, bodyText(body, 'path', 500));
  if (!mediaTypes[path.extname(file).toLowerCase()]) throw problem(422, 'Expected reviewable media or a document inside the project');
  const sha256 = revision(file);
  if (sha256 !== body.sha256) throw problem(409, 'Result file does not match its hash');
  writeNew(path.join(folder(p, 'tasks', id), 'result.json'), {
    path: path.relative(p.dir, file), sha256, note: bodyText(body, 'note', 1200),
    received: new Date().toISOString(), status: 'candidate'
  });
  return task(p, id);
}

function requireInt(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw problem(422, 'Frame is out of range');
  return value;
}

function prepareEdit(p, body) {
  if (p.battle) throw problem(403, 'This project is open in review mode');
  if (!config.kdenlive?.command) throw problem(503, 'Configure Kdenlive MCP in the desktop menu first');
  const draft = body.draft || null;
  const t = timeline(p, draft);
  if (t.native) throw problem(403, 'Native Kdenlive projects support review. Edit the project in Kdenlive and export a new review video');
  if (t.revision !== body.revision) throw problem(409, 'The source revision changed. Reload the canvas');
  const track = t.tracks.find(row => row.id === body.track);
  const clip = track?.clips[body.clip];
  if (!Number.isInteger(body.clip) || !clip) throw problem(422, 'The selected clip does not exist');
  const args = { track_id: track.id, clip_index: clip.index };
  const candidate = { ...clip };
  let edit;
  if (body.operation === 'trim') {
    candidate.start = requireInt(body.start, 0, clip.max - 1);
    candidate.end = requireInt(body.end, candidate.start + 1, clip.max);
    if (candidate.start === clip.start && candidate.end === clip.end) throw problem(422, 'In/out points have not changed');
    edit = ['trim_clip', { ...args, source_in_seconds: candidate.start / t.fps, source_out_seconds: candidate.end / t.fps }];
  } else if (body.operation === 'move') {
    candidate.position = requireInt(body.position, 0, t.frames + Math.round(5 * t.fps));
    if (candidate.position === clip.position) throw problem(422, 'Timeline position has not changed');
    edit = ['move_clip', { ...args, position_seconds: candidate.position / t.fps }];
  } else {
    throw problem(422, 'Unknown edit operation');
  }
  const end = c => c.position + c.end - c.start;
  if (track.clips.some(c => c.index !== clip.index && c.position < end(candidate) && candidate.position < end(c))) {
    throw problem(422, 'This edit overlaps a clip on the same track. Adjust the frame');
  }
  return { kind: 'edit', title: clip.name, draft, source: t.source, revision: t.revision,
    edits: [edit], operation: body.operation, track: track.id, clip: clip.index,
    before: { start: clip.start, end: clip.end, position: clip.position },
    after: { start: candidate.start, end: candidate.end, position: candidate.position } };
}

function referenceRecord(p) {
  return read(existing(p.dir, p.manifest.corridor_three_camera_previs.manifest.path));
}

function prepareReferences(p) {
  if (!config.comfy?.command || p.demo) throw problem(503, 'No runnable reference-image workflow is connected to this project');
  const record = referenceRecord(p);
  const source = existing(p.dir, record.comfy_mcp.workflow.path);
  const scene = existing(p.dir, record.candidate_scene.path);
  const sha256 = revision(source);
  if (sha256 !== record.comfy_mcp.workflow.sha256 || revision(scene) !== record.candidate_scene.sha256) {
    throw problem(409, 'The three-angle workflow or scene changed. Check its version');
  }
  return { kind: 'references', title: 'Three-angle corridor references', source, scene, revision: sha256 };
}

function start(p, request) {
  const id = hash(JSON.stringify(request)).slice(0, 32);
  const dir = folder(p, 'runs', id);
  const receipt = path.join(dir, 'request.json');
  if (fs.existsSync(receipt)) return job(p, id);
  if (ids(p, 'runs', 'request.json').some(other => !terminal.has(job(p, other).status))) {
    throw problem(409, 'A local job is running. Wait for its result');
  }
  if (!config.python || !fs.existsSync(config.python)) throw problem(503, 'The local MCP client runtime is missing');
  fs.mkdirSync(dir, { recursive: true });
  writeNew(receipt, { ...request, created: new Date().toISOString() });
  const log = fs.openSync(path.join(dir, 'worker.log'), 'ax');
  const child = spawn(config.python, ['-X', 'utf8', config.worker, dir, config.toolFile], {
    cwd: path.dirname(config.worker), detached: true, windowsHide: true, stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  child.on('error', error => {
    const file = path.join(dir, 'status.json');
    if (!fs.existsSync(file)) writeNew(file, { status: 'failed', stage: 'start', error: error.message });
  });
  child.unref();
  return job(p, id);
}

function media(p, key, draft, runId) {
  if (key.startsWith('task-')) {
    const result = task(p, key.slice(5)).result;
    if (!result) throw problem(404, 'The task result has not been attached');
    const file = existing(p.dir, result.path);
    if (revision(file) !== result.sha256) throw problem(409, 'Result changed. Check its version');
    return file;
  }
  if (/^still-[0-9]+[a-z]*$/.test(key)) {
    const frames = p.battle?.first_frames;
    const shot = key.slice(6);
    if (!frames || !Object.hasOwn(frames, shot)) throw problem(404, 'First frame is not registered');
    const record = frames[shot];
    const file = existing(p.dir, record.path);
    if (revision(file) !== record.sha256) throw problem(409, 'First frame does not match the manifest');
    return file;
  }
  if (key.startsWith('bin-')) {
    const item = timeline(p, draft).bin.get(key.slice(4));
    if (!item) throw problem(404, 'Source does not exist');
    return existing(p.dir, item.source);
  }
  const thumbnail = /^thumb-(\d+)-(\d+)$/.exec(key);
  if (thumbnail) {
    const t = timeline(p, draft);
    const row = readReview(p, t).data?.clips.find(row => row.track === Number(thumbnail[1]) && row.clip === Number(thumbnail[2]));
    if (!row?.thumbnail) throw problem(404, 'Thumbnail is not registered');
    const file = existing(p.dir, row.thumbnail.path);
    if (revision(file) !== row.thumbnail.sha256) throw problem(409, 'Thumbnail does not match its record');
    return file;
  }
  if (key === 'preview' || key === 'editable') {
    const item = draft && job(p, draft);
    if (!item || item.status !== 'completed' || item.kind !== 'edit') throw problem(404, 'Draft is not complete');
    return existing(folder(p, 'runs', draft), key === 'preview' ? 'preview.mp4' : 'draft.kdenlive');
  }
  if (/^reference-[abc]$/.test(key) && runId) {
    const item = job(p, runId);
    if (item.kind !== 'references' || item.status !== 'completed') throw problem(404, 'Reference images are not complete');
    return existing(folder(p, 'runs', runId), key + '.png');
  }
  const s03 = p.manifest.active_s03_storyboard;
  const opening = p.manifest.active_s01_s02_revision;
  if (['s03', 'opening', 'battle-focus'].includes(key)) {
    return existing(p.dir, reviewVideoPaths(p)[key === 'battle-focus' ? 'battle' : key]);
  }
  const fixed = p.review ? {
    sound: p.review.mix, storyboard: p.review.notes
  } : p.battle ? {
    sound: p.battle.lossless_mix,
    storyboard: p.manifest.latest_compact_handoff?.readme || 'README.md'
  } : {
    storyboard: s03.reader,
    cartoon: opening.cartoon_original_audio_4k.path, sound: s03.audio_revision.master.path,
    'reference-compare': p.manifest.corridor_three_camera_previs ? referenceRecord(p).media['three-camera'].path : null
  };
  return existing(p.dir, Object.hasOwn(fixed, key) && fixed[key]);
}

function stream(req, res, file) {
  const type = mediaTypes[path.extname(file).toLowerCase()];
  if (!type) throw problem(403, 'File type cannot be previewed');
  const length = fs.statSync(file).size;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store' };
  let start = 0;
  let end = length - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    } else if (m && Number(m[2]) > 0) {
      start = Math.max(0, length - Number(m[2]));
    } else {
      start = length;
    }
    if (start >= length || start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + length });
      return res.end();
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + length;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  if (file.endsWith('.kdenlive')) headers['Content-Disposition'] = 'attachment; filename="draft.kdenlive"';
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !length) return res.end();
  const content = fs.createReadStream(file, { start, end });
  content.on('error', () => res.destroy());
  res.on('close', () => content.destroy());
  content.pipe(res);
}

async function handle(req, res, url, json, readBody) {
  const [, , noun, id, action, key, sub] = url.pathname.split('/').filter(Boolean);
  const draft = url.searchParams.get('draft');
  const method = req.method;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw problem(403, 'Canvas accepts local access only');
  }
  if (method === 'POST') {
    if (req.headers.origin && req.headers.origin !== url.origin) throw problem(403, 'Writes must originate from the local canvas');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw problem(415, 'Use a JSON request');
    }
  }
  if (noun !== 'projects') throw problem(404, 'Canvas route does not exist');
  if (!id && method === 'GET') return json(res, 200, Object.entries(config.projects).map(([id, p]) => ({ id, title: p.title })));
  const p = project(id);
  if (!action && method === 'GET') return json(res, 200, summary(p, draft));
  if (action === 'media' && key && !sub && ['GET', 'HEAD'].includes(method)) {
    return stream(req, res, media(p, key, draft, url.searchParams.get('run')));
  }
  if (action === 'jobs' && key && !sub && method === 'GET') return json(res, 200, job(p, key));
  if (action === 'tasks' && key && !sub && method === 'GET') return json(res, 200, task(p, key));
  if (action === 'review-decisions' && !key && method === 'POST') return json(res, 201, reviewDecision(p, draft, await readBody(req)));
  if (action === 'tasks' && !key && method === 'POST') return json(res, 201, createTask(p, await readBody(req)));
  if (action === 'tasks' && key && sub === 'result' && method === 'POST') {
    return json(res, 201, receiveTask(p, key, await readBody(req)));
  }
  if (action === 'edits' && !key && method === 'POST') return json(res, 202, start(p, prepareEdit(p, await readBody(req))));
  if (action === 'references' && !key && method === 'POST') return json(res, 202, start(p, prepareReferences(p)));
  throw problem(404, 'Canvas route does not exist');
}

function comfyWorkflow(id) {
  const p = project(id);
  const record = p.review?.comfy || p.battle?.canvas;
  if (!record?.canvas_id || typeof record.path !== 'string') throw problem(404, 'No ComfyUI workspace is bound to this project');
  return { filename: path.basename(record.path), id: record.canvas_id };
}

module.exports = { configure, handle, comfyWorkflow };
