import { verifiedCharacterName } from './character-identity.js';
import { verifiedRoleNoun } from './character-reference.js';

const text = v => String(v ?? '').trim();

function factName(c) {
  if (!c || c.identityConflict || c.evidenceLevel !== 'fact' || !text(c.evidence)) return '';
  const n = verifiedCharacterName(c);
  const r = verifiedRoleNoun(c.displayName);
  return n || (r ? text(c.displayName) : '');
}

function characterLookup(chars) {
  const registry = new Map();
  for (const c of chars) {
    if (!c) continue;
    const aliases = [c.id, c.participantTrackId, ...(Array.isArray(c.characterIds) ? c.characterIds : [])];
    for (const a of aliases) {
      if (text(a)) registry.set(text(a), c.identityConflict ? null : c);
    }
  }
  return id => registry.get(text(id)) || null;
}

function replaceTargetPlaceholder(val, name) {
  if (!name || typeof val !== 'string') return val;
  return val.replace(/(Karakter A|Partner A|PARTNER_A|PARTNER_[A-Z0-9]+)/gi, name);
}

function fixTurkishSuffixes(t) {
  if (typeof t !== 'string') return t;
  return t.replace(/kızı ile/gi, "kızınla").replace(/kızı'nın/gi, "kızının").replace(/kızı'na/gi, "kızına")
          .replace(/anne ile/gi, "annenle").replace(/anne'ye/gi, "annene").replace(/annesi'nin/gi, "annesinin")
          .replace(/baba ile/gi, "babanla").replace(/baba'ya/gi, "babana").replace(/babası'nın/gi, "babasının")
          .replace(/teyze ile/gi, "teyzenle").replace(/teyze'ye/gi, "teyzene").replace(/teyzesi'nin/gi, "teyzesinin");
}

export function synchronizeExportIdentity(analysis) {
  if (!analysis?.actions) return analysis;
  const chars = analysis.storyContext?.characters || [];
  if (!chars.length) return analysis;
  const lookup = characterLookup(chars);

  return {
    ...analysis,
    actions: analysis.actions.map(action => {
      if (!action) return action;
      const primary = lookup(action.primaryCharacterId);
      const partner = lookup(action.partnerTrackId);
      const subject = lookup(action.subjectTrackId);
      const missing = (text(action.primaryCharacterId) && !primary) ||
        (text(action.partnerTrackId) && !partner);
      const primaryIsSubject = primary && subject && primary === subject;
      const conflict = primary && partner && primary !== partner && !primaryIsSubject;
      const target = missing || conflict ? null :
        (primaryIsSubject && partner ? partner : primary || partner);
      const targetFact = factName(target);

      const result = {
        ...action,
        primaryCharacterDisplayNameFact: targetFact,
        partnerDisplayNameFact: missing || conflict ? '' : factName(partner),
        subjectDisplayNameFact: factName(subject)
      };

      const intimate = action.adultScene === true ||
        ['approach', 'panel'].includes(text(action.choiceSurface)) ||
        ['position', 'touch', 'kiss', 'clothing', 'tempo_change', 'rhythm', 'outcome', 'aftermath']
          .includes(text(action.actionType));
      if (!intimate && targetFact) {
        for (const field of ['label', 'narrativeChoiceLabel', 'primaryCharacterLabel']) {
          if (result[field]) {
            result[field] = replaceTargetPlaceholder(result[field], targetFact);
            result[field] = fixTurkishSuffixes(result[field]);
          }
        }
      }
      return result;
    })
  };
}
