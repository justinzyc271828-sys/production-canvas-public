'use strict';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let project = params.get('project');
let draft = params.get('draft');
let model;
let selected;
let currentView = 'opening';
let player;
let screening = false;
let polling = false;
let pendingOpen = null;
let projectEpoch = 0;
let briefId;
let briefAnchor;
let quickNote;
let playbackRate = 1;
let muted = false;
let loop = null;
let lastSavedDirectionId = null;

const stages = {
  start: '排队', connect: '连接本地工具', copy: '复制工作版', edit: '修改剪辑',
  'starting-render': '准备渲染', render: '渲染预览', validate: '验证工作流', comfy: '取回参考图', review: '可审阅'
};
const statuses = { completed: '已完成 · 候选', failed: '失败', attention: '待检查', running: '运行中', queued: '排队' };
const trackLabels = {
  'Lighting review picture': '画面底稿', 'Title - approved typography': '标题叠加',
  'room-tone': '环境底噪', breath: '呼吸', steps: '脚步', button: '按钮', landing: '落地',
  clothing: '衣物', 'Main score - EMPTY': '主配乐 · 待选'
};
const api = (suffix = '') => '/api/canvas/projects/' + encodeURIComponent(project) + suffix;
const query = () => draft ? '?draft=' + encodeURIComponent(draft) : '';

function el(tag, text = '', attributes = {}) {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function button(label, fn, cls) {
  const node = el('button', label, { type: 'button' });
  if (cls) node.className = cls;
  node.addEventListener('click', fn);
  return node;
}

async function request(url, payload) {
  const options = payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  };
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}

function tell(text, error = false) {
  $('status').textContent = text;
  $('status').dataset.error = error;
  if ($('side-panel').open) {
    $('panel-status').hidden = false;
    $('panel-status').textContent = text;
    $('panel-status').dataset.error = error;
  }
}

function sec(value) {
  return Number(value).toFixed(2) + ' 秒';
}

function setUrl() {
  const url = new URL(location.href);
  url.searchParams.set('project', project);
  if (draft) url.searchParams.set('draft', draft);
  else url.searchParams.delete('draft');
  history.replaceState(null, '', url);
}

function media(view, type, url, label, start = 0, play = false, exact = false) {
  currentView = view;
  if (view !== 'asset') $('review-version').value = view;
  loop = null;
  updateVersion();
  $('player').setAttribute('aria-label', label);
  $('markers').replaceChildren();
  $('note-at-time').disabled = true;
  if (player && typeof player.pause === 'function') player.pause();
  const mediaNode = el(type === 'image' ? 'img' : type, '', { src: url, 'aria-label': label });
  player = mediaNode;
  if (type === 'video') trackVideoFrames(mediaNode);
  else { if (videoClock) settleFrameSeek(videoClock, false); videoClock = null; }
  if (type === 'image') {
    player.alt = label;
  } else {
    player.controls = false;
    player.muted = muted;
    player.playbackRate = playbackRate;
    player.preload = 'metadata';
    player.playsInline = true;
    player.addEventListener('loadedmetadata', () => {
      if (player !== mediaNode) return;
      if (type === 'video') seekVideoFrame(mediaNode, start, false, exact);
      syncPlayhead();
    }, { once: true });
    for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'ended']) {
      player.addEventListener(event, () => { if (player === mediaNode) syncPlayhead(); });
    }
    player.addEventListener('ended', () => {
      if (player !== mediaNode) return;
      if (loop) void restartLoop();
      else if (screening && currentView === 'opening') showSegment('s03', 0, true);
      else if (screening && currentView === 's03') {
        screening = false;
        tell('已播完当前可看片段。');
      }
    });
  }
  player.addEventListener('error', () => {
    if (player === mediaNode) tell('当前素材无法播放，请检查文件或换看段落预览。', true);
  });
  $('player').replaceChildren(player);
  renderTransport();
  renderTimeline();
  if (play && type !== 'image') {
    mediaNode.play().catch(() => {
      if (player === mediaNode) tell('已切到下一段，点击播放继续。');
    });
  }
}

function showSegment(view, start = 0, play = false, exact = false) {
  if (!model) return;
  if (view === 'battle') {
    media(view, 'video', model.focus.url, model.viewLabels?.battle || '重点片段', start, play, exact);
    return;
  }
  const opening = view === 'opening';
  media(view, 'video', opening ? model.opening.url : model.segment.url,
    opening ? (model.opening.approved ? '开场 · 已定稿' : '开场 · 当前记录') :
      (draft ? '草稿预览' : model.viewLabels?.s03 || '剪辑候选'), start, play, exact);
  if (opening) {
    for (const marker of model.opening.markers || []) {
      $('markers').append(button(marker.label + ' · ' + sec(marker.seconds), () => {
        seekLocalFrame(Math.round(marker.seconds * model.fps));
      }));
    }
  }
}

function numberField(id, label, value, max) {
  const wrapper = el('label', label);
  wrapper.append(el('input', '', { id, type: 'number', value, min: '0', max, step: '1', required: '' }));
  return wrapper;
}

function renderInspector() {
  const target = $('inspector');
  target.replaceChildren();
  const track = model.tracks.find(track => track.id === selected?.track);
  const clip = track?.clips[selected.clip];
  $('close-inspector').hidden = !clip;
  $('loop-shot').disabled = !clip || !isTimelineView();
  if (!clip) {
    renderOverviewInspector(target);
    return;
  }
  const fps = model.fps;
  target.append(el('h3', clip.name, { class: 'clip-title' }));
  const status = el('p', '', { class: clip.placeholder ? 'still-status' : 'chip' });
  const refreshStatus = () => {
    const decision = model.decisions[shotDecisionKey(track, clip)];
    status.textContent = decision === 'pass' ? '镜头审阅 · 通过' : decision === 'redo' ? '镜头审阅 · 需重做' :
      clip.placeholder ? (model.generic ? '占位镜头 · 待审' : '占位 · 静态首帧 · 待审') : '剪辑片段';
  };
  refreshStatus();
  target.append(status, el('p', timecode(clip.position) + ' – ' + timecode(clipEnd(clip)), { class: 'clip-range' }),
    el('p', (clip.end - clip.start) + ' 帧 · ' + ((clip.end - clip.start) / fps).toFixed(3) + ' 秒 · ' + trackCode(track), { class: 'hint' }));
  if (clip.thumbnail) target.append(el('img', '', { class: 'inspector-still', alt: '项目提供的镜头缩略图', src: clip.thumbnail }));
  if (model.wholeFilm) {
    const actions = el('div', '', { class: 'row' });
    for (const [state, label] of [['pass', '通过'], ['redo', '需重做']]) {
      actions.append(button(label, async () => {
        try {
          const owner = model;
          const result = await request(api('/review-decisions'), { track: track.id, clip: clip.index, revision: model.revision, state });
          owner.decisions[shotDecisionKey(track, clip)] = result.state;
          if (model === owner && status.isConnected) refreshStatus();
        } catch (error) { tell(error.message, true); }
      }));
    }
    actions.append(button('循环本镜', toggleLoop));
    target.append(actions);
    if (clip.graphNode) target.append(button('在 ComfyUI 查看节点 #' + clip.graphNode, () => toggleComfy(true, clip.graphNode)));
  }
  target.append(el('p', '来源 · ' + track.name + ' · ' + clip.bin, { class: 'hint' }));
  if (model.generic) target.append(el('p', '标注编号 · track ' + track.id + ' · clip ' + clip.index, { class: 'hint' }));
  if (clip.effects.length) {
    const effects = el('details');
    effects.append(el('summary', '查看片段效果参数'), el('pre', JSON.stringify(clip.effects, null, 2)));
    target.append(effects);
  }
  target.append(button('看原素材', () => {
    screening = false;
    media('asset', clip.mediaType, model.mediaBase + 'bin-' + encodeURIComponent(clip.bin) + query(), clip.name);
  }, 'secondary'));
  const form = el('form');
  const choice = el('label', '修改方式');
  const operation = el('select', '', { id: 'operation' });
  operation.append(el('option', '裁切源素材入出点', { value: 'trim' }), el('option', '移动片段位置', { value: 'move' }));
  choice.append(operation);
  form.append(choice);
  const trim = el('div', '', { class: 'form-row' });
  trim.append(numberField('source-in', '源入点（帧）', clip.start, clip.max - 1),
    numberField('source-out', '源出点（不含此帧）', clip.end, clip.max));
  const move = numberField('position', '段内位置（帧）', clip.position, model.frames + Math.round(5 * fps));
  move.hidden = true;
  operation.addEventListener('change', () => {
    trim.hidden = operation.value !== 'trim';
    move.hidden = !trim.hidden;
  });
  form.append(trim, move);
  form.append(el('p', fps + ' fps · 裁切保留片段位置，缩短可能留下空位。', { class: 'hint' }));
  const submit = el('button', '另存草稿并渲染', { class: 'primary', type: 'submit', id: 'render-edit' });
  form.append(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const payload = {
        draft, revision: model.revision, track: track.id, clip: clip.index, operation: operation.value,
        start: $('source-in').valueAsNumber, end: $('source-out').valueAsNumber, position: $('position').valueAsNumber
      };
      const run = await request(api('/edits'), payload);
      updateJob(run);
      tell('草稿任务已登记。' + (run.status === 'completed' ? ' 可打开已有预览。' : ' 进度见「工程」。'));
      if (run.status === 'completed') await openDraft(run.id);
      else schedulePoll(run.id);
    } catch (error) {
      tell(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  if (model.canEdit) target.append(form);
  else target.append(el('p', model.wholeFilm ? '当前为审片模式。' : '可查看素材与剪点。要渲染剪辑草稿，请在桌面菜单接入 Kdenlive MCP。', { class: 'hint' }));
  appendInspectorNotes(target);
}

function renderJobs() {
  const root = $('jobs');
  root.replaceChildren();
  if (!model.jobs.length) root.append(el('p', '本画布的本地任务会保存在这里。', { class: 'hint' }));
  for (const run of model.jobs) {
    const item = el('article', '', { class: 'item', 'data-job': run.id });
    item.append(el('h3', run.title), el('p', (statuses[run.status] || run.status) + ' · ' + (stages[run.stage] || run.stage), { class: 'hint' }));
    if (run.kind === 'edit' && run.before) {
      const { before, after } = run;
      item.append(el('small', '位置 ' + before.position + ' → ' + after.position + ' 帧 · 源区间 [' +
        before.start + ', ' + before.end + ') → [' + after.start + ', ' + after.end + ')'));
    }
    if (run.error) item.append(el('p', run.error, { class: 'hint' }));
    if (run.status === 'completed' && run.kind === 'edit') {
      const links = el('div', '', { class: 'row' });
      links.append(button('打开草稿', () => openDraft(run.id).catch(error => tell(error.message, true))),
        el('a', '下载可编辑工程', { href: model.mediaBase + 'editable?draft=' + run.id }));
      item.append(links);
    }
    if (run.status === 'completed' && run.kind === 'references') {
      const refs = el('div', '', { class: 'reference-grid' });
      for (const angle of ['a', 'b', 'c']) {
        const url = model.mediaBase + 'reference-' + angle + '?run=' + run.id;
        const link = el('a', '', { href: url, target: '_blank', rel: 'noopener' });
        link.append(el('img', '', { src: url, alt: angle.toUpperCase() + ' 机位参考', loading: 'lazy' }));
        refs.append(link);
      }
      item.append(refs);
    }
    root.append(item);
  }
}

function updateJob(run) {
  model.jobs = [run, ...model.jobs.filter(item => item.id !== run.id)]
    .sort((a, b) => b.created.localeCompare(a.created));
  renderJobs();
}

function schedulePoll(openId) {
  if (openId) pendingOpen = openId;
  if (polling) return;
  polling = true;
  const epoch = projectEpoch;
  const check = async () => {
    if (epoch !== projectEpoch) return;
    const pending = model.jobs.filter(run => run.status === 'queued' || run.status === 'running');
    try {
      for (const item of pending) {
        const current = await request(api('/jobs/' + item.id));
        if (epoch !== projectEpoch) return;
        if (current.status !== item.status || current.stage !== item.stage) updateJob(current);
        if (current.status === 'completed' && current.id === pendingOpen && current.kind === 'edit') {
          pendingOpen = null;
          await openDraft(current.id);
          tell('草稿预览已完成，可检查修改并打开可编辑工程。');
        }
        if (['failed', 'attention'].includes(current.status)) {
          if (pendingOpen === current.id) pendingOpen = null;
          tell(current.error || '请检查任务。', true);
        }
      }
      if (model.jobs.some(run => run.status === 'queued' || run.status === 'running')) {
        setTimeout(check, 1600);
      } else {
        polling = false;
      }
    } catch (error) {
      polling = false;
      tell('暂时无法读取任务状态。刷新可从项目记录恢复。' + error.message, true);
    }
  };
  setTimeout(check, 300);
}

function renderTasks() {
  const root = $('tasks');
  root.replaceChildren();
  if (!model.tasks.length) root.append(el('p', '这里会保留你的原始指令和按版本回填的结果。', { class: 'hint' }));
  const unavailable = el('section', '', { 'aria-label': '无法定位' });
  for (const item of model.tasks) {
    const location = resolveNote(item);
    const card = el('details', '', { class: 'item', 'data-task': item.id });
    const status = item.result ? '候选已回填' : '待交给 Codex';
    card.append(el('summary', item.title + ' · ' + status));
    card.append(el('p', item.target + ' · ' + model.crafts[item.route], { class: 'hint' }), el('pre', item.text));
    if (item.anchor) {
      card.append(el('p', [anchorDetails(item.anchor), noteStatus(item, location)].filter(Boolean).join(' · '), { class: 'hint' }));
      if (location) card.append(button('跳到这一帧', () => jumpNote(item)));
    }
    const handoff = '项目 ' + model.title + '\n任务 ' + item.title + '\n对象 ' + item.target + '\n路线 ' + model.crafts[item.route] + '\n原文\n' + item.text + '\n本地任务记录 ' + item.receiptPath;
    card.append(button('复制交接指令', async () => {
      try {
        await navigator.clipboard.writeText(handoff);
        tell('已复制。可以粘贴到当前 Codex 对话。');
      } catch {
        tell('可手动复制这条任务记录路径：' + item.receiptPath);
      }
    }));
    if (item.result) {
      card.append(el('p', item.result.note, { class: 'hint' }), el('a', '打开候选结果', {
        href: item.result.url, target: '_blank', rel: 'noopener'
      }));
    }
    (item.anchor && !location ? unavailable : root).append(card);
  }
  if (unavailable.childElementCount) {
    unavailable.prepend(el('h3', '无法定位'));
    root.append(unavailable);
  }
}

function render() {
  player?.pause?.();
  currentView = 'asset';
  $('workspace').hidden = false;
  $('comfy-canvas').hidden = !model.comfyCanvas;
  $('screening').hidden = !model.opening;
  $('run-references').hidden = !model.canReferences;
  $('title').textContent = model.title;
  $('review-version').replaceChildren(
    el('option', draft ? '剪辑草稿' : model.viewLabels?.s03 || '剪辑候选', { value: 's03' }));
  if (model.focus) $('review-version').append(el('option', model.viewLabels?.battle || '重点片段', { value: 'battle' }));
  if (model.opening) $('review-version').append(el('option', model.viewLabels?.opening || '开场', { value: 'opening' }));
  if (draft) $('review-version').append(el('option', '回到项目底稿', { value: 'base' }));
  resetTimeline();
  $('storyboard').href = model.mediaBase + 'storyboard';
  $('storyboard').hidden = model.hasStoryboard === false;
  const assets = $('assets');
  assets.replaceChildren(...model.assets.map(asset => button(asset.title, () => {
    screening = false;
    media('asset', asset.type, asset.url, asset.title);
    $('side-panel').close();
  }, 'secondary')));
  $('bindings').replaceChildren(el('p', '当前剪辑文件 ' + model.timelineFile), el('p', '剪辑版本 ' + model.revision, { class: 'hint' }));
  for (const warning of model.warnings || []) $('bindings').append(el('p', warning, { class: 'hint' }));
  const routes = $('brief').elements.route;
  routes.replaceChildren(...Object.entries(model.crafts).map(([value, label]) => el('option', label, { value })));
  renderTimeline();
  renderInspector();
  renderJobs();
  renderTasks();
}

async function openDraft(id) {
  const next = await request(api(id ? '?draft=' + encodeURIComponent(id) : ''));
  draft = id;
  model = next;
  selected = null;
  setUrl();
  render();
  showSegment('s03');
}

async function boot() {
  const projects = await request('/api/canvas/projects');
  $('project').replaceChildren(...projects.map(p => el('option', p.title, { value: p.id })));
  if (!projects.some(p => p.id === project)) project = projects[0]?.id;
  if (!project) throw new Error('尚未登记画布项目');
  $('project').value = project;
  model = await request(api(query()));
  setUrl();
  render();
  showSegment(draft || !model.opening ? 's03' : 'opening');
  tell(model.warnings?.join(' ') || (draft ? '已恢复选中的工作草稿。' : (model.demo ? '内置示例 · 可离线试用' : '本地项目 · 已同步当前版本')));
  schedulePoll();
}

$('project').addEventListener('change', () => {
  closeQuickNote(false);
  project = $('project').value;
  draft = null;
  selected = null;
  polling = false;
  pendingOpen = null;
  screening = false;
  briefId = null;
  briefAnchor = null;
  lastSavedDirectionId = null;
  $('brief').reset();
  projectEpoch += 1;
  boot().catch(error => tell(error.message, true));
});
$('project-menu').onclick = () => request('/desktop/project-menu', {}).catch(error => tell(error.message, true));
$('review-version').addEventListener('change', () => {
  const view = $('review-version').value;
  if (view === 'base') {
    openDraft(null).catch(error => tell(error.message, true));
    return;
  }
  const frame = isTimelineView() ? playFrame() : 0;
  screening = false;
  clearSelection();
  if (view === 'battle') {
    const start = frame >= model.focus.start && frame < model.focus.end ? frame : model.focus.start;
    showSegment(view, start - model.focus.start);
    setRange(model.focus.start, model.focus.end - model.focus.start, 'act');
  } else {
    showSegment(view, view === 's03' ? frame : 0);
    setRange(0, model.frames, 'full');
  }
});
$('screening').addEventListener('click', () => {
  screening = Boolean(model.opening);
  clearSelection();
  showSegment(model.opening ? 'opening' : 's03', 0, true);
});

let switchingComfy = false;
async function toggleComfy(open, node) {
  if (!model.comfyCanvas || switchingComfy || (!open && document.body.dataset.view !== 'comfy')) return;
  switchingComfy = true;
  const control = $('comfy-canvas');
  control.disabled = true;
  $('return-review').disabled = true;
  const status = $('comfy-status');
  try {
    if (open) {
      player?.pause?.();
      const thumb = $('return-frame');
      thumb.hidden = !(player instanceof HTMLVideoElement && player.readyState >= 2);
      if (!thumb.hidden) thumb.getContext('2d').drawImage(player, 0, 0, thumb.width, thumb.height);
      const clip = selectedClip();
      $('return-label').textContent = '← 返回审片 · ' + timecode(playFrame()) + (clip?.shot ? ' · ' + clip.shot : '');
      document.body.dataset.view = 'comfy';
      $('project').disabled = $('review-version').disabled = true;
      status.hidden = false;
      $('retry-comfy').hidden = true;
      graphStatus('正在连接…');
    }
    const result = await request('/desktop/comfy', { project: open ? project : null, node });
    if (open) graphStatus('本机已连接', result);
    else {
      document.body.dataset.view = 'review';
      $('return-label').textContent = '审片';
      $('return-frame').hidden = status.hidden = true;
      $('project').disabled = $('review-version').disabled = false;
    }
  } catch (error) {
    graphStatus(error.message);
    $('retry-comfy').hidden = false;
  } finally {
    switchingComfy = false;
    control.disabled = false;
    $('return-review').disabled = false;
    control.setAttribute('aria-pressed', document.body.dataset.view === 'comfy');
    $('return-review').setAttribute('aria-pressed', document.body.dataset.view !== 'comfy');
  }
}
function graphStatus(message, result = {}) {
  $('graph-info').textContent = [model.graph?.name, '第 ' + (result.revision ?? model.graph?.revision) + ' 版',
    (result.nodes ?? model.graph?.nodes) + ' 个节点', '只读查看', message].join('　·　');
}
$('comfy-canvas').onclick = () => toggleComfy(true);
$('return-review').onclick = () => toggleComfy(false);
$('retry-comfy').onclick = () => toggleComfy(true);

function clearSelection() {
  selected = null;
  loop = null;
  renderInspector();
  renderTimeline();
}

const panelTitles = { materials: '素材', direction: '导演指令', engineering: '工程' };
function openPanel(name) {
  for (const panel of Object.keys(panelTitles)) $(panel).hidden = panel !== name;
  $('panel-title').textContent = panelTitles[name];
  $('panel-status').hidden = true;
  if (!$('side-panel').open) $('side-panel').showModal();
}
for (const control of document.querySelectorAll('[data-panel]')) {
  control.addEventListener('click', () => openPanel(control.dataset.panel));
}
$('close-panel').addEventListener('click', () => $('side-panel').close());
$('close-inspector').onclick = () => clearSelection();
$('inspect-toggle').onclick = () => $('review').classList.toggle('show-inspector');
function noteTarget({ section, stamp, version }) {
  return (section + ' · ' + stamp + ' · ' + version).slice(0, 120);
}

function noteTitle(text) {
  return text.split(/(?<=[。！？!?])|(?<=\.)\s+/u)[0].slice(0, 100);
}

function closeQuickNote(restoreFocus = true) {
  quickNote = null;
  $('quick-note').hidden = true;
  $('inline-note').value = '';
  if (restoreFocus) $('player').focus({ preventScroll: true });
}

function quickNoteIsAtCurrentFrame() {
  const anchor = quickNote.context.anchor;
  return anchor.frame === playFrame() && anchor.view === currentView &&
    anchor.version === versionName() &&
    anchor.revision === (currentView === 'opening' ? model.opening.revision : model.revision);
}

function setQuickNoteFrame() {
  const id = crypto.randomUUID().replaceAll('-', '');
  quickNote = { context: noteContext(), id, saving: false };
}

function refreshQuickNote() {
  if (!quickNote || quickNote.saving || $('quick-note').hidden) return;
  const ready = currentView !== 'asset' && videoClock?.displayed != null && !videoClock.pending;
  let moved = ready && !quickNoteIsAtCurrentFrame();
  if (moved && !$('inline-note').value.trim()) {
    setQuickNoteFrame();
    moved = false;
  }
  const { anchor, stamp, version } = quickNote.context;
  const current = '当前帧 ' + playFrame() + (anchor.view !== currentView || version !== versionName()
    ? ' · ' + versionName() : '');
  const label = $('inline-note-label');
  label.textContent = moved ? '草稿记在 ' + stamp + '（帧 ' + anchor.frame + '），' + current :
    stamp + ' · ' + version;
  label.title = moved ? label.textContent + ' · ' + version : noteTarget(quickNote.context);
  label.classList.toggle('draft-frame-mismatch', moved);
  $('retarget-note').hidden = !moved;
}

async function openQuickNote() {
  const epoch = projectEpoch;
  if (quickNote?.saving || !await pauseForNote() || epoch !== projectEpoch ||
    quickNote?.saving || document.body.dataset.view === 'comfy') return;
  if (!quickNote || !quickNoteIsAtCurrentFrame()) setQuickNoteFrame();
  $('quick-note').hidden = false;
  refreshQuickNote();
  $('inline-note').focus();
}

$('note-at-time').addEventListener('click', openQuickNote);
$('retarget-note').addEventListener('click', openQuickNote);
$('quick-note').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || quickNote?.saving) return;
  event.preventDefault();
  event.stopPropagation();
  closeQuickNote();
});
async function saveQuickNote() {
  const active = quickNote;
  const input = $('inline-note');
  const text = input.value.trim();
  if (!active || !text || active.saving) return;
  active.saving = true;
  const controls = [...$('quick-note').elements];
  for (const control of controls) control.disabled = true;
  try {
    const saved = await saveBrief({ id: active.id, title: noteTitle(text), text, target: noteTarget(active.context),
      route: 'direction', anchor: active.context.anchor });
    lastSavedDirectionId = saved.id;
    if (quickNote === active) {
      closeQuickNote();
      tell('已保存指令。');
    }
    return saved;
  } finally {
    active.saving = false;
    for (const control of controls) control.disabled = false;
    if (quickNote === active) { refreshQuickNote(); input.focus(); }
  }
}
$('quick-note').addEventListener('submit', async event => {
  event.preventDefault();
  try { await saveQuickNote(); }
  catch (error) { tell(error.message, true); }
});
$('inline-note').addEventListener('input', () => {
  if (quickNote && !quickNote.saving) quickNote.id = crypto.randomUUID().replaceAll('-', '');
  refreshQuickNote();
});
$('detail-note').addEventListener('click', () => {
  if (!quickNote) return;
  const form = $('brief').elements;
  const unfinished = Boolean(form.title.value || form.target.value || form.text.value);
  openPanel('direction');
  $('new-brief').open = true;
  if (unfinished) {
    tell('详细表单有未保存内容，快记草稿仍在播放器下方。');
  } else {
    const text = $('inline-note').value.trim();
    briefAnchor = quickNote.context.anchor;
    form.target.value = noteTarget(quickNote.context);
    form.route.value = 'direction';
    form.title.value = noteTitle(text);
    form.text.value = text;
    closeQuickNote(false);
  }
  form.title.focus();
});
$('brief').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    briefId ||= crypto.randomUUID().replaceAll('-', '');
    const payload = Object.fromEntries(new FormData(event.target));
    await saveBrief({ ...payload, id: briefId, anchor: briefAnchor || undefined });
    briefId = null;
    briefAnchor = null;
    event.target.reset();
    renderInspector();
    tell('已保存指令。打开该条目可复制交接信息。');
  } catch (error) {
    tell(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
$('run-references').addEventListener('click', async event => {
  const control = event.currentTarget;
  control.disabled = true;
  try {
    const run = await request(api('/references'), {});
    updateJob(run);
    schedulePoll();
    tell(run.status === 'completed' ? '已打开完成记录。' : '三机位本地工作流已登记，零积分。');
  } catch (error) {
    tell(error.message, true);
  } finally {
    control.disabled = false;
  }
});

function mcpFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function mcpReviewState() {
  if (!model || !(player instanceof HTMLVideoElement)) {
    return { ready: false, project_id: project || null };
  }
  const media = currentView === 'battle' ? model.focus : currentView === 'opening' ? model.opening : model.video;
  const clip = selectedClip();
  const draftFields = $('brief').elements;
  return {
    ready: player.readyState >= 2 && videoClock?.displayed != null && !videoClock.pending,
    project_id: project, revision: currentView === 'opening' ? model.opening.revision : model.revision,
    video_sha256: media?.actualSha256 || media?.sha256 || null, video_version: versionName(), current_view: currentView,
    displayed_frame: playFrame(), requested_frame: videoClock?.target == null ? null : videoClock.target + mediaOffset(),
    fps: model.fps, frames: currentView === 'opening' ? media?.frames || Math.round(player.duration * model.fps) : model.frames,
    current_time: player.currentTime + mediaOffset() / model.fps,
    available_views: ['s03', ...(model.focus ? ['battle'] : []), ...(model.opening ? ['opening'] : [])],
    paused: player.paused, ended: player.ended, ready_state: player.readyState,
    media_error: player.error ? { code: player.error.code, message: player.error.message } : null,
    network_state: player.networkState,
    selected_clip: clip ? { track: selected.track, clip: selected.clip, shot: clip.shot || null, frame: clip.position } : null,
    quick_note: quickNote ? { id: quickNote.id, frame: quickNote.context.anchor.frame,
      has_text: Boolean($('inline-note').value.trim()), saving: quickNote.saving } : null,
    unsaved_direction: Boolean((quickNote && $('inline-note').value.trim()) || quickNote?.saving ||
      draftFields.title.value.trim() || draftFields.target.value.trim() || draftFields.text.value.trim()),
    last_saved_direction_id: lastSavedDirectionId,
    directions: model.tasks.filter(task => task.route === 'direction').map(task => ({
      id: task.id, title: task.title, anchor: task.anchor, resolved: resolveNote(task) })),
    shots: pictureClips().filter(item => item.shot).map(item => ({ id: item.shot, frame: item.position })),
  };
}

async function mcpWaitForFrame(frame, epoch) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (epoch !== projectEpoch) throw mcpFailure('project_changed', '项目在操作过程中发生变化');
    if (videoClock?.displayed != null && !videoClock.pending && !player.seeking &&
        (frame === undefined || playFrame() === frame)) return mcpReviewState();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw mcpFailure('frame_not_settled', '未能确认实际显示帧，请先读取当前状态');
}

function mcpCheckIdentity(command) {
  const state = mcpReviewState();
  const canStartLoading = ['play', 'seek_frame', 'select_view'].includes(command.action) && state.ready_state >= 1;
  if (!state.ready && !canStartLoading) throw mcpFailure('not_ready', '影片尚未加载完成');
  if (state.media_error) throw mcpFailure('media_error', state.media_error.message || '影片解码失败');
  if (command.project_id !== state.project_id || command.expected_revision !== state.revision ||
      command.expected_video_sha256 !== state.video_sha256) {
    throw mcpFailure('version_changed', '项目、时间轴或视频版本不匹配');
  }
  if (currentView === 'asset' || document.body.dataset.view === 'comfy') {
    throw mcpFailure('unsupported_view', '请先切换到影片审看视图');
  }
  return state;
}

window.productionCanvasMcp = async command => {
  const actions = ['state', 'select_view', 'seek_frame', 'navigate_shot', 'play', 'pause',
    'open_direction', 'save_direction', 'jump_to_direction'];
  if (!command || !actions.includes(command.action)) throw mcpFailure('unknown_command', '不支持的画布控制命令');
  if (command.action === 'state') return mcpReviewState();
  const state = mcpCheckIdentity(command);
  const epoch = projectEpoch;
  const moving = ['select_view', 'seek_frame', 'navigate_shot', 'play', 'jump_to_direction'].includes(command.action);
  if (moving && (quickNote?.saving || (quickNote && $('inline-note').value.trim()))) {
    throw mcpFailure('unsaved_direction', '请先保存当前导演指令');
  }
  if (command.action === 'select_view') {
    if (!state.available_views.includes(command.view)) throw mcpFailure('unknown_view', '该审片版本不存在');
    if (command.view === currentView) return mcpReviewState();
    if (quickNote) closeQuickNote(false);
    showSegment(command.view, 0, false, true);
    return mcpWaitForFrame(command.view === 'battle' ? model.focus.start : 0, epoch);
  }
  if (command.action === 'play') {
    loop = null;
    screening = false;
    await player.play();
    return mcpReviewState();
  }
  if (command.action === 'pause') {
    if (!await pauseForNote()) throw mcpFailure('pause_failed', '未能确认暂停帧');
    return mcpWaitForFrame(undefined, epoch);
  }
  if (command.action === 'seek_frame' || command.action === 'navigate_shot') {
    const shot = command.action === 'navigate_shot' ? pictureClips().find(item => item.shot === (command.shot || command.shot_id)) : null;
    const frame = shot ? shot.position : command.frame;
    const frames = currentView === 'opening' && command.action === 'seek_frame'
      ? Math.round(player.duration * model.fps) : model.frames;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frames) {
      throw mcpFailure('invalid_frame', '目标帧或镜头不存在');
    }
    if (command.action === 'navigate_shot' && !shot) throw mcpFailure('unknown_shot', '镜头不存在');
    if (quickNote) closeQuickNote(false);
    if (currentView === 'opening' && command.action === 'seek_frame') seekLocalFrame(frame, true);
    else seekFrame(frame);
    return mcpWaitForFrame(frame, epoch);
  }
  if (command.action === 'open_direction') {
    if (quickNote && $('inline-note').value.trim() && !quickNoteIsAtCurrentFrame()) {
      throw mcpFailure('unsaved_direction', '请先处理原帧上的导演草稿');
    }
    await openQuickNote();
    if (!quickNote) throw mcpFailure('note_not_ready', '导演指令框未能打开');
    return mcpReviewState();
  }
  if (command.action === 'save_direction') {
    if (!/^[a-f0-9]{32}$/.test(command.operation_id || '') || typeof command.text !== 'string' ||
        !command.text.trim() || command.text.length > 16000) throw mcpFailure('invalid_direction', '指令编号或内容无效');
    const text = command.text.trim();
    const previous = model.tasks.find(task => task.id === command.operation_id);
    if (previous) {
      if (previous.route !== 'direction' || previous.text !== text || previous.anchor?.revision !== state.revision ||
          previous.anchor?.version !== state.video_version) throw mcpFailure('operation_conflict', '操作编号已用于另一条指令');
      lastSavedDirectionId = previous.id;
      return { ...mcpReviewState(), direction_id: previous.id, direction: previous, idempotent: true };
    }
    const retryDraft = quickNote && quickNote.id === command.operation_id &&
      $('inline-note').value.trim() === text && quickNoteIsAtCurrentFrame() &&
      quickNote.context.anchor.revision === state.revision && quickNote.context.version === state.video_version;
    if (quickNote?.saving || (quickNote && $('inline-note').value.trim() && !retryDraft)) {
      throw mcpFailure('unsaved_direction', '请先处理已有导演草稿');
    }
    await openQuickNote();
    mcpCheckIdentity(command);
    if (epoch !== projectEpoch || !quickNote || !quickNoteIsAtCurrentFrame()) throw mcpFailure('frame_changed', '指令锚点已变化');
    quickNote.id = command.operation_id;
    $('inline-note').value = text;
    const saved = await saveQuickNote();
    if (!saved) throw mcpFailure('save_failed', '指令未保存');
    return { ...mcpReviewState(), direction_id: saved.id, direction: saved, idempotent: false };
  }
  const task = model.tasks.find(item => item.id === command.direction_id);
  const location = task && resolveNote(task);
  if (!location) throw mcpFailure('unresolved_direction', '这条指令无法定位到当前版本');
  if (quickNote) closeQuickNote(false);
  jumpNote(task);
  return mcpWaitForFrame(location.frame, epoch);
};

document.addEventListener('DOMContentLoaded', () => boot().catch(error => tell(error.message, true)));
