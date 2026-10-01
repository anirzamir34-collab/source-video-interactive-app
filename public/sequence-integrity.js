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
    const key = JSON.stringify([id, range.startTime, range.endTime,
      String(item.occurrenceId || item.sourceOccurrenceId || '').trim()]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...item, id, ...range }];
  }).sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
}

export function sourceRangeForClip(parent = {}, clip = null, ranges = normalizedSourceRanges(parent)) {
  const range = clipRange(clip);
  if (!range || clip.sourceVerified !== true || parent.sourceVerified === false) return null;
  // Identity is source data. A matching time alone must not move a clip to a
  // different subject, partner or routing namespace.
  for (const field of ['partnerTrackId', 'subjectTrackId', 'routeNamespace']) {
    const parentValue = String(parent[field] || '').trim();
    const clipValue = String(clip[field] || '').trim();
    if (parentValue && clipValue && parentValue !== clipValue) return null;
  }
  // Tolerate only floating-point rounding, not gaps or neighbouring footage.
  const epsilon = 1e-7;
  const observed = timelineRange(clip.startTime, clip.endTime);
  if ((clip.startTime !== undefined || clip.endTime !== undefined) && !observed) return null;
  if (observed && (range.startTime < observed.startTime - epsilon ||
    range.endTime > observed.endTime + epsilon)) return null;
  const occurrence = String(clip.sourceOccurrenceId || clip.positionOccurrenceId || '').trim();
  return ranges.find(source => source.sourceVerified !== false &&
    source.id === String(clip.sourcePositionId || '') &&
    (!occurrence || !String(source.occurrenceId || source.sourceOccurrenceId || '').trim() ||
      occurrence === String(source.occurrenceId || source.sourceOccurrenceId).trim()) &&
    range.startTime >= source.startTime - epsilon &&
    range.endTime <= source.endTime + epsilon) || null;
}
