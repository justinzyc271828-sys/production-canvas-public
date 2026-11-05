'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadProject, readTimeline, readReview, shotPattern, read, hash, inside, existing } = require('./project');

let config;

function configure(settings) {
  config = settings;
}
const idPattern = /^[a-f0-9]{32}$/;
const terminal = new Set(['completed', 'failed', 'attention']);
const crafts = {
  direction: '导演／分镜', blender: 'Blender MCP', image: 'Codex imagegen',
  music: 'Suno 官方 MCP', video: 'Runway 审核队列', edit: 'Kdenlive / REAPER'
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
  if (!Object.hasOwn(config.projects, id)) throw problem(404, '没有这个画布项目');
  const binding = config.projects[id];
  return { id, demo: Boolean(binding.demo), ...loadProject(binding) };
}

function folder(p, kind, id = '') {
  if (id && !idPattern.test(id)) throw problem(404, '找不到记录');
  const parent = path.join(p.store, kind);
  const target = path.join(parent, id);
  for (const item of [parent, target]) {
    if (fs.existsSync(item) && !inside(p.store, fs.realpathSync(item))) throw problem(403, '记录超出项目');
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
        throw problem(409, '渲染文件和回执不一致');
      }
      state = { ...state, status: 'completed', stage: 'review', revision: receipt.source_revision, preview_sha256: receipt.sha256 };
    } else if (receipt.state === 'failed') {
      state = { ...state, status: 'failed', error: receipt.error || '渲染失败，请检查工程回执。' };
    }
  }
  if (!terminal.has(state.status) && Date.now() - Date.parse(state.updated_at || request.created) > 480_000) {
    state = { ...state, status: 'attention', error: '状态已久未更新，请核对现有回执。' };
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
    if (run.kind !== 'edit' || run.status !== 'completed') throw problem(409, '此草稿尚未出片');
    source = existing(folder(p, 'runs', draft), 'draft.kdenlive-cli.json');
    if (revision(source) !== run.revision) throw problem(409, '草稿已被外部修改，请核对版本');
  } else if (p.review) {
    source = existing(p.dir, p.review.timeline);
  } else if (p.battle) {
    source = existing(p.dir, p.battle.working_project);
  } else {
    const native = p.manifest.active_s03_storyboard?.editable_project?.path;
    if (typeof native !== 'string' || !native.endsWith('.kdenlive')) throw problem(409, '清单未绑定可编辑的 S03 版本');
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
  const assets = p.review ? (p.review.mix ? [{ title: '混音', type: 'audio', url: base + 'sound' }] : []) : p.battle ? [
    { title: '战斗段 · 23 秒', type: 'video', url: base + 'battle-focus' },
    { title: '战斗版完整混音', type: 'audio', url: base + 'sound' }
  ] : p.demo ? [
    { key: 'cartoon', title: '示例画面素材', type: 'video', url: base + 'cartoon' },
    { key: 'sound', title: '示例声音素材', type: 'audio', url: base + 'sound' }
  ] : [
    { key: 'reference-compare', title: '走廊三机位', type: 'video', url: base + 'reference-compare' },
    { key: 'cartoon', title: '卡通与原声', type: 'video', url: base + 'cartoon' },
    { key: 'sound', title: 'S03 混音底稿', type: 'audio', url: base + 'sound' }
  ];
  const film = p.review?.video || p.battle?.current_candidate || s03.preview;
  const short = p.battle?.short_review;
  const interval = short?.original_interval_seconds;
  let focus = Array.isArray(interval) && interval.length === 2 &&
    interval.every(Number.isFinite) && interval[0] >= 0 && interval[1] > interval[0] &&
    Math.round((interval[1] - interval[0]) * t.fps) === short.frames
    ? { ...videoInfo(short), start: Math.round(interval[0] * t.fps),
        end: Math.round(interval[1] * t.fps), url: base + 'battle-focus' } : null;
  if (p.review?.focus && !draft) {
    const record = p.review.focus;
    if (record.end > t.frames) throw problem(422, '重点片段超出时间线');
    focus = { ...videoInfo(record, p.dir), start: record.start, end: record.end, frames: record.end - record.start,
      width: record.width || t.width, height: record.height || t.height, label: record.label, url: base + 'battle-focus' };
  }
  let graph = p.battle?.canvas;
  if (p.review?.comfy) {
    const saved = read(existing(p.dir, p.review.comfy.path));
    if (saved.id !== p.review.comfy.canvas_id || !Array.isArray(saved.nodes)) throw problem(422, '项目画布身份无效');
    graph = { ...p.review.comfy, revision: saved.revision, nodes: saved.nodes.length };
  }
  const annotations = draft ? { data: null } : readReview(p, t);
  if (p.battle) {
    for (const track of t.tracks) for (const clip of track.clips) {
      const shot = clip.name.match(/^([0-9]+[a-z-]*)[｜|]/)?.[1];
      const still = shot && Object.hasOwn(p.battle.first_frames || {}, shot) && clip.name.includes('首帧占位');
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
    generic: Boolean(p.review), viewLabels: { s03: p.review?.video.label || (p.battle ? '全片候选' : p.demo ? '示例剪辑' : 'S03 · 当前候选'),
      battle: focus?.label || '战斗重点版', opening: 'S01–S02 · 开场' },
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
  if ((!p.battle && !p.review) || t.revision !== body.revision) throw problem(409, '剪辑版本已变化');
  const track = t.tracks.find(row => row.id === body.track);
  if (!Number.isSafeInteger(body.clip) || !track?.clips[body.clip] || !['pass', 'redo'].includes(body.state)) {
    throw problem(422, '镜头审阅状态无效');
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
  if (!value || value.length > max) throw problem(422, '字段长度无效：' + key);
  return value;
}

function createTask(p, body) {
  if (!Object.hasOwn(crafts, body.route) || !idPattern.test(body.id || '')) throw problem(422, '任务类型或编号无效');
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
    throw problem(422, '指令时间锚点无效');
  }
  const message = { id: body.id, title: bodyText(body, 'title', 100), target: bodyText(body, 'target', 120),
    text: bodyText(body, 'text', 16000), route: body.route, ...(anchor ? { anchor } : {}) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'brief.json');
  if (fs.existsSync(file)) {
    const current = task(p, body.id);
    if (Object.keys(message).some(key => JSON.stringify(current[key]) !== JSON.stringify(message[key]))) throw problem(409, '任务编号已用于其他指令');
    return current;
  }
  writeNew(file, { ...message, created: new Date().toISOString(), status: 'prepared_for_codex' });
  return task(p, body.id);
}

function receiveTask(p, id, body) {
  if (task(p, id).result) throw problem(409, '该任务已有结果，另开一条记录修订');
  const file = existing(p.dir, bodyText(body, 'path', 500));
  if (!mediaTypes[path.extname(file).toLowerCase()]) throw problem(422, '只接收项目内可审阅的媒体或文档');
  const sha256 = revision(file);
  if (sha256 !== body.sha256) throw problem(409, '结果文件和哈希不一致');
  writeNew(path.join(folder(p, 'tasks', id), 'result.json'), {
    path: path.relative(p.dir, file), sha256, note: bodyText(body, 'note', 1200),
    received: new Date().toISOString(), status: 'candidate'
  });
  return task(p, id);
}

function requireInt(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw problem(422, '帧号超出允许范围');
  return value;
}

function prepareEdit(p, body) {
  if (p.battle) throw problem(403, '《破阵子》当前以审片模式打开');
  if (!config.kdenlive?.command) throw problem(503, '请先在桌面菜单配置 Kdenlive MCP');
  const draft = body.draft || null;
  const t = timeline(p, draft);
  if (t.native) throw problem(403, '原生 Kdenlive 工程支持审片，请在 Kdenlive 中修改工程并重新导出审片视频');
  if (t.revision !== body.revision) throw problem(409, '底稿版本已变化，请刷新画布');
  const track = t.tracks.find(row => row.id === body.track);
  const clip = track?.clips[body.clip];
  if (!Number.isInteger(body.clip) || !clip) throw problem(422, '所选片段不存在');
  const args = { track_id: track.id, clip_index: clip.index };
  const candidate = { ...clip };
  let edit;
  if (body.operation === 'trim') {
    candidate.start = requireInt(body.start, 0, clip.max - 1);
    candidate.end = requireInt(body.end, candidate.start + 1, clip.max);
    if (candidate.start === clip.start && candidate.end === clip.end) throw problem(422, '入点和出点未变化');
    edit = ['trim_clip', { ...args, source_in_seconds: candidate.start / t.fps, source_out_seconds: candidate.end / t.fps }];
  } else if (body.operation === 'move') {
    candidate.position = requireInt(body.position, 0, t.frames + Math.round(5 * t.fps));
    if (candidate.position === clip.position) throw problem(422, '时间线位置未变化');
    edit = ['move_clip', { ...args, position_seconds: candidate.position / t.fps }];
  } else {
    throw problem(422, '未知剪辑操作');
  }
  const end = c => c.position + c.end - c.start;
  if (track.clips.some(c => c.index !== clip.index && c.position < end(candidate) && candidate.position < end(c))) {
    throw problem(422, '改动会覆盖同轨片段，请调整帧号');
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
  if (!config.comfy?.command || p.demo) throw problem(503, '此项目未接入可运行的参考图工作流');
  const record = referenceRecord(p);
  const source = existing(p.dir, record.comfy_mcp.workflow.path);
  const scene = existing(p.dir, record.candidate_scene.path);
  const sha256 = revision(source);
  if (sha256 !== record.comfy_mcp.workflow.sha256 || revision(scene) !== record.candidate_scene.sha256) {
    throw problem(409, '三机位工作流或场景已变化，请先核对版本');
  }
  return { kind: 'references', title: '走廊三机位参考图', source, scene, revision: sha256 };
}

function start(p, request) {
  const id = hash(JSON.stringify(request)).slice(0, 32);
  const dir = folder(p, 'runs', id);
  const receipt = path.join(dir, 'request.json');
  if (fs.existsSync(receipt)) return job(p, id);
  if (ids(p, 'runs', 'request.json').some(other => !terminal.has(job(p, other).status))) {
    throw problem(409, '已有本地任务运行，请先等待结果');
  }
  if (!config.python || !fs.existsSync(config.python)) throw problem(503, '本地 MCP 客户端运行环境缺失');
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
    if (!result) throw problem(404, '任务结果还未回填');
    const file = existing(p.dir, result.path);
    if (revision(file) !== result.sha256) throw problem(409, '结果已变化，请核对版本');
    return file;
  }
  if (/^still-[0-9]+[a-z]*$/.test(key)) {
    const frames = p.battle?.first_frames;
    const shot = key.slice(6);
    if (!frames || !Object.hasOwn(frames, shot)) throw problem(404, '未登记的首帧');
    const record = frames[shot];
    const file = existing(p.dir, record.path);
    if (revision(file) !== record.sha256) throw problem(409, '首帧与清单不一致');
    return file;
  }
  if (key.startsWith('bin-')) {
    const item = timeline(p, draft).bin.get(key.slice(4));
    if (!item) throw problem(404, '素材不存在');
    return existing(p.dir, item.source);
  }
  const thumbnail = /^thumb-(\d+)-(\d+)$/.exec(key);
  if (thumbnail) {
    const t = timeline(p, draft);
    const row = readReview(p, t).data?.clips.find(row => row.track === Number(thumbnail[1]) && row.clip === Number(thumbnail[2]));
    if (!row?.thumbnail) throw problem(404, '缩略图未登记');
    const file = existing(p.dir, row.thumbnail.path);
    if (revision(file) !== row.thumbnail.sha256) throw problem(409, '缩略图和记录不一致');
    return file;
  }
  if (key === 'preview' || key === 'editable') {
    const item = draft && job(p, draft);
    if (!item || item.status !== 'completed' || item.kind !== 'edit') throw problem(404, '草稿还未完成');
    return existing(folder(p, 'runs', draft), key === 'preview' ? 'preview.mp4' : 'draft.kdenlive');
  }
  if (/^reference-[abc]$/.test(key) && runId) {
    const item = job(p, runId);
    if (item.kind !== 'references' || item.status !== 'completed') throw problem(404, '参考图还未完成');
    return existing(folder(p, 'runs', runId), key + '.png');
  }
  const s03 = p.manifest.active_s03_storyboard;
  const opening = p.manifest.active_s01_s02_revision;
  const fixed = p.review ? {
    s03: p.review.video.path, 'battle-focus': p.review.focus?.path, sound: p.review.mix, storyboard: p.review.notes
  } : p.battle ? {
    s03: p.battle.current_candidate.path, 'battle-focus': p.battle.short_review.path, sound: p.battle.lossless_mix,
    storyboard: p.manifest.latest_compact_handoff?.readme || 'README.md'
  } : {
    opening: opening.video.path, s03: s03.preview.path, storyboard: s03.reader,
    cartoon: opening.cartoon_original_audio_4k.path, sound: s03.audio_revision.master.path,
    'reference-compare': p.manifest.corridor_three_camera_previs ? referenceRecord(p).media['three-camera'].path : null
  };
  return existing(p.dir, Object.hasOwn(fixed, key) && fixed[key]);
}

function stream(req, res, file) {
  const type = mediaTypes[path.extname(file).toLowerCase()];
  if (!type) throw problem(403, '文件类型不可预览');
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
    throw problem(403, '仅允许本机访问画布');
  }
  if (method === 'POST') {
    if (req.headers.origin && req.headers.origin !== url.origin) throw problem(403, '仅接受本机画布发起的写操作');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw problem(415, '请使用 JSON 请求');
    }
  }
  if (noun !== 'projects') throw problem(404, '画布路由不存在');
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
  throw problem(404, '画布路由不存在');
}

function comfyWorkflow(id) {
  const p = project(id);
  const record = p.review?.comfy || p.battle?.canvas;
  if (!record?.canvas_id || typeof record.path !== 'string') throw problem(404, '项目没有绑定 ComfyUI 画布');
  return { filename: path.basename(record.path), id: record.canvas_id };
}

module.exports = { configure, handle, comfyWorkflow };
