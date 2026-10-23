// Who is in the video, for dubbing: gender and the age the voice should
// sound like. The analysis may give ageGroup directly; otherwise the visible
// description and name ("Olgun erkek", "Genç kadın", "yaşlı adam") decide.

const fold = value => String(value || '').toLocaleLowerCase('tr-TR')
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o');

export function characterAgeGroup(character = {}) {
  const direct = String(character.ageGroup || '').toLowerCase();
  if (['young', 'adult', 'mature', 'senior'].includes(direct)) return direct;
  const text = fold([character.displayName, character.role, character.sourceRole, character.description,
    character.evidence, character.voiceTone].filter(Boolean).join(' '));
  if (/\b(yasli|ihtiyar|old|elderly|senior|aksakal)\w*/u.test(text)) return 'senior';
  if (/\b(olgun|orta yas\w*|mature|middle.aged|milf)\w*/u.test(text)) return 'mature';
  if (/\b(genc|young|ufak tefek|minyon|petite|tiz|ince ses)\w*/u.test(text)) return 'young';
  return '';
}

export function castProfilesFor(analysis) {
  const out = [];
  for (const character of analysis?.storyContext?.characters || []) {
    if (character?.evidenceLevel !== 'fact' || character?.identityConflict) continue;
    const gender = String(character.gender || '').toLowerCase();
    if (!['male', 'female'].includes(gender)) continue;
    const characterId = String(character.id || character.participantTrackId || '').trim();
    if (!characterId) continue;
    const ageGroup = characterAgeGroup(character);
    const identity = String(character.genderIdentity || '').toLowerCase();
    out.push({ characterId, gender, ...(ageGroup ? { ageGroup } : {}), ...(['trans_woman', 'trans_man', 'nonbinary'].includes(identity) ? { genderIdentity: identity } : {}) });
  }
  return out.slice(0, 16);
}
