// Classification data must remain separate from generated display prose.
// These are existing schema values, not a source for inventing new labels.
export const POSITION_IDS = Object.freeze([
  'oral', 'manual', 'reverse-cowgirl', 'seated-facing', 'prone-bone',
  'legs-up', 'missionary', 'cowgirl', 'spoon', 'reverse-spoon',
  'standing-rear', 'rear', 'seated', 'standing'
]);
const positionIds = new Set(POSITION_IDS);

export function knownPositionId(value) {
  const id = String(value || '').trim().toLowerCase();
  return positionIds.has(id) ? id : '';
}

export function isClassificationCandidate(action = {}) {
  return Boolean(action.positionId || action.positionLabel || action.actionType === 'position');
}

// A review can narrow an original clip, but cannot replace it with a different
// part of the source. Parent ranges must also contain the reviewed clip.
export function isVerifiedReviewWithinSource(review = {}, source = {}) {
  const start = Number(review.startTime), end = Number(review.endTime);
  const from = Number(source.startTime), to = Number(source.endTime);
  if (review.sourceVerified !== true || ![start, end, from, to].every(Number.isFinite) ||
      end <= start || start < from - 0.05 || end > to + 0.05) return false;
  if (isClassificationCandidate(review)) {
    if (!knownPositionId(review.positionId) || !String(review.positionEvidence || '').trim()) return false;
    if (Number(review.positionConfigurationConfidence || 0) < 0.78) return false;
    const parentStart = Number(review.positionStartTime ?? start);
    const parentEnd = Number(review.positionEndTime ?? end);
    const loopStart = Number(review.loopStartTime ?? start);
    const loopEnd = Number(review.loopEndTime ?? end);
    if (![parentStart, parentEnd, loopStart, loopEnd].every(Number.isFinite) ||
        parentStart > start + 0.05 || parentEnd < end - 0.05 ||
        loopStart < start - 0.05 || loopEnd > end + 0.05 || loopEnd <= loopStart) return false;
  }
  return true;
}

const reviewFields = new Set([
  'actionId', 'sceneId', 'actionType', 'actionLevel', 'startTime', 'endTime', 'label',
  'sourceVerified', 'confidence', 'adultScene', 'adultSceneId', 'adultSceneStartTime',
  'adultSceneEndTime', 'positionId', 'positionLabel', 'positionOccurrenceId',
  'positionStartTime', 'positionEndTime', 'loopStartTime', 'loopEndTime',
  'receiverBodyOrientation', 'receiverSupport', 'positionConfigurationConfidence', 'positionEvidence',
  'movementType', 'movementTempo', 'activityType', 'activityTypeConfidence', 'activityEvidence',
  'groupScene', 'adultParticipantCount', 'participantTrackIds', 'partnerTrackId', 'partnerLabel',
  'partnerEvidence', 'partnerSwitch', 'previousPartnerTrackId', 'subjectTrackId',
  'involvedCharacterIds', 'primaryCharacterId', 'primaryCharacterLabel',
  'narrativeChoiceLabel', 'sceneTitle', 'sceneGoal', 'relationshipContext',
  'storyEvidenceLevel', 'storyConfidence', 'storyEvidence',
  'outcomeType', 'outcomeStartTime', 'outcomeEndTime', 'outcomeLabel'
]);

export function serializeReviewCandidates(input) {
  const candidates = typeof input === 'string' ? JSON.parse(input || '[]') : input;
  if (!Array.isArray(candidates) || candidates.length > 256) throw new Error('INVALID_REVIEW_CANDIDATES');
  // Serialize complete objects; slicing a JSON string silently lost the tail
  // of larger reviews and sometimes left the model with invalid JSON.
  return JSON.stringify(candidates.map(candidate => Object.fromEntries(
    Object.entries(candidate || {}).filter(([key]) => reviewFields.has(key)).map(([key, value]) => [
      key, typeof value === 'string' ? value.slice(0, 500) : Array.isArray(value) ? value.slice(0, 12) : value
    ])
  )));
}
