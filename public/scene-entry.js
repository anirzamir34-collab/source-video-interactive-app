import { clipRange } from './sequence-integrity.js';

const participants = action => [...new Set([
  action.subjectTrackId, action.partnerTrackId, action.primaryCharacterId,
  ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])
].map(value => String(value || '').trim()).filter(Boolean))].sort();

// Link only existing, verified adjacent introductions for the same exact pair
// or group. A dialogue, another cast, or a long gap is a boundary, not evidence
// for widening a scene. Input records and their source times stay unchanged.
export function matchSceneIntroductions(actions, anchors, eligible, maxGap = 45) {
  const ordered = [...actions].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const result = new Map();
  for (const { action: anchor, sceneId } of anchors) {
    const cast = participants(anchor);
    if (cast.length < 2) continue;
    let nextStart = Number(anchor.startTime);
    for (let i = ordered.indexOf(anchor) - 1; i >= 0; i--) {
      const action = ordered[i];
      const start = Number(action.startTime), end = Number(action.endTime);
      if (!eligible(action) || action.sourceVerified !== true || !(Number(action.confidence) >= 0.6) ||
          !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
          end > nextStart + 0.15 || nextStart - end > maxGap ||
          participants(action).join('|') !== cast.join('|') ||
          (action.adultSceneId && action.adultSceneId !== sceneId) ||
          (result.has(action) && result.get(action) !== sceneId)) break;
      result.set(action, sceneId);
      nextStart = start;
    }
  }
  return result;
}

// An actual source interval can open its UI even if an optional introduction
// was too short to satisfy a progress meter. Never use a wide parent span that
// could contain gaps or another chapter, and never seek as a side effect.
export function sourcePositionAtTime(positions, time) {
  const point = Number(time);
  if (!Number.isFinite(point)) return null;
  return positions.find(position => {
    const ranges = position.sourceRanges?.length ? position.sourceRanges :
      (position.movements || []).filter(item => item.sourceVerified === true).map(clipRange).filter(Boolean);
    return ranges.some(range => Number.isFinite(Number(range.startTime)) &&
      Number(range.endTime) > Number(range.startTime) &&
      point >= Number(range.startTime) - 0.04 && point < Number(range.endTime) - 0.04);
  }) || null;
}

export function sceneEntrySeekTarget(scene, mediaTime, forceStart, sameSession) {
  const start = Number(scene?.startTime);
  const time = Number(mediaTime);
  return forceStart && !sameSession && Number.isFinite(start) && Number.isFinite(time) &&
    time < start - 0.15 ? Math.max(0, start) : null;
}
