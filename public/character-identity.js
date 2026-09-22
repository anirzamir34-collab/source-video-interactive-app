import { resolveLeadingCharacterReference, verifiedRoleNoun, relationshipChoiceLabel } from './character-reference.js';
import { inverseRelationshipRole, isAdultSocialRelationshipRole, isOrdinaryRelationshipAction } from './relationship-roles.js';
// Names come from source evidence and explicit tracks, never appearance or a relationship guess.
const text = value => String(value || '').trim().replace(/\s+/g, ' ');
const nameKey = value => text(value).toLocaleLowerCase('tr-TR');
const vaguePossessive = /\p{L}+(?:['’]|\s)?(?:n?[ıiuü]n)\s+(?:kadın|erkek|adam|partner)[\p{L}]*/iu;
const roleWords = /(?:^|[^\p{L}])(?:kadın|kadını|erkek|adam|kişi|karakter|partner|sevgili|sevgilisi|anne|baba|kız|kızı|oğul|oğlu|kardeş|üvey|abla|ağabey|amca|dayı|hala|teyze|eş|eşi|karısı|kocası|woman|man|mother|father|daughter|son|wife|husband|girlfriend|boyfriend|unknown)(?:$|[^\p{L}])/iu;

export function verifiedCharacterName(character) {
  const name = text(character?.displayName);
  const confidence = Number(character?.confidence);
  if (!name || character.identityConflict || character.evidenceLevel !== 'fact' ||
      !Number.isFinite(confidence) || confidence < 0.68 || !text(character.evidence) ||
      /['’](?:n?[ıiuü]n|s)\s+/iu.test(name) ||
      vaguePossessive.test(name) || roleWords.test(name) || verifiedRoleNoun(name) ||
      nameKey(name) === nameKey(character.sourceRole || character.role)) return '';
  return name;
}

export function verifiedVisualDescription(character) {
  if (character?.identityConflict || character?.evidenceLevel !== 'fact' ||
      Number(character?.confidence) < 0.68) return '';
  const evidence = text(character?.evidence);
  // Use only a directly supplied visual descriptor. Never turn a track ID,
  // generic gender, or a claimed relationship into a character name.
  const phrase = evidence.match(/^([^,.;]{5,65})[,.;]/u)?.[1]?.trim() || '';
  if (!/(?:^|\s)(?:\S+\s+)?(?:üstlü|kazaklı|gömlekli|ceketli|saçlı|elbiseli|tişörtlü)(?=\s|$)/iu.test(phrase)) return '';
  return phrase.replace(/\s+(?:diğer\s+)?(?:kadın|erkek|kişi)$/iu, '').trim();
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
    const conflict = old.identityConflict || record.identityConflict ||
      (oldName && newName && nameKey(oldName) !== nameKey(newName));
    const rank = value => verifiedCharacterName(value) ? 3 :
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
    if (conflict) { merged.displayName = ''; merged.identityConflict = true; }
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
  const matches = direct.length ? direct : supported.flatMap(item => {
    if (canonicalCharacterId(lookup(item.to)) !== canonicalCharacterId(subject) ||
        canonicalCharacterId(lookup(item.from)) !== canonicalCharacterId(target)) return [];
    const relation = inverseRelationshipRole(item.relation);
    return relation ? [{ ...item, from: item.to, to: item.from, relation }] : [];
  });
  // Different chunks can record the same fact using an ID or its track alias.
  // Repeated evidence is not a conflict; different roles still are.
  if (new Set(matches.map(item => verifiedRoleNoun(item.relation) || nameKey(item.relation))).size !== 1) return null;
  return matches.reduce((best, item) => Number(item.confidence) > Number(best.confidence) ? item : best);
}

function participantLabel(character) {
  const id = text(character.participantTrackId || character.id);
  if (id === 'MAIN_MALE') return 'Ana karakter';
  return `Karakter ${id.replace(/^(?:PARTNER|CHARACTER|CHAR|PERSON)[_-]?/i, '') || '?'}`;
}

export function bindActionCharacter(action, context = {}) {
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
  const conflictingTargets = Boolean(action.primaryCharacterId && action.partnerTrackId && candidate &&
    partnerCandidate && canonicalCharacterId(candidate) !== canonicalCharacterId(partnerCandidate));
  const mismatch = conflictingTargets || Boolean(candidate && declared.length && !present.includes(candidate));
  const target = mismatch ? null : candidate;
  const result = { ...action,
    characterSourceLabel: String(action.characterSourceLabel ?? action.label ?? ''),
    characterSourceNarrativeLabel: String(action.characterSourceNarrativeLabel ?? action.narrativeChoiceLabel ?? '')
  };
  // Rebinding another pair must start from the source wording, not a role or
  // proper name inserted for the previously selected pair.
  result.label = result.characterSourceLabel;
  result.narrativeChoiceLabel = result.characterSourceNarrativeLabel;
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
  let targetRole = '';
  if (target) {
    result.primaryCharacterId = target.participantTrackId || target.id;
    result.primaryCharacterLabel = verifiedCharacterName(target) || verifiedVisualDescription(target) || participantLabel(target);
    result.identityResolution = target.identityConflict ? 'conflict' : verifiedCharacterName(target) ? 'verified'
      : verifiedVisualDescription(target) ? 'described' : 'unknown';
  } else if (targetId || declared.length || vaguePossessive.test(text(action.primaryCharacterLabel))) {
    result.primaryCharacterLabel = '';
    result.identityResolution = mismatch ? 'conflict' : 'unknown';
  }
  if (action.partnerTrackId) {
    const partner = lookup(action.partnerTrackId);
    result.partnerLabel = !mismatch && partner && (!declared.length || present.includes(partner))
      ? verifiedCharacterName(partner) || verifiedVisualDescription(partner) || participantLabel(partner) : '';
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
    const canShowRelationship = relation && (ordinaryRelationshipAction || isAdultSocialRelationshipRole(relation.relation));
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
