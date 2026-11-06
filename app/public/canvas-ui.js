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
let projectLoad = 0;

const stages = {
  start: 'Queued', connect: 'Connecting local tool', copy: 'Copying working version', edit: 'Editing timeline',
  'starting-render': 'Preparing render', render: 'Rendering preview', validate: 'Validating workflow', comfy: 'Retrieving references', review: 'Ready for review'
};
const statuses = { completed: 'Completed - candidate', failed: 'Failed', attention: 'Needs attention', running: 'Running', queued: 'Queued' };
const trackLabels = {
  'Lighting review picture': 'Picture source', 'Title - approved typography': 'Title overlay',
  'room-tone': 'Room tone', breath: 'Breath', steps: 'Footsteps', button: 'Button', landing: 'Landing',
  clothing: 'Clothing', 'Main score - EMPTY': 'Main score - pending'
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
  if (!response.ok) throw new Error(value.error || 'Request failed');
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
  return Number(value).toFixed(2) + ' s';
}

function countLabel(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

function setUrl(view) {
  const url = new URL(location.href);
  url.searchParams.set('project', project);
  if (draft) url.searchParams.set('draft', draft);
  else url.searchParams.delete('draft');
  if (view) url.searchParams.set('view', view);
  else url.searchParams.delete('view');
  history.replaceState(null, '', url);
}

const reviewMonitor = $('review').querySelector('.monitor');
const fullscreenControl = $('review-fullscreen');
async function toggleReviewFullscreen() {
  try {
    if (document.fullscreenElement === reviewMonitor) await document.exitFullscreen();
    else await reviewMonitor.requestFullscreen();
  } catch (error) {
    tell('Could not change fullscreen mode: ' + error.message, true);
  }
}
fullscreenControl.addEventListener('click', toggleReviewFullscreen);
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement === reviewMonitor ? 'Exit fullscreen' : 'Fullscreen';
  fullscreenControl.setAttribute('aria-label', label);
  fullscreenControl.title = label;
});

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
  fullscreenControl.hidden = !document.fullscreenEnabled || type === 'audio';
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
        tell('The current review sequence has ended.');
      }
    });
  }
  player.addEventListener('error', () => {
    if (player === mediaNode) tell('This source cannot play. Check the file or select a section preview.', true);
  });
  $('player').replaceChildren(player);
  renderTransport();
  renderTimeline();
  if (play && type !== 'image') {
    mediaNode.play().catch(() => {
      if (player === mediaNode) tell('Next section selected. Press Play to continue.');
    });
  }
}

function showSegment(view, start = 0, play = false, exact = false) {
  if (!model) return;
  if (view === 'battle') {
    media(view, 'video', model.focus.url, model.viewLabels?.battle || 'Focus range', start, play, exact);
  } else {
    const opening = view === 'opening';
    media(view, 'video', opening ? model.opening.url : model.segment.url,
      opening ? (model.opening.approved ? 'Opening - approved' : 'Opening - current record') :
        (draft ? 'Draft preview' : model.viewLabels?.s03 || 'Edit candidate'), start, play, exact);
    if (opening) {
      for (const marker of model.opening.markers || []) {
        $('markers').append(button(marker.label + ' · ' + sec(marker.seconds), () => {
          seekLocalFrame(Math.round(marker.seconds * model.fps));
        }));
      }
    }
  }
  setUrl(view);
  if (!draft) request('/desktop/review-selection', { project, view }).catch(error => tell(error.message, true));
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
    status.textContent = decision === 'pass' ? 'Shot review - accepted' : decision === 'redo' ? 'Shot review - revise' :
      clip.placeholder ? (model.generic ? 'Placeholder shot - pending' : 'Placeholder - static first frame - pending') : 'Edit clip';
  };
  refreshStatus();
  target.append(status, el('p', timecode(clip.position) + ' – ' + timecode(clipEnd(clip)), { class: 'clip-range' }),
    el('p', countLabel(clip.end - clip.start, 'frame') + ' - ' + ((clip.end - clip.start) / fps).toFixed(3) + ' s · ' + trackCode(track), { class: 'hint' }));
  if (clip.thumbnail) target.append(el('img', '', { class: 'inspector-still', alt: 'Project-provided shot thumbnail', src: clip.thumbnail }));
  if (model.wholeFilm) {
    const actions = el('div', '', { class: 'row' });
    for (const [state, label] of [['pass', 'Accept'], ['redo', 'Revise']]) {
      actions.append(button(label, async () => {
        try {
          const owner = model;
          const result = await request(api('/review-decisions'), { track: track.id, clip: clip.index, revision: model.revision, state });
          owner.decisions[shotDecisionKey(track, clip)] = result.state;
          if (model === owner && status.isConnected) refreshStatus();
        } catch (error) { tell(error.message, true); }
      }));
    }
    actions.append(button('Loop shot', toggleLoop));
    target.append(actions);
    if (clip.graphNode) target.append(button('View ComfyUI node #' + clip.graphNode, () => toggleComfy(true, clip.graphNode)));
  }
  target.append(el('p', 'Source - ' + track.name + ' · ' + clip.bin, { class: 'hint' }));
  if (model.generic) target.append(el('p', 'Annotation reference - track ' + track.id + ' · clip ' + clip.index, { class: 'hint' }));
  if (clip.effects.length) {
    const effects = el('details');
    effects.append(el('summary', 'Show clip effect parameters'), el('pre', JSON.stringify(clip.effects, null, 2)));
    target.append(effects);
  }
  target.append(button('View source', () => {
    screening = false;
    media('asset', clip.mediaType, model.mediaBase + 'bin-' + encodeURIComponent(clip.bin) + query(), clip.name);
  }, 'secondary'));
  const form = el('form');
  const choice = el('label', 'Edit operation');
  const operation = el('select', '', { id: 'operation' });
  operation.append(el('option', 'Trim source in/out points', { value: 'trim' }), el('option', 'Move clip', { value: 'move' }));
  choice.append(operation);
  form.append(choice);
  const trim = el('div', '', { class: 'form-row' });
  trim.append(numberField('source-in', 'Source in (frame)', clip.start, clip.max - 1),
    numberField('source-out', 'Source out (exclusive)', clip.end, clip.max));
  const move = numberField('position', 'Position in sequence (frame)', clip.position, model.frames + Math.round(5 * fps));
  move.hidden = true;
  operation.addEventListener('change', () => {
    trim.hidden = operation.value !== 'trim';
    move.hidden = !trim.hidden;
  });
  form.append(trim, move);
  form.append(el('p', fps + ' fps - trimming preserves clip position. Shortening can leave a gap.', { class: 'hint' }));
  const submit = el('button', 'Save draft and render', { class: 'primary', type: 'submit', id: 'render-edit' });
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
      tell('Draft job registered.' + (run.status === 'completed' ? ' The existing preview is available.' : ' See Details for progress.'));
      if (run.status === 'completed') await openDraft(run.id);
      else schedulePoll(run.id);
    } catch (error) {
      tell(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  if (model.canEdit) target.append(form);
  else target.append(el('p', model.wholeFilm ? 'Review mode is active.' : 'Inspect sources and cuts. To render a draft, connect Kdenlive MCP from the desktop menu.', { class: 'hint' }));
  appendInspectorNotes(target);
}

function renderJobs() {
  const root = $('jobs');
  root.replaceChildren();
  if (!model.jobs.length) root.append(el('p', 'Local canvas jobs appear here.', { class: 'hint' }));
  for (const run of model.jobs) {
    const item = el('article', '', { class: 'item', 'data-job': run.id });
    item.append(el('h3', run.title), el('p', (statuses[run.status] || run.status) + ' · ' + (stages[run.stage] || run.stage), { class: 'hint' }));
    if (run.kind === 'edit' && run.before) {
      const { before, after } = run;
      item.append(el('small', 'Position ' + before.position + ' → ' + after.position + ' frames - source range [' +
        before.start + ', ' + before.end + ') → [' + after.start + ', ' + after.end + ')'));
    }
    if (run.error) item.append(el('p', run.error, { class: 'hint' }));
    if (run.status === 'completed' && run.kind === 'edit') {
      const links = el('div', '', { class: 'row' });
      links.append(button('Open draft', () => openDraft(run.id).catch(error => tell(error.message, true))),
        el('a', 'Download editable project', { href: model.mediaBase + 'editable?draft=' + run.id }));
      item.append(links);
    }
    if (run.status === 'completed' && run.kind === 'references') {
      const refs = el('div', '', { class: 'reference-grid' });
      for (const angle of ['a', 'b', 'c']) {
        const url = model.mediaBase + 'reference-' + angle + '?run=' + run.id;
        const link = el('a', '', { href: url, target: '_blank', rel: 'noopener' });
        link.append(el('img', '', { src: url, alt: angle.toUpperCase() + ' camera reference', loading: 'lazy' }));
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
          tell('Draft preview is ready. Inspect the changes or open the editable project.');
        }
        if (['failed', 'attention'].includes(current.status)) {
          if (pendingOpen === current.id) pendingOpen = null;
          tell(current.error || 'Check the job.', true);
        }
      }
      if (model.jobs.some(run => run.status === 'queued' || run.status === 'running')) {
        setTimeout(check, 1600);
      } else {
        polling = false;
      }
    } catch (error) {
      polling = false;
      tell('Job status is temporarily unavailable. Reload to recover the project record. ' + error.message, true);
    }
  };
  setTimeout(check, 300);
}

function renderTasks() {
  const root = $('tasks');
  root.replaceChildren();
  if (!model.tasks.length) root.append(el('p', 'Original annotations and version-linked results appear here.', { class: 'hint' }));
  const unavailable = el('section', '', { 'aria-label': 'Unlocated' });
  for (const item of model.tasks) {
    const location = resolveNote(item);
    const card = el('details', '', { class: 'item', 'data-task': item.id });
    const status = item.result ? 'Candidate attached' : 'Ready for Codex';
    card.append(el('summary', item.title + ' · ' + status));
    card.append(el('p', item.target + ' · ' + model.crafts[item.route], { class: 'hint' }), el('pre', item.text));
    if (item.anchor) {
      card.append(el('p', [anchorDetails(item.anchor), noteStatus(item, location)].filter(Boolean).join(' · '), { class: 'hint' }));
      if (location) card.append(button('Go to frame', () => jumpNote(item)));
    }
    const handoff = [
      'Production Canvas annotation',
      'Project ' + model.title,
      'Annotation ' + item.title,
      'Target ' + item.target,
      'Workflow ' + model.crafts[item.route],
      'Original author text', item.text,
      'Original frame anchor', JSON.stringify(item.anchor || {}, null, 2),
      'Current resolved location', JSON.stringify(location || { status: 'unlocated' }, null, 2),
      'Local record ' + item.receiptPath
    ].join('\n');
    card.append(button('Copy for Codex', async () => {
      try {
        await navigator.clipboard.writeText(handoff);
        tell('Copied. Paste into your current Codex chat.');
      } catch {
        tell('Copy this task-record path manually: ' + item.receiptPath);
      }
    }));
    if (item.result) {
      card.append(el('p', item.result.note, { class: 'hint' }), el('a', 'Open candidate', {
        href: item.result.url, target: '_blank', rel: 'noopener'
      }));
    }
    (item.anchor && !location ? unavailable : root).append(card);
  }
  if (unavailable.childElementCount) {
    unavailable.prepend(el('h3', 'Unlocated'));
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
    el('option', draft ? 'Edit draft' : model.viewLabels?.s03 || 'Edit candidate', { value: 's03' }));
  if (model.focus) $('review-version').append(el('option', model.viewLabels?.battle || 'Focus range', { value: 'battle' }));
  if (model.opening) $('review-version').append(el('option', model.viewLabels?.opening || 'Opening', { value: 'opening' }));
  if (draft) $('review-version').append(el('option', 'Return to source edit', { value: 'base' }));
  resetTimeline();
  $('storyboard').href = model.mediaBase + 'storyboard';
  $('storyboard').hidden = model.hasStoryboard === false;
  const assets = $('assets');
  assets.replaceChildren(...model.assets.map(asset => button(asset.title, () => {
    screening = false;
    media('asset', asset.type, asset.url, asset.title);
    $('side-panel').close();
  }, 'secondary')));
  $('bindings').replaceChildren(el('p', 'Current edit file ' + model.timelineFile), el('p', 'Edit revision ' + model.revision, { class: 'hint' }));
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

async function boot(view, nextProject = project, nextDraft = draft) {
  const load = ++projectLoad;
  const projects = await request('/api/canvas/projects');
  if (!nextProject) nextProject = projects[0]?.id;
  if (!projects.some(p => p.id === nextProject)) throw new Error('This project is not registered. Open it again from the project menu.');
  const next = await request('/api/canvas/projects/' + encodeURIComponent(nextProject) +
    (nextDraft ? '?draft=' + encodeURIComponent(nextDraft) : ''));
  if (view && !['s03', ...(next.focus ? ['battle'] : []), ...(next.opening ? ['opening'] : [])].includes(view)) {
    throw new Error('No review version in this project matches the selected video.');
  }
  if (load !== projectLoad) return;
  if (model && hasUnsavedDirection()) throw new Error('Save or discard the current annotation before switching projects.');
  closeQuickNote(false);
  projectEpoch += 1;
  selected = null;
  polling = false;
  pendingOpen = null;
  screening = false;
  briefId = null;
  briefAnchor = null;
  lastSavedDirectionId = null;
  $('brief').reset();
  project = nextProject;
  draft = nextDraft;
  model = next;
  $('project').replaceChildren(...projects.map(p => el('option', p.title, { value: p.id })));
  $('project').value = project;
  render();
  showSegment(view || (draft || !model.opening ? 's03' : 'opening'));
  tell(model.warnings?.join(' ') || (draft ? 'Selected working draft restored.' : (model.demo ? 'Built-in sample - available offline' : 'Local project - current version loaded')));
  schedulePoll();
}

$('project').addEventListener('change', () => {
  const next = $('project').value;
  $('project').value = project;
  if (hasUnsavedDirection()) return tell('Save or discard the current annotation before switching projects.', true);
  boot(undefined, next, null).catch(error => tell(error.message, true));
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
      if (document.fullscreenElement === reviewMonitor) await document.exitFullscreen();
      player?.pause?.();
      const thumb = $('return-frame');
      thumb.hidden = !(player instanceof HTMLVideoElement && player.readyState >= 2);
      if (!thumb.hidden) thumb.getContext('2d').drawImage(player, 0, 0, thumb.width, thumb.height);
      const clip = selectedClip();
      $('return-label').textContent = 'Back to review - ' + timecode(playFrame()) + (clip?.shot ? ' · ' + clip.shot : '');
      document.body.dataset.view = 'comfy';
      $('project').disabled = $('review-version').disabled = true;
      status.hidden = false;
      $('retry-comfy').hidden = true;
      graphStatus('Connecting...');
    }
    const result = await request('/desktop/comfy', { project: open ? project : null, node });
    if (open) graphStatus('Local connection ready', result);
    else {
      document.body.dataset.view = 'review';
      $('return-label').textContent = 'Review';
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
  $('graph-info').textContent = [model.graph?.name, 'Revision ' + (result.revision ?? model.graph?.revision),
    (result.nodes ?? model.graph?.nodes) + ' nodes', 'Read-only view', message].join(' · ');
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

const panelTitles = { materials: 'Sources', direction: 'Frame annotations', engineering: 'Details' };
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
  return text.split(/(?<=[.！？!?])|(?<=\.)\s+/u)[0].slice(0, 100);
}

function closeQuickNote(restoreFocus = true) {
  quickNote = null;
  $('quick-note').hidden = true;
  $('inline-note').value = '';
  if (restoreFocus) $('player').focus({ preventScroll: true });
}

function hasUnsavedDirection() {
  const fields = $('brief').elements;
  return Boolean((quickNote && $('inline-note').value.trim()) || quickNote?.saving ||
    fields.title.value.trim() || fields.target.value.trim() || fields.text.value.trim());
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
  const current = 'Current frame ' + playFrame() + (anchor.view !== currentView || version !== versionName()
    ? ' · ' + versionName() : '');
  const label = $('inline-note-label');
  label.textContent = moved ? 'Draft anchored at ' + stamp + ' (frame ' + anchor.frame + '). ' + current :
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
      tell('Annotation saved.');
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
    tell('The detailed form has unsaved text. Your quick annotation remains below the player.');
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
    tell('Annotation saved. Open its record to copy the Codex handoff.');
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
    tell(run.status === 'completed' ? 'Completed record opened.' : 'Three-angle local workflow registered. No generation credits used.');
  } catch (error) {
    tell(error.message, true);
  } finally {
    control.disabled = false;
  }
});

function mcpFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function mcpReviewVideo(view) {
  if (view === 'opening' && model.opening) {
    const { url, version, actualSha256, seconds } = model.opening;
    return { url, version, sha256: actualSha256, start: 0, end: Math.round(seconds * model.fps) };
  }
  if (view === 'battle' && model.focus) {
    const { url, version, actualSha256, start, end } = model.focus;
    return { url, version, sha256: actualSha256, start, end };
  }
  if (view === 's03') {
    const { url, version } = model.segment;
    const sha256 = draft ? model.jobs.find(job => job.id === draft)?.preview_sha256 : model.video.actualSha256;
    return { url, version, sha256, start: 0, end: model.frames };
  }
  return null;
}

function mcpReviewState() {
  if (!model || !(player instanceof HTMLVideoElement)) {
    return { ready: false, project_id: project || null };
  }
  const media = mcpReviewVideo(currentView);
  const clip = selectedClip();
  return {
    ready: player.readyState >= 2 && videoClock?.displayed != null && !videoClock.pending,
    project_id: project, revision: currentView === 'opening' ? model.opening.revision : model.revision,
    video_sha256: media?.sha256 || null, video_version: versionName(), current_view: currentView,
    displayed_frame: playFrame(), requested_frame: videoClock?.target == null ? null : videoClock.target + mediaOffset(),
    fps: model.fps, frames: currentView === 'opening' ? model.opening.frames || Math.round(player.duration * model.fps) : model.frames,
    current_time: player.currentTime + mediaOffset() / model.fps,
    available_views: ['s03', ...(model.focus ? ['battle'] : []), ...(model.opening ? ['opening'] : [])],
    paused: player.paused, ended: player.ended, ready_state: player.readyState,
    media_error: player.error ? { code: player.error.code, message: player.error.message } : null,
    network_state: player.networkState,
    selected_clip: clip ? { track: selected.track, clip: selected.clip, shot: clip.shot || null, frame: clip.position } : null,
    quick_note: quickNote ? { id: quickNote.id, frame: quickNote.context.anchor.frame,
      has_text: Boolean($('inline-note').value.trim()), saving: quickNote.saving } : null,
    unsaved_direction: hasUnsavedDirection(),
    last_saved_direction_id: lastSavedDirectionId,
    directions: model.tasks.filter(task => task.route === 'direction').map(task => ({
      id: task.id, title: task.title, anchor: task.anchor, resolved: resolveNote(task) })),
    shots: pictureClips().filter(item => item.shot).map(item => ({ id: item.shot, frame: item.position })),
  };
}

function mcpDirectionContext(state) {
  const views = {};
  for (const view of state.available_views) {
    const { url: _localUrl, ...video } = mcpReviewVideo(view);
    views[view] = { ...video, label: model.viewLabels?.[view] };
  }
  const directions = model.tasks.map(({ id, title, target, text, route, created, anchor }) => {
    const entry = { id, title, target, text, route, created, anchor: anchor ? { ...anchor, timecode: timecode(anchor.frame) } : null };
    const location = resolveNote({ anchor });
    if (!location) return { ...entry, status: anchor ? 'unlocated' : 'unanchored' };
    const { frame, view } = location;
    const video = views[view];
    const shots = view === 'opening' ? null : noteShotContext(model, anchor, frame);
    const frames = new Map();
    const add = (number, role) => {
      if (number < video.start || number >= video.end) return;
      if (!frames.has(number)) frames.set(number, { frame: number, timecode: timecode(number), roles: [] });
      frames.get(number).roles.push(role);
    };
    add(frame, 'anchor');
    for (const offset of [-2, -1, 1, 2]) add(frame + offset, offset < 0 ? 'before' : 'after');
    if (shots?.previous) add(shots.previous.end - 1, 'previous_shot_end');
    if (shots?.next) add(shots.next.start, 'next_shot_start');
    return { ...entry, status: 'located', resolved: { ...location, timecode: timecode(frame) }, shots,
      frames: [...frames.values()].sort((a, b) => a.frame - b.frame) };
  });
  return { project_id: state.project_id, title: model.title, revision: state.revision, fps: state.fps, views, directions };
}

async function mcpDirectionFrames(command) {
  const owner = model;
  const videoInfo = mcpReviewVideo(command.view);
  const frames = command.frames;
  if (!videoInfo?.sha256 || !Array.isArray(frames) || frames.length < 1 || frames.length > 8 ||
      frames.some(frame => !Number.isSafeInteger(frame) || frame < videoInfo.start || frame >= videoInfo.end) ||
      new Set(frames).size !== frames.length) throw mcpFailure('invalid_frames', 'Invalid annotation frame range');

  const video = el('video', '', { 'aria-hidden': 'true', inert: '' });
  video.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1px;height:1px;opacity:0;pointer-events:none';
  video.preload = 'auto';
  video.muted = true;
  let displayed = null;
  let callback;
  const follow = (_, { mediaTime }) => {
    displayed = frameFromMediaTime(mediaTime);
    callback = video.requestVideoFrameCallback(follow);
  };
  const wait = async (test, timeout) => {
    const deadline = Date.now() + timeout;
    while (!test() && !video.error && model === owner && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return test();
  };
  const width = 384, height = 240;
  const columns = Math.min(frames.length, 4);
  const sheet = el('canvas', '', { width: columns * width, height: Math.ceil(frames.length / columns) * height });
  const paint = sheet.getContext('2d');
  const tiles = [];
  document.body.append(video);
  try {
    callback = video.requestVideoFrameCallback(follow);
    video.src = videoInfo.url;
    const loaded = await wait(() => video.readyState >= 1, 3000);
    for (const [index, frame] of frames.entries()) {
      if (model !== owner) throw mcpFailure('project_changed', 'Project changed while capturing frames');
      const x = index % columns * width;
      const y = Math.floor(index / columns) * height;
      const local = frame - videoInfo.start;
      const time = frameMidpoint(local);
      let confirmed = false;
      if (loaded && time < video.duration && !video.error) {
        video.currentTime = time;
        confirmed = await wait(() => !video.seeking && video.readyState >= 2 && displayed === local, 1500);
      }
      paint.fillStyle = '#151515';
      paint.fillRect(x, y, width, height);
      if (confirmed) {
        const scale = Math.min(width / video.videoWidth, (height - 24) / video.videoHeight);
        const w = video.videoWidth * scale, h = video.videoHeight * scale;
        paint.drawImage(video, x + (width - w) / 2, y + (height - 24 - h) / 2, w, h);
      }
      const stamp = timecode(frame);
      paint.fillStyle = '#ededed';
      paint.font = '15px sans-serif';
      paint.fillText(stamp + '  /  Frame ' + frame + (confirmed ? '' : '  /  Unavailable'), x + 8, y + height - 7);
      tiles.push({ frame, timecode: stamp, x, y, width, height, status: confirmed ? 'verified' : 'unavailable' });
    }
    if (model !== owner) throw mcpFailure('project_changed', 'Project changed while capturing frames');
    mcpCheckIdentity(command);
    return { view: command.view, version: videoInfo.version, video_sha256: videoInfo.sha256, tiles,
      ...(tiles.some(tile => tile.status === 'verified') ? { jpeg_base64: sheet.toDataURL('image/jpeg', .91).split(',')[1] } : {}) };
  } finally {
    video.cancelVideoFrameCallback(callback);
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

async function mcpWaitForFrame(frame, epoch) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (epoch !== projectEpoch) throw mcpFailure('project_changed', 'Project changed during the operation');
    if (videoClock?.displayed != null && !videoClock.pending && !player.seeking &&
        (frame === undefined || playFrame() === frame)) return mcpReviewState();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw mcpFailure('frame_not_settled', 'The displayed frame could not be confirmed. Read the current state');
}

function mcpCheckIdentity(command) {
  const state = mcpReviewState();
  const canStartLoading = ['play', 'seek_frame', 'select_view'].includes(command.action) && state.ready_state >= 1;
  if (!state.ready && !canStartLoading) throw mcpFailure('not_ready', 'The film has not finished loading');
  if (state.media_error) throw mcpFailure('media_error', state.media_error.message || 'Film decoding failed');
  if (command.project_id !== state.project_id || command.expected_revision !== state.revision ||
      command.expected_video_sha256 !== state.video_sha256) {
    throw mcpFailure('version_changed', 'Project, timeline, or video version does not match');
  }
  if (currentView === 'asset' || document.body.dataset.view === 'comfy') {
    throw mcpFailure('unsupported_view', 'Switch to the film review view first');
  }
  return state;
}

window.productionCanvasMcp = async command => {
  const actions = ['state', 'select_view', 'seek_frame', 'navigate_shot', 'play', 'pause',
    'open_direction', 'save_direction', 'jump_to_direction', 'list_direction_context', 'capture_direction_frames'];
  if (!command || !actions.includes(command.action)) throw mcpFailure('unknown_command', 'Unsupported canvas command');
  if (command.action === 'state') return mcpReviewState();
  const state = mcpCheckIdentity(command);
  if (command.action === 'list_direction_context') return mcpDirectionContext(state);
  if (command.action === 'capture_direction_frames') return mcpDirectionFrames(command);
  const epoch = projectEpoch;
  const moving = ['select_view', 'seek_frame', 'navigate_shot', 'play', 'jump_to_direction'].includes(command.action);
  if (moving && (quickNote?.saving || (quickNote && $('inline-note').value.trim()))) {
    throw mcpFailure('unsaved_direction', 'Save the current annotation first');
  }
  if (command.action === 'select_view') {
    if (!state.available_views.includes(command.view)) throw mcpFailure('unknown_view', 'This review version does not exist');
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
    if (!await pauseForNote()) throw mcpFailure('pause_failed', 'The paused frame could not be confirmed');
    return mcpWaitForFrame(undefined, epoch);
  }
  if (command.action === 'seek_frame' || command.action === 'navigate_shot') {
    const shot = command.action === 'navigate_shot' ? pictureClips().find(item => item.shot === (command.shot || command.shot_id)) : null;
    const frame = shot ? shot.position : command.frame;
    const frames = currentView === 'opening' && command.action === 'seek_frame'
      ? Math.round(player.duration * model.fps) : model.frames;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frames) {
      throw mcpFailure('invalid_frame', 'Target frame or shot does not exist');
    }
    if (command.action === 'navigate_shot' && !shot) throw mcpFailure('unknown_shot', 'Shot does not exist');
    if (quickNote) closeQuickNote(false);
    if (currentView === 'opening' && command.action === 'seek_frame') seekLocalFrame(frame, true);
    else seekFrame(frame);
    return mcpWaitForFrame(frame, epoch);
  }
  if (command.action === 'open_direction') {
    if (quickNote && $('inline-note').value.trim() && !quickNoteIsAtCurrentFrame()) {
      throw mcpFailure('unsaved_direction', 'Resolve the draft on its original frame first');
    }
    await openQuickNote();
    if (!quickNote) throw mcpFailure('note_not_ready', 'The annotation editor could not open');
    return mcpReviewState();
  }
  if (command.action === 'save_direction') {
    if (!/^[a-f0-9]{32}$/.test(command.operation_id || '') || typeof command.text !== 'string' ||
        !command.text.trim() || command.text.length > 16000) throw mcpFailure('invalid_direction', 'Invalid annotation ID or text');
    const text = command.text.trim();
    const previous = model.tasks.find(task => task.id === command.operation_id);
    if (previous) {
      if (previous.route !== 'direction' || previous.text !== text || previous.anchor?.revision !== state.revision ||
          previous.anchor?.version !== state.video_version) throw mcpFailure('operation_conflict', 'Operation ID is assigned to another annotation');
      lastSavedDirectionId = previous.id;
      return { ...mcpReviewState(), direction_id: previous.id, direction: previous, idempotent: true };
    }
    const retryDraft = quickNote && quickNote.id === command.operation_id &&
      $('inline-note').value.trim() === text && quickNoteIsAtCurrentFrame() &&
      quickNote.context.anchor.revision === state.revision && quickNote.context.version === state.video_version;
    if (quickNote?.saving || (quickNote && $('inline-note').value.trim() && !retryDraft)) {
      throw mcpFailure('unsaved_direction', 'Resolve the existing annotation draft first');
    }
    await openQuickNote();
    mcpCheckIdentity(command);
    if (epoch !== projectEpoch || !quickNote || !quickNoteIsAtCurrentFrame()) throw mcpFailure('frame_changed', 'The annotation anchor changed');
    quickNote.id = command.operation_id;
    $('inline-note').value = text;
    const saved = await saveQuickNote();
    if (!saved) throw mcpFailure('save_failed', 'Annotation was not saved');
    return { ...mcpReviewState(), direction_id: saved.id, direction: saved, idempotent: false };
  }
  const task = model.tasks.find(item => item.id === command.direction_id);
  const location = task && resolveNote(task);
  if (!location) throw mcpFailure('unresolved_direction', 'This annotation cannot be located in the current version');
  if (quickNote) closeQuickNote(false);
  jumpNote(task);
  return mcpWaitForFrame(location.frame, epoch);
};

document.addEventListener('DOMContentLoaded', () => boot(params.get('view')).catch(error => tell(error.message, true)));
