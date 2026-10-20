import { clipRange, timelineRange } from './sequence-integrity.js';

const participants = action => {
  const subject = String(action?.subjectTrackId || '').trim();
  const partner = String(action?.partnerTrackId || '').trim();
  // Stable gameplay track IDs are authoritative when both sides are present.
  // Provider-local character aliases (char-001, char-002, etc.) may change
  // between chunks and must not break an otherwise continuous source scene.
  if (subject && partner) return [...new Set([subject, partner])].sort();
  return [...new Set([
    subject, partner, action?.primaryCharacterId,
    ...(action?.involvedCharacterIds || []), ...(action?.participantTrackIds || [])
  ].map(value => String(value || '').trim()).filter(Boolean))].sort();
};

// A missing partnerTrackId is not proof of a new character. Where the model
// supplied a separate primaryCharacterId, accept it as a partner for grouping
// only when the story context uniquely verifies that exact source track.
// This helper never rewrites the source action or invents a participant.
export function verifiedOpeningCast(action = {}, characters = []) {
  if (action.sourceVerified !== true) return '';
  const subject = String(action.subjectTrackId || '').trim();
  let partner = String(action.partnerTrackId || '').trim();
  if (!partner && action.groupScene !== true && action.identityResolution !== 'conflict') {
    const candidate = String(action.primaryCharacterId || '').trim();
    const matches = (Array.isArray(characters) ? characters : []).filter(character =>
      String(character.participantTrackId || '').trim() === candidate &&
      character.identityConflict !== true && character.evidenceLevel === 'fact');
    if (candidate && candidate !== subject && matches.length === 1) partner = candidate;
  }
  if (!subject || !partner || subject === partner) return '';
  return JSON.stringify([...([subject, partner].includes('MAIN_MALE') ? [subject, partner].sort() : [subject, partner]),
    action.groupScene === true ? [...(action.participantTrackIds || [])].sort() : []]);
}

// Link only existing, verified adjacent introductions for the same exact pair
// or group. A dialogue, another cast, or a long gap is a boundary, not evidence
// for widening a scene. Input records and their source times stay unchanged.
export function matchSceneIntroductions(actions, anchors, eligible, maxGap = 45, onDecision = () => {}, allowBridge = () => false) {
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
      // The same two people stay the same cast whoever is acting: a partner
      // massaging the protagonist and him moving her are one encounter.
      const pair = item => [String(item?.subjectTrackId || '').trim(), String(item?.partnerTrackId || '').trim()];
      const [anchorSubject, anchorPartner] = pair(anchor), [actionSubject, actionPartner] = pair(action);
      // Swapped roles count as the same cast only around the protagonist
      // (a partner acting on MAIN_MALE); two other people stay role-exact.
      const sameRoles = anchorSubject && anchorPartner && actionSubject && actionPartner &&
        [anchorSubject, anchorPartner].includes('MAIN_MALE')
        ? [anchorSubject, anchorPartner].sort().join('|') === [actionSubject, actionPartner].sort().join('|')
        : ['subjectTrackId', 'partnerTrackId'].every(field =>
          !String(anchor[field] || '').trim() || String(action[field] || '').trim() === String(anchor[field]).trim());
      const gap = nextStart - end;
      const verifiedBridge = gap > 0.25 && allowBridge(action, anchor, gap) === true;
      const reason = !eligible(action) ? 'INELIGIBLE_ACTION'
        : action.sourceVerified !== true ? 'SOURCE_NOT_VERIFIED'
          : !(Number(action.confidence) >= 0.6) ? 'CONFIDENCE_BELOW_0_60'
            : !range ? 'INVALID_SOURCE_INTERVAL'
              : end > nextStart + 0.15 ? 'SOURCE_OVERLAP'
                : gap > maxGap && !verifiedBridge ? 'SOURCE_GAP_TOO_LARGE'
                  : !sameRoles || participants(action).join('|') !== cast.join('|') ? 'SOURCE_CAST_MISMATCH'
                    // The optional scene flag cannot reject otherwise verified,
                    // adjacent source evidence when provider IDs change.
                    : action.adultSceneId && action.adultSceneId !== sceneId && gap > 0.25 && !verifiedBridge
                      ? 'SCENE_ID_GAP'
                      : result.has(action) && result.get(action) !== sceneId ? 'SCENE_MEMBERSHIP_CONFLICT' : '';
      if (reason) {
        onDecision(action, reason, sceneId);
        // A short excluded clip (e.g. one that may not be offered) between a
        // verified opening and its position must not cut the opening off;
        // the gap is still measured from the last accepted clip.
        if (reason === 'INELIGIBLE_ACTION' && range && action.choiceSurface === 'approach' &&
            end - start <= 30 && nextStart - start <= maxGap) continue;
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
