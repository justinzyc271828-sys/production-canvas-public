const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProject, readTimeline, readReview, existing, hash } = require('../app/project');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-project-test-'));
  fs.cpSync(path.resolve(__dirname, '../demo'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('generic project resolves a native timeline and complete editorial data', t => {
  const root = fixture(t);
  const p = loadProject({ root });
  const timeline = readTimeline(existing(root, p.review.timeline));
  const review = readReview(p, timeline);
  assert.equal(p.manifestName, 'project.json');
  assert.equal(p.store, path.join(root, '.production-canvas'));
  assert.equal(timeline.frames, 720);
  assert.equal(timeline.fps, 24);
  assert.deepEqual(timeline.tracks.map(track => track.clips.length), [16, 1]);
  assert.equal(review.data.chapters.length, 4);
  assert.equal(review.data.clips.filter(clip => clip.placeholder).length, 3);
  assert.equal(review.data.music.bar, 2);
  assert.equal(review.warning, null);
});

test('native inclusive out points match the CLI JSON exclusive ranges', t => {
  const root = fixture(t);
  const native = readTimeline(path.join(root, 'edit/sample.kdenlive'));
  const json = readTimeline(path.join(root, 'edit/sample.kdenlive-cli.json'));
  assert.deepEqual(native.tracks, json.tracks);
});

test('native blank time and timecode entries preserve the playhead position', t => {
  const root = fixture(t);
  const file = path.join(root, 'edit/sample.kdenlive');
  const xml = fs.readFileSync(file, 'utf8').replace('<playlist id="video">', '<playlist id="video"><blank length="00:00:01.000"/>')
    .replace('in="0" out="95"', 'in="00:00:00.000" out="00:00:03.958"');
  fs.writeFileSync(file, xml);
  const timeline = readTimeline(file);
  assert.equal(timeline.tracks[0].clips[0].position, 24);
  assert.equal(timeline.tracks[0].clips[0].end, 96);
  assert.equal(timeline.frames, 744);
});

test('native parsing rejects entity declarations and missing producers', t => {
  const root = fixture(t), file = path.join(root, 'edit/sample.kdenlive');
  const xml = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '<!DOCTYPE x [<!ENTITY x "x">]>' + xml);
  assert.throws(() => readTimeline(file), /DTD/);
  fs.writeFileSync(file, xml.replace('<entry producer="source-1"', '<entry producer="missing"'));
  assert.throws(() => readTimeline(file), /嵌套片段/);
});

test('invalid timeline ranges and duplicate tracks fail explicitly', t => {
  const root = fixture(t), file = path.join(root, 'edit/sample.kdenlive-cli.json');
  const doc = JSON.parse(fs.readFileSync(file));
  doc.tracks[0].clips[0].out = -1;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => readTimeline(file), /出点/);
  doc.tracks[0].clips[0].out = 4;
  doc.tracks[1].id = 0;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => readTimeline(file), /轨道/);
});

test('project paths reject files outside the selected root', t => {
  const root = fixture(t);
  assert.throws(() => existing(root, '../outside'), /不存在|超出/);
  assert.throws(() => existing(root, __filename), /超出/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'project.json')));
  manifest.video.path = __filename;
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(manifest));
  assert.throws(() => loadProject({ root }), /超出/);
});

test('mismatched editorial hashes are visible as warnings', t => {
  const root = fixture(t), p = loadProject({ root });
  const timeline = readTimeline(existing(root, p.review.timeline));
  const file = path.join(root, 'review.json');
  const review = JSON.parse(fs.readFileSync(file));
  review.timelineRevision = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(review));
  assert.deepEqual(readReview(p, timeline), { data: null, warning: '审片标注绑定了其他剪辑版本，请更新项目标注文件。' });
});

test('unknown project schema and invalid editorial clip mappings fail explicitly', t => {
  const root = fixture(t), file = path.join(root, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.schema = 'production-canvas/v99';
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => loadProject({ root }), /不支持/);
  manifest.schema = 'production-canvas/v1';
  fs.writeFileSync(file, JSON.stringify(manifest));
  const p = loadProject({ root }), timeline = readTimeline(existing(root, p.review.timeline));
  const review = JSON.parse(fs.readFileSync(path.join(root, 'review.json')));
  review.clips[0].clip = 100;
  fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify(review));
  assert.throws(() => readReview(p, timeline), /片段标注/);
});

test('legacy opening/storyboard projects still bind without the generic schema', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'edit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify({
    active_s01_s02_revision: { video: { path: 'media/sequence.mp4' } },
    active_s03_storyboard: { editable_project: { path: 'edit/sample.kdenlive' } }
  }));
  const p = loadProject({ root, manifest: 'old.json' });
  assert.equal(p.review, null);
  assert.equal(p.store, path.join(root, 'edit/production-canvas'));
});

test('legacy battle projects read project-owned editorial metadata', t => {
  const root = fixture(t), native = 'edit/sample.kdenlive';
  fs.mkdirSync(path.join(root, 'edit/production-canvas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'old.json'), JSON.stringify({ current_battle_revision: { manifest: 'battle.json' } }));
  fs.writeFileSync(path.join(root, 'battle.json'), JSON.stringify({ working_project: native, current_candidate: { sha256: 'f'.repeat(64) } }));
  fs.copyFileSync(path.join(root, 'review.json'), path.join(root, 'edit/production-canvas/review-data.json'));
  const p = loadProject({ root, manifest: 'old.json' });
  assert.equal(readReview(p, readTimeline(path.join(root, native))).data.clips.length, 16);
  assert.equal(hash(fs.readFileSync(path.join(root, native))).length, 64);
});

test('rational native frame rates preserve integer frame boundaries', t => {
  const root = fixture(t), file = path.join(root, 'edit/sample.kdenlive');
  const xml = fs.readFileSync(file, 'utf8').replace('frame_rate_num="24" frame_rate_den="1"', 'frame_rate_num="24000" frame_rate_den="1001"');
  fs.writeFileSync(file, xml);
  const timeline = readTimeline(file);
  assert.equal(timeline.fps, 24000 / 1001);
  assert.equal(timeline.frames, 720);
  assert.equal(timeline.tracks[0].clips[5].position, 300);
  assert.equal(timeline.tracks[0].clips[5].end, 306);
});

test('native empty tracks retain their place in a nine-track edit', t => {
  const root = fixture(t), file = path.join(root, 'edit/sample.kdenlive');
  let xml = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 7; i++) {
    xml = xml.replace('<playlist id="main_bin">', '<playlist id="empty-' + i + '"/><tractor id="empty-track-' + i +
      '"><property name="kdenlive:audio_track">1</property><track producer="empty-' + i + '" hide="video"/></tractor><playlist id="main_bin">');
    xml = xml.replace('<track producer="video-track"/>', '<track producer="empty-track-' + i + '"/><track producer="video-track"/>');
  }
  fs.writeFileSync(file, xml);
  const timeline = readTimeline(file);
  assert.equal(timeline.tracks.length, 9);
  assert.equal(timeline.tracks.filter(track => track.clips.length === 0).length, 7);
});

test('invalid editorial points and timewarp sources fail explicitly', t => {
  const root = fixture(t), p = loadProject({ root }), file = path.join(root, 'edit/sample.kdenlive');
  const reviewFile = path.join(root, 'review.json');
  const review = JSON.parse(fs.readFileSync(reviewFile));
  review.cues[0].frame = 1.5;
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  assert.throws(() => readReview(p, readTimeline(file)), /整数/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('>avformat<', '>timewarp<'));
  assert.throws(() => readTimeline(file), /变速/);
});

test('native resource paths honor the MLT root directory', t => {
  const root = fixture(t), file = path.join(root, 'edit/sample.kdenlive');
  const xml = fs.readFileSync(file, 'utf8').replace('<mlt producer="main_bin">', '<mlt producer="main_bin" root="..">')
    .replaceAll('../media/', 'media/');
  fs.writeFileSync(file, xml);
  const timeline = readTimeline(file);
  assert.equal(timeline.bin.get('1').source, path.join(root, 'media/sequence.mp4'));
});
