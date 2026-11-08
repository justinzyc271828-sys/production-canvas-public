
'use strict';
let range, heightMode, rulerMode, navLane, rulerLane, drag, peaks, peakUrl;
const colors = { Reality: '#747a7d', Dream: '#71858c', Memory: '#af7f58', Fantasy: '#8a7792',
  '\u73b0\u5b9e': '#747a7d', '\u68a6': '#71858c', '\u8bb0\u5fc6': '#af7f58', '\u5e7b\u60f3': '#8a7792' };
const clipEnd = clip => clip.position + clip.end - clip.start;
const selectedTrack = () => model?.tracks.find(track => track.id === selected?.track);
const selectedClip = () => selectedTrack()?.clips[selected.clip];
const pictureTrack = () => model.tracks.find(track => track.type === 'video');
const pictureClips = () => pictureTrack()?.clips || [];
const chapters = () => model.reviewData?.chapters || [];
const isTimelineView = () => ['s03', 'battle'].includes(currentView);
const mediaOffset = () => currentView === 'battle' ? model.focus.start : 0;
let videoClock, activeNoteId, openingNoteRange;
const frameFromMediaTime = time => Math.round(time * model.fps);
const frameMidpoint = frame => (frame + .5) / model.fps;

function playFrame() {
  const local = player instanceof HTMLVideoElement ? videoClock?.displayed ?? 0 :
    Math.floor((player?.currentTime || 0) * model.fps);
  return local + mediaOffset();
}

function trackVideoFrames(video) {
  if (videoClock) settleFrameSeek(videoClock, false);
  const clock = videoClock = { displayed: null, target: null, settle: null, pending: null, timer: null };
  const follow = (_, { mediaTime }) => {
    if (video !== player) return;
    clock.mediaTime = mediaTime;
    clock.displayed = frameFromMediaTime(mediaTime);
    finishFrameSeek(video);
    syncPlayhead();
    video.requestVideoFrameCallback(follow);
  };
  video.requestVideoFrameCallback(follow);
  video.addEventListener('seeked', () => finishFrameSeek(video));
  video.addEventListener('error', () => settleFrameSeek(clock, false), { once: true });
  video.addEventListener('pause', () => {
    if (video === player && video.paused && !video.ended && clock.target === null && !video.seeking && clock.displayed !== null) {
      seekVideoFrame(video, clock.displayed);
    }
  });
}

function finishFrameSeek(video) {
  const clock = videoClock;
  if (video !== player || !clock || video.seeking || clock.target !== clock.displayed) return;
  settleFrameSeek(clock, true);
}

function settleFrameSeek(clock, success) {
  clearTimeout(clock.timer);
  const settle = clock.settle;
  clock.target = clock.pending = clock.settle = clock.timer = null;
  settle?.(success);
}

function seekVideoFrame(video, frame, pause = false, exact = false) {
  if (video !== player || !videoClock) return Promise.resolve(false);
  const mediaFrames = Math.round(video.duration * model.fps);
  const declaredFrames = currentView === 's03' ? model.frames : currentView === 'battle' ? model.focus.frames : mediaFrames;
  const frames = Math.min(declaredFrames, mediaFrames);
  const target = Math.min(Math.max(0, frame), Math.max(0, frames - 1));
  if (exact && target !== frame) {
    video.pause();
    tell('The current preview does not include the annotated frame.', true);
    return Promise.resolve(false);
  }
  const clock = videoClock;
  settleFrameSeek(clock, false);
  const time = frameMidpoint(target);
  if (pause) video.pause();
  if (!video.seeking && clock.displayed === target && Math.abs(video.currentTime - time) <= .000001) {
    return Promise.resolve(true);
  }
  clock.target = target;
  const pending = clock.pending = new Promise(resolve => { clock.settle = resolve; });
  clock.timer = setTimeout(() => {
    settleFrameSeek(clock, false);
    if (video === player) tell('The target frame could not be confirmed. Try again.', true);
  }, 3000);
  video.currentTime = time;
  finishFrameSeek(video);
  return pending;
}

async function pauseForNote() {
  const video = player;
  if (!(video instanceof HTMLVideoElement) || currentView === 'asset') return false;
  screening = false;
  loop = null;
  const clock = videoClock;
  video.pause();
  if (clock.target === null && clock.displayed !== null) seekVideoFrame(video, clock.displayed);
  while (video === player && clock.pending) {
    const pending = clock.pending;
    if (!await pending && !clock.pending) return false;
  }
  return video === player && clock.displayed !== null && !video.seeking;
}
const versionName = () => currentView === 'battle' ? model.focus.version :
  currentView === 'opening' ? model.opening.version : model.segment.version;
const shotDecisionKey = (track, clip) => track.id + ':' + clip.index;
function resolveNote({ anchor }) {
  return resolveNoteLocation(model, anchor);
}

function reviewNotes(opening = currentView === 'opening') {
  return model.tasks.flatMap(task => {
    const location = resolveNote(task);
    return location ? [{ ...location, task }] : [];
  }).sort((a, b) => Number(b.view === 'opening') - Number(a.view === 'opening') || a.frame - b.frame)
    .map((note, index) => ({ ...note, number: index + 1 }))
    .filter(note => (note.view === 'opening') === opening);
}

function anchorDetails(anchor) {
  const label = model.viewLabels?.[anchor.view] || (anchor.view === 'opening' ? 'Opening' : 'Edit candidate');
  return [label, anchor.version, timecode(anchor.frame), 'Frame ' + anchor.frame, anchor.shot && 'Shot ' + anchor.shot]
    .filter(Boolean).join(' · ');
}

function noteStatus(task, location) {
  if (!location) return 'Unlocated';
  const label = location.review === 'replacement' ? 'Shot source replaced - review needed' :
    location.review === 'trim' ? 'Shot trimmed - review needed' : '';
  const moved = location.frame !== task.anchor.frame ? 'Originally at ' + timecode(task.anchor.frame) : '';
  return [label, moved].filter(Boolean).join(' · ');
}

function appendInspectorNotes(target) {
  const anchored = model.tasks.filter(task => task.anchor);
  target.append(el('h4', 'Frame annotations · ' + model.tasks.length));
  const available = [...reviewNotes(true), ...reviewNotes(false)];
  for (const location of available) {
    const { task } = location;
    const label = timecode(location.frame) + ' ' + task.title;
    const row = button('', () => jumpNote(task), location.review ? 'note-entry old-note' : 'note-entry');
    row.append(el('span', String(location.number), { class: 'note-number', 'aria-hidden': 'true' }),
      el('span', label, { class: 'note-entry-label' }));
    row.setAttribute('aria-label', 'Go to annotation ' + location.number + ' · ' + label);
    row.dataset.note = task.id;
    row.dataset.frame = location.frame;
    row.dataset.view = location.view;
    const status = noteStatus(task, location);
    row.title = [anchorDetails(task.anchor), status].filter(Boolean).join(' · ');
    target.append(row);
    if (status) target.append(el('p', status, { class: 'hint' }));
  }
  const missing = anchored.filter(task => !resolveNote(task));
  if (missing.length) {
    target.append(el('h4', 'Unlocated'));
    for (const task of missing) target.append(el('p', task.title + ' · ' + anchorDetails(task.anchor), { class: 'hint' }));
  }
  if (model.tasks.length > anchored.length) target.append(el('p', 'Unanchored records appear under Frame annotations.', { class: 'hint' }));
  highlightInspectorNote();
}

function timecode(frame, fraction = true) {
  const cs = Math.round(Math.max(0, frame) * 100 / model.fps);
  const pad = value => String(value).padStart(2, '0');
  return pad(Math.floor(cs / 6000)) + ':' + pad(Math.floor(cs / 100) % 60) + (fraction ? '.' + pad(cs % 100) : '');
}
function trackCode(track) {
  return (track.type === 'video' ? 'V' : 'A') + (model.tracks.filter(item => item.type === track.type).indexOf(track) + 1);
}
function updateVersion() {
  const info = currentView === 'battle' ? model.focus : model.video;
  const frames = currentView === 'battle' ? model.focus.frames : model.frames;
  $('review-version').title = versionName();
  $('film-summary').textContent = currentView === 'opening' ? sec(model.opening.seconds) :
    [sec(frames / model.fps), info?.height && info.height + 'p', Number(model.fps.toFixed(2)) + ' fps',
      model.wholeFilm ? countLabel(pictureClips().filter(clip => clip.placeholder).length, 'placeholder') : countLabel(model.tracks.length, 'track')].filter(Boolean).join(' · ');
  renderInspector();
}
function seekFrame(frame) {
  frame = Math.max(0, Math.min(model.frames - 1, frame));
  if (!isTimelineView() || (currentView === 'battle' && (frame < model.focus.start || frame >= model.focus.end))) {
    showSegment('s03', frame);
    return;
  }
  seekLocalFrame(frame - mediaOffset());
}

function seekLocalFrame(frame, exact = false) {
  const target = player;
  const seek = () => seekVideoFrame(target, frame, true, exact);
  if (target.readyState) seek();
  else target.addEventListener('loadedmetadata', seek, { once: true });
}
function renderTransport() {
  const playable = player instanceof HTMLMediaElement;
  const playing = playable && !player.paused && !player.ended;
  $('play-toggle').disabled = !playable;
  $('play-toggle').textContent = playing ? 'Ⅱ' : '▶';
  $('play-toggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('play-time').textContent = timecode(playFrame());
  $('frame-number').textContent = player instanceof HTMLVideoElement ? 'Frame ' + playFrame() : '';
  $('note-at-time').disabled = currentView === 'asset' || !(player instanceof HTMLVideoElement) || videoClock?.displayed == null;
  $('total-time').textContent = ' / ' + timecode(isTimelineView() ? model.frames : (player?.duration || 0) * model.fps || 0);
  $('loop-shot').setAttribute('aria-pressed', Boolean(loop));
  $('loop-shot').disabled = !selectedClip() || !isTimelineView();
  const active = isTimelineView() && pictureClips().find(clip => clip.placeholder &&
    playFrame() >= clip.position && playFrame() < clipEnd(clip));
  $('player').dataset.still = active ? active.shot + (model.generic ? ' - placeholder shot' : ' - static first-frame placeholder') : '';
  const frame = playFrame();
  highlightInspectorNote(frame);
  refreshQuickNote();
  for (const node of $('review-rows').querySelectorAll('.chapter')) {
    node.classList.toggle('chapter-active', isTimelineView() && frame >= Number(node.dataset.start) && frame < Number(node.dataset.end));
  }
}
function highlightInspectorNote(frame = playFrame()) {
  const rows = [...$('inspector').querySelectorAll('.note-entry')];
  const candidates = rows.filter(row => currentView === 'opening' ? row.dataset.view === 'opening' :
    isTimelineView() && row.dataset.view !== 'opening' && (currentView !== 'battle' ||
      (Number(row.dataset.frame) >= model.focus.start && Number(row.dataset.frame) < model.focus.end)));
  const distance = row => Math.abs(Number(row.dataset.frame) - frame);
  const nearest = candidates.reduce((best, row) => !best || distance(row) < distance(best) ||
    (distance(row) === distance(best) && row.dataset.note === activeNoteId) ? row : best, null);
  for (const row of rows) {
    if (row === nearest) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  for (const marker of $('edit').querySelectorAll('.note-mark, .note-cluster .cluster-button, .overview-note')) {
    const ids = (marker.dataset.notes || marker.dataset.note || '').split(' ');
    if (nearest && ids.includes(nearest.dataset.note)) marker.setAttribute('aria-current', 'true');
    else marker.removeAttribute('aria-current');
  }
}

function syncPlayhead() {
  if (!model || !range) return;
  const frame = playFrame();
  if (loop && !player.paused && !player.seeking && videoClock?.target === null && frame >= loop.end) {
    void restartLoop();
  }
  renderTransport();
  const visible = isTimelineView();
  if (visible && !player.paused && (frame < range.start || frame > range.start + range.span) && frame < model.frames) {
    setRange(frame - range.span * .1, range.span);
    return;
  }
  $('edit').style.setProperty('--cursor-overview', visible ? 100 * frame / model.frames + '%' : '-1%');
  $('edit').style.setProperty('--cursor-visible', visible && frame >= range.start && frame <= range.start + range.span ? 'visible' : 'hidden');
  $('edit').style.setProperty('--cursor', visible ? 100 * (frame - range.start) / range.span + '%' : '-1%');
}
function startPlayback() { player.play().catch(error => tell(error.message, true)); }

async function restartLoop() {
  const video = player;
  const active = loop;
  if (!active) return;
  const reached = await seekVideoFrame(video, active.start - mediaOffset(), true, true);
  if (video !== player || active !== loop) return;
  if (reached) startPlayback();
  else { loop = null; renderTransport(); }
}
function togglePlayback() {
  if (!(player instanceof HTMLMediaElement)) return;
  if (player.paused) startPlayback();
  else player.pause();
}
function toggleLoop() {
  const clip = selectedClip();
  if (!clip || !isTimelineView()) return;
  if (loop) { loop = null; renderTransport(); return; }
  const music = model.reviewData?.music;
  const padding = music && clip.position < music.end * model.fps ? Math.round(music.bar / (music.beatsPerBar || 4) * model.fps) : 0;
  loop = { start: Math.max(mediaOffset(), clip.position - padding),
    end: Math.min(currentView === 'battle' ? model.focus.end : model.frames, clipEnd(clip) + padding) };
  void restartLoop();
}
function stepFrame(delta) {
  if (!(player instanceof HTMLVideoElement) || !player.readyState) return;
  loop = null;
  const frame = (videoClock?.target ?? (playFrame() - mediaOffset())) + mediaOffset() + delta;
  if (isTimelineView()) { seekFrame(frame); reveal(frame); }
  else seekLocalFrame(frame);
}
function jumpCut(delta) {
  const track = selectedTrack() || pictureTrack();
  if (!track?.clips.length) return;
  const clips = [...track.clips].sort((a, b) => a.position - b.position);
  const clip = selectedClip();
  const next = clip ? clips[clips.indexOf(clip) + delta] : delta > 0
    ? clips.find(item => item.position > playFrame()) : clips.findLast(item => item.position < playFrame());
  if (next) chooseClip(track, next);
}
function reveal(frame) {
  if (frame < range.start || frame >= range.start + range.span) setRange(frame - range.span * .1, range.span);
}
function chooseClip(track, clip, zoom) {
  selected = { track: track.id, clip: clip.index };
  loop = null;
  screening = false;
  seekFrame(clip.position);
  if (zoom === 'act') zoomAct(clip.position);
  else if (zoom === 'selection') zoomSelection();
  else reveal(clip.position);
  $('review').classList.add('show-inspector');
  renderInspector();
  renderTimeline();
  const item = [...$('tracks').querySelectorAll('.edit-clip')].find(node =>
    node.dataset.track === track.id && Number(node.dataset.clip) === clip.index);
  item?.focus({ preventScroll: true });
}
function renderOverviewInspector(target) {
  const heading = $('review-version').selectedOptions[0]?.textContent || 'Current candidate';
  target.append(el('p', 'Version', { class: 'hint' }), el('h3', heading), el('p', $('film-summary').textContent, { class: 'hint' }));
  target.append(el('p', model.tracks.map(track => trackCode(track) + ' ' + countLabel(track.clips.length, 'clip')).join(' · '), { class: 'track-summary' }));
  const track = pictureTrack();
  if (model.wholeFilm && track) {
    const pending = track.clips.filter(clip => clip.placeholder && model.decisions[shotDecisionKey(track, clip)] !== 'pass');
    const strip = el('div', '', { class: 'completion-strip', 'aria-label': 'Placeholder distribution' });
    for (const clip of track.clips) strip.append(el('span', '', { class: clip.placeholder ? 'strip-still' : '' }));
    target.append(el('p', 'Picture placeholders', { class: 'hint' }), strip, el('h4', 'Pending - ' + pending.length));
    for (const clip of pending) {
      const row = button('', () => chooseClip(track, clip, 'act'), 'pending-shot');
      row.dataset.shot = clip.shot;
      row.append(el('strong', clip.shot), el('span', clip.name.split('｜')[1] || clip.name), el('time', timecode(clip.position)));
      target.append(row);
    }
  }
  appendInspectorNotes(target);
}
function noteContext() {
  const frame = playFrame();
  const version = versionName();
  const section = model.viewLabels?.[currentView] || (currentView === 'opening' ? 'Opening' : 'Full film');
  const anchor = { view: currentView, frame, version,
    revision: currentView === 'opening' ? model.opening.revision : model.revision };
  if (isTimelineView()) {
    const tracks = model.tracks.filter(track => track.type === 'video');
    const ordered = [selectedTrack(), ...tracks].filter(track => track?.type === 'video');
    for (const track of ordered) {
      const clip = track.clips.find(item => frame >= item.position && frame < clipEnd(item));
      if (!clip) continue;
      const offset = frame - clip.position;
      anchor.clip = { track: track.id, bin: clip.bin, sourceFrame: clip.start + offset, offset,
        start: clip.start, end: clip.end };
      if (clip.shot) anchor.shot = clip.shot;
      break;
    }
  }
  return { stamp: timecode(frame), section, version, anchor };
}
async function saveBrief(payload) {
  const owner = model;
  const item = await request(api('/tasks'), payload);
  if (model === owner) {
    model.tasks = [item, ...model.tasks.filter(task => task.id !== item.id)];
    renderTasks();
    renderInspector();
    renderTimeline();
  }
  return item;
}
function jumpNote(task) {
  const location = resolveNote(task);
  if (!location) return;
  const { frame, view } = location;
  activeNoteId = task.id;
  if (view === 'opening' && openingNoteRange &&
    (frame < openingNoteRange.start || frame >= openingNoteRange.start + openingNoteRange.span)) openingNoteRange = null;
  loop = null;
  screening = false;
  if ($('side-panel').open) $('side-panel').close();
  if (view !== currentView) showSegment(view, frame - (view === 'battle' ? model.focus.start : 0), false, true);
  else seekLocalFrame(frame - mediaOffset(), true);
  if (view !== 'opening') reveal(frame);
  else renderReviewRows();
  $('inspector').querySelector('[data-note="' + task.id + '"]')?.scrollIntoView({ block: 'nearest' });
}


function laneWidth() {
  const label = parseInt(getComputedStyle($('edit')).getPropertyValue('--label-width'));
  return Math.max(100, $('timeline-scroll').clientWidth - label - 12);
}
function resetTimeline() {
  activeNoteId = null;
  openingNoteRange = null;
  range = { start: 0, span: model.frames, preset: 'full' };
  rulerMode = 'time';
  $('ruler-time').setAttribute('aria-pressed', 'true');
  $('ruler-bars').setAttribute('aria-pressed', 'false');
  $('active-tracks').checked = false;
  $('review').classList.remove('show-inspector');
  setHeight(innerWidth < 1024 || innerHeight < 700 ? 'collapsed' : 'standard', false);
  loadPeaks();
}
function setHeight(mode, paint = true) {
  heightMode = mode;
  $('workspace').dataset.timeline = mode;
  for (const [id, value] of [['collapse-tracks', 'collapsed'], ['standard-tracks', 'standard'], ['expand-tracks', 'expanded']]) {
    $(id).setAttribute('aria-pressed', mode === value);
  }
  if (paint) renderTimeline();
}
function setRange(start, span, preset = 'custom', minimumSpan = laneWidth() / 12) {
  span = Math.min(model.frames, Math.max(minimumSpan, span));
  range = { start: Math.max(0, Math.min(model.frames - span, start)), span, preset };
  renderTimeline();
}
function zoomAct(frame = selectedClip()?.position ?? playFrame()) {
  const act = chapters().find(row => frame >= row.start && frame < row.end) || model.focus;
  if (!act) return;
  const length = act.end - act.start;
  setRange(act.start - length * .1, length * 1.2, 'act');
}
function zoomSelection() {
  const clip = selectedClip();
  if (!clip) return;
  const length = clipEnd(clip) - clip.position;
  const span = Math.max(laneWidth() / 12, length / .4);
  setRange(clip.position + (length - span) / 2, span, 'selection');
}
function magnify(scale, anchor) {
  if (anchor < range.start || anchor > range.start + range.span) anchor = range.start + range.span / 2;
  setRange(anchor - (anchor - range.start) * scale, range.span * scale);
}
function pos(node, start, end, window = range) {
  if (end !== undefined) {
    start = Math.max(window.start, start);
    node.style.width = (100 * (Math.min(window.start + window.span, end) - start) / window.span) + '%';
  }
  node.style.left = (100 * (start - window.start) / window.span) + '%';
  return node;
}
function intersects(start, end, window = range) {
  return start < window.start + window.span && end > window.start;
}
function selectionBand(lane, window = range) {
  const clip = selectedClip();
  if (clip && intersects(clip.position, clipEnd(clip), window)) lane.append(
    pos(el('span', '', { class: 'selection-band' }), clip.position, clipEnd(clip), window));
}
function makeRow(label, kind, container) {
  const row = el('div', '', { class: 'track ' + kind });
  const head = el('div', label, { class: 'track-name' });
  const lane = el('div', '', { class: 'lane' });
  row.append(head, lane);
  container.append(row);
  return { row, head, lane };
}
function ratio(event, lane) {
  const box = lane.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
}
function renderOverview() {
  if (!navLane) {
    ({ lane: navLane } = makeRow('Full film', 'overview-row', $('overview')));
    navLane.tabIndex = 0;
    navLane.setAttribute('aria-label', 'Full-film navigation. Use arrow keys to move the visible range');
    navLane.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      setRange(range.start + range.span * (event.key === 'ArrowLeft' ? -.2 : .2), range.span);
    };
    navLane.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const frame = ratio(event, navLane) * model.frames;
      const edge = 7 * model.frames / navLane.clientWidth;
      const end = range.start + range.span;
      const mode = Math.abs(frame - range.start) < edge ? 'left' : Math.abs(frame - end) < edge ? 'right' : 'move';
      if (frame < range.start - edge || frame > end + edge) setRange(frame - range.span / 2, range.span);
      drag = { mode, frame, start: range.start, span: range.span };
      navLane.setPointerCapture(event.pointerId);
    };
    navLane.onpointermove = event => {
      if (!drag) return;
      const { mode, frame, start, span } = drag;
      const delta = ratio(event, navLane) * model.frames - frame;
      const min = laneWidth() / 12;
      if (mode === 'left') {
        const next = Math.max(0, Math.min(start + span - min, start + delta));
        setRange(next, start + span - next);
      } else if (mode === 'right') setRange(start, Math.min(model.frames - start, Math.max(min, span + delta)));
      else setRange(start + delta, span);
    };
    navLane.onlostpointercapture = () => { drag = null; };
  }
  const lane = navLane;
  lane.replaceChildren();
  const full = { start: 0, span: model.frames };
  for (const [index, act] of chapters().entries()) {
    const tile = pos(el('span', '', { class: 'overview-act', title: (index + 1) + ' · ' + act.title }), act.start, act.end, full);
    tile.style.setProperty('--chapter-color', colors[act.layer]);
    lane.append(tile);
  }
  for (const clip of pictureClips().filter(clip => clip.placeholder)) {
    lane.append(pos(el('span', '', { class: 'overview-still' }), clip.position, clipEnd(clip), full));
  }
  for (const { frame, task } of reviewNotes(false)) {
    const mark = el('span', '', { class: 'overview-note' });
    mark.dataset.note = task.id;
    lane.append(pos(mark, frame, undefined, full));
  }
  if (currentView === 'battle') lane.append(
    pos(el('span', '', { class: 'version-mask' }), 0, model.focus.start, full),
    pos(el('span', '', { class: 'version-mask' }), model.focus.end, model.frames, full));
  selectionBand(lane, full);
  lane.append(pos(el('span', '', { class: 'viewport-box' }), range.start, range.start + range.span, full),
    el('span', '', { class: 'overview-cursor' }));
}
function timeTicks(lane) {
  const px = laneWidth() / range.span;
  const steps = [...new Set([1, 2, 6, ...[.25, .5, 1, 2, 5, 10, 15, 30, 60, 120].map(s => Math.max(1, Math.round(s * model.fps)))])].sort((a, b) => a - b);
  const major = steps.find(step => step * px >= 70) || steps.at(-1);
  const minor = steps.find(step => major % step === 0 && step * px >= 8) || major;
  for (let frame = Math.ceil(range.start / minor) * minor; frame < range.start + range.span; frame += minor) {
    const labelled = frame % major === 0;
    lane.append(pos(el('span', labelled ? timecode(frame, major < model.fps) : '', { class: labelled ? 'tick major' : 'tick' }), frame));
  }
}
function barTicks(lane) {
  const music = model.reviewData?.music;
  if (!music) return missing(lane, 'No bar markers');
  const beatsPerBar = music.beatsPerBar || 4;
  const spacing = music.bar * model.fps * laneWidth() / range.span;
  const interval = [1, 2, 4, 8, 16].find(step => spacing * step >= 44) || 16;
  const beat = spacing / beatsPerBar >= 7 ? 1 : beatsPerBar;
  for (let i = 0; ; i += beat) {
    const frame = (music.offset + i * music.bar / beatsPerBar) * model.fps;
    if (frame >= music.end * model.fps || frame >= range.start + range.span) break;
    if (frame < range.start) continue;
    const number = i % (beatsPerBar * interval) === 0 ? String(i / beatsPerBar + 1) : '';
    lane.append(pos(el('span', number, { class: number ? 'tick major' : 'tick' }), frame));
  }
  if (music.end * model.fps < range.start + range.span) lane.append(pos(
    el('span', 'Outro - free time', { class: 'tick major' }), Math.max(range.start, music.end * model.fps)));
}
function missing(lane, label) {
  lane.append(el('span', label, { class: 'missing' }));
}
function reviewMarks(lane, marks, kind, handler = mark => seekFrame(mark.frame), window = range) {
  let last = -Infinity;
  const px = laneWidth() / window.span;
  const visible = marks.filter(mark => mark.frame >= window.start && mark.frame < window.start + window.span)
    .sort((a, b) => a.frame - b.frame);
  for (const [index, mark] of visible.entries()) {
    const marker = button(mark.symbol || mark.title, () => handler(mark), 'marker ' + kind);
    marker.title = [mark.title, timecode(mark.frame), mark.status].filter(Boolean).join(' · ');
    if (mark.old) marker.classList.add('old-note');
    marker.setAttribute('aria-label', marker.title);
    if ((mark.frame - last) * px < (kind === 'shot-mark' ? 24 : 16)) marker.classList.add('unlabelled');
    else last = mark.frame;
    if (kind === 'shot-mark') {
      const space = ((visible[index + 1]?.frame ?? window.start + window.span) - mark.frame) * px - 4;
      marker.style.maxWidth = Math.max(4, space) + 'px';
      if (space < 72) marker.classList.add('unlabelled');
    }
    if (kind === 'shot-mark' && selectedClip()?.position === mark.frame) marker.classList.add('selected-marker');
    lane.append(pos(marker, mark.frame, undefined, window));
  }
}
function renderNoteMarks(lane, notes, window) {
  const scale = laneWidth() / window.span;
  const visible = notes.filter(({ frame }) => frame >= window.start && frame < window.start + window.span);
  for (let start = 0; start < visible.length;) {
    let end = start + 1;
    while (end < visible.length && (visible[end].frame - visible[end - 1].frame) * scale < 36) end++;
    const first = visible[start];
    if (end === start + 1) {
      const { task } = first;
      const text = [task.title, timecode(first.frame), noteStatus(task, first)].filter(Boolean).join(' · ');
      const mark = button(String(first.number), () => jumpNote(task),
        'marker note-mark' + (first.review ? ' old-note' : ''));
      mark.title = 'Annotation ' + first.number + ' · ' + timecode(first.frame) + ' - click to locate';
      mark.dataset.note = task.id;
      mark.dataset.number = first.number;
      mark.setAttribute('aria-label', 'Annotation ' + first.number + ' · ' + text);
      lane.append(pos(mark, first.frame, undefined, window));
    } else {
      const group = pos(el('div', '', { class: 'cluster note-cluster' }), first.frame, undefined, window);
      const badge = button((end - start) + ' notes', () => {
        const extent = Math.max(1, visible[end - 1].frame - first.frame + 1);
        const span = extent * 1.6;
        const offset = first.frame - extent * .3;
        if (currentView === 'opening') {
          openingNoteRange = { start: Math.max(0, offset), span };
          renderReviewRows();
        } else setRange(offset, span, 'custom', 1);
      }, 'cluster-button');
      badge.dataset.notes = visible.slice(start, end).map(note => note.task.id).join(' ');
      badge.title = 'Zoom to these annotations';
      const menu = el('div', '', { class: 'cluster-menu' });
      for (const note of visible.slice(start, end)) {
        const label = 'Annotation ' + note.number + ' · ' + timecode(note.frame) + ' · ' + note.task.title;
        const item = button(label, () => jumpNote(note.task), note.review ? 'old-note' : undefined);
        item.title = [label, noteStatus(note.task, note)].filter(Boolean).join(' · ');
        item.dataset.note = note.task.id;
        menu.append(item);
      }
      group.append(badge, menu);
      group.onmouseenter = group.onfocusin = () => placeClusterMenu(badge, menu, 0);
      lane.append(group);
    }
    start = end;
  }
}

function jumpAdjacentNote(direction) {
  const notes = reviewNotes();
  const target = videoClock?.target;
  const frame = target == null ? playFrame() : target + mediaOffset();
  const waitingForMedia = videoClock?.displayed == null;
  const index = notes.findIndex(note => note.task.id === activeNoteId && (waitingForMedia || note.frame === frame));
  const next = index >= 0 ? notes[index + direction] :
    direction < 0 ? notes.findLast(note => note.frame < frame) : notes.find(note => note.frame > frame);
  if (next) jumpNote(next.task);
}

function renderReviewRows() {
  const root = $('review-rows');
  root.replaceChildren();
  if (heightMode === 'collapsed') return;
  rulerLane = makeRow(rulerMode === 'time' ? 'Time' : 'Bars', 'ruler', root).lane;
  rulerLane.setAttribute('aria-label', 'Ruler - click to locate');
  rulerLane.onclick = event => { loop = null; seekFrame(Math.round(range.start + range.span * ratio(event, rulerLane))); };
  (rulerMode === 'time' ? timeTicks : barTicks)(rulerLane);
  if (heightMode === 'expanded' && rulerMode === 'time' && model.reviewData) barTicks(makeRow('Bars', 'review-row bars-row', root).lane);
  const acts = makeRow('Chapters', 'review-row chapter-row', root).lane;
  for (const [index, act] of chapters().entries()) {
    if (!intersects(act.start, act.end)) continue;
    const width = (Math.min(act.end, range.start + range.span) - Math.max(act.start, range.start)) * laneWidth() / range.span;
    const mark = button((index + 1) + ' ' + act.title, () => seekFrame(act.start),
      'chapter' + (width < 72 ? ' compact-chapter' : ''));
    mark.setAttribute('aria-label', (index + 1) + ' · ' + act.title);
    mark.style.setProperty('--chapter-color', act.color || colors[act.layer] || '#747a7d');
    mark.dataset.start = act.start;
    mark.dataset.end = act.end;
    mark.title = [act.layer, act.title, model.generic ? 'Project chapter markers' : 'Director handoff'].filter(Boolean).join(' · ');
    mark.ondblclick = () => zoomAct(act.start);
    acts.append(pos(mark, act.start, act.end));
  }
  if (!chapters().length) missing(acts, 'No chapter markers');
  const shots = makeRow('Shots / cues', 'review-row shots-row', root).lane;
  if (model.reviewData) {
    const actual = pictureClips().filter(clip => clip.shot).map(clip => ({ frame: clip.position, title: clip.shot }));
    const unique = new Map();
    for (const mark of [...actual, ...model.reviewData.shots]) unique.set(mark.frame + '|' + mark.title, mark);
    reviewMarks(shots, [...unique.values()], 'shot-mark');
    reviewMarks(shots, model.reviewData.cues.map(mark => ({ ...mark, symbol: '◆' })), 'cue-mark');
  } else missing(shots, 'No shot markers');
  const opening = currentView === 'opening';
  const tasks = reviewNotes();
  const noteRow = makeRow((opening ? 'Opening annotations' : 'Annotations') + ' · ' + tasks.length, 'review-row notes-row', root);
  const notes = noteRow.lane;
  noteRow.head.title = 'Click a number to locate its annotation. Use [ or ] for the previous or next annotation';
  const noteWindow = opening ? openingNoteRange || { start: 0, span: Math.max(1, model.opening.seconds * model.fps) } : range;
  if (tasks.length) renderNoteMarks(notes, tasks, noteWindow);
  else missing(notes, 'No frame-linked annotations');
  if (heightMode === 'expanded' && model.reviewData) {
    const sound = makeRow('Sound cues', 'review-row sounds-row', root).lane;
    reviewMarks(sound, model.reviewData.sounds.map(mark => ({ ...mark, symbol: '◆' })), 'cue-mark');
  }
  for (const lane of root.querySelectorAll('.lane')) selectionBand(lane);
}

async function loadPeaks() {
  if (model.mixUrl === peakUrl) return;
  peakUrl = model.mixUrl;
  peaks = null;
  if (!peakUrl) return;
  const source = peakUrl;
  try {
    const response = await fetch(source);
    if (!response.ok) throw Error('Mix is unavailable');
    const buffer = await new OfflineAudioContext(1, 1, 12000).decodeAudioData(await response.arrayBuffer());
    const values = new Float32Array(Math.ceil(buffer.duration * 48));
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        const bin = Math.floor(i * values.length / samples.length);
        values[bin] = Math.max(values[bin], Math.abs(samples[i]));
      }
    }
    if (peakUrl === source) { peaks = { values, duration: buffer.duration }; renderTimeline(); }
  } catch {
    if (peakUrl === source) { peaks = false; renderTimeline(); }
  }
}
function waveform(node, clip, width, start, end) {
  if (!peaks) {
    node.append(el('span', peaks === false ? 'Mix waveform unavailable' : 'Loading mix waveform...', { class: 'clip-caption' }));
    return;
  }
  const graph = el('canvas', '', { class: 'waveform', 'aria-label': 'Current mix waveform' });
  graph.width = Math.max(1, Math.ceil(width));
  graph.height = 60;
  const paint = graph.getContext('2d');
  paint.fillStyle = '#848484';
  const bucket = frame => Math.floor((frame - clip.position + clip.start) / model.fps / peaks.duration * peaks.values.length);
  for (let i = 0; i < graph.width; i++) {
    const a = bucket(start + (end - start) * i / graph.width);
    const b = bucket(start + (end - start) * (i + 1) / graph.width);
    let value = 0;
    for (let j = a; j <= b; j++) value = Math.max(value, peaks.values[j] || 0);
    const amplitude = Math.max(.5, Math.sqrt(value) * 27);
    paint.fillRect(i, 30 - amplitude, 1, amplitude * 2);
  }
  node.append(graph);
}
let thumbnailSession;

function releaseThumbnailVideo(video) {
  video.removeAttribute('src');
  video.load();
}

function waitForThumbnailMedia(video, event, signal, start) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('thumbnail cancelled'));
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const fail = () => finish(Error('thumbnail unavailable'));
    const timer = setTimeout(fail, 3500);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', fail, { once: true });
    try { start(); }
    catch (error) { finish(error); }
  });
}

function thumbnailAt(frame, width, height, needed = () => true) {
  const source = model.segment.url;
  const identity = source + '|' + model.video.actualSha256;
  if (thumbnailSession?.identity !== identity) {
    if (thumbnailSession) {
      thumbnailSession.controller.abort();
      releaseThumbnailVideo(thumbnailSession.video);
    }
    const video = el('video', '', { preload: 'auto' });
    video.muted = true;
    thumbnailSession = {
      identity, video, controller: new AbortController(), queue: Promise.resolve(),
      cache: new Map(), pending: new Map()
    };
  }
  const session = thumbnailSession;
  const { video, controller: { signal }, cache, pending } = session;
  const time = frameMidpoint(frame);
  width = Math.ceil(width / 16) * 16;
  height = Math.ceil(height / 16) * 16;
  const key = [frame, width, height].join(':');
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const existing = pending.get(key);
  if (existing) {
    existing.watchers.push(needed);
    return existing.promise;
  }
  const watchers = [needed];
  const promise = session.queue.then(async () => {
    if (signal.aborted || !watchers.some(watch => watch())) return null;
    try {
      if (video.readyState < 2) {
        await waitForThumbnailMedia(video, 'loadeddata', signal, () => { video.src = source; });
      }
      const target = Math.min(time, video.duration - .001);
      if (Math.abs(target - video.currentTime) > .000001) {
        await waitForThumbnailMedia(video, 'seeked', signal, () => { video.currentTime = target; });
      }
      const scale = Math.min(1, width / video.videoWidth, height / video.videoHeight);
      const original = el('canvas', '', { width: video.videoWidth, height: video.videoHeight });
      original.getContext('2d').drawImage(video, 0, 0);
      let image = original;
      if (scale < 1) {
        image = el('canvas', '', {
          width: Math.max(1, Math.ceil(video.videoWidth * scale)),
          height: Math.max(1, Math.ceil(video.videoHeight * scale))
        });
        const context = image.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(original, 0, 0, image.width, image.height);
        original.width = original.height = 1;
      }
      cache.set(key, image);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return image;
    } catch {
      if (!signal.aborted) releaseThumbnailVideo(video);
      return null;
    }
  }).finally(() => pending.delete(key));
  pending.set(key, { watchers, promise });
  session.queue = promise;
  return promise;
}
function appendThumbnails(node, clip, start, end, width) {
  if (!model.wholeFilm) return;
  const count = Math.min(7, Math.max(1, Math.ceil(width / (heightMode === 'expanded' ? 196 : 89))));
  const strip = el('span', '', { class: 'thumbnail-strip' });
  strip.style.setProperty('--thumbnail-ratio', (model.video.width || 16) / (model.video.height || 9));
  node.append(strip);
  for (let i = 0; i < count; i++) {
    if (clip.thumbnail) {
      strip.append(el('img', '', { src: clip.thumbnail, alt: '', class: 'clip-thumbnail' }));
    } else {
      const thumb = el('canvas', '', { class: 'clip-thumbnail', width: 1, height: 1, 'aria-hidden': 'true' });
      strip.append(thumb);
      const frame = Math.ceil(start + (end - start) * i / count);
      requestAnimationFrame(() => {
        if (!thumb.isConnected) return;
        const bounds = thumb.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        thumbnailAt(frame, bounds.width * scale, bounds.height * scale, () => thumb.isConnected).then(image => {
          if (!image || !thumb.isConnected) return;
          thumb.width = image.width;
          thumb.height = image.height;
          thumb.getContext('2d').drawImage(image, 0, 0);
          thumb.dataset.frame = frame;
        });
      });
    }
  }
}
let lastClipClick;
function renderClip(lane, track, clip, pixels) {
  const active = selected?.track === track.id && selected.clip === clip.index;
  const start = Math.max(clip.position, range.start);
  const end = Math.min(clipEnd(clip), range.start + range.span);
  const width = (end - start) * pixels;
  const item = button('', () => {
    const key = shotDecisionKey(track, clip);
    const now = performance.now();
    const double = lastClipClick?.key === key && now - lastClipClick.time < 380;
    lastClipClick = double ? null : { key, time: now };
    chooseClip(track, clip, double ? 'selection' : undefined);
  }, 'edit-clip' + (clip.placeholder ? ' placeholder' : ''));
  item.dataset.track = track.id;
  item.dataset.clip = clip.index;
  if (clip.shot) item.dataset.shot = clip.shot;
  item.setAttribute('aria-pressed', active);
  item.setAttribute('aria-label', clip.name + ' · ' + timecode(clip.position));
  item.title = item.getAttribute('aria-label');
  const content = el('span', '', { class: 'clip-content' });
  item.append(content);
  const caption = width >= 110 ? clip.name : width >= 26 ? clip.shot || clip.name : '';
  if (caption) content.append(el('span', caption, { class: width < 110 ? 'clip-caption compact-caption' : 'clip-caption' }));
  if (track.type === 'video' && width >= 20) appendThumbnails(content, clip, start, end, width);
  if (track.type === 'audio' && model.mixUrl) waveform(content, clip, width, start, end);
  if (model.reviewData && track.type === 'video' && !clip.shot) {
    for (const mark of model.reviewData.shots) if (mark.frame > start && mark.frame < end) {
      content.append(pos(el('span', '', { class: 'internal-boundary', title: 'Shot markers - ' + mark.title }),
        mark.frame, undefined, { start, span: end - start }));
    }
  }
  if (clip.placeholder && width >= 84 && width < 110) content.append(el('span', 'Placeholder', { class: 'clip-state' }));
  if (width < 12) {
    item.classList.add('small-hit');
    content.style.width = Math.max(6, width) + 'px';
  }
  lane.append(pos(item, clip.position, clipEnd(clip)));
}
function placeClusterMenu(anchor, menu, gap = 1) {
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(0, Math.min(rect.left, innerWidth - 166)) + 'px';
  menu.style.bottom = innerHeight - rect.top - gap + 'px';
}
function renderCluster(lane, track, clips) {
  const first = clips[0].position, end = clipEnd(clips.at(-1));
  const group = pos(el('div', '', { class: 'cluster' }), first, end);
  const open = button(countLabel(clips.length, 'clip'), () => setRange(first - (end - first) * .3, (end - first) * 1.6), 'cluster-button');
  open.title = 'Zoom in ' + clips.length + ' short clips';
  const bars = el('span', '', { class: 'cluster-bars', 'aria-hidden': 'true' });
  const menu = el('div', '', { class: 'cluster-menu' });
  for (const clip of clips) {
    bars.append(el('i', '', { class: clip.placeholder ? 'placeholder' : '' }));
    menu.append(button((clip.shot || clip.name) + ' · ' + ((clip.end - clip.start) / model.fps).toFixed(3) + ' s',
      () => chooseClip(track, clip, 'selection')));
  }
  open.append(bars);
  group.append(open, menu);
  group.onmouseenter = group.onfocusin = () => placeClusterMenu(open, menu);
  lane.append(group);
}
function renderTracks() {
  const container = $('tracks');
  const pixels = laneWidth() / range.span;
  container.replaceChildren();
  container.classList.toggle('multitrack', model.tracks.length > 2);
  for (const track of model.tracks) {
    if ($('active-tracks').checked && !track.clips.length) continue;
    if (heightMode === 'collapsed' && track !== pictureTrack()) continue;
    const { head, lane } = makeRow('', 'project-track ' + track.type, container);
    head.append(el('strong', trackCode(track)), el('span',
      model.generic ? track.name : model.wholeFilm ? (track.type === 'audio' ? 'Mix - combined' : 'Picture') : trackLabels[track.name] || track.name),
      el('small', 'Kdenlive · ' + countLabel(track.clips.length, 'clip')));
    head.title = track.name;
    const visible = track.clips.filter(clip => intersects(clip.position, clipEnd(clip))).sort((a, b) => a.position - b.position);
    for (let i = 0; i < visible.length;) {
      const clip = visible[i];
      let next = i + 1;
      if (track.type === 'video' && (clipEnd(clip) - clip.position) * pixels < 12) {
        while (next < visible.length && (clipEnd(visible[next]) - visible[next].position) * pixels < 12 &&
          (visible[next].position - clipEnd(visible[next - 1])) * pixels < 6) next++;
      }
      if (next > i + 1) renderCluster(lane, track, visible.slice(i, next));
      else renderClip(lane, track, clip, pixels);
      i = next;
    }
    if (!track.clips.length) missing(lane, 'Empty track');
    selectionBand(lane);
  }
}
function renderTimeline() {
  if (!model || !range) return;
  $('timeline-range').textContent = timecode(range.start) + ' – ' + timecode(range.start + range.span);
  $('zoom-act').disabled = !chapters().length && !model.focus;
  $('zoom-selection').disabled = !selectedClip();
  $('ruler-bars').disabled = !model.reviewData;
  $('track-filter').hidden = model.tracks.length <= 2;
  for (const [id, name] of [['zoom-full', 'full'], ['zoom-act', 'act'], ['zoom-selection', 'selection']]) {
    $(id).setAttribute('aria-pressed', range.preset === name);
  }
  const scroll = $('timeline-scroll');
  $('edit').style.setProperty('--scroll-gutter', (scroll.offsetWidth - scroll.clientWidth) + 'px');
  renderOverview();
  renderReviewRows();
  renderTracks();
  syncPlayhead();
}
$('zoom-full').onclick = () => setRange(0, model.frames, 'full');
$('zoom-act').onclick = () => zoomAct();
$('zoom-selection').onclick = zoomSelection;
$('zoom-out').onclick = () => magnify(2, playFrame());
$('zoom-in').onclick = () => magnify(.5, playFrame());
$('collapse-tracks').onclick = () => setHeight('collapsed');
$('standard-tracks').onclick = () => setHeight('standard');
$('expand-tracks').onclick = () => setHeight('expanded');
$('active-tracks').onchange = renderTimeline;
for (const [id, mode] of [['ruler-time', 'time'], ['ruler-bars', 'bars']]) {
  $(id).onclick = () => {
    rulerMode = mode;
    $('ruler-time').setAttribute('aria-pressed', mode === 'time');
    $('ruler-bars').setAttribute('aria-pressed', mode === 'bars');
    renderTimeline();
  };
}
$('play-toggle').onclick = togglePlayback;
$('prev-frame').onclick = () => stepFrame(-1);
$('next-frame').onclick = () => stepFrame(1);
$('prev-cut').onclick = () => jumpCut(-1);
$('next-cut').onclick = () => jumpCut(1);
$('loop-shot').onclick = toggleLoop;
$('mute').onclick = () => {
  muted = !muted;
  if (player instanceof HTMLMediaElement) player.muted = muted;
  $('mute').textContent = muted ? 'Muted' : 'Volume';
  $('mute').setAttribute('aria-pressed', muted);
};
$('speed').onclick = () => {
  const speeds = [1, 1.25, 1.5, .5, .75];
  playbackRate = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length];
  if (player instanceof HTMLMediaElement) player.playbackRate = playbackRate;
  $('speed').textContent = playbackRate + '×';
};
$('edit').addEventListener('wheel', event => {
  if (!model || (!event.ctrlKey && !event.shiftKey && !event.deltaX)) return;
  const lane = rulerLane?.isConnected ? rulerLane : $('tracks').querySelector('.lane');
  if (!lane) return;
  event.preventDefault();
  if (event.ctrlKey) magnify(event.deltaY < 0 ? .8 : 1.25, range.start + range.span * ratio(event, lane));
  else setRange(range.start + (event.deltaX || event.deltaY) * range.span / laneWidth(), range.span);
}, { passive: false });
document.addEventListener('keydown', event => {
  if (!model || $('side-panel').open || event.target.closest('input,select,textarea,[contenteditable]')) return;
  let action;
  if (event.ctrlKey && event.key === '1') action = () => toggleComfy(false);
  else if (event.ctrlKey && event.key === '2') action = () => toggleComfy(true);
  else if (document.body.dataset.view === 'comfy') return;
  else if (event.ctrlKey && event.key === '0') action = $('zoom-full').onclick;
  else if (event.shiftKey && event.key.toLowerCase() === 'z') action = zoomSelection;
  else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'n') action = openQuickNote;
  else if (!event.ctrlKey && !event.metaKey && !event.altKey && ['[', ']'].includes(event.key)) {
    action = () => jumpAdjacentNote(event.key === '[' ? -1 : 1);
  }
  else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    action = () => event.altKey ? jumpCut(direction) : stepFrame(direction);
  } else if (event.code === 'Space') action = togglePlayback;
  else if (event.key === 'Escape') action = document.fullscreenElement === reviewMonitor ? toggleReviewFullscreen :
    () => $('review').classList.remove('show-inspector');
  if (!action) return;
  event.preventDefault();
  action();
});
let resizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(renderTimeline);
});
function watchThumbnailScale() {
  matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)').addEventListener('change', () => {
    watchThumbnailScale();
    renderTimeline();
  }, { once: true });
}
watchThumbnailScale();
