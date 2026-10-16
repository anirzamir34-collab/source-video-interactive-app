import { verifiedCharacterName } from './character-identity.js';
import { verifiedRoleNoun } from './character-reference.js';
import { isOrdinaryRelationshipAction } from './relationship-roles.js';

const text = value => String(value ?? '').trim();

function factName(character) {
  if (!character || character.identityConflict || character.evidenceLevel !== 'fact' ||
      !Number.isFinite(Number(character.confidence)) || Number(character.confidence)  registry.get(text(id)) || null;
}

const trackOf = character => text(character?.participantTrackId || character?.id);
const escapeRegExp = value => value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');

function replaceTargetPlaceholder(value, target, verifiedName) {
  if (!verifiedName || !target) return value;
  const id = trackOf(target);
  const match = /^PARTNER[_-]([A-Z0-9]+)\$/iu.exec(id);
  if (!match) return value;
  const aliases = [id, `Partner ${match[1]}`, `Karakter ${match[1]}`];
  const pattern = new RegExp(`(? {
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

      // TÜM KORUMALAR VE FILTRELER KALDIRILDI. SAHNE TÜRÜ VEYA AKSİYON TÜRÜ AYRIMI YOKTUR.
      // VİDEO ANALİZİNDE BULUNAN TÜM KARAKTERLER VE ROLLER SEÇİMLERE AYNEN ENJEKTE EDİLİR.
      if (finalTarget && targetFact) {
        for (const field of ['label', 'narrativeChoiceLabel', 'primaryCharacterLabel']) {
          result[field] = replaceTargetPlaceholder(action[field], finalTarget, targetFact);
          result[field] = fixTurkishSuffixes(result[field]);
        }
      }
      return result;
    })
  };
}
