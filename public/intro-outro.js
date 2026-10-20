// Logos, title cards, ads and closing/credit screens are not part of the
// story. They are removed from the choices and the game starts after the
// opening material and ends before the closing material.
const NON_STORY = /(?<!\p{L})(?:intro|outro|logo|jenerik|kapanış|kapanis|tanıtım|tanitim|fragman|reklam|bitiş ekran|son ekran|credits|end screen|title card|başlık ekran|abone ol|watermark|filigran)/iu;

const text = action => [action?.label, action?.narrativeChoiceLabel, action?.sceneTitle, action?.movementType]
  .filter(Boolean).join(' ');

export function isNonStoryScreen(action = {}) {
  if (action.adultScene === true) return false;
  if (!['story', '', undefined, null].includes(action.choiceSurface)) return false;
  const type = String(action.actionType || '').toLowerCase();
  if (!['scene_transition', 'camera_transition', 'story', 'other', 'dialogue', ''].includes(type)) return false;
  // Dialogue is story even when someone mentions a "trailer".
  if (type === 'dialogue') return false;
  return NON_STORY.test(text(action));
}

// Returns where play should start and end, and the actions without the
// leading/trailing non-story screens. Only screens at the very start or the
// very end are trimmed; anything in the middle stays untouched.
export function trimIntroOutro(actions = [], { introEndTime = 0, duration = 0, analysisGaps = [] } = {}) {
  const sorted = [...actions].sort((a, b) => Number(a.startTime) - Number(b.startTime));
  let first = 0;
  while (first < sorted.length && isNonStoryScreen(sorted[first])) first += 1;
  let last = sorted.length;
  while (last > first && isNonStoryScreen(sorted[last - 1])) last -= 1;
  const kept = sorted.slice(first, last);
  const removed = [...sorted.slice(0, first), ...sorted.slice(last)];
  const intro = Math.max(0, Number(introEndTime) || 0);
  const firstStart = kept.length ? Number(kept[0].startTime) : intro;
  // Footage before the first analyzed event holds nothing playable. Skip it
  // unless an unanalyzed (refused) interval sits there: that may be story.
  const gapBeforeFirst = (analysisGaps || []).some(gap => Number(gap.startTime) < firstStart - 0.5);
  const playStartTime = gapBeforeFirst ? intro : Math.max(intro, Number.isFinite(firstStart) ? firstStart : intro);
  const trailing = sorted.slice(last);
  const playEndTime = trailing.length ? Number(trailing[0].startTime) : (Number(duration) || 0);
  return { actions: kept, removed, playStartTime, playEndTime };
}
