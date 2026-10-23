// A model-supplied subject label alone cannot establish who is on screen.
// If another identified male is present, keep the source footage but do not
// turn that ambiguous observation into a protagonist choice.
export function partitionProtagonistActions(actions = [], context = {}, mainTrack = 'MAIN_MALE') {
  const characters = Array.isArray(context.characters) ? context.characters : [];
  const aliases = new Map();
  for (const character of characters) {
    const track = String(character.participantTrackId || character.id || '').trim();
    for (const id of [character.id, character.participantTrackId, ...(character.characterIds || [])]) {
      if (id) aliases.set(String(id).trim(), track);
    }
  }
  const canonical = id => aliases.get(String(id || '').trim()) || String(id || '').trim();
  const protagonist = canonical(mainTrack || 'MAIN_MALE');
  const otherMaleTrack = track => /(?:^|[_-])(?:OTHER_MALE|MALE_OTHER|SECOND_MALE)(?:$|[_-])/i.test(track);
  const otherMaleTracks = new Set(characters.filter(character => {
    const track = canonical(character.participantTrackId || character.id);
    return track && track !== protagonist && otherMaleTrack(track);
  }).map(character => canonical(character.participantTrackId || character.id)));
  const playable = [];
  const excluded = [];
  const actionCast = new Map();
  for (const action of actions) {
    const subject = canonical(action.subjectTrackId);
    const participants = [action.subjectTrackId, action.primaryCharacterId, action.partnerTrackId,
      ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])].map(canonical).filter(Boolean);
    const witnessedCast = [...(action.involvedCharacterIds || []),
      ...(action.participantTrackIds || [])].map(canonical).filter(Boolean);
    const mainWitnessed = !witnessedCast.length || witnessedCast.includes(protagonist);
    // A verified conversation or story event belongs to its observed actor,
    // not to every person in the same frame. Another male may listen, answer,
    // or stand nearby without transferring the player's agency to him.
    // Keep the stronger cast ownership barrier for intimate/core scenes.
    const ordinaryStory = action.sourceVerified === true && subject === protagonist &&
      mainWitnessed &&
      ['dialogue', 'story', 'scene_transition', 'camera_transition'].includes(String(action.actionType || '').toLowerCase()) &&
      action.adultScene !== true && !action.positionId && !action.positionLabel &&
      !['oral', 'manual', 'vaginal', 'anal'].includes(String(action.activityType || '').toLowerCase()) &&
      !['climax', 'aftermath'].includes(String(action.outcomeType || '').toLowerCase());
    // Only another man's action is foreign. A female partner acting on the
    // protagonist (massaging him, climbing on top, oral) is still his scene:
    // the player's choice is to let it happen. Dropping those made the whole
    // opening of a woman-led video disappear.
    const subjectCharacter = characters.find(character =>
      canonical(character.participantTrackId || character.id) === subject);
    const subjectGender = String(subjectCharacter?.gender || '').toLowerCase();
    const femalePartnerActsOnMain = Boolean(subject) && subject !== protagonist &&
      (subjectGender === 'female' || (!subjectGender && /^PARTNER[_-]?[A-Z0-9]+$/i.test(subject))) &&
      !otherMaleTrack(subject) && participants.includes(protagonist);
    const foreignActor = Boolean(subject && subject !== protagonist) && !femalePartnerActsOnMain;
    const anotherMaleInShot = participants.some(id =>
      id !== protagonist && (otherMaleTracks.has(id) || otherMaleTrack(id) ||
        /^(?:MALE|MAN|M)[_-]?[B-Z0-9]+$/i.test(id)));
    const mainActorVerified = action.sourceVerified === true && (subject === protagonist || femalePartnerActsOnMain) &&
      mainWitnessed;
    // The other man appearing in the same frame never disqualifies a
    // source-verified action belonging to the selected protagonist.
    // An actor-less or unverified mixed-cast event still cannot grant a card.
    const belongsToMain = !foreignActor &&
      (!anotherMaleInShot || ordinaryStory || mainActorVerified);
    actionCast.set(action, { protagonistVisible: witnessedCast.length
      ? witnessedCast.includes(protagonist) : participants.includes(protagonist),
      sceneKey: String(action.adultSceneId || action.sceneId || '').trim(),
      mainActorVerified });
    if (belongsToMain) playable.push(action);
    else excluded.push(action);
  }
  const playableScenes = new Set(playable.flatMap(action => {
    const key = actionCast.get(action)?.sceneKey;
    return key && (action.sourceVerified === true) ? [key] : [];
  }));
  // Unowned placeholders only belong to a genuinely other-person section.
  // A second man's action during a protagonist-owned group encounter remains
  // watchable source footage but must not replace the main actor's panel with
  // "skip / watch". Never convert that other actor's event into a main choice.
  const skippableExcluded = excluded.filter(action => {
    const record = actionCast.get(action);
    if (record?.protagonistVisible || (record?.sceneKey && playableScenes.has(record.sceneKey)))
      return false;
    return !playable.some(mainAction => mainAction.sourceVerified === true &&
      Number(mainAction.startTime) < Number(action.endTime) - 0.05 &&
      Number(mainAction.endTime) > Number(action.startTime) + 0.05);
  });
  return { playable, excluded, skippableExcluded };
}

export function mergeUnownedIntervals(intervals = []) {
  const sorted = intervals.map(interval => ({
    startTime: Number(interval.startTime), endTime: Number(interval.endTime)
  })).filter(interval => Number.isFinite(interval.startTime) && Number.isFinite(interval.endTime) &&
    interval.endTime > interval.startTime).sort((a, b) => a.startTime - b.startTime);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.startTime <= previous.endTime + 0.05) {
      previous.endTime = Math.max(previous.endTime, interval.endTime);
    } else merged.push(interval);
  }
  return merged;
}

// Gameplay is built around "protagonist + partner". When a female partner is
// the one acting on the protagonist (massage, climbing on top, oral), the
// model may name her as both subject and partner. Present the action from the
// protagonist's side — subject MAIN_MALE, partner her — and keep who actually
// moved in actorTrackId, so one encounter is never split by who acts.
// 69: both give oral at once. The model sometimes files it under the body
// arrangement (missionary, cowgirl); the words win and it becomes mutual oral.
const SIXTY_NINE = /(?:^|[^\p{L}\d])(?:69|altmış\s*dokuz|sixty[\s-]?nine)(?:$|[^\p{L}\d])|karşılıklı\s+oral|birbirlerine\s+oral|aynı\s+anda\s+(?:birbirlerini|birbirine)/iu;
export function sixtyNine(action = {}) {
  const text = [action.label, action.positionLabel, action.positionEvidence, action.movementType, action.narrativeChoiceLabel]
    .filter(Boolean).join(' ');
  if (String(action.oralGiver || '').toLowerCase() !== 'mutual' && !SIXTY_NINE.test(text)) return action;
  return { ...action, positionId: 'oral', positionLabel: '69 Pozisyonu', oralGiver: 'mutual',
    activityType: 'oral', choiceSurface: action.choiceSurface === 'story' ? 'story' : 'panel' };
}

export function protagonistPerspective(action = {}, context = {}, mainTrack = 'MAIN_MALE') {
  action = sixtyNine(action);
  const subject = String(action.subjectTrackId || '').trim();
  if (!subject) return missingProtagonistSubject(action, context, mainTrack);
  if (subject === mainTrack) return action;
  if (/(?:^|[_-])(?:OTHER_MALE|MALE_OTHER|SECOND_MALE)(?:$|[_-])/i.test(subject)) return action;
  const character = (Array.isArray(context.characters) ? context.characters : []).find(item =>
    String(item.participantTrackId || item.id || '').trim() === subject);
  const gender = String(character?.gender || '').toLowerCase();
  const female = gender === 'female' || (!gender && /^PARTNER[_-]?[A-Z0-9]+$/i.test(subject));
  if (!female) return action;
  const ids = [action.partnerTrackId, action.primaryCharacterId, ...(action.involvedCharacterIds || []),
    ...(action.participantTrackIds || [])].map(value => String(value || '').trim());
  if (!ids.includes(mainTrack)) return action;
  return { ...action, actorTrackId: subject, subjectTrackId: mainTrack,
    partnerTrackId: subject, primaryCharacterId: subject };
}

// A two-person sex action that names only the woman (subject left empty,
// e.g. "Hızlanarak devam et" in cowgirl) is still the protagonist's: without
// this the empty subject looked like a different cast and split the scene.
function missingProtagonistSubject(action, context, mainTrack) {
  if (action.adultScene !== true || action.groupScene === true ||
      !['panel', 'approach'].includes(String(action.choiceSurface || ''))) return action;
  const partner = String(action.partnerTrackId || '').trim();
  if (!partner || partner === mainTrack || /OTHER_MALE|MALE_OTHER|SECOND_MALE|MULTI_PARTNER/i.test(partner)) return action;
  const character = (Array.isArray(context.characters) ? context.characters : []).find(item =>
    String(item.participantTrackId || item.id || '').trim() === partner);
  if (String(character?.gender || '').toLowerCase() === 'male') return action;
  const others = [...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])]
    .map(value => String(value || '').trim()).filter(Boolean).filter(id => id !== partner && id !== mainTrack);
  if (others.length) return action;
  return { ...action, subjectTrackId: mainTrack };
}

// A touch or kiss the model files as "approach" while a penetrative position
// is already running (it carries that position's id) is a movement of that
// position, not an opening card. Oral/manual stay opening activities.
const PENETRATIVE = new Set(['reverse-cowgirl', 'seated-facing', 'prone-bone', 'legs-up', 'missionary',
  'cowgirl', 'spoon', 'reverse-spoon', 'standing-rear', 'rear', 'seated', 'standing']);
// On her back, the legs decide: held up -> legs-up, otherwise missionary.
function poseFromLegs(action) {
  const position = String(action.positionId || '').trim().toLowerCase();
  const legs = String(action.receiverLegs || '').toLowerCase();
  if (!['missionary', 'legs-up'].includes(position) || !legs || legs === 'unclear' ||
      String(action.receiverBodyOrientation || '').toLowerCase() !== 'on_back' ||
      Number(action.positionConfigurationConfidence || 0) < 0.78) return action;
  const raised = ['raised', 'raised_on_shoulders'].includes(legs);
  const corrected = raised ? 'legs-up' : 'missionary';
  if (corrected === position) return action;
  return { ...action, positionId: corrected, positionLabel: raised ? 'Bacaklar havada' : 'Misyoner', poseCorrectedFrom: position };
}

export function inPositionApproachAsMovement(action = {}) {
  action = poseFromLegs(action);
  const position = String(action.positionId || '').trim().toLowerCase();
  // A body change inside the same running position (he leans over her and
  // speeds up) filed as a story card is a movement of that position.
  if (action.choiceSurface === 'story' && action.adultScene === true && PENETRATIVE.has(position) &&
      String(action.actionType || '').toLowerCase() === 'body_transition' &&
      Number(action.positionConfigurationConfidence || 0) >= 0.78 && String(action.positionEvidence || '').trim() &&
      /thrust|pump|itme|darbe|vuruş|girip|ritim|ritmik|tempo|hızlan|sert|derin/iu.test(
        [action.movementType, action.label, action.choiceSurfaceEvidence].filter(Boolean).join(' '))) {
    return { ...action, choiceSurface: 'panel', originalChoiceSurface: 'story', actionType: 'tempo_change' };
  }
  if (action.choiceSurface !== 'approach' || action.adultScene !== true) return action;
  if (!PENETRATIVE.has(position)) return action;
  if (!['touch', 'kiss', 'tempo_change', 'other'].includes(String(action.actionType || '').toLowerCase())) return action;
  return { ...action, choiceSurface: 'panel', originalChoiceSurface: 'approach', actionType: 'tempo_change' };
}
