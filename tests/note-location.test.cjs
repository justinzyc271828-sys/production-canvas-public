const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNoteLocation } = require('../app/public/note-location');

function fixture() {
  const clip = { bin: 'source', position: 100, start: 20, end: 40, shot: 'S06' };
  const model = { revision: 'current', frames: 500, fps: 24, tracks: [{ id: 0, type: 'video', clips: [clip] }],
    focus: { start: 90, end: 150 }, opening: { version: 'opening.mp4', revision: 'opening', seconds: 2 } };
  const anchor = { view: 's03', version: 'review.mp4', revision: 'old', frame: 107, shot: 'S06',
    clip: { track: 0, bin: 'source', sourceFrame: 27, offset: 7, start: 20, end: 40 } };
  return { model, anchor, clip };
}

test('current-revision and pre-offset notes retain their frame', () => {
  const { model, anchor } = fixture();
  anchor.revision = model.revision;
  delete anchor.clip;
  assert.equal(resolveNoteLocation(model, anchor).frame, 107);
});

test('filter-only revision changes keep the note current', () => {
  const { model, anchor } = fixture();
  assert.deepEqual(resolveNoteLocation(model, anchor), { frame: 107, view: 's03', review: undefined });
});

test('moved clips carry notes by source frame', () => {
  const { model, anchor, clip } = fixture();
  clip.position = 140;
  assert.deepEqual(resolveNoteLocation(model, anchor), { frame: 147, view: 's03', review: undefined });
});

test('trimmed clips are marked for another review', () => {
  const { model, anchor, clip } = fixture();
  clip.start = 25;
  assert.deepEqual(resolveNoteLocation(model, anchor), { frame: 102, view: 's03', review: 'trim' });
});

test('replaced media carries the relative offset and clamps shorter clips', () => {
  const { model, anchor, clip } = fixture();
  clip.bin = 'replacement';
  assert.equal(resolveNoteLocation(model, anchor).frame, 107);
  clip.end = 24;
  assert.deepEqual(resolveNoteLocation(model, anchor), { frame: 103, view: 's03', review: 'replacement' });
});

test('legacy replacement note preserves an in-range frame and otherwise uses the first frame', () => {
  const { model, anchor, clip } = fixture();
  anchor.clip = { track: 0, bin: 'source', sourceFrame: 27 };
  clip.bin = 'replacement';
  assert.equal(resolveNoteLocation(model, anchor).frame, 107);
  clip.end = 24;
  assert.equal(resolveNoteLocation(model, anchor).frame, 100);
});

test('missing source and shot remain unlocated', () => {
  const { model, anchor, clip } = fixture();
  clip.bin = 'different';
  clip.shot = 'other';
  assert.equal(resolveNoteLocation(model, anchor), null);
  delete anchor.clip;
  assert.equal(resolveNoteLocation(model, anchor), null);
});

test('same-shot candidates prefer the nearest resolved frame', () => {
  const { model, anchor, clip } = fixture();
  clip.bin = 'replacement';
  model.tracks[0].clips.unshift({ ...clip, position: 300 });
  assert.equal(resolveNoteLocation(model, anchor).frame, 107);
});

test('battle coordinates fall back to full film after a move outside the focus range', () => {
  const { model, anchor, clip } = fixture();
  anchor.view = 'battle';
  assert.equal(resolveNoteLocation(model, anchor).view, 'battle');
  clip.position = 200;
  assert.equal(resolveNoteLocation(model, anchor).view, 's03');
});

test('opening notes use their own version and bounds', () => {
  const { model } = fixture();
  const anchor = { frame: 23, revision: 'opening', version: 'opening.mp4', view: 'opening' };
  assert.equal(resolveNoteLocation(model, anchor).frame, 23);
  anchor.frame = 48;
  assert.equal(resolveNoteLocation(model, anchor), null);
});
