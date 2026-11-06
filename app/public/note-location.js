'use strict';

function resolveNoteLocation(model, anchor) {
  if (!anchor) return null;
  if (anchor.view === 'opening') {
    const opening = model.opening;
    return opening && opening.version === anchor.version && anchor.frame < Math.round(opening.seconds * model.fps) &&
      [opening.revision, model.revision].includes(anchor.revision)
      ? { frame: anchor.frame, view: 'opening' } : null;
  }
  let frame = anchor.frame;
  let review;
  if (anchor.revision !== model.revision) {
    if (!anchor.clip) return null;
    const { bin, sourceFrame, track, offset, start, end } = anchor.clip;
    const clips = model.tracks.filter(row => row.type === 'video').flatMap(row =>
      row.clips.map(clip => ({ clip, sameShot: Boolean(anchor.shot && clip.shot === anchor.shot), sameTrack: row.id === track })));
    const closest = candidates => candidates.sort((a, b) => Number(b.sameShot) - Number(a.sameShot) ||
      Math.abs(a.frame - anchor.frame) - Math.abs(b.frame - anchor.frame) || Number(b.sameTrack) - Number(a.sameTrack))[0];
    const source = closest(clips.filter(({ clip }) => clip.bin === bin && sourceFrame >= clip.start && sourceFrame < clip.end)
      .map(match => ({ ...match, frame: match.clip.position + sourceFrame - match.clip.start })));
    const match = source || closest(clips.filter(({ clip, sameShot }) => sameShot && clip.end > clip.start)
      .map(match => {
        const { position, start, end } = match.clip;
        const duration = end - start;
        const originalOffset = anchor.frame - position;
        const legacyOffset = originalOffset >= 0 && originalOffset < duration ? originalOffset : 0;
        return { ...match, frame: position + Math.min(offset ?? legacyOffset, duration - 1) };
      }));
    if (!match) return null;
    frame = match.frame;
    if (match.clip.bin !== bin) review = 'replacement';
    else if (!source || (start !== undefined && (start !== match.clip.start || end !== match.clip.end))) review = 'trim';
  }
  if (frame < 0 || frame >= model.frames) return null;
  const focus = model.focus;
  const view = anchor.view === 'battle' && focus && frame >= focus.start && frame < focus.end ? 'battle' : 's03';
  return { frame, view, review };
}

function noteShotContext(model, anchor, frame) {
  const tracks = model.tracks.filter(track => track.type === 'video');
  const endOf = clip => clip.position + clip.end - clip.start;
  const covering = tracks.flatMap(track => track.clips.filter(clip => clip.position <= frame && frame < endOf(clip))
    .map(clip => ({ track, clip })));
  const match = covering.find(({ track, clip }) => track.id === anchor.clip?.track && clip.shot === anchor.shot) ||
    covering.find(({ clip }) => anchor.shot && clip.shot === anchor.shot) ||
    covering.find(({ track }) => track.id === anchor.clip?.track) || covering[0];
  if (!match) return null;

  const markers = new Map((model.reviewData?.shots || []).map(mark => [mark.frame, mark.title]));
  const starts = [...markers.keys()].sort((a, b) => a - b);
  const shots = match.track.clips.flatMap(clip => {
    const end = endOf(clip);
    const boundaries = [clip.position, ...starts.filter(start => start > clip.position && start < end), end];
    return boundaries.slice(0, -1).map((start, index) => ({
      track: match.track.id, clip: clip.index, start, end: boundaries[index + 1],
      id: (index === 0 ? clip.shot : null) || markers.get(start) || null,
      title: markers.get(start) || clip.name,
      source: markers.has(start) ? 'shot_marker' : 'picture_clip'
    }));
  }).sort((a, b) => a.start - b.start);
  const index = shots.findIndex(shot => shot.clip === match.clip.index && shot.start <= frame && frame < shot.end);
  return { current: shots[index], previous: shots[index - 1] || null, next: shots[index + 1] || null };
}

if (typeof module !== 'undefined') module.exports = { resolveNoteLocation, noteShotContext };
