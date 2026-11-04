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
  if (typeof relative !== 'string' || !relative) throw problem('缺少项目文件记录', 404);
  let file;
  try { file = fs.realpathSync(path.resolve(parent, relative)); }
  catch (error) {
    if (error.code === 'ENOENT') throw problem('项目文件不存在：' + relative, 404);
    throw error;
  }
  if (!inside(parent, file) || !fs.statSync(file).isFile()) throw problem('文件超出项目目录', 403);
  return file;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw problem(label + '需要有效整数');
  return value;
}

function text(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw problem(label + '无效');
  return value;
}

function loadProject(binding) {
  const dir = fs.realpathSync(binding.root);
  const name = binding.manifest || (fs.existsSync(path.join(dir, 'project.json')) ? 'project.json' : 'current-manifest.json');
  if (!/^[a-z0-9._-]+\.json$/i.test(name)) throw problem('需要项目根目录中的 JSON 清单');
  const manifest = read(existing(dir, name));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw problem('项目清单需要 JSON 对象');
  let review = null;
  let battle = null;
  if (manifest.schema === schema) {
    text(manifest.title, '项目名称');
    existing(dir, manifest.timeline);
    if (!manifest.video || typeof manifest.video !== 'object') throw problem('缺少审片视频');
    existing(dir, manifest.video.path);
    if (manifest.video.label !== undefined) text(manifest.video.label, '版本名称', 160);
    if (manifest.review !== undefined) existing(dir, manifest.review);
    if (manifest.notes !== undefined) existing(dir, manifest.notes);
    if (manifest.mix !== undefined) existing(dir, manifest.mix);
    if (manifest.focus !== undefined) {
      integer(manifest.focus.start, '重点片段起点');
      integer(manifest.focus.end, '重点片段终点', manifest.focus.start + 1);
      existing(dir, manifest.focus.path);
      text(manifest.focus.label, '重点片段名称', 160);
    }
    if (manifest.comfy !== undefined) {
      existing(dir, manifest.comfy.path);
      text(manifest.comfy.canvas_id, 'ComfyUI 画布编号');
    }
    review = manifest;
  } else if (manifest.schema !== undefined) {
    throw problem('不支持的项目格式：' + manifest.schema);
  } else if (manifest.current_battle_revision?.manifest) {
    battle = read(existing(dir, manifest.current_battle_revision.manifest));
  } else if (!manifest.active_s03_storyboard?.editable_project?.path || !manifest.active_s01_s02_revision?.video?.path) {
    throw problem('需要 production-canvas/v1 项目清单或受支持的旧版项目清单');
  }
  const store = review ? path.join(dir, '.production-canvas') : path.join(fs.realpathSync(path.join(dir, 'edit')), 'production-canvas');
  if (!inside(dir, store) || (fs.existsSync(store) && !inside(dir, fs.realpathSync(store)))) {
    throw problem('指令目录超出项目', 403);
  }
  return { dir, manifest, manifestName: name, review, battle, store, title: binding.title || manifest.title || path.basename(dir) };
}

// Kdenlive's native XML uses inclusive out points. The shared model uses exclusive ends.
function readNativeTimeline(bytes, file) {
  const xml = bytes.toString('utf8');
  if (xml.length > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw problem('不支持带 DTD 或实体声明的剪辑文件');
  if (XMLValidator.validate(xml) !== true) throw problem('Kdenlive XML 格式无效');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(xml);
  const rootNode = parsed.find(node => node.mlt);
  const nodes = rootNode?.mlt;
  if (!nodes) throw problem('需要 MLT/Kdenlive XML 文件');
  const attrs = node => node?.[':@'] || {};
  const mediaRoot = path.resolve(path.dirname(file), attrs(rootNode)['@_root'] || '.');
  const properties = node => Object.fromEntries((node || []).filter(item => item.property)
    .map(item => [attrs(item)['@_name'], item.property.map(part => part['#text'] || '').join('')]));
  const profile = attrs(nodes.find(node => node.profile));
  const fpsNum = Number(profile['@_frame_rate_num']);
  const fpsDen = Number(profile['@_frame_rate_den']);
  const fps = fpsNum / fpsDen;
  if (!Number.isFinite(fps) || fps <= 0) throw problem('剪辑工程帧率无效');
  const frame = value => {
    if (/^\d+$/.test(String(value))) return Number(value);
    const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(value));
    if (!clock) throw problem('不支持的 MLT 时间码：' + value);
    return Math.round((Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * fps);
  };
  const registry = new Map(nodes.filter(node => attrs(node)['@_id']).map(node => [attrs(node)['@_id'], node]));
  const mainBin = registry.get('main_bin');
  const active = properties(mainBin?.playlist)['kdenlive:docproperties.activetimeline'];
  const wrapper = nodes.find(node => node.tractor && properties(node.tractor)['kdenlive:projectTractor'] === '1');
  const rootId = active || attrs(wrapper?.tractor.find(node => node.track))['@_producer'];
  if (rootId && !registry.has(rootId)) throw problem('剪辑工程的主序列引用无效');
  const root = registry.get(rootId) || nodes.findLast(node => node.tractor);
  if (!root?.tractor) throw problem('剪辑工程没有可读取的主时间线');
  const bin = new Map();
  const tracks = [];
  for (const reference of root.tractor.filter(node => node.track)) {
    const trackNode = registry.get(attrs(reference)['@_producer']);
    if (trackNode?.producer && properties(trackNode.producer)['kdenlive:playlistid'] === 'black_track') continue;
    if (!trackNode?.tractor && !trackNode?.playlist) throw problem('不支持的主时间线轨道');
    const trackProperties = properties(trackNode.tractor || trackNode.playlist);
    const type = trackProperties['kdenlive:audio_track'] === '1' || attrs(reference)['@_hide'] === 'video' ? 'audio' : 'video';
    const playlists = trackNode.playlist ? [trackNode] : trackNode.tractor.filter(node => node.track)
      .map(node => registry.get(attrs(node)['@_producer']));
    const clips = [];
    for (const playlist of playlists) {
      if (!playlist?.playlist) throw problem('嵌套序列暂不支持，请提供平铺时间线');
      let cursor = 0;
      for (const entry of playlist.playlist) {
        if (entry.blank) { cursor += frame(attrs(entry)['@_length']); continue; }
        if (!entry.entry) continue;
        const attributes = attrs(entry);
        const producer = registry.get(attributes['@_producer']);
        const content = producer?.chain || producer?.producer;
        if (!content) throw problem('时间线含嵌套片段，无法可靠读取剪点');
        const info = properties(content);
        if (info.mlt_service === 'timewarp') throw problem('变速片段暂不支持，请提供固定帧率平铺时间线');
        const id = info['kdenlive:id'] || attributes['@_producer'];
        const start = frame(attributes['@_in'] ?? 0);
        const end = frame(attributes['@_out']) + 1;
        const length = info.length ? frame(info.length) : frame(attrs(producer)['@_out'] ?? end - 1) + 1;
        const source = info.resource;
        const item = { id, name: info['kdenlive:clipname'] || (source && path.basename(source)) || id,
          source: source && path.resolve(mediaRoot, source), duration: length / fps,
          type: info.video_index === '-1' ? 'audio' : /\.(png|jpe?g|webp)$/i.test(source || '') ? 'image' : 'video' };
        if (bin.has(id) && bin.get(id).source !== item.source) throw problem('素材编号对应多个不同文件');
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
  integer(numerator, '帧率分子', 1);
  integer(denominator, '帧率分母', 1);
  const fps = numerator / denominator;
  const frames = (seconds, label) => {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.round(seconds * fps))) throw problem(label + '无效');
    return Math.round(seconds * fps);
  };
  if (!Array.isArray(data.bin) || !Array.isArray(data.tracks)) throw problem('剪辑工程缺少素材或轨道列表');
  const bin = new Map(data.bin.map(item => [text(item.id, '素材编号'), item]));
  if (bin.size !== data.bin.length) throw problem('素材编号重复');
  const ids = new Set();
  const tracks = data.tracks.map(track => {
    integer(track.id, '轨道编号');
    if (ids.has(track.id) || !['audio', 'video'].includes(track.type) || !Array.isArray(track.clips)) throw problem('轨道格式无效');
    ids.add(track.id);
    return { id: track.id, name: text(track.name, '轨道名称'), type: track.type,
      clips: track.clips.map((clip, index) => {
        const item = bin.get(clip.clip_id);
        if (!item) throw problem('剪辑片段引用了不存在的素材');
        const start = frames(clip.in, '素材入点');
        const end = frames(clip.out, '素材出点');
        const max = frames(item.duration, '素材时长');
        if (start >= end || end > max) throw problem('素材入出点超出范围');
        if (clip.shot !== undefined && !shotPattern.test(clip.shot)) throw problem('镜头编号无效');
        return { index, bin: item.id, name: item.name || item.id, mediaType: item.type,
          position: frames(clip.position, '片段位置'), start, end, max, effects: clip.filters || [],
          ...(clip.shot ? { shot: clip.shot } : {}) };
      }) };
  });
  const end = Math.max(1, ...tracks.flatMap(track => track.clips.map(clip => clip.position + clip.end - clip.start)));
  return { source: file, native, bin, tracks, fps, frames: end, width, height, revision: hash(bytes), transitions: data.transitions || [] };
}

function readReview(project, timeline) {
  const legacy = 'edit/production-canvas/review-data.json';
  const file = project.review?.review || project.manifest.production_canvas?.review ||
    (project.battle && fs.existsSync(path.join(project.dir, legacy)) ? legacy : null);
  if (!file) return { data: null, warning: null };
  const record = read(existing(project.dir, file));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw problem('审片标注需要 JSON 对象');
  for (const key of ['timelineRevision', 'previewSha256']) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !/^[a-f0-9]{64}$/.test(record[key]))) {
      throw problem(key + '需要 SHA-256');
    }
  }
  if ((record.timelineRevision && record.timelineRevision !== timeline.revision) ||
      (record.previewSha256 && record.previewSha256 !== (project.review?.video.sha256 || project.battle?.current_candidate.sha256))) {
    return { data: null, warning: '审片标注绑定了其他剪辑版本，请更新项目标注文件。' };
  }
  for (const name of ['chapters', 'shots', 'cues', 'sounds', 'clips']) {
    if (record[name] !== undefined && !Array.isArray(record[name])) throw problem(name + '需要数组');
  }
  const point = row => {
    text(row.title, '标注名称');
    integer(row.frame, '标注帧');
    if (row.frame >= timeline.frames) throw problem('标注超出时间线');
    return row;
  };
  const chapters = (record.chapters || []).map(row => {
    text(row.title, '章节名称');
    integer(row.start, '章节起点');
    integer(row.end, '章节终点', row.start + 1);
    if (row.end > timeline.frames) throw problem('章节超出时间线');
    if (row.color !== undefined && !/^#[0-9a-f]{6}$/i.test(row.color)) throw problem('章节颜色无效');
    return row;
  });
  const seen = new Set();
  const clips = (record.clips || []).map(row => {
    integer(row.track, '标注轨道');
    integer(row.clip, '标注片段');
    const clip = timeline.tracks.find(track => track.id === row.track)?.clips[row.clip];
    const key = row.track + ':' + row.clip;
    if (!clip || seen.has(key)) throw problem('片段标注不存在或重复');
    seen.add(key);
    if (row.shot !== undefined && !shotPattern.test(row.shot)) throw problem('镜头编号无效');
    if (row.placeholder !== undefined && typeof row.placeholder !== 'boolean') throw problem('占位状态需要布尔值');
    if (row.thumbnail) {
      existing(project.dir, row.thumbnail.path);
      if (!/^[a-f0-9]{64}$/.test(row.thumbnail.sha256 || '')) throw problem('缩略图需要 SHA-256');
    }
    return row;
  });
  let music = record.music;
  if (music?.bpm !== undefined) {
    if (!Number.isFinite(music.bpm) || music.bpm <= 0 || music.bpm > 1000) throw problem('BPM 无效');
    integer(music.beatsPerBar, '每小节拍数', 1);
    integer(music.start, '音乐起点');
    integer(music.end, '音乐终点', music.start + 1);
    if (music.beatsPerBar > 16 || music.end > timeline.frames) throw problem('音乐范围无效');
    music = { ...music, offset: music.start / timeline.fps, end: music.end / timeline.fps, bar: 60 * music.beatsPerBar / music.bpm };
  } else if (music && (![music.offset, music.bar, music.end].every(Number.isFinite) || music.bar <= 0 || music.offset < 0 || music.end <= music.offset)) {
    throw problem('小节记录无效');
  }
  return { data: { ...record, chapters, shots: (record.shots || []).map(point), cues: (record.cues || []).map(point),
    sounds: (record.sounds || []).map(point), clips, music }, warning: null };
}

module.exports = { schema, shotPattern, loadProject, readTimeline, readReview, read, hash, inside, existing };
