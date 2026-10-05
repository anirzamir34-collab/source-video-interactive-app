const text = value => String(value || '').trim().toLowerCase();
const approachTypes = new Set(['kiss', 'touch', 'clothing']);
const storyTypes = new Set(['dialogue', 'story', 'scene_transition', 'camera_transition']);

// Source categories own their choices. Speech, shared participants and a scene
// envelope do not change a category, and a requested panel cannot create one.
export function choiceSurfaceForAction(action = {}, { panelFamily = '' } = {}) {
  if (action.sourceVerified !== true) return 'unverified';
  const type = text(action.actionType);
  if (panelFamily || action.positionId || action.positionLabel || type === 'position' ||
      ['partner_transition', 'outcome', 'aftermath'].includes(type) ||
      ['climax', 'aftermath'].includes(text(action.outcomeType))) return 'panel';
  const declaredEvidence = String(action.choiceSurfaceEvidence || '').trim() && Number(action.choiceSurfaceConfidence) >= 0.6;
  if (storyTypes.has(type) || (text(action.choiceSurface) === 'story' && declaredEvidence)) return 'story';
  if (approachTypes.has(type)) return 'approach';
  if (text(action.choiceSurface) === 'approach' && declaredEvidence) return 'approach';
  return 'story';
}

export function withChoiceSurface(action, options) {
  return { ...action, choiceSurface: choiceSurfaceForAction(action, options) };
}

// Display groups must never combine clips owned by different surfaces, even
// when their labels, cast, declared scene and action origin happen to match.
export function choiceSurfaceKey(clip = {}) {
  return text(clip.choiceSurface) || (clip.nonIntimate === true ? 'story' : '');
}

// A chronological playback adapter, not a merged category or display group.
export function scenePreludeChoices(scene) {
  return [...(scene?.foreplay || []), ...(scene?.dialogue || [])]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

export function sceneOwnsStoryChoice(scene, action) {
  const id = String(action?.actionId || '');
  return Boolean(id && (scene?.dialogue || []).some(item =>
    item.sourceVerified === true && [item.id, item.sourceActionId].includes(id)));
}

export function choiceSurfaceWindow(items, surface, timelineFloor = 0) {
  const forward = (items || []).filter(item => item.sourceVerified === true &&
    Number(item.endTime) > Number(timelineFloor) + 0.05)
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const key = item => choiceSurfaceKey(item) || 'approach';
  const first = forward[0];
  if (!first || key(first) !== surface) return [];
  const boundary = forward.find(item => key(item) !== surface)?.startTime ?? Infinity;
  return forward.filter(item => key(item) === surface && Number(item.startTime) < Number(boundary) &&
    Number(item.endTime) <= Number(boundary) + 0.05);
}
