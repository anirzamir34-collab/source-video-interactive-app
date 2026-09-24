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
  const otherMaleTracks = new Set(characters.filter(character => {
    const track = canonical(character.participantTrackId || character.id);
    return track && track !== protagonist && /(?:^|[_-])(?:OTHER_MALE|MALE_OTHER|SECOND_MALE)(?:$|[_-])/i.test(track);
  }).map(character => canonical(character.participantTrackId || character.id)));
  const playable = [];
  const excluded = [];
  for (const action of actions) {
    const subject = canonical(action.subjectTrackId);
    const participants = [action.subjectTrackId, action.primaryCharacterId,
      ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])].map(canonical).filter(Boolean);
    if ((subject && subject !== protagonist) || participants.some(id => otherMaleTracks.has(id))) excluded.push(action);
    else playable.push(action);
  }
  return { playable, excluded };
}
