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
  for (const action of actions) {
    const subject = canonical(action.subjectTrackId);
    const participants = [action.subjectTrackId, action.primaryCharacterId, action.partnerTrackId,
      ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])].map(canonical).filter(Boolean);
    // A verified conversation or story event belongs to its observed actor,
    // not to every person in the same frame. Another male may listen, answer,
    // or stand nearby without transferring the player's agency to him.
    // Keep the stronger cast ownership barrier for intimate/core scenes.
    const ordinaryStory = action.sourceVerified === true && subject === protagonist &&
      ['dialogue', 'story', 'scene_transition', 'camera_transition'].includes(String(action.actionType || '').toLowerCase()) &&
      action.adultScene !== true && !action.positionId && !action.positionLabel &&
      !['oral', 'manual', 'vaginal', 'anal'].includes(String(action.activityType || '').toLowerCase()) &&
      !['climax', 'aftermath'].includes(String(action.outcomeType || '').toLowerCase());
    const foreignActor = Boolean(subject && subject !== protagonist);
    const ambiguousCast = participants.some(id =>
      id !== protagonist && (otherMaleTracks.has(id) || otherMaleTrack(id)));
    if (foreignActor || (ambiguousCast && !ordinaryStory)) excluded.push(action);
    else playable.push(action);
  }
  return { playable, excluded };
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
