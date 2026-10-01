import { clipRange, timelineRange } from './sequence-integrity.js';

const participants = action => [...new Set([
  action.subjectTrackId, action.partnerTrackId, action.primaryCharacterId,
  ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])
].map(value => String(value || '').trim()).filter(Boolean))].sort();

// Link only existing, verified adjacent introductions for the same exact pair
// or group. A dialogue, another cast, or a long gap is a boundary, not evidence
// for widening a scene. Input records and their source times stay unchanged.
export function matchSceneIntroductions(actions, anchors, eligible, maxGap = 45, onDecision = () => {}) {
  const ordered = [...actions].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const result = new Map();
  for (const { action: anchor, sceneId } of anchors) {
    const cast = participants(anchor);
    if (cast.length < 2) continue;
    let nextStart = Number(anchor.startTime);
    for (let i = ordered.indexOf(anchor) - 1; i >= 0; i--) {
      const action = ordered[i];
      const range = timelineRange(action.startTime, action.endTime);
      const start = range?.startTime, end = range?.endTime;
      const sameRoles = ['subjectTrackId', 'partnerTrackId'].every(field =>
        !String(anchor[field] || '').trim() || String(action[field] || '').trim() === String(anchor[field]).trim());
      const reason = !eligible(action) ? 'INELIGIBLE_ACTION'
        : action.sourceVerified !== true ? 'SOURCE_NOT_VERIFIED'
          : !(Number(action.confidence) >= 0.6) ? 'CONFIDENCE_BELOW_0_60'
            : !range ? 'INVALID_SOURCE_INTERVAL'
              : end > nextStart + 0.15 ? 'SOURCE_OVERLAP'
                : nextStart - end > maxGap ? 'SOURCE_GAP_TOO_LARGE'
                  : !sameRoles || participants(action).join('|') !== cast.join('|') ? 'SOURCE_CAST_MISMATCH'
                    // The optional scene flag cannot reject otherwise verified,
                    // adjacent source evidence when provider IDs change.
                    : action.adultSceneId && action.adultSceneId !== sceneId && nextStart - end > 0.25
                      ? 'SCENE_ID_GAP'
                      : result.has(action) && result.get(action) !== sceneId ? 'SCENE_MEMBERSHIP_CONFLICT' : '';
      if (reason) {
        onDecision(action, reason, sceneId);
        break;
      }
      result.set(action, sceneId);
      onDecision(action, 'VERIFIED_SAME_CAST_INTRODUCTION', sceneId);
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
    if (position.sourceVerified !== true) return false;
    const ranges = position.sourceRanges?.length ? position.sourceRanges :
      (position.movements || []).filter(item => item.sourceVerified === true).map(clipRange).filter(Boolean);
    return ranges.some(range => range.sourceVerified !== false && Number.isFinite(Number(range.startTime)) &&
      Number(range.endTime) > Number(range.startTime) &&
      point >= Number(range.startTime) && point < Number(range.endTime));
  }) || null;
}

export function sceneEntrySeekTarget(scene, mediaTime, forceStart, sameSession) {
  const start = Number(scene?.startTime);
  const time = Number(mediaTime);
  return forceStart && !sameSession && Number.isFinite(start) && Number.isFinite(time) &&
    time < start - 0.15 ? Math.max(0, start) : null;
}
