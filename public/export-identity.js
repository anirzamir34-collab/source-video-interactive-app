import { verifiedCharacterName } from './character-identity.js';
import { verifiedRoleNoun } from './character-reference.js';
import { isOrdinaryRelationshipAction } from './relationship-roles.js';

// Prepare an export-only copy of factual identity metadata, without changing
// the runtime, a saved game, or any intimate/sexual choice wording.
const text = value => String(value ?? '').trim();

function factName(character) {
  if (!character || character.identityConflict || character.evidenceLevel !== 'fact' ||
      !Number.isFinite(Number(character.confidence)) || Number(character.confidence) < 0.68 ||
      !text(character.evidence)) return '';
  const name = verifiedCharacterName(character);
  const role = verifiedRoleNoun(character.displayName);
  return name || (role ? text(character.displayName) : '');
}

function characterLookup(characters) {
  const registry = new Map();
  for (const character of characters) {
    if (!character || typeof character !== 'object') continue;
    const aliases = [character.id, character.participantTrackId, ...(Array.isArray(character.characterIds) ? character.characterIds : [])];
    for (const alias of aliases) {
      const key = text(alias);
      if (!key) continue;
      if (registry.has(key) && registry.get(key) !== character) registry.set(key, null);
      else if (!registry.has(key)) registry.set(key, character.identityConflict ? null : character);
    }
  }
  return id => registry.get(text(id)) || null;
}

const trackOf = character => text(character?.participantTrackId || character?.id);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceTargetPlaceholder(value, target, verifiedName) {
  if (!verifiedName || !target) return value;
  const id = trackOf(target);
  const match = /^PARTNER[_-]([A-Z0-9]+)$/iu.exec(id);
  if (!match) return value;
  const aliases = [id, `Partner ${match[1]}`, `Karakter ${match[1]}`];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${aliases.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return typeof value === 'string' ? value.replace(pattern, verifiedName) : value;
}

export function synchronizeExportIdentity(analysis) {
  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.actions)) return analysis;
  const characters = Array.isArray(analysis.storyContext?.characters) ? analysis.storyContext.characters : [];
  if (!characters.length) return analysis;
  const lookup = characterLookup(characters);
  return {
    ...analysis,
    actions: analysis.actions.map(action => {
      if (!action || typeof action !== 'object') return action;
      const involved = [
        ...(Array.isArray(action.involvedCharacterIds) ? action.involvedCharacterIds : []),
        ...(Array.isArray(action.participantTrackIds) ? action.participantTrackIds : [])
      ].map(lookup);
      const hasDeclared = (Array.isArray(action.involvedCharacterIds) && action.involvedCharacterIds.length > 0) ||
        (Array.isArray(action.participantTrackIds) && action.participantTrackIds.length > 0);
      const declaredValid = !hasDeclared || involved.every(Boolean);
      const inScene = person => Boolean(person) && (!hasDeclared || involved.includes(person));
      const subject = lookup(action.subjectTrackId);
      const primary = lookup(action.primaryCharacterId);
      const partner = lookup(action.partnerTrackId);
      const actorInPrimary = Boolean(primary && subject && trackOf(primary) === trackOf(subject));
      const conflictingTarget = Boolean(action.primaryCharacterId && action.partnerTrackId &&
        (!primary || !partner || (trackOf(primary) !== trackOf(partner) && !actorInPrimary)));
      const safe = declaredValid && !conflictingTarget;
      const target = safe ? (actorInPrimary && partner && partner !== subject ? partner : (primary || partner)) : null;
      const finalTarget = inScene(target) ? target : null;
      const targetFact = factName(finalTarget);
      const partnerFact = safe && inScene(partner) ? factName(partner) : '';
      const subjectFact = safe && inScene(subject) ? factName(subject) : '';
      const result = {
        ...action,
        primaryCharacterDisplayNameFact: targetFact,
        partnerDisplayNameFact: partnerFact,
        subjectDisplayNameFact: subjectFact
      };
      // Exact, ordinary dialogue only. Unknown scene type and all intimate
      // scenes retain their original playable copy without substitutions.
      if (action.adultScene === false && action.actionType === 'dialogue' &&
          isOrdinaryRelationshipAction(action) && finalTarget && targetFact) {
        for (const field of ['label', 'narrativeChoiceLabel', 'primaryCharacterLabel']) {
          result[field] = replaceTargetPlaceholder(action[field], finalTarget, targetFact);
        }
      }
      return result;
    })
  };
}
