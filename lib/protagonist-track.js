// The analysis contract names the player's man MAIN_MALE. Weaker models
// sometimes invent their own ids instead ("man-orange-vest", "participant-001")
// and then every action looks like somebody else's scene. When a chapter
// never uses MAIN_MALE, the male with the most on-screen action time in that
// chapter becomes MAIN_MALE, the same "dominant male" rule as with no hint.
const MAIN = 'MAIN_MALE';
const MALE_ID = /^(?:man|male|erkek|guy|boy)\b|(?:^|[-_])(?:man|male|erkek)(?:$|[-_])/i;

export function ensureProtagonistTrack(parsed = {}) {
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const ids = action => [action.subjectTrackId, action.partnerTrackId, action.primaryCharacterId,
    ...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])].map(value => String(value || '').trim());
  if (!actions.length || actions.some(action => ids(action).includes(MAIN))) return { parsed, inferred: null };
  const characters = Array.isArray(parsed?.storyContext?.characters) ? parsed.storyContext.characters : [];
  const genderOf = id => String(characters.find(item => String(item?.participantTrackId || item?.id || '').trim() === id)?.gender || '').toLowerCase();
  const isMale = id => id && !/OTHER_MALE/i.test(id) && (genderOf(id) === 'male' || (!genderOf(id) && MALE_ID.test(id)));
  const seconds = new Map();
  for (const action of actions) {
    const subject = String(action.subjectTrackId || '').trim();
    if (!isMale(subject)) continue;
    const span = Math.max(0, Number(action.endTime) - Number(action.startTime)) || 0;
    seconds.set(subject, (seconds.get(subject) || 0) + span);
  }
  const chosen = [...seconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!chosen) return { parsed, inferred: null };
  const swap = value => String(value || '').trim() === chosen ? MAIN : value;
  const next = { ...parsed, actions: actions.map(action => ({ ...action,
    subjectTrackId: swap(action.subjectTrackId), partnerTrackId: swap(action.partnerTrackId),
    primaryCharacterId: swap(action.primaryCharacterId),
    ...(Array.isArray(action.involvedCharacterIds) ? { involvedCharacterIds: action.involvedCharacterIds.map(swap) } : {}),
    ...(Array.isArray(action.participantTrackIds) ? { participantTrackIds: action.participantTrackIds.map(swap) } : {}) })) };
  if (parsed.storyContext && typeof parsed.storyContext === 'object') {
    next.storyContext = { ...parsed.storyContext,
      characters: characters.map(item => String(item?.participantTrackId || item?.id || '').trim() === chosen
        ? { ...item, id: MAIN, participantTrackId: MAIN } : item),
      relationships: (parsed.storyContext.relationships || []).map(row => ({ ...row, from: swap(row?.from), to: swap(row?.to) })) };
  }
  next.warnings = [...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
    `Baş karakter işaretlenmemişti; en çok görünen erkek (${chosen}) baş karakter kabul edildi.`];
  return { parsed: next, inferred: chosen };
}
