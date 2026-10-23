import { resolveLeadingCharacterReference, verifiedRoleNoun, relationshipChoiceLabel } from './character-reference.js';
import { inverseRelationshipRole, isAdultSocialRelationshipRole, isOrdinaryRelationshipAction, isSpouseRelationshipRole } from './relationship-roles.js';
// Names come from source evidence and explicit tracks, never appearance or a relationship guess.
const text = value => String(value || '').trim().replace(/\s+/g, ' ');
const nameKey = value => text(value).toLocaleLowerCase('tr-TR');
const vaguePossessive = /\p{L}+(?:['’]|\s)?(?:n?[ıiuü]n)\s+(?:kadın|erkek|adam|partner)[\p{L}]*/iu;
const roleWords = /(?:^|[^\p{L}])(?:kadın|kadını|erkek|adam|kişi|karakter|partner|sevgili|sevgilisi|anne|baba|kız|kızı|oğul|oğlu|kardeş|üvey|abla|ağabey|amca|dayı|hala|teyze|eş|eşi|karısı|kocası|woman|man|mother|father|daughter|son|wife|husband|girlfriend|boyfriend|unknown)(?:$|[^\p{L}])/iu;

// Model-made routing keys ("FEMALE_1", "PARTNER_A", "participant-002") and
// bare gender words are never a character's name.
const TRACK_TOKEN = /(?<![\p{L}\p{N}_])(?:MAIN_MALE|OTHER_(?:FE)?MALE(?:_\d+)?|PARTNER_[A-Z0-9]{1,3}|(?:FE)?MALE_\d{1,2}|(?:WO)?MAN_\d{1,2}|PARTICIPANT[-_]\d{1,3})(?![\p{L}\p{N}_])/u;
export function isTrackIdName(name, character = {}) {
  const value = text(name);
  if (!value) return false;
  if ([character.id, character.participantTrackId].map(text).includes(value)) return true;
  return /^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+$/.test(value) || /^(?:fe)?male$|^(?:wo)?man$|^participant[-_ ]?\d+$/i.test(value);
}

// Removes leaked routing keys from player-facing wording:
// "PARTNER_A'nın oral seks yapmasına izin ver" -> "Oral seks yapmasına izin ver".
export function stripTrackTokens(value) {
  const source = String(value ?? '');
  const token = new RegExp(TRACK_TOKEN.source, 'gu');
  if (!token.test(source)) return source;
  const out = source
    .replace(new RegExp(`${TRACK_TOKEN.source}(?:['’]\\p{L}+)?(?:\\s+(?:ile|ve|için))?\\s*`, 'gu'), '')
    .replace(/\s{2,}/g, ' ').replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '').trim();
  return out ? out.slice(0, 1).toLocaleUpperCase('tr-TR') + out.slice(1) : '';
}

// Choices are the protagonist's own moves. A label that narrates him in the
// third person and asks to watch it ("Erkeğin odaya girişini ve kadınla
// konuşmasını izle") becomes his own action ("Odaya gir ve kadınla konuş").
const imperativeOf = word => {
  let match = word.match(/^(.+?)(?:ma|me)(?:sı|si)(?:nı|ni|na|ne)$/u);
  if (match) return match[1];
  match = word.match(/^(.+?)[ıiuü]ş[ıiuü](?:nı|ni|nu|nü)$/u);
  if (match) return match[1];
  return null;
};
export function protagonistFirstPerson(label = '') {
  const value = String(label || '').trim();
  const match = value.match(/^(?:(?:genç|yakışıklı|takım elbiseli|ana)\s+)?(?:erkeğin|adamın|erkek karakterin|ana karakterin)\s+(.+?)\s+izle$/iu);
  if (!match) return value;
  let changed = 0;
  const body = match[1].split(/\s+/u).map(word => {
    const verb = imperativeOf(word.toLocaleLowerCase('tr-TR'));
    if (verb) { changed += 1; return verb; }
    return word;
  }).join(' ');
  if (!changed) return value;
  return body.slice(0, 1).toLocaleUpperCase('tr-TR') + body.slice(1);
}

export function verifiedCharacterName(character) {
  const name = text(character?.displayName);
  if (isTrackIdName(name, character || {})) return '';
  // A name the video gives (spoken in the dialogue or shown on screen) is used
  // as is; only conflicting names, possessives and role words are refused.
  if (!name || character.identityConflict ||
      /['’](?:n?[ıiuü]n|s)\s+/iu.test(name) ||
      vaguePossessive.test(name) || roleWords.test(name) || verifiedRoleNoun(name) ||
      nameKey(name) === nameKey(character.sourceRole || character.role)) return '';
  return name;
}

// Preserve verified source identities independently from player-facing labels.
// A FACT relationship title is source metadata, not an inferred proper name.
function factSourceDisplayName(character) {
  const value = text(character?.displayName);
  const confidence = Number(character?.confidence);
  if (!value || character?.identityConflict || character?.evidenceLevel !== 'fact' ||
      !Number.isFinite(confidence) || confidence < 0.68 || !text(character?.evidence)) return '';
  return verifiedCharacterName(character) || (verifiedRoleNoun(value) ? value : '');
}

// A short look-based display name such as "Esmer kadın" or "Bıyıklı adam" is
// a stable visual description, not a proper name and not a relationship.
const visualAdjectives = /^(?:esmer|sarışın|kumral|kızıl|siyah saçlı|sarı saçlı|kahverengi saçlı|kısa saçlı|uzun saçlı|kıvırcık saçlı|bıyıklı|sakallı|kel|dövmeli|gözlüklü|uzun boylu|kısa boylu|kaslı|zayıf|dolgun|balıketli|esmer tenli|beyaz tenli|siyahi|kumral saçlı)$/iu;
function visualDisplayName(character) {
  const name = text(character?.displayName);
  const match = name.match(/^(.{2,40}?)\s+(kadın|erkek|adam)$/iu);
  if (!match || !visualAdjectives.test(match[1].trim())) return '';
  return name.slice(0, 1).toLocaleUpperCase('tr-TR') + name.slice(1);
}

// "Erkeğin üstünde oturan pembe büstiyerli genç kadın" is a posture plus a
// look; only the look identifies her: "Pembe büstiyerli kadın".
const LOOK_WORD = /^(?:\p{L}+(?:lü|lu|li|lı)|esmer|sarışın|kızıl|kumral|kel|dövmeli|gözlüklü|bıyıklı|sakallı)$/iu;
const COLOR = /^(?:pembe|kırmızı|siyah|beyaz|mavi|yeşil|sarı|mor|turuncu|gri|lacivert|kahverengi|bej|bordo|açık|koyu|uzun|kısa|kıvırcık|düz|dar|ince)$/iu;
function compactLook(phrase, character) {
  const words = String(phrase || '').trim().split(/\s+/u);
  const index = words.findIndex(word => LOOK_WORD.test(word) && !/^(?:oturan|yatan|duran)$/iu.test(word));
  if (index < 0) return '';
  const parts = [words[index]];
  for (let i = index - 1; i >= 0 && parts.length < 3 && COLOR.test(words[i]); i--) parts.unshift(words[i]);
  const gender = String(character?.gender || '').toLowerCase();
  const noun = gender === 'female' ? 'kadın' : gender === 'male' ? 'adam' : '';
  const look = `${parts.join(' ')}${noun ? ` ${noun}` : ''}`.trim();
  return look.slice(0, 1).toLocaleUpperCase('tr-TR') + look.slice(1);
}

// One stable name per person in every scene: the name the video gives, or a
// plain age word ("Genç kadın", "Kadın", "Olgun kadın"). Looks such as hair
// or clothes are never used as names, and adults are never called "kız".
const AGE_NOUNS = {
  female: { young: 'Genç kadın', adult: 'Kadın', mature: 'Olgun kadın', senior: 'Yaşlı kadın', '': 'Kadın' },
  male: { young: 'Genç adam', adult: 'Adam', mature: 'Olgun adam', senior: 'Yaşlı adam', '': 'Adam' }
};
export function ageBasedName(character = {}) {
  const gender = String(character?.gender || '').toLowerCase();
  const identity = String(character?.genderIdentity || '').toLowerCase();
  // A trans or non-binary person is named as the video establishes them.
  if (identity === 'trans_woman' || identity === 'trans_man') {
    const noun = identity === 'trans_woman' ? 'trans kadın' : 'trans erkek';
    const prefix = { young: 'Genç ', mature: 'Olgun ', senior: 'Yaşlı ' }[String(character?.ageGroup || '').toLowerCase()] || '';
    return prefix ? `${prefix}${noun}` : noun[0].toLocaleUpperCase('tr-TR') + noun.slice(1);
  }
  if (identity === 'nonbinary') return 'Non-binary kişi';
  if (identity === 'femboy') return String(character?.ageGroup || '').toLowerCase() === 'young' ? 'Genç femboy' : 'Femboy';
  if (!AGE_NOUNS[gender]) return '';
  const age = String(character?.ageGroup || '').toLowerCase();
  const said = text(character?.displayName).toLocaleLowerCase('tr-TR');
  const fallback = /genç|young/u.test(said) ? 'young' : /olgun|orta yaş/u.test(said) ? 'mature' : /yaşlı/u.test(said) ? 'senior' : '';
  return AGE_NOUNS[gender][AGE_NOUNS[gender][age] ? age : fallback];
}
export function stableCharacterName(character, characters = []) {
  if (!character) return '';
  const name = verifiedCharacterName(character);
  if (name && !/\bkız\b/iu.test(name)) return name;
  const base = ageBasedName(character);
  if (!base) return '';
  // Two people of the same kind are numbered in order of appearance.
  const same = (Array.isArray(characters) ? characters : []).filter(other =>
    !verifiedCharacterName(other) && ageBasedName(other) === base);
  const index = same.findIndex(other => (other.participantTrackId || other.id) === (character.participantTrackId || character.id));
  return same.length > 1 && index >= 0 ? `${base} ${index + 1}` : base;
}

// "kız" forms become "kadın" forms in labels about adults ("Genç kızı öp" ->
// "Genç kadını öp"); "kızıl" (red-haired) and other words are left alone.
const KIZ_FORMS = { 'kız': 'kadın', 'kızı': 'kadını', 'kızla': 'kadınla', 'kızın': 'kadının', 'kıza': 'kadına',
  'kızdan': 'kadından', 'kızda': 'kadında', 'kızlar': 'kadınlar', 'kızları': 'kadınları', 'kızlarla': 'kadınlarla' };
export function adultWording(label = '') {
  return String(label || '').replace(/(^|[^\p{L}])(kız(?:ı|la|ın|a|dan|da|lar|ları|larla)?)(?=$|[^\p{L}])/giu, (match, lead, word) => {
    const lower = word.toLocaleLowerCase('tr-TR');
    const next = KIZ_FORMS[lower];
    if (!next) return match;
    const upper = word[0] !== word[0].toLocaleLowerCase('tr-TR');
    return lead + (upper ? next[0].toLocaleUpperCase('tr-TR') + next.slice(1) : next);
  });
}

// Replaces a person's look nickname ("Örgülü kadın", "Pembe büstiyerli kadın")
// in a label with their stable name, keeping the Turkish case ending.
export function replaceNickname(label, nicknames = [], stable = '') {
  let out = String(label || '');
  if (!stable) return out;
  for (const nick of [...new Set(nicknames.map(text).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    if (nick.toLocaleLowerCase('tr-TR') === stable.toLocaleLowerCase('tr-TR')) continue;
    const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\p{L}])${escaped}(\\p{L}*)`, 'giu'), (match, lead, suffix, offset) => {
      const atStart = offset + lead.length === 0;
      // "Genç kadın 2" cannot take a case ending; the plain words can.
      const plain = suffix ? stable.replace(/\s+\d+$/u, '') : stable;
      const name = atStart ? plain : (/^[A-ZÇĞİÖŞÜ]/u.test(plain.split(' ')[0]) && !AGE_WORD.test(plain) ? plain : plain.toLocaleLowerCase('tr-TR'));
      return `${lead}${name}${suffix}`;
    });
  }
  return out;
}
const AGE_WORD = /^(?:Genç|Olgun|Yaşlı|Kadın|Adam)(?=\s|$)/u;

export function verifiedVisualDescription(character) {
  if (character?.identityConflict || character?.evidenceLevel !== 'fact' ||
      Number(character?.confidence) < 0.68) return '';
  const lookName = visualDisplayName(character);
  if (lookName) return lookName;
  const evidence = text(character?.evidence).replace(/\s*\(spk:\d+\)/giu, '');
  // Use only a directly supplied visual descriptor. Never turn a track ID,
  // generic gender, or a claimed relationship into a character name.
  const descriptor = /(?:^|\s)(?:\S+\s+)?(?:üstlü|kazaklı|gömlekli|ceketli|saçlı|elbiseli|tişörtlü|dövmeli|gözlüklü|kel|bıyıklı|sakallı|büstiyerli|etekli|bikinili|sabahlıklı|takım elbiseli|esmer|sarışın|kızıl)(?=\s|,|$)/iu;
  // Prefer the shortest directly observed distinguishing phrase, not a camera
  // position or a generic relationship. Later comma-separated descriptors can
  // still be used if the first phrase is not visually distinguishing.
  for (const value of [evidence, text(character?.description)]) {
    if (!/(?:kadın|erkek|kişi|woman|man)/iu.test(value)) continue;
    const phrase = value.split(/[,.;]/u).map(item => item.trim())
      .find(item => descriptor.test(item));
    if (phrase) return compactLook(phrase, character) ||
      phrase.replace(/\s+(?:misafir\s+|diğer\s+)?(?:kadın|erkek|kişi)$/iu, '').trim().slice(0, 75);
  }
  return '';
}

export function mergeCharacterRecords(records = []) {
  const out = [];
  const byTrack = new Map();
  for (const record of records) {
    const key = text(record.participantTrackId || record.id);
    // A name alone never proves two observations show the same person.
    if (!key || !byTrack.has(key)) {
      if (key) byTrack.set(key, out.length);
      out.push({ ...record });
      continue;
    }
    const index = byTrack.get(key);
    const old = out[index];
    const oldName = verifiedCharacterName(old);
    const newName = verifiedCharacterName(record);
    const factRole = value => value.evidenceLevel === 'fact' && Number(value.confidence) >= 0.78 &&
      text(value.evidence) ? verifiedRoleNoun(value.sourceRole || value.role) : '';
    const oldRole = factRole(old), newRole = factRole(record);
    // Contradictory family roles on one track are an identity conflict, not a
    // reason to silently use whichever chunk happened to arrive last.
    const conflict = old.identityConflict || record.identityConflict ||
      (oldName && newName && nameKey(oldName) !== nameKey(newName)) ||
      (oldRole && newRole && oldRole !== newRole);
    // Do not overwrite an evidenced source role with a higher-confidence
    // provider placeholder from a later chunk of the same track.
    const rank = value => verifiedCharacterName(value) ? 3 :
      factSourceDisplayName(value) ? 2.5 :
      value.evidenceLevel === 'fact' && text(value.evidence) ? 2 : value.evidenceLevel === 'inference' ? 1 : 0;
    const better = rank(record) > rank(old) ||
      (rank(record) === rank(old) && Number(record.confidence) > Number(old.confidence));
    const selected = better ? record : old;
    const other = better ? old : record;
    const merged = { ...other, ...Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== '')) };
    const supportedVoices = [old, record].filter(item => text(item.voiceMatchEvidence));
    const speakerIds = [...new Set(supportedVoices.flatMap(item => item.speakerIds || []))];
    if (speakerIds.length) {
      merged.speakerIds = speakerIds.slice(0, 8);
      merged.voiceMatchEvidence = [...new Set(supportedVoices.map(item => text(item.voiceMatchEvidence)))].join(' ').slice(0, 360);
    }
    const aliases = [...new Set([old.id, record.id, ...(old.characterIds || []), ...(record.characterIds || [])].map(text).filter(Boolean))];
    if (aliases.length > 1) merged.characterIds = aliases.slice(0, 24);
    if (conflict) {
      merged.displayName = '';
      merged.sourceRole = '';
      merged.role = '';
      merged.identityConflict = true;
    }
    out[index] = merged;
  }
  return out;
}

function characterLookup(characters, id) {
  const key = text(id);
  if (!key) return null;
  const matches = characters.filter(character =>
    [character.id, character.participantTrackId, ...(character.characterIds || [])].includes(key));
  return matches.length === 1 ? matches[0] : null;
}

function canonicalCharacterId(character) {
  return text(character?.participantTrackId || character?.id);
}

// Provider chunks may use a local character id for a participant that the
// verified story context already maps to a stable video track. Use only unique
// explicit aliases; an ambiguous id must keep its original source identity.
export function canonicalizeActionTrackIds(action, context = {}) {
  const aliases = new Map();
  for (const character of Array.isArray(context.characters) ? context.characters : []) {
    const track = text(character?.participantTrackId);
    if (!track) continue;
    for (const id of [character.id, character.participantTrackId, ...(character.characterIds || [])]) {
      const key = text(id);
      if (!key) continue;
      if (character.identityConflict) { aliases.set(key, null); continue; }
      if (aliases.has(key) && aliases.get(key) !== track) aliases.set(key, null);
      else if (!aliases.has(key)) aliases.set(key, track);
    }
  }
  const canonical = id => aliases.get(text(id)) || text(id);
  return { ...action,
    subjectTrackId: canonical(action.subjectTrackId),
    primaryCharacterId: canonical(action.primaryCharacterId),
    partnerTrackId: canonical(action.partnerTrackId),
    involvedCharacterIds: Array.isArray(action.involvedCharacterIds)
      ? [...new Set(action.involvedCharacterIds.map(canonical))] : action.involvedCharacterIds,
    participantTrackIds: Array.isArray(action.participantTrackIds)
      ? action.participantTrackIds.map(canonical) : action.participantTrackIds
  };
}

function verifiedRelationship(context, subject, target) {
  if (!subject || !target || subject === target) return null;
  const characters = Array.isArray(context.characters) ? context.characters : [];
  const lookup = id => characterLookup(characters, id);
  const supported = (Array.isArray(context.relationships) ? context.relationships : []).filter(item => {
    const confidence = Number(item?.confidence);
    if (item?.evidenceLevel !== 'fact' || !Number.isFinite(confidence) || confidence < 0.78 ||
        !text(item.evidence) || !text(item.relation)) return false;
    return lookup(item.from) && lookup(item.to);
  });
  const direct = supported.filter(item => {
    const from = lookup(item.from);
    const to = lookup(item.to);
    return canonicalCharacterId(from) === canonicalCharacterId(subject) &&
      canonicalCharacterId(to) === canonicalCharacterId(target);
  });
  const reverse = supported.flatMap(item => {
    if (canonicalCharacterId(lookup(item.to)) !== canonicalCharacterId(subject) ||
        canonicalCharacterId(lookup(item.from)) !== canonicalCharacterId(target)) return [];
    const relation = inverseRelationshipRole(item.relation);
    return relation ? [{ ...item, from: item.to, to: item.from, relation }] : [];
  });
  const matches = direct.length ? direct : reverse;
  // Equivalent spouse terms ("eşi" / "karısı" / "kocası") may describe
  // the same FACT-level pair without becoming an identity conflict. Unlike
  // an unrelated family role, they never establish a different addressee.
  const spouseOnly = matches.length > 0 && matches.every(item => isSpouseRelationshipRole(item.relation));
  if (!spouseOnly && new Set(matches.map(item => verifiedRoleNoun(item.relation) || nameKey(item.relation))).size !== 1) return null;
  // Do not silently prefer a spouse claim if the reverse FACT-level edge
  // identifies this SAME pair as a sibling, child or other non-spouse role.
  if (spouseOnly && [...direct, ...reverse].some(item => !isSpouseRelationshipRole(item.relation))) return null;
  return matches.reduce((best, item) => Number(item.confidence) > Number(best.confidence) ? item : best);
}

function participantLabel(character) {
  const id = text(character.participantTrackId || character.id);
  if (id === 'MAIN_MALE') return 'Ana karakter';
  const numbered = id.match(/^(FE)?MALE_(\d{1,2})$/i);
  if (numbered) return `${numbered[1] ? 'Kadın' : 'Adam'} ${numbered[2]}`;
  if (/^OTHER_FEMALE/i.test(id)) return 'Diğer kadın';
  if (/^OTHER_MALE/i.test(id)) return 'Diğer adam';
  return `Karakter ${id.replace(/^(?:PARTNER|CHARACTER|CHAR|PERSON)[_-]?/i, '') || '?'}`;
}

export function bindActionCharacter(action, context = {}) {
  action = canonicalizeActionTrackIds(action, context);
  const characters = Array.isArray(context.characters) ? context.characters : [];
  const lookup = id => characterLookup(characters, id);
  const declared = [...new Set([...(action.involvedCharacterIds || []), ...(action.participantTrackIds || [])].map(text).filter(Boolean))];
  const present = [...new Set(declared.map(lookup).filter(Boolean))];
  let targetId = text(action.primaryCharacterId || action.partnerTrackId);
  if (!targetId && present.length === 1 && declared.every(lookup)) targetId = present[0].participantTrackId || present[0].id;
  if (!targetId && declared.every(lookup)) {
    const subject = lookup(action.subjectTrackId);
    const others = present.filter(character => character !== subject);
    if (subject && present.includes(subject) && others.length === 1) targetId = others[0].participantTrackId || others[0].id;
  }
  const candidate = lookup(targetId);
  const partnerCandidate = lookup(action.partnerTrackId);
  const subject = lookup(action.subjectTrackId);
  // primaryCharacterId and partnerTrackId do not necessarily denote the same
  // person. Some providers place the player (actor) in primaryCharacterId
  // and the real addressee in partnerTrackId. Two different valid people are
  // not an identity conflict. Prefer the witnessed partner only when the
  // primary candidate is explicitly the actor, not the addressee.
  const primaryIsActor = Boolean(candidate && subject &&
    canonicalCharacterId(candidate) === canonicalCharacterId(subject));
  const partnerIsDistinct = Boolean(partnerCandidate && subject &&
    canonicalCharacterId(partnerCandidate) !== canonicalCharacterId(subject));
  const partnerInScene = partnerCandidate && (!declared.length || present.includes(partnerCandidate));
  const resolvedTarget = primaryIsActor && partnerIsDistinct && partnerInScene
    ? partnerCandidate : (candidate || partnerCandidate);
  // If two different people are both asserted as the addressee in a
  // group scene, the target remains ambiguous. The ONE exception is a provider
  // duplicating the known actor in primaryCharacterId and correctly naming
  // a different witnessed partner; this is not a two-target contradiction.
  const conflictingTargets = Boolean(action.primaryCharacterId && action.partnerTrackId &&
    (!candidate || !partnerCandidate ||
      (canonicalCharacterId(candidate) !== canonicalCharacterId(partnerCandidate) &&
       !primaryIsActor)));
  // An impossible target (not among the explicitly observed scene people)
  // remains unresolved; never rewrite it to someone merely nearby.
  const mismatch = conflictingTargets ||
    Boolean(resolvedTarget && declared.length && !present.includes(resolvedTarget)) ||
    Boolean(targetId && !candidate && !partnerCandidate);
  const target = mismatch ? null : resolvedTarget;
  const result = { ...action,
    characterSourceLabel: String(action.characterSourceLabel ?? action.label ?? ''),
    characterSourceNarrativeLabel: String(action.characterSourceNarrativeLabel ?? action.narrativeChoiceLabel ?? '')
  };
  // Rebinding another pair must start from the source wording, not a role or
  // proper name inserted for the previously selected pair.
  result.label = stripTrackTokens(result.characterSourceLabel) || result.characterSourceLabel;
  result.narrativeChoiceLabel = stripTrackTokens(result.characterSourceNarrativeLabel) || result.characterSourceNarrativeLabel;
  if (['MAIN_MALE', ''].includes(text(action.subjectTrackId))) {
    result.label = protagonistFirstPerson(result.label);
    result.narrativeChoiceLabel = protagonistFirstPerson(result.narrativeChoiceLabel);
  }
  // Every person keeps one name in every label: look nicknames give way to
  // the stable name, and adults are never called "kız".
  for (const person of [lookup(action.partnerTrackId), lookup(action.primaryCharacterId)].filter(Boolean)) {
    const stable = stableCharacterName(person, characters);
    const nicknames = [person.displayName, visualDisplayName(person), action.partnerLabel, action.primaryCharacterLabel]
      .filter(value => value && !verifiedCharacterName({ ...person, displayName: value }));
    result.label = replaceNickname(result.label, nicknames, stable);
    result.narrativeChoiceLabel = replaceNickname(result.narrativeChoiceLabel, nicknames, stable);
  }
  result.label = adultWording(result.label);
  result.narrativeChoiceLabel = adultWording(result.narrativeChoiceLabel);
  // He gives oral to her: never word it as her doing it to him.
  if (String(action.oralGiver || '').toLowerCase() === 'main_male' &&
      /yapmasına izin ver|emmesine|yalamasına/iu.test(result.label)) {
    result.label = /tempo|hızlan|sert|derin/iu.test(result.label) ? 'Onu yalamaya devam et' : 'Onu yala';
    if (/yapmasına izin ver|emmesine|yalamasına/iu.test(result.narrativeChoiceLabel)) result.narrativeChoiceLabel = '';
  }
  // Derived labels must be rebuilt when a scene changes, never carried over.
  result.relationshipDisplayLabel = '';
  result.relationshipContext = '';
  result.relationshipResolution = 'unknown';
  result.relationshipRoleLabel = '';
  result.relationshipOwnerLabel = '';
  result.relationshipSubjectId = '';
  result.relationshipTargetId = '';
  result.characterPairLabel = '';
  result.characterPairResolution = 'unknown';
  // Proven source display names survive as factual action metadata across
  // normal/adult scene changes. They are deliberately NOT gameplay wording.
  // Recompute all fields on every bind, so stale names cannot migrate to
  // another participant or an ambiguous group scene.
  result.primaryCharacterDisplayNameFact = target ? factSourceDisplayName(target) : '';
  result.subjectDisplayNameFact = subject && !mismatch && (!declared.length || present.includes(subject))
    ? factSourceDisplayName(subject) : '';
  result.partnerDisplayNameFact = '';
  if (!mismatch && action.partnerTrackId) {
    const partnerForMetadata = lookup(action.partnerTrackId);
    if (partnerForMetadata && (!declared.length || present.includes(partnerForMetadata))) {
      result.partnerDisplayNameFact = factSourceDisplayName(partnerForMetadata);
    }
  }
  let targetRole = '';
  // Track aliases are private routing keys. Ordinary story/dialogue metadata
  // must not pretend that 'Karakter A' is a verified on-screen identity.
  const ordinary = isOrdinaryRelationshipAction(action);
  const evidencedLabel = character => stableCharacterName(character, characters) ||
    verifiedCharacterName(character) || verifiedVisualDescription(character);
  if (target) {
    result.primaryCharacterId = target.participantTrackId || target.id;
    result.primaryCharacterLabel = evidencedLabel(target) || (ordinary ? '' : participantLabel(target));
    result.identityResolution = target.identityConflict ? 'conflict' : verifiedCharacterName(target) ? 'verified'
      : verifiedVisualDescription(target) ? 'described' : 'unknown';
  } else if (targetId || declared.length || vaguePossessive.test(text(action.primaryCharacterLabel))) {
    result.primaryCharacterLabel = '';
    result.identityResolution = mismatch ? 'conflict' : 'unknown';
  }
  if (action.partnerTrackId) {
    const partner = lookup(action.partnerTrackId);
    result.partnerLabel = !mismatch && partner && (!declared.length || present.includes(partner))
      ? evidencedLabel(partner) || (ordinary ? '' : participantLabel(partner)) : '';
  }
  // Relationship labels are story context only. Intimate controls retain the
  // verified name/track so a family role never becomes erotic UI wording.
  if (target) {
    const ordinaryRelationshipAction = isOrdinaryRelationshipAction(action);
    let subject = lookup(action.subjectTrackId);
    if (declared.length && !present.includes(subject)) subject = null;
    // A group has no implicit actor. Only an exact two-person scene can supply
    // the missing subject; an explicit but unresolved subject is not replaced.
    if (!action.subjectTrackId && present.length === 2 && declared.every(lookup) && present.includes(target)) {
      subject = present.find(character => character !== target);
    }
    // Every selectable story action is from MAIN_MALE's point of view. Some
    // provider responses omit him from involvedCharacterIds even though they
    // correctly identify the addressee. In an ordinary non-group action, the
    // unique locked protagonist is therefore the exact actor, not a guessed
    // age/gender label.
    if (!action.subjectTrackId && !subject && ordinaryRelationshipAction && action.groupScene !== true) {
      const protagonists = characters.filter(character =>
        canonicalCharacterId(character) === 'MAIN_MALE' && character !== target
      );
      if (protagonists.length === 1) subject = protagonists[0];
    }
    const subjectName = verifiedCharacterName(subject);
    const targetName = verifiedCharacterName(target);
    if (ordinaryRelationshipAction && subject && subject !== target && subjectName && targetName &&
        (action.groupScene === true || present.length > 2)) {
      result.characterPairLabel = `${subjectName} → ${targetName}`;
      result.characterPairResolution = 'verified';
    }
    const relation = verifiedRelationship(context, subject, target);
    // A directly evidenced spouse bond belongs to this exact subject-target
    // pair, even when either adult is also another character's parent.
    // All other kinship terms remain ordinary-story context only.
    const verifiedSpousePair = Boolean(relation && isSpouseRelationshipRole(relation.relation));
    const canShowRelationship = relation && (ordinaryRelationshipAction ||
      verifiedSpousePair || isAdultSocialRelationshipRole(relation.relation));
    if (canShowRelationship) {
      targetRole = verifiedRoleNoun(relation.relation);
      result.relationshipRoleLabel = targetRole;
      result.relationshipOwnerLabel = action.groupScene === true || present.length > 2 ? subjectName : '';
      result.relationshipSubjectId = canonicalCharacterId(subject);
      result.relationshipTargetId = canonicalCharacterId(target);
      result.relationshipDisplayLabel = subjectName
        ? `${subjectName} ile ilişkisi: ${text(relation.relation)}`
        : `İlişki: ${text(relation.relation)}`;
      result.relationshipContext = result.relationshipDisplayLabel;
      result.relationshipResolution = 'verified';
    }
  }
  // Reject an ambiguous possessive description without inventing a replacement action.
  if (vaguePossessive.test(text(result.label))) result.label = 'Kesiti oynat';
  if (vaguePossessive.test(text(result.narrativeChoiceLabel))) result.narrativeChoiceLabel = '';
  if (target) {
    const reference = { name: verifiedCharacterName(target), role: targetRole,
      ownerName: result.relationshipOwnerLabel,
      allowGeneric: Boolean(targetRole && action.groupScene !== true &&
        result.relationshipSubjectId && result.relationshipTargetId),
      targetIds: [target.id, target.participantTrackId, ...(target.characterIds || [])] };
    result.label = relationshipChoiceLabel(resolveLeadingCharacterReference(result.label, reference), targetRole, result.relationshipOwnerLabel);
    result.narrativeChoiceLabel = relationshipChoiceLabel(resolveLeadingCharacterReference(result.narrativeChoiceLabel, reference), targetRole, result.relationshipOwnerLabel);
  }
  return result;
}

