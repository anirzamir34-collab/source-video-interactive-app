// Builds the dialogue-led label requests from the real source speech (Scribe
// transcript) and its Turkish lines, and applies the answers. Only story and
// opening choices are touched; position and sex labels stay as analysed.

export const DIALOGUE_LABEL_VERSION = 'dialogue-labels-v1';
const BEFORE = 10;
const AFTER = 1.5;

const words = text => String(text || '').split(/\s+/).filter(word => /\p{L}{2,}/u.test(word)).length;

export function dialogueLabelItems(actions = [], { utterances = [], turkishBySegment = new Map(),
  speakerName = () => '', labelFor = action => action.narrativeChoiceLabel || action.label } = {}) {
  const speech = (Array.isArray(utterances) ? utterances : [])
    .filter(row => Number.isFinite(row?.sourceStart) && Number.isFinite(row?.sourceEnd) && String(row.sourceText || '').trim())
    .sort((a, b) => a.sourceStart - b.sourceStart);
  if (!speech.length) return [];
  return (Array.isArray(actions) ? actions : [])
    .filter(action => action?.sourceVerified === true && !action.positionId &&
      ['story', 'approach'].includes(String(action.choiceSurface || '')) && action.dialogueLabel !== DIALOGUE_LABEL_VERSION)
    .map(action => {
      const start = Number(action.startTime);
      const lines = speech.filter(row => row.sourceEnd > start - BEFORE && row.sourceStart < start + AFTER).slice(-4)
        .map(row => ({ speaker: speakerName(row.speakerId) || '', text: String(row.sourceText).trim(),
          tr: String(turkishBySegment.get(row.segmentId) || '').trim() }));
      return { actionId: action.actionId, currentLabel: String(labelFor(action) || '').trim(),
        surface: action.choiceSurface, lines };
    })
    .filter(item => item.currentLabel && item.lines.some(line => words(line.tr || line.text) >= 2))
    .slice(0, 40);
}

export function applyDialogueLabels(actions = [], labels = {}) {
  let changed = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    const label = labels?.[action?.actionId];
    action.dialogueLabel = DIALOGUE_LABEL_VERSION;
    if (!label) continue;
    action.labelBeforeDialogue = action.narrativeChoiceLabel || action.label;
    action.narrativeChoiceLabel = label;
    action.storyEvidenceLevel = 'fact';
    action.storyConfidence = Math.max(Number(action.storyConfidence) || 0, 0.8);
    action.storyEvidence = 'Seçenekten hemen önce söylenen kaynak konuşma';
    changed += 1;
  }
  return changed;
}
