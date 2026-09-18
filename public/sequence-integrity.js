// Content-independent timeline validation. A parent envelope is not evidence
// that every frame between its first and last child belongs to that parent.
export function timelineRange(startValue, endValue) {
  const number = value => (typeof value === 'number' ||
    (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
  const startTime = number(startValue);
  const endTime = number(endValue);
  return Number.isFinite(startTime) && Number.isFinite(endTime) &&
    startTime >= 0 && endTime > startTime ? { startTime, endTime } : null;
}

export function clipRange(clip) {
  if (!clip) return null;
  return timelineRange(
    clip.loopStartTime === undefined ? clip.startTime : clip.loopStartTime,
    clip.loopEndTime === undefined ? clip.endTime : clip.loopEndTime
  );
}

export function normalizedSourceRanges(parent = {}) {
  const source = Array.isArray(parent.sourceRanges) ? parent.sourceRanges : [];
  const seen = new Set();
  return source.flatMap(item => {
    const id = String(item?.id || '').trim();
    const range = timelineRange(item?.startTime, item?.endTime);
    if (!id || !range) return [];
    const key = JSON.stringify([id, range.startTime, range.endTime]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...item, id, ...range }];
  }).sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
}

export function sourceRangeForClip(parent = {}, clip = null, ranges = normalizedSourceRanges(parent)) {
  const range = clipRange(clip);
  if (!range || clip.sourceVerified !== true) return null;
  const parentTrack = String(parent.partnerTrackId || '').trim();
  const clipTrack = String(clip.partnerTrackId || '').trim();
  if (parentTrack && clipTrack && parentTrack !== clipTrack) return null;
  // Tolerate only floating-point rounding, not gaps or neighbouring footage.
  const epsilon = 1e-7;
  return ranges.find(source => source.id === String(clip.sourcePositionId || '') &&
    range.startTime >= source.startTime - epsilon &&
    range.endTime <= source.endTime + epsilon) || null;
}
