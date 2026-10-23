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

// The viewer may say who is in the video ("bir trans kadın ve bir erkek").
// That stated fact fills genderIdentity when the analysis left it empty and
// exactly one person in the cast can be meant.
const NOTE_IDENTITIES = [
  { identity: 'trans_woman', gender: 'female', pattern: /\btrans\s*(kadin|woman|kiz|girl)|\btranseksuel kadin|\bts\b|\btgirl\b|\bshemale\b/u },
  { identity: 'trans_man', gender: 'male', pattern: /\btrans\s*(erkek|man|adam)\b/u },
  { identity: 'femboy', gender: 'male', pattern: /\bfemboy\b/u },
  { identity: 'nonbinary', gender: null, pattern: /\b(non.?binary|nonbinary|ikili olmayan)\b/u }
];
export function castNoteIdentities(note) {
  const text = fold(note);
  return text ? NOTE_IDENTITIES.filter(row => row.pattern.test(text)) : [];
}
export function applyCastNote(characters = [], note = '') {
  const list = Array.isArray(characters) ? characters : [];
  for (const row of castNoteIdentities(note)) {
    if (list.some(character => String(character?.genderIdentity || '').toLowerCase() === row.identity)) continue;
    const candidates = list.filter(character => character && !character.genderIdentity &&
      (!row.gender || String(character.gender || '').toLowerCase() === row.gender) &&
      !(row.gender === 'male' && /MAIN_MALE/.test(String(character.participantTrackId || character.id || ''))));
    if (candidates.length === 1) candidates[0].genderIdentity = row.identity;
  }
  return list;
}

export function castProfilesFor(analysis, castNote = '') {
  const out = [];
  const note = castNote || analysis?.castNote || '';
  if (note) applyCastNote((analysis?.storyContext?.characters || []).filter(row => row?.evidenceLevel === 'fact' && !row?.identityConflict), note);
  for (const character of analysis?.storyContext?.characters || []) {
    if (character?.evidenceLevel !== 'fact' || character?.identityConflict) continue;
    const gender = String(character.gender || '').toLowerCase();
    if (!['male', 'female'].includes(gender)) continue;
    const characterId = String(character.id || character.participantTrackId || '').trim();
    if (!characterId) continue;
    const ageGroup = characterAgeGroup(character);
    const identity = String(character.genderIdentity || '').toLowerCase();
    out.push({ characterId, gender, ...(ageGroup ? { ageGroup } : {}), ...(['trans_woman', 'trans_man', 'nonbinary', 'femboy'].includes(identity) ? { genderIdentity: identity } : {}) });
  }
  return out.slice(0, 16);
}
