// Scene edges follow the measured picture: when a hard cut lies within the
// first or last 1.5 s of a part, the part is trimmed to that cut so it never
// opens on, or ends with, frames of another shot. Parts are only shortened,
// never lengthened, so they cannot start overlapping; a loop always keeps at
// least 5 s and a story part at least 1 s, otherwise it stays unchanged.

export const BOUNDARY_SNAP_VERSION = 'hard-cut-trim-v1';

function sampleInterval(motionProfile = []) {
  const times = (Array.isArray(motionProfile) ? motionProfile : [])
    .map(row => Number(Array.isArray(row) ? row[0] : row?.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) if (times[i] > times[i - 1]) gaps.push(times[i] - times[i - 1]);
  if (!gaps.length) return 1;
  gaps.sort((a, b) => a - b);
  return Math.min(2, Math.max(0.2, gaps[Math.floor(gaps.length / 2)]));
}

export function hardCutTimes(sceneBoundaries = []) {
  return (Array.isArray(sceneBoundaries) ? sceneBoundaries : [])
    .filter(row => row && (row.kind === 'hard-cut' || Number(row.score) >= 48))
    .map(row => Number(row.time)).filter(Number.isFinite).sort((a, b) => a - b);
}

// A cut is detected at the first sample showing the new shot; the old shot
// is certainly visible one sample earlier.
function trimmedRange(start, end, cuts, interval, maxShift) {
  let nextStart = start, nextEnd = end;
  const startCut = cuts.filter(time => time > start + 0.05 && time <= start + maxShift).pop();
  if (startCut !== undefined) nextStart = startCut;
  const endCut = cuts.find(time => time - interval < end - 0.05 && time - interval >= end - maxShift && time - interval > nextStart);
  if (endCut !== undefined) nextEnd = endCut - interval;
  return { start: nextStart, end: nextEnd };
}

export function snapActionBoundaries(actions = [], { sceneBoundaries = [], motionProfile = [], maxShift = 1.5 } = {}) {
  const cuts = hardCutTimes(sceneBoundaries);
  const list = Array.isArray(actions) ? actions : [];
  if (!cuts.length) return { actions: list, changed: 0 };
  const interval = sampleInterval(motionProfile);
  let changed = 0;
  const round = value => Number(value.toFixed(3));
  const out = list.map(action => {
    const start = Number(action?.startTime), end = Number(action?.endTime);
    if (action?.outcomeType && action.outcomeType !== 'none') return action;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return action;
    const range = trimmedRange(start, end, cuts, interval, maxShift);
    if (range.start === start && range.end === end) return action;
    const hasPosition = Boolean(action.positionId);
    const loopStart = Math.max(Number(action.loopStartTime ?? start), range.start);
    const loopEnd = Math.min(Number(action.loopEndTime ?? end), range.end);
    if (hasPosition && !(loopEnd - loopStart >= 5)) return action;
    if (!(range.end - range.start >= (hasPosition ? 5 : 1))) return action;
    changed += 1;
    const next = { ...action, startTime: round(range.start), endTime: round(range.end),
      loopStartTime: round(loopStart), loopEndTime: round(loopEnd), boundarySnap: BOUNDARY_SNAP_VERSION };
    // An occurrence edge that was the part's own edge moves with it.
    if (Math.abs(Number(action.positionStartTime) - start) < 0.01) next.positionStartTime = next.startTime;
    if (Math.abs(Number(action.positionEndTime) - end) < 0.01) next.positionEndTime = next.endTime;
    if (Array.isArray(action.verifiedSubsequences)) {
      next.verifiedSubsequences = action.verifiedSubsequences
        .map(part => ({ ...part, startTime: Math.max(Number(part.startTime), next.startTime),
          endTime: Math.min(Number(part.endTime), next.endTime) }))
        .filter(part => part.endTime - part.startTime >= 5);
      if (next.verifiedSubsequences.length < 2) next.verifiedSubsequences = [];
    }
    return next;
  });
  return { actions: out, changed };
}
