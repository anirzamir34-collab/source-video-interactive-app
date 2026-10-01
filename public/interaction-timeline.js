import { clipRange, normalizedSourceRanges, timelineRange } from './sequence-integrity.js';

const text = value => String(value ?? '').trim();
const epsilon = 1e-7;
const list = value => Array.isArray(value) ? value : [];
const toleranceFor = value => Math.max(0, Math.min(0.25, Number(value) || 0));

function occurrenceBuckets(ranges, tolerance = 0.25) {
  const buckets = [];
  for (const range of ranges) {
    const previous = buckets[buckets.length - 1];
    if (previous && range.startTime <= previous.endTime + tolerance) {
      previous.endTime = Math.max(previous.endTime, range.endTime);
      previous.ranges.push(range);
    } else buckets.push({ startTime: range.startTime, endTime: range.endTime, ranges: [range] });
  }
  return buckets;
}

// Identity fields are opaque provider data. No label or content inference is
// used to decide whether two observed groups belong to the same occurrence.
export function interactionGroupIdentity(group = {}) {
  return JSON.stringify([
    text(group.groupType ?? group.familyId) || `source-id:${text(group.id)}`,
    text(group.subjectId ?? group.subjectTrackId),
    text(group.partnerId ?? group.partnerTrackId),
    text(group.phase ?? group.progressionRole),
    text(group.routeNamespace ?? group.verifiedRoute ?? group.route)
  ]);
}

export function verifiedOccurrenceRanges(group = {}) {
  if (group.sourceVerified !== true) return [];
  const parentRange = timelineRange(group.startTime, group.endTime);
  // A verified parent flag does not prove a continuous envelope. Require the
  // actual declared source intervals before a target can become playable.
  const source = list(group.sourceRanges);
  const ranges = normalizedSourceRanges({ sourceRanges: source })
    .filter(range => range.sourceVerified !== false && (!parentRange ||
      (range.startTime >= parentRange.startTime - epsilon && range.endTime <= parentRange.endTime + epsilon)));
  const fallbackOccurrence = text(group.occurrenceId || group.id);
  if (!fallbackOccurrence) return [];
  return ranges.map(range => ({
    ...range,
    occurrenceId: text(range.occurrenceId || range.sourceOccurrenceId || fallbackOccurrence),
    sourceVerified: true
  }));
}

export function consolidateInteractionOccurrences(groups = [], { adjacencyTolerance = 0.25 } = {}) {
  const tolerance = toleranceFor(adjacencyTolerance);
  const inputs = list(groups).flatMap(group => {
    const ranges = verifiedOccurrenceRanges(group);
    if (!ranges.length || !text(group.id)) return [];
    const buckets = occurrenceBuckets(ranges, tolerance);
    return buckets.map(bucket => ({ ...group,
      id: buckets.length > 1
        ? `${text(group.id)}@${bucket.startTime}:${bucket.endTime}` : group.id,
      occurrenceId: buckets.length > 1
        ? `${text(group.occurrenceId || group.id)}@${bucket.startTime}:${bucket.endTime}`
        : text(group.occurrenceId || group.id),
      sourceRanges: bucket.ranges,
      sourceGroupIds: [...new Set((list(group.sourceGroupIds).length
        ? list(group.sourceGroupIds).map(text) : [text(group.id)]).filter(Boolean))],
      startTime: bucket.startTime, endTime: bucket.endTime,
      movements: list(group.movements).filter(clip => interactionClipGuard({ ...group,
        sourceRanges: bucket.ranges }, clip).allowed)
    }));
  }).sort((a, b) => a.startTime - b.startTime || text(a.id).localeCompare(text(b.id)));
  const results = [];
  for (const group of inputs) {
    const identity = interactionGroupIdentity(group);
    const previous = [...results].reverse().find(candidate =>
      interactionGroupIdentity(candidate) === identity &&
      group.startTime <= candidate.endTime + tolerance &&
      group.endTime >= candidate.startTime - tolerance);
    if (!previous) {
      results.push({ ...group,
        sourceOccurrenceIds: [...new Set(group.sourceRanges.map(range => range.occurrenceId))],
        movements: [...list(group.movements)] });
      continue;
    }
    previous.sourceRanges = normalizedSourceRanges({ sourceRanges: [...previous.sourceRanges, ...group.sourceRanges] });
    previous.sourceOccurrenceIds = [...new Set(previous.sourceRanges.map(range => range.occurrenceId))];
    previous.sourceGroupIds = [...new Set([...previous.sourceGroupIds, ...group.sourceGroupIds])];
    previous.startTime = Math.min(previous.startTime, group.startTime);
    previous.endTime = Math.max(previous.endTime, group.endTime);
    const seen = new Set();
    previous.movements = [...previous.movements, ...list(group.movements)].filter(clip => {
      const range = clipRange(clip);
      const key = JSON.stringify([clip?.id, clip?.sourcePositionId || clip?.sourceGroupId,
        clip?.sourceOccurrenceId || clip?.occurrenceId, range?.startTime, range?.endTime]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  // Source intervals stay exact even when a tiny provider split is represented
  // by one tab. In particular, no broad parent envelope becomes playable.
  return results;
}

export function interactionClipGuard(group = {}, clip = null, { occurrenceId = '' } = {}) {
  if (!clip || clip.sourceVerified !== true || group.sourceVerified !== true) {
    return { allowed: false, reason: 'SOURCE_NOT_VERIFIED' };
  }
  const target = clipRange(clip);
  if (!target) return { allowed: false, reason: 'INVALID_SOURCE_INTERVAL' };
  const observed = timelineRange(clip.startTime, clip.endTime);
  if ((clip.startTime !== undefined || clip.endTime !== undefined) && !observed) {
    return { allowed: false, reason: 'INVALID_SOURCE_INTERVAL' };
  }
  if (observed && (target.startTime < observed.startTime - epsilon || target.endTime > observed.endTime + epsilon)) {
    return { allowed: false, reason: 'CLIP_OUTSIDE_SOURCE' };
  }
  const sourceId = text(clip.sourcePositionId || clip.sourceGroupId);
  if (!sourceId) return { allowed: false, reason: 'SOURCE_ID_MISSING' };
  for (const fields of [['subjectId', 'subjectTrackId'], ['partnerId', 'partnerTrackId'], ['routeNamespace']]) {
    const value = object => text(fields.map(field => object[field]).find(item => item !== undefined));
    if (value(group) && value(clip) && value(group) !== value(clip)) {
      return { allowed: false, reason: 'SOURCE_IDENTITY_MISMATCH' };
    }
  }
  const selectedOccurrence = text(occurrenceId);
  const sourceOccurrence = text(clip.sourceOccurrenceId || clip.positionOccurrenceId);
  const declaredOccurrence = text(clip.occurrenceId);
  const groupOccurrence = text(group.occurrenceId || group.id);
  const aliases = new Set([groupOccurrence, ...list(group.sourceOccurrenceIds).map(text)]);
  if (selectedOccurrence && !aliases.has(selectedOccurrence) &&
    !verifiedOccurrenceRanges(group).some(range => range.occurrenceId === selectedOccurrence)) {
    return { allowed: false, reason: 'OCCURRENCE_MISMATCH' };
  }
  const sourceRange = verifiedOccurrenceRanges(group).find(range =>
    range.id === sourceId && target.startTime >= range.startTime - epsilon &&
    target.endTime <= range.endTime + epsilon &&
    (!sourceOccurrence || sourceOccurrence === range.occurrenceId) &&
    (!declaredOccurrence || declaredOccurrence === range.occurrenceId || declaredOccurrence === groupOccurrence) &&
    (!selectedOccurrence || selectedOccurrence === groupOccurrence || selectedOccurrence === range.occurrenceId));
  return sourceRange ? { allowed: true, reason: '', sourceRange } :
    { allowed: false, reason: 'CLIP_OUTSIDE_OCCURRENCE' };
}

export function interactionEntryClip(group = {}) {
  if (interactionClipGuard(group, group.entryClip).allowed) return { ...group.entryClip };
  // A tab selects one observed entry only. It never chains internal cards.
  const first = verifiedOccurrenceRanges(group)[0];
  if (!first) return null;
  return {
    id: `entry:${text(group.id)}:${first.startTime}`,
    sourceVerified: true, sourcePositionId: first.id, sourceOccurrenceId: first.occurrenceId,
    startTime: first.startTime, endTime: first.endTime,
    loopStartTime: first.startTime, loopEndTime: first.endTime,
    entryOnly: true
  };
}

export function interactionMovementVariants(group = {}, card = null, { occurrenceId = '', adjacencyTolerance = 0.25 } = {}) {
  if (!card) return [];
  const variants = Array.isArray(card.variants) ? card.variants : [card];
  const allowed = variants.filter(clip => interactionClipGuard(group, clip, { occurrenceId }).allowed);
  if (!allowed.length) return [];
  // One card cannot silently cross a discontinuous return, including an input
  // provider group which already contains several disjoint sourceRanges.
  const ranges = verifiedOccurrenceRanges(group);
  const firstRange = interactionClipGuard(group, allowed[0], { occurrenceId }).sourceRange;
  const continuous = occurrenceBuckets(ranges, toleranceFor(adjacencyTolerance));
  const occurrence = continuous.find(item => item.ranges.includes(firstRange) || item.ranges.some(range =>
    range.id === firstRange.id && range.startTime === firstRange.startTime && range.endTime === firstRange.endTime));
  return allowed.filter(clip => {
    const range = clipRange(clip);
    return range.startTime >= occurrence.startTime - epsilon && range.endTime <= occurrence.endTime + epsilon;
  });
}
