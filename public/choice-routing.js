const text = value => String(value || '').trim().toLowerCase();
const approachTypes = new Set(['kiss', 'touch', 'clothing']);
const storyTypes = new Set(['dialogue', 'story', 'scene_transition', 'camera_transition']);

function visiblyApproachesPartner(action) {
  if (String(action.actionType || '').toLowerCase() !== 'story' || action.nonIntimate === true ||
      Number(action.choiceSurfaceConfidence) < 0.8) return false;
  const subject = String(action.subjectTrackId || '').trim();
  const partner = String(action.partnerTrackId || '').trim();
  if (!subject || !partner || subject === partner) return false;
  const normalize = value => String(value || '').toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o');
  const label = normalize(action.label);
  const evidence = normalize(action.choiceSurfaceEvidence);
  const proximity = /\b(?:yakinlas\w*|yaklas\w*|draws? closer|moves? closer)\b/u;
  const nonApproach = /\b(?:teklif\w*|soyl\w*|konus\w*|dedi|selam\w*|tokalas\w*|greeting|handshake|sadece konusma|only spoken|speech only|invites?)\b/u;
  return proximity.test(label) && proximity.test(evidence) && !nonApproach.test(evidence);
}

// Source categories own their choices. Speech, shared participants and a scene
// envelope do not change a category, and a requested panel cannot create one.
export function choiceSurfaceForAction(action = {}, { panelFamily = '' } = {}) {
  if (action.sourceVerified !== true) return 'unverified';
  const type = text(action.actionType);
  // A model can call an observed approach a generic story event. Preserve a
  // directly evidenced, two-person source interval in the opening controls.
  if (visiblyApproachesPartner(action)) return 'approach';
  // A camera cut or a broadly named touch can still contain a verified
  // continuation of the same position. Require independent motion, body
  // configuration and source timing; a camera change alone stays story.
  const continuedPosition = ['touch', 'camera_transition'].includes(type) && panelFamily &&
    text(action.positionId) === text(panelFamily) &&
    Number(action.positionConfigurationConfidence) >= 0.9 &&
    String(action.positionEvidence || '').trim() && String(action.movementType || '').trim() &&
    ['slow', 'moderate', 'fast'].includes(text(action.movementTempo)) &&
    Number(action.loopEndTime) - Number(action.loopStartTime) >= 5;
  if (continuedPosition) return 'panel';
  // A verified dialogue range keeps its own category even when a broad parent
  // carries unrelated outcome metadata. Speech is not a performed event.
  if (storyTypes.has(type)) return 'story';
  if (panelFamily ||
      ['partner_transition', 'outcome', 'aftermath'].includes(type) ||
      ['climax', 'aftermath'].includes(text(action.outcomeType))) return 'panel';
  const declaredEvidence = String(action.choiceSurfaceEvidence || '').trim() && Number(action.choiceSurfaceConfidence) >= 0.6;
  // A provider may label a visible kiss/contact as story just because people
  // are also speaking. Preserve an explicitly ordinary greeting or gesture,
  // but let the observed action kind determine the intimate choice surface.
  const ordinaryContact = action.nonIntimate === true ||
    /\b(?:ordinary greeting|handshake|greeting gesture|selamlasma|tokalasma|konusurken jest)\b/iu.test(
      String(action.choiceSurfaceEvidence || '').toLocaleLowerCase('tr-TR')
        .replace(/ş/g, 's').replace(/ı/g, 'i'));
  // An explicit spoken-only description cannot prove a visual event. Keep
  // older verified source-action types playable even when legacy analysis
  // omitted a dedicated evidence field; never promote a spoken invitation.
  const speechOnly = /\b(?:only spoken words|speech only|dialogue only|only dialogue|only speech|sadece konusma|yalnizca konusma|yalnizca soz)\b/iu.test(
    String(action.choiceSurfaceEvidence || '').toLocaleLowerCase('tr-TR')
      .replace(/ş/g, 's').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u'));
  if (approachTypes.has(type)) return (ordinaryContact && declaredEvidence) || speechOnly ? 'story' : 'approach';
  if (text(action.choiceSurface) === 'story' && declaredEvidence) return 'story';
  if (text(action.choiceSurface) === 'approach' && declaredEvidence) return 'approach';
  return 'story';
}

// Normal timeline choices may be offered only while their source start is
// still ahead of the decision cursor. A lingering tail of an earlier clip
// must not send playback back to that clip's beginning.
export function isForwardTimelineChoice(action, cursor, { lookAhead = 45 } = {}) {
  const start = Number(action?.startTime);
  const end = Number(action?.endTime);
  const position = Number(cursor);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(position) &&
    end > start && end > position + 0.03 &&
    start >= position - 0.05 && start <= position + lookAhead;
}

export function withChoiceSurface(action, options) {
  return { ...action, choiceSurface: choiceSurfaceForAction(action, options) };
}

// Display groups must never combine clips owned by different surfaces, even
// when their labels, cast, declared scene and action origin happen to match.
export function choiceSurfaceKey(clip = {}) {
  return text(clip.choiceSurface) || (clip.nonIntimate === true ? 'story' : '');
}

// A chronological playback adapter, not a merged category or display group.
export function scenePreludeChoices(scene) {
  return [...(scene?.foreplay || []), ...(scene?.dialogue || [])]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

export function sceneOwnsStoryChoice(scene, action) {
  const id = String(action?.actionId || '');
  return Boolean(id && (scene?.dialogue || []).some(item =>
    item.sourceVerified === true && [item.id, item.sourceActionId].includes(id)));
}

export function sceneOwnsApproachChoice(scene, action) {
  const id = String(action?.actionId || '');
  return Boolean(id && (scene?.foreplay || []).some(item =>
    item.sourceVerified === true && [item.id, item.sourceActionId].includes(id)));
}

export function isUnroutedVerifiedApproach(action, trace, acceptedApproachIds, isIntroduction) {
  const id = String(action?.sourceActionId || action?.actionId || '');
  return action?.sourceVerified === true && isIntroduction === true &&
    !acceptedApproachIds?.has(id) &&
    !(trace?.route === 'POSITION' && trace?.movementAccepted === true);
}

// Collapse only evidence-identical observations across the same source,
// route, cast and timestamp. Equal labels alone never prove duplication.
export function distinctVerifiedSourceChoices(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(item => {
    if (item?.sourceVerified !== true) return false;
    const origin = String(item.sourceActionId || item.observedActionId ||
      item.actionOriginId || item.derivedFromVerifiedSegment || item.actionId || item.id || '').trim();
    const start = Number(item.startTime), end = Number(item.endTime);
    if (!origin || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return true;
    const cast = [...new Set([...(item.participantTrackIds || []), ...(item.involvedCharacterIds || []),
      item.subjectTrackId, item.partnerTrackId, item.primaryCharacterId]
      .filter(Boolean).map(String))].sort();
    const key = JSON.stringify([
      origin, start, end, choiceSurfaceKey(item),
      String(item.sourceGroupId || item.sourcePositionId || ''),
      String(item.sourceOccurrenceId || item.positionOccurrenceId || item.occurrenceId || ''),
      String(item.routeNamespace || ''), String(item.actionType || ''), cast
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function choiceSurfaceWindow(items, surface, timelineFloor = 0) {
  const forward = (items || []).filter(item => item.sourceVerified === true &&
    Number(item.endTime) > Number(timelineFloor) + 0.05)
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const key = item => choiceSurfaceKey(item) || 'approach';
  const first = forward[0];
  if (!first || key(first) !== surface) return [];
  const boundary = forward.find(item => key(item) !== surface)?.startTime ?? Infinity;
  return distinctVerifiedSourceChoices(forward.filter(item => key(item) === surface && Number(item.startTime) < Number(boundary) &&
    Number(item.endTime) <= Number(boundary) + 0.05));
}

// A decision can jump to any verified clip in its bounded scene chapter.
// Timeline order is the default playback path, not a requirement to watch
// intervening footage before another source-backed choice becomes available.
export function sceneSurfaceChoices(items, surface, { floor = 0, ceiling = Infinity, replay = false } = {}) {
  return distinctVerifiedSourceChoices((items || []).filter(item => item?.sourceVerified === true &&
    choiceSurfaceKey(item) === surface &&
    Number.isFinite(Number(item.startTime)) && Number.isFinite(Number(item.endTime)) &&
    Number(item.endTime) > Number(item.startTime) &&
    Number(item.startTime) < ceiling - 0.05 &&
    (replay || Number(item.endTime) > floor + 0.05))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime)));
}

// The first approach menu is a scene-wide choice list, not a timeline queue.
// Keep every distinct verified opening clip available before the first core
// position, even when the viewer replays an older clip or moves the playhead.
// Story-labelled source clips retain their original surface and label.
export function openingSceneChoiceMenu(items = [], { firstCoreStart = Infinity } = {}) {
  const ceiling = Number(firstCoreStart);
  return distinctVerifiedSourceChoices((Array.isArray(items) ? items : []).filter(item => {
    const start = Number(item?.startTime), end = Number(item?.endTime);
    return item?.sourceVerified === true &&
      ['approach', 'story'].includes(choiceSurfaceKey(item)) &&
      Number.isFinite(start) && Number.isFinite(end) && end > start &&
      end <= ceiling + 0.05;
  }).sort((a, b) => Number(a.startTime) - Number(b.startTime)));
}

/**
 * An unowned-source interval is a lack-of-player-identity hint, not evidence
 * that a separately verified normal decision must disappear from gameplay.
 * Keep an already source-verified ordinary card visible within lookahead.
 */
export function verifiedStoryAheadOfGap(candidates = [], cursor = 0, interval = null) {
  if (!interval || !Number.isFinite(Number(interval.endTime))) return false;
  const now = Number(cursor) || 0, end = Number(interval.endTime);
  return (Array.isArray(candidates) ? candidates : []).some(action =>
    action?.sourceVerified === true && choiceSurfaceKey(action) === 'story' &&
    Number.isFinite(Number(action.startTime)) &&
    Number(action.startTime) >= now - 0.05 &&
    Number(action.startTime) <= end + 0.05);
}
