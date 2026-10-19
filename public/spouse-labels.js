// A verified spouse of the protagonist is addressed as "karın" in intimate
// choices instead of a neutral "genç kadın / kadın". Only a FACT relation
// recorded directly between the protagonist and that partner counts; a
// spouse of some third person ("hedefin eşi") never does.
const SPOUSE = /(?:^|[^\p{L}])(?:karı(?:sı|m|n)?|eş(?:i|im|in)?|wife|spouse|husband|koca(?:sı)?)(?=$|[^\p{L}])/iu;
const NEUTRAL = /^(?:genç\s+)?(?:kadın|kız|partner(?:\s+\S+)?|yabancı|esmer kadın|sarışın kadın)$/iu;

export function protagonistSpouseTracks(storyContext = {}, protagonist = 'MAIN_MALE') {
  const characters = Array.isArray(storyContext.characters) ? storyContext.characters : [];
  const track = id => {
    const character = characters.find(item => item.id === id || item.participantTrackId === id);
    return String(character?.participantTrackId || id || '').trim();
  };
  const result = new Set();
  for (const row of Array.isArray(storyContext.relationships) ? storyContext.relationships : []) {
    if (row?.evidenceLevel !== 'fact' || Number(row.confidence ?? 1) < 0.7) continue;
    if (!SPOUSE.test(String(row.relation || row.role || ''))) continue;
    if (/eski|ex[- ]/iu.test(String(row.relation || ''))) continue;
    const from = track(row.from), to = track(row.to);
    if (from === protagonist && to) result.add(to);
    else if (to === protagonist && from) result.add(from);
  }
  return result;
}

export function withSpouseLabel(action = {}, spouseTracks = new Set()) {
  const partner = String(action.partnerTrackId || '').trim();
  if (!partner || !spouseTracks.has(partner) || String(action.subjectTrackId || 'MAIN_MALE') !== 'MAIN_MALE') return action;
  const intimate = action.adultScene === true || ['approach', 'panel'].includes(String(action.choiceSurface || ''));
  if (!intimate) return action;
  const keep = value => value && !NEUTRAL.test(String(value).trim());
  return { ...action, partnerLabel: keep(action.partnerLabel) && !/partner/i.test(action.partnerLabel) ? action.partnerLabel : 'Karın',
    primaryCharacterLabel: 'Karın', identityResolution: 'verified' };
}
