'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const schema = 'production-canvas/v1';
const shotPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const problem = (message, status = 422) => Object.assign(new Error(message), { status });

function inside(parent, file) {
  const relative = path.relative(parent, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function existing(parent, relative) {
  if (typeof relative !== 'string' || !relative) throw problem('Missing project file reference', 404);
  let file;
  try { file = fs.realpathSync(path.resolve(parent, relative)); }
  catch (error) {
    if (error.code === 'ENOENT') throw problem('Project file does not exist: ' + relative, 404);
    throw error;
  }
  if (!inside(parent, file) || !fs.statSync(file).isFile()) throw problem('File is outside the project directory', 403);
  return file;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw problem(label + ' requires a valid integer');
  return value;
}

function text(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw problem(label + ' is invalid');
  return value;
}

function loadProject(binding) {
  const dir = fs.realpathSync(binding.root);
  const name = binding.manifest || (fs.existsSync(path.join(dir, 'project.json')) ? 'project.json' : 'current-manifest.json');
  if (!/^[a-z0-9._-]+\.json$/i.test(name)) throw problem('Expected a JSON manifest in the project root');
  const manifest = read(existing(dir, name));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw problem('The project manifest must be a JSON object');
  let review = null;
  let battle = null;
  if (manifest.schema === schema) {
    text(manifest.title, 'Project title');
    existing(dir, manifest.timeline);
    if (!manifest.video || typeof manifest.video !== 'object') throw problem('Missing review video');
    existing(dir, manifest.video.path);
    if (manifest.video.label !== undefined) text(manifest.video.label, 'Version label', 160);
    if (manifest.review !== undefined) existing(dir, manifest.review);
    if (manifest.notes !== undefined) existing(dir, manifest.notes);
    if (manifest.mix !== undefined) existing(dir, manifest.mix);
    if (manifest.focus !== undefined) {
      integer(manifest.focus.start, 'Focus start');
      integer(manifest.focus.end, 'Focus end', manifest.focus.start + 1);
      existing(dir, manifest.focus.path);
      text(manifest.focus.label, 'Focus title', 160);
    }
    if (manifest.comfy !== undefined) {
      existing(dir, manifest.comfy.path);
      text(manifest.comfy.canvas_id, 'ComfyUI workspace ID');
    }
    review = manifest;
  } else if (manifest.schema !== undefined) {
    throw problem('Unsupported project format: ' + manifest.schema);
  } else if (manifest.current_battle_revision?.manifest) {
    battle = read(existing(dir, manifest.current_battle_revision.manifest));
  } else if (!manifest.active_s03_storyboard?.editable_project?.path || !manifest.active_s01_s02_revision?.video?.path) {
    throw problem('Expected a production-canvas/v1 manifest or a supported legacy manifest');
  }
  const store = review ? path.join(dir, '.production-canvas') : path.join(fs.realpathSync(path.join(dir, 'edit')), 'production-canvas');
  if (!inside(dir, store) || (fs.existsSync(store) && !inside(dir, fs.realpathSync(store)))) {
    throw problem('Annotation directory is outside the project', 403);
  }
  return { dir, manifest, manifestName: name, review, battle, store, title: binding.title || manifest.title || path.basename(dir) };
}

function reviewVideoPaths(project) {
  const { review, battle, manifest } = project;
  if (review) return { s03: review.video.path, battle: review.focus?.path };
  if (battle) return { s03: battle.current_candidate?.path, battle: battle.short_review?.path };
  return { s03: manifest.active_s03_storyboard?.preview?.path, opening: manifest.active_s01_s02_revision?.video?.path };
}

function videoArgument(args, cwd) {
  const files = args.filter(value => !value.startsWith('-'));
  if (!files.length) return null;
  if (files.length !== 1) throw problem('Open one review video at a time');
  if (path.extname(files[0]).toLowerCase() !== '.mp4') throw problem('Select an MP4 review video');
  return path.resolve(cwd, files[0]);
}

function findVideoProject(filename, registered) {
  const video = fs.realpathSync(filename);
  if (!fs.statSync(video).isFile() || path.extname(filename).toLowerCase() !== '.mp4') {
    throw problem('Select an MP4 review video');
  }
  const match = (binding, id) => {
    let project;
    try { project = loadProject(binding); } catch { return null; }
    for (const [view, relative] of Object.entries(reviewVideoPaths(project))) {
      if (!relative) continue;
      let file;
      try { file = existing(project.dir, relative); } catch { continue; }
      if (path.relative(video, file) === '') {
        return { id, view, binding: { title: project.title, root: project.dir, manifest: project.manifestName } };
      }
    }
    return null;
  };
  const registeredMatches = registered.map(([id, binding]) => match(binding, id)).filter(Boolean);
  const unique = new Map(registeredMatches.map(item =>
    [JSON.stringify([process.platform === 'win32' ? item.binding.root.toLowerCase() : item.binding.root,
      process.platform === 'win32' ? item.binding.manifest.toLowerCase() : item.binding.manifest, item.view]), item]));
  if (unique.size === 1) return registeredMatches[0];
  if (unique.size > 1) throw problem('Multiple registered projects reference this video. Use Open project manifest to select an edit.');
  for (let root = path.dirname(video); ; root = path.dirname(root)) {
    const matches = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^project(?:-[a-z0-9._-]+)?\.json$/i.test(entry.name))
      .map(entry => match({ root, manifest: entry.name })).filter(Boolean);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw problem('Multiple project manifests reference this video. Use Open project manifest to select an edit.');
    const legacy = match({ root, manifest: 'current-manifest.json' });
    if (legacy) return legacy;
    if (path.dirname(root) === root) break;
  }
  throw problem('No review project found for "' + path.basename(video) + '". Use Open project manifest to connect its video and edit.', 404);
}

// Kdenlive's native XML uses inclusive out points. The shared model uses exclusive ends.
function readNativeTimeline(bytes, file) {
  const xml = bytes.toString('utf8');
  if (xml.length > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw problem('Edits with DTD or entity declarations are unsupported');
  if (XMLValidator.validate(xml) !== true) throw problem('Invalid Kdenlive XML');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(xml);
  const rootNode = parsed.find(node => node.mlt);
  const nodes = rootNode?.mlt;
  if (!nodes) throw problem('Expected an MLT/Kdenlive XML file');
  const attrs = node => node?.[':@'] || {};
  const mediaRoot = path.resolve(path.dirname(file), attrs(rootNode)['@_root'] || '.');
  const properties = node => Object.fromEntries((node || []).filter(item => item.property)
    .map(item => [attrs(item)['@_name'], item.property.map(part => part['#text'] || '').join('')]));
  const profile = attrs(nodes.find(node => node.profile));
  const fpsNum = Number(profile['@_frame_rate_num']);
  const fpsDen = Number(profile['@_frame_rate_den']);
  const fps = fpsNum / fpsDen;
  if (!Number.isFinite(fps) || fps <= 0) throw problem('Invalid edit frame rate');
  const frame = value => {
    if (/^\d+$/.test(String(value))) return Number(value);
    const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(value));
    if (!clock) throw problem('Unsupported MLT timecode: ' + value);
    return Math.round((Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * fps);
  };
  const registry = new Map(nodes.filter(node => attrs(node)['@_id']).map(node => [attrs(node)['@_id'], node]));
  const mainBin = registry.get('main_bin');
  const active = properties(mainBin?.playlist)['kdenlive:docproperties.activetimeline'];
  const wrapper = nodes.find(node => node.tractor && properties(node.tractor)['kdenlive:projectTractor'] === '1');
  const rootId = active || attrs(wrapper?.tractor.find(node => node.track))['@_producer'];
  if (rootId && !registry.has(rootId)) throw problem('Invalid main sequence reference');
  const root = registry.get(rootId) || nodes.findLast(node => node.tractor);
  if (!root?.tractor) throw problem('The edit has no readable main timeline');
  const bin = new Map();
  const tracks = [];
  for (const reference of root.tractor.filter(node => node.track)) {
    const trackNode = registry.get(attrs(reference)['@_producer']);
    if (trackNode?.producer && properties(trackNode.producer)['kdenlive:playlistid'] === 'black_track') continue;
    if (!trackNode?.tractor && !trackNode?.playlist) throw problem('Unsupported main timeline track');
    const trackProperties = properties(trackNode.tractor || trackNode.playlist);
    const type = trackProperties['kdenlive:audio_track'] === '1' || attrs(reference)['@_hide'] === 'video' ? 'audio' : 'video';
    const playlists = trackNode.playlist ? [trackNode] : trackNode.tractor.filter(node => node.track)
      .map(node => registry.get(attrs(node)['@_producer']));
    const clips = [];
    for (const playlist of playlists) {
      if (!playlist?.playlist) throw problem('Nested sequences are unsupported. Provide a flattened timeline');
      let cursor = 0;
      for (const entry of playlist.playlist) {
        if (entry.blank) { cursor += frame(attrs(entry)['@_length']); continue; }
        if (!entry.entry) continue;
        const attributes = attrs(entry);
        const producer = registry.get(attributes['@_producer']);
        const content = producer?.chain || producer?.producer;
        if (!content) throw problem('Nested clips prevent reliable cut detection');
        const info = properties(content);
        if (info.mlt_service === 'timewarp') throw problem('Timewarp clips are unsupported. Provide a flattened, constant-frame-rate timeline');
        const id = info['kdenlive:id'] || attributes['@_producer'];
        const start = frame(attributes['@_in'] ?? 0);
        const end = frame(attributes['@_out']) + 1;
        const length = info.length ? frame(info.length) : frame(attrs(producer)['@_out'] ?? end - 1) + 1;
        const source = info.resource;
        const item = { id, name: info['kdenlive:clipname'] || (source && path.basename(source)) || id,
          source: source && path.resolve(mediaRoot, source), duration: length / fps,
          type: info.video_index === '-1' ? 'audio' : /\.(png|jpe?g|webp)$/i.test(source || '') ? 'image' : 'video' };
        if (bin.has(id) && bin.get(id).source !== item.source) throw problem('A source ID references more than one file');
        bin.set(id, item);
        clips.push({ clip_id: id, position: cursor / fps, in: start / fps, out: end / fps,
          filters: content.filter(node => node.filter).map(node => properties(node.filter)),
          shot: properties(entry.entry)['production_canvas:shot'] });
        cursor += end - start;
      }
    }
    clips.sort((a, b) => a.position - b.position);
    tracks.push({ id: tracks.length, name: trackProperties['kdenlive:track_name'] || type + ' ' + (tracks.length + 1), type, clips });
  }
  return { profile: { fps_num: fpsNum, fps_den: fpsDen, width: Number(profile['@_width']), height: Number(profile['@_height']) },
    bin: [...bin.values()], tracks, transitions: [] };
}

function readTimeline(file) {
  const bytes = fs.readFileSync(file);
  const native = file.toLowerCase().endsWith('.kdenlive');
  const data = native ? readNativeTimeline(bytes, file) : JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const { fps_num: numerator, fps_den: denominator, width, height } = data.profile || {};
  integer(numerator, 'Frame-rate numerator', 1);
  integer(denominator, 'Frame-rate denominator', 1);
  const fps = numerator / denominator;
  const frames = (seconds, label) => {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.round(seconds * fps))) throw problem(label + ' is invalid');
    return Math.round(seconds * fps);
  };
  if (!Array.isArray(data.bin) || !Array.isArray(data.tracks)) throw problem('The edit is missing its source or track list');
  const bin = new Map(data.bin.map(item => [text(item.id, 'Source ID'), item]));
  if (bin.size !== data.bin.length) throw problem('Duplicate source ID');
  const ids = new Set();
  const tracks = data.tracks.map(track => {
    integer(track.id, 'Track ID');
    if (ids.has(track.id) || !['audio', 'video'].includes(track.type) || !Array.isArray(track.clips)) throw problem('Invalid track format');
    ids.add(track.id);
    return { id: track.id, name: text(track.name, 'Track name'), type: track.type,
      clips: track.clips.map((clip, index) => {
        const item = bin.get(clip.clip_id);
        if (!item) throw problem('A clip references a missing source');
        const start = frames(clip.in, 'Source in point');
        const end = frames(clip.out, 'Source out point');
        const max = frames(item.duration, 'Source duration');
        if (start >= end || end > max) throw problem('Source in/out points are out of range');
        if (clip.shot !== undefined && !shotPattern.test(clip.shot)) throw problem('Invalid shot ID');
        return { index, bin: item.id, name: item.name || item.id, mediaType: item.type,
          position: frames(clip.position, 'Clip position'), start, end, max, effects: clip.filters || [],
          ...(clip.shot ? { shot: clip.shot } : {}) };
      }) };
  });
  const end = Math.max(1, ...tracks.flatMap(track => track.clips.map(clip => clip.position + clip.end - clip.start)));
  return { source: file, native, bin, tracks, fps, frames: end, width, height, revision: hash(bytes), transitions: data.transitions || [] };
}

function readReview(project, timeline, actualPreviewSha256) {
  const legacy = 'edit/production-canvas/review-data.json';
  const file = project.review?.review || project.manifest.production_canvas?.review ||
    (project.battle && fs.existsSync(path.join(project.dir, legacy)) ? legacy : null);
  if (!file) return { data: null, warning: null };
  const record = read(existing(project.dir, file));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw problem('Review annotations must be a JSON object');
  for (const key of ['timelineRevision', 'previewSha256']) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !/^[a-f0-9]{64}$/.test(record[key]))) {
      throw problem(key + ' requires a SHA-256 hash');
    }
  }
  const previewSha256 = actualPreviewSha256 ?? project.review?.video.sha256 ?? project.battle?.current_candidate.sha256;
  if ((record.timelineRevision && record.timelineRevision !== timeline.revision) ||
      (record.previewSha256 && record.previewSha256 !== previewSha256)) {
    return { data: null, warning: 'Review annotations belong to another edit revision. Update the project annotation file.' };
  }
  for (const name of ['chapters', 'shots', 'cues', 'sounds', 'clips']) {
    if (record[name] !== undefined && !Array.isArray(record[name])) throw problem(name + ' must be an array');
  }
  const point = row => {
    text(row.title, 'Annotation title');
    integer(row.frame, 'Annotation frame');
    if (row.frame >= timeline.frames) throw problem('Annotation is outside the timeline');
    return row;
  };
  const chapters = (record.chapters || []).map(row => {
    text(row.title, 'Chapter title');
    integer(row.start, 'Chapter start');
    integer(row.end, 'Chapter end', row.start + 1);
    if (row.end > timeline.frames) throw problem('Chapter is outside the timeline');
    if (row.color !== undefined && !/^#[0-9a-f]{6}$/i.test(row.color)) throw problem('Invalid chapter color');
    return row;
  });
  const seen = new Set();
  const clips = (record.clips || []).map(row => {
    integer(row.track, 'Annotation track');
    integer(row.clip, 'Annotation clip');
    const clip = timeline.tracks.find(track => track.id === row.track)?.clips[row.clip];
    const key = row.track + ':' + row.clip;
    if (!clip || seen.has(key)) throw problem('Clip annotation is missing or duplicated');
    seen.add(key);
    if (row.shot !== undefined && !shotPattern.test(row.shot)) throw problem('Invalid shot ID');
    if (row.placeholder !== undefined && typeof row.placeholder !== 'boolean') throw problem('Placeholder status must be boolean');
    if (row.thumbnail) {
      existing(project.dir, row.thumbnail.path);
      if (!/^[a-f0-9]{64}$/.test(row.thumbnail.sha256 || '')) throw problem('Thumbnail requires a SHA-256 hash');
    }
    return row;
  });
  let music = record.music;
  if (music?.bpm !== undefined) {
    if (!Number.isFinite(music.bpm) || music.bpm <= 0 || music.bpm > 1000) throw problem('Invalid BPM');
    integer(music.beatsPerBar, 'Beats per bar', 1);
    integer(music.start, 'Music start');
    integer(music.end, 'Music end', music.start + 1);
    if (music.beatsPerBar > 16 || music.end > timeline.frames) throw problem('Invalid music range');
    music = { ...music, offset: music.start / timeline.fps, end: music.end / timeline.fps, bar: 60 * music.beatsPerBar / music.bpm };
  } else if (music && (![music.offset, music.bar, music.end].every(Number.isFinite) || music.bar <= 0 || music.offset < 0 || music.end <= music.offset)) {
    throw problem('Invalid bar record');
  }
  return { data: { ...record, chapters, shots: (record.shots || []).map(point), cues: (record.cues || []).map(point),
    sounds: (record.sounds || []).map(point), clips, music }, warning: null };
}

module.exports = { schema, shotPattern, loadProject, reviewVideoPaths, videoArgument, findVideoProject, readTimeline, readReview, read, hash, inside, existing };
