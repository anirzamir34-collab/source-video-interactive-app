// Speech-aware boundaries: a choice never appears in the middle of a
// sentence. Where one part ends and the next begins inside a spoken line
// (original or Turkish dub), the shared edge moves to the end of that line
// (up to 4 s later) or, if the line only just started, to its start (up to
// 2 s earlier). Both parts keep their minimum length; loops keep 5 s.

export const SPEECH_BOUNDARY_VERSION = 'speech-edges-v1';

export function speechIntervals(rows = []) {
  const list = (Array.isArray(rows) ? rows : [])
    .map(row => ({ start: Number(row?.startTime ?? row?.start ?? row?.sourceStart), end: Number(row?.endTime ?? row?.end ?? row?.sourceEnd) }))
    .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const row of list) {
    const last = merged[merged.length - 1];
    // Lines with a breath between them (< 0.35 s) are one utterance.
    if (last && row.start <= last.end + 0.35) last.end = Math.max(last.end, row.end);
    else merged.push({ ...row });
  }
  return merged;
}

function minimumLength(action) {
  return action?.positionId ? 5 : 1;
}

function moveEnd(action, from, to) {
  const next = { ...action, endTime: to };
  if (Math.abs(Number(action.loopEndTime) - from) < 0.06 || Number(action.loopEndTime) > to) next.loopEndTime = to;
  if (Math.abs(Number(action.positionEndTime) - from) < 0.06) next.positionEndTime = to;
  if (Array.isArray(action.verifiedSubsequences) && action.verifiedSubsequences.length) {
    const parts = action.verifiedSubsequences.map(part => ({ ...part }));
    const last = parts[parts.length - 1];
    if (Math.abs(Number(last.endTime) - from) < 0.06 || Number(last.endTime) > to) last.endTime = to;
    next.verifiedSubsequences = parts.every(part => part.endTime - part.startTime >= 5) ? parts : [];
  }
  return next;
}

function moveStart(action, from, to) {
  const next = { ...action, startTime: to };
  if (Math.abs(Number(action.loopStartTime) - from) < 0.06 || Number(action.loopStartTime) < to) next.loopStartTime = to;
  if (Math.abs(Number(action.positionStartTime) - from) < 0.06) next.positionStartTime = to;
  if (Array.isArray(action.verifiedSubsequences) && action.verifiedSubsequences.length) {
    const parts = action.verifiedSubsequences.map(part => ({ ...part }));
    const first = parts[0];
    if (Math.abs(Number(first.startTime) - from) < 0.06 || Number(first.startTime) < to) first.startTime = to;
    next.verifiedSubsequences = parts.every(part => part.endTime - part.startTime >= 5) ? parts : [];
  }
  return next;
}

function longEnough(action) {
  const length = Number(action.endTime) - Number(action.startTime);
  if (!(length >= minimumLength(action))) return false;
  if (action.positionId) {
    const loop = Number(action.loopEndTime) - Number(action.loopStartTime);
    if (!(loop >= 5)) return false;
  }
  return true;
}

export function alignBoundariesToSpeech(actions = [], speechRows = [], { maxForward = 4, maxBack = 2 } = {}) {
  const speech = speechIntervals(speechRows);
  const list = (Array.isArray(actions) ? actions : []).slice();
  if (!speech.length || list.length < 2) return { actions: list, changed: 0 };
  const order = list.map((action, index) => ({ action, index }))
    .sort((a, b) => Number(a.action.startTime) - Number(b.action.startTime));
  let changed = 0;
  for (let k = 0; k + 1 < order.length; k += 1) {
    const left = list[order[k].index], right = list[order[k + 1].index];
    const edge = Number(right.startTime);
    if (!(Math.abs(Number(left.endTime) - edge) <= 0.3)) continue;
    if ([left, right].some(item => item?.outcomeType && item.outcomeType !== 'none')) continue;
    const line = speech.find(row => row.start < edge - 0.05 && row.end > edge + 0.05);
    if (!line) continue;
    const targets = [];
    if (line.end - edge <= maxForward) targets.push(line.end);
    if (edge - line.start <= maxBack) targets.push(line.start);
    for (const target of targets) {
      const newLeft = moveEnd(left, Number(left.endTime), Number(target.toFixed(3)));
      const newRight = moveStart(right, edge, Number(target.toFixed(3)));
      if (!longEnough(newLeft) || !longEnough(newRight)) continue;
      list[order[k].index] = { ...newLeft, speechAligned: SPEECH_BOUNDARY_VERSION };
      list[order[k + 1].index] = { ...newRight, speechAligned: SPEECH_BOUNDARY_VERSION };
      changed += 1;
      break;
    }
  }
  return { actions: list, changed };
}
