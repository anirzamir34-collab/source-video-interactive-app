// Builds the dialogue-led label requests from the real source speech (Scribe
// transcript) and its Turkish lines, and applies the answers. Every label is
// checked for perspective; only story and opening labels use the dialogue.

export const DIALOGUE_LABEL_VERSION = 'dialogue-labels-v2';
const BEFORE = 10;
const AFTER = 1.5;

const words = text => String(text || '').split(/\s+/).filter(word => /\p{L}{2,}/u.test(word)).length;

export function dialogueLabelItems(actions = [], { utterances = [], turkishBySegment = new Map(),
  speakerName = () => '', labelFor = action => action.narrativeChoiceLabel || action.label } = {}) {
  const speech = (Array.isArray(utterances) ? utterances : [])
    .filter(row => Number.isFinite(row?.sourceStart) && Number.isFinite(row?.sourceEnd) && String(row.sourceText || '').trim())
    .sort((a, b) => a.sourceStart - b.sourceStart);
  // Every playable label is checked for perspective (the player's own
  // second-person choice); story and opening labels may also be phrased
  // after the line spoken just before them.
  return (Array.isArray(actions) ? actions : [])
    .filter(action => action?.sourceVerified === true && action.dialogueLabel !== DIALOGUE_LABEL_VERSION &&
      (action.positionId || ['story', 'approach'].includes(String(action.choiceSurface || ''))))
    .map(action => {
      const start = Number(action.startTime);
      const panel = Boolean(action.positionId);
      const lines = panel ? [] : speech.filter(row => row.sourceEnd > start - BEFORE && row.sourceStart < start + AFTER).slice(-4)
        .map(row => ({ speaker: speakerName(row.speakerId) || '', text: String(row.sourceText).trim(),
          tr: String(turkishBySegment.get(row.segmentId) || '').trim() }))
        .filter(line => words(line.tr || line.text) >= 2);
      return { actionId: action.actionId, currentLabel: String(panel ? action.label : labelFor(action) || '').trim(),
        surface: panel ? 'panel' : action.choiceSurface,
        actor: String(action.subjectTrackId || '') === 'MAIN_MALE' ? 'player' : 'partner', lines };
    })
    .filter(item => item.currentLabel)
    .slice(0, 80);
}

export function applyDialogueLabels(actions = [], labels = {}) {
  let changed = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    const label = labels?.[action?.actionId];
    action.dialogueLabel = DIALOGUE_LABEL_VERSION;
    if (!label) continue;
    if (action.positionId) {
      // Sex-panel cards show the action label itself.
      action.labelBeforeDialogue = action.label;
      action.label = label;
      changed += 1;
      continue;
    }
    action.labelBeforeDialogue = action.narrativeChoiceLabel || action.label;
    action.narrativeChoiceLabel = label;
    action.storyEvidenceLevel = 'fact';
    action.storyConfidence = Math.max(Number(action.storyConfidence) || 0, 0.8);
    action.storyEvidence = 'Seçenekten hemen önce söylenen kaynak konuşma';
    changed += 1;
  }
  return changed;
}
