import test from 'node:test';
import assert from 'node:assert/strict';
import { clipRange, timelineRange, normalizedSourceRanges, sourceRangeForClip } from '../public/sequence-integrity.js';
import {
  consolidateVerifiedPositions, positionOccurrenceGroups, positionOccurrenceForMovement,
  movementsForPositionOccurrence, expandVerifiedMovementVariants, buildVerifiedMovementChoices
} from '../public/adult-gameplay.js';
import { canPlayAction } from '../public/engine-hardening.js';
import {
  verifiedOccurrenceRanges, consolidateInteractionOccurrences, interactionClipGuard,
  interactionEntryClip, interactionMovementVariants
} from '../public/interaction-timeline.js';

const clip = (id, start, end, source = 'raw') => ({
  id, sourcePositionId: source, label: `Action ${id}`, sourceVerified: true,
  startTime: start, endTime: end, loopStartTime: start, loopEndTime: end
});
const parent = (id, start, end, movements = []) => ({
  id, familyId: 'chapter', label: 'Chapter', partnerTrackId: 'track-a',
  startTime: start, endTime: end, movements
});
const merge = positions => consolidateVerifiedPositions(positions, { mergeDistantReturns: true });

for (const [name, start, end] of [
  ['null', null, 10], ['empty', '', 10], ['whitespace', ' ', 10],
  ['boolean', false, 10], ['array', [], 10], ['missing', undefined, 10],
  ['NaN', NaN, 10], ['infinity', 0, Infinity], ['negative', -1, 10],
  ['reversed', 10, 5], ['zero-duration', 5, 5], ['null-end', 0, null]
]) {
  test(`timeline rejects ${name} rather than coercing it into a playable range`, () => {
    assert.equal(timelineRange(start, end), null);
    assert.equal(clipRange({ loopStartTime: start, loopEndTime: end }), null);
  });
}

test('numeric strings and valid start/end-only clips remain compatible', () => {
  assert.deepEqual(timelineRange('0', '3.5'), { startTime: 0, endTime: 3.5 });
  assert.deepEqual(clipRange({ startTime: 0, endTime: 4 }), { startTime: 0, endTime: 4 });
});

test('range normalization deduplicates only exact ranges and never fills a gap', () => {
  const p = { sourceRanges: [
    { id: 'raw', startTime: 40, endTime: 50 },
    { id: 'raw', startTime: 0, endTime: 10 },
    { id: 'raw', startTime: '0', endTime: '10' },
    { id: 'broken', startTime: null, endTime: 100 }
  ] };
  assert.deepEqual(normalizedSourceRanges(p).map(r => [r.startTime, r.endTime]), [[0, 10], [40, 50]]);
  assert.equal(sourceRangeForClip(p, clip('gap', 9, 41)), null);
  assert.ok(sourceRangeForClip(p, clip('valid', 41, 49)));
  const groups = positionOccurrenceGroups(p);
  assert.equal(new Set(groups.map(g => g.id)).size, 2);
  assert.equal(positionOccurrenceForMovement(p, clip('valid', 41, 49)).id, groups[1].id);
});

test('even a small gap in one display occurrence cannot be played across', () => {
  const p = { sourceRanges: [
    { id: 'raw', startTime: 0, endTime: 10 },
    { id: 'raw', startTime: 10.1, endTime: 20 }
  ], movements: [clip('first', 0, 9), clip('bridge', 9, 11), clip('last', 11, 19)] };
  assert.equal(positionOccurrenceGroups(p).length, 1);
  assert.deepEqual(movementsForPositionOccurrence(p).map(m => m.id), ['first', 'last']);
  assert.equal(positionOccurrenceForMovement(p, p.movements[1]), null);
});

test('unverified, mismatched-track and wrong-source clips have no playable occurrence', () => {
  const p = { partnerTrackId: 'track-a', sourceRanges: [{ id: 'raw', startTime: 0, endTime: 10 }] };
  for (const patch of [
    { sourceVerified: false }, { sourceVerified: undefined },
    { partnerTrackId: 'track-b' }, { sourcePositionId: 'wrong' },
    { loopStartTime: 9, loopEndTime: 2 }, { loopStartTime: null }
  ]) assert.equal(positionOccurrenceForMovement(p, { ...clip('x', 0, 10), ...patch }), null);
});

test('colliding clip IDs retain every distinct interval and become addressable individually', () => {
  const result = merge([
    parent('first', 0, 10, [clip('reused', 0, 10, 'first')]),
    parent('last', 30, 40, [clip('reused', 30, 40, 'last')])
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].movements.length, 2);
  assert.equal(new Set(result[0].movements.map(m => m.id)).size, 2);
  assert.ok(result[0].movements.every(m => !m.id.includes(',')));
  assert.equal(result[0].entryMovementId, result[0].movements[0].id);
  assert.deepEqual(merge(result), result);
});

test('repeated graph preparation is idempotent and preserves source ranges', () => {
  const source = [
    parent('raw', 0, 20, [clip('a', 0, 10), clip('b', 10, 20)]),
    parent('return', 80, 90, [clip('c', 80, 90, 'return')])
  ];
  const result = merge(source);
  assert.deepEqual(merge(result), result);
  assert.deepEqual(merge([...source].reverse()), result);
  assert.equal(positionOccurrenceGroups(result[0]).length, 2);
  assert.ok(result[0].movements.every(m => positionOccurrenceForMovement(result[0], m)));
  assert.equal(source[0].movements[0].id, 'a');
});

test('malformed declared source ranges do not fall back to a broad parent envelope', () => {
  const p = parent('raw', 0, 100, [clip('a', 0, 10)]);
  for (const sourceRanges of [[], null, [{ id: 'raw', startTime: 30, endTime: 20 }]]) {
    assert.deepEqual(merge([{ ...p, sourceRanges }]), []);
  }
});

test('consolidation filters invalid clips without promoting unverified evidence', () => {
  const p = parent('raw', 0, 10, [
    clip('valid', 1, 5), { ...clip('unverified', 1, 5), sourceVerified: false },
    clip('outside', 8, 20), { ...clip('null', 0, 3), loopStartTime: null }
  ]);
  assert.deepEqual(merge([p])[0].movements.map(m => m.id), ['valid']);
  assert.deepEqual(merge([{ ...p, startTime: null }]), []);
});

test('variant expansion never upgrades unverified or missing evidence', () => {
  const source = [false, undefined].map((sourceVerified, index) => ({
    ...clip(`clip-${index}`, 0, 30), sourceVerified
  }));
  assert.deepEqual(expandVerifiedMovementVariants(source, 0, 30), []);
});

for (const splitEachMovement of [true, false]) {
  test(`expansion stays within individual source intervals (split=${splitEachMovement})`, () => {
    const source = [clip('first', 0, 21), clip('last', 90, 111)];
    const variants = expandVerifiedMovementVariants(source, 0, 111, { minSeconds: 3, splitEachMovement });
    assert.ok(variants.length >= 2);
    assert.ok(variants.every(v => source.some(s => v.loopStartTime >= s.loopStartTime && v.loopEndTime <= s.loopEndTime)));
    assert.equal(variants.reduce((n, v) => n + v.loopEndTime - v.loopStartTime, 0), 42);
  });

  test(`long input retains all source clips after optional split budget is exhausted (split=${splitEachMovement})`, () => {
    const source = Array.from({ length: 100 }, (_, i) => clip(`clip-${i}`, i * 40, i * 40 + 30));
    const variants = expandVerifiedMovementVariants(source, 0, 4000, { minSeconds: 3, maxVariants: 24, splitEachMovement });
    assert.equal(new Set(variants.map(v => v.derivedFromVerifiedSegment || v.id)).size, 100);
    assert.equal(variants.reduce((n, v) => n + v.loopEndTime - v.loopStartTime, 0), 3000);
  });
}

test('overlapping observations do not erase a distinct labelled interval', () => {
  const source = [clip('first', 0, 20), clip('second', 1, 21)];
  const variants = expandVerifiedMovementVariants(source, 0, 21, { minSeconds: 3, splitEachMovement: true });
  assert.deepEqual(new Set(variants.map(v => v.derivedFromVerifiedSegment)), new Set(['first', 'second']));
});

test('unknown-tempo source actions become separate cards and preserve every clip', () => {
  const source = Array.from({ length: 8 }, (_, i) => clip(String(i), i * 10, i * 10 + 5));
  const choices = buildVerifiedMovementChoices(source, 'Chapter', 3);
  assert.deepEqual(choices.map(c => c.label), source.map(item => item.label));
  assert.equal(choices.flatMap(c => c.variants).length, source.length);
  assert.deepEqual(choices.flatMap(choice => choice.variants).map(v => v.id), ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.ok(choices.every(choice => choice.variants.length === 1));
});

test('central guard rejects gap-spanning, oversized-loop and unverified clips', () => {
  const p = { ...parent('raw', 0, 100), sourceRanges: [
    { id: 'raw', startTime: 0, endTime: 10 }, { id: 'raw', startTime: 90, endTime: 100 }
  ] };
  const guard = action => canPlayAction({ kind: 'movement', action, parentPosition: p, videoDuration: 100 });
  assert.equal(guard(clip('valid', 0, 10)).allowed, true);
  assert.equal(guard(clip('gap', 5, 95)).reason, 'CLIP_OUTSIDE_VERIFIED_RANGE');
  assert.equal(guard({ ...clip('oversized', 0, 5), loopEndTime: 8 }).reason, 'CLIP_OUTSIDE_SOURCE');
  assert.equal(guard({ ...clip('unverified', 0, 5), sourceVerified: false }).allowed, false);
});

test('1000 deterministic timelines preserve every valid clip and exact occurrence boundaries', () => {
  let seed = 834127;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 1000; run += 1) {
    let cursor = Math.floor(random() * 50);
    const inputs = Array.from({ length: 2 + Math.floor(random() * 10) }, (_, i) => {
      const start = cursor;
      const end = start + 4 + Math.floor(random() * 30);
      cursor = end + 2 + Math.floor(random() * 100);
      const id = `source-${i % 3}`;
      return parent(id, start, end, [clip(`reused-${i % 2}`, start, end, id)]);
    });
    const [result] = merge(inputs);
    assert.equal(result.movements.length, inputs.length);
    assert.equal(new Set(result.movements.map(m => m.id)).size, inputs.length);
    assert.equal(positionOccurrenceGroups(result).length, inputs.length);
    assert.ok(result.movements.every(m => sourceRangeForClip(result, m)));
    assert.deepEqual(merge([result]), [result]);
    assert.equal(result.entryMovementId, result.movements[0].id);
    assert.equal(sourceRangeForClip(result, clip('gap', inputs[0].endTime, inputs[1].startTime, inputs[0].id)), null);
  }
});

const genericGroup = (id, startTime, endTime, extra = {}) => ({
  id, occurrenceId: `occ:${id}`, groupType: 'group-a',
  subjectId: 'subject-a', partnerId: 'partner-a', phase: 'CORE', routeNamespace: 'route-a',
  label: `Opaque ${id}`, sourceVerified: true, startTime, endTime,
  sourceRanges: [{ id: `source:${id}`, occurrenceId: `occ:${id}`, startTime, endTime }],
  movements: [{ ...clip(`clip:${id}`, startTime, endTime, `source:${id}`), sourceOccurrenceId: `occ:${id}` }],
  ...extra
});

test('generic occurrence guard requires verified group, clip and non-rejected source evidence', () => {
  const group = genericGroup('a', 0, 10);
  const action = group.movements[0];
  assert.equal(interactionClipGuard(group, action).allowed, true);
  for (const sourceVerified of [false, undefined, 'true', 1]) {
    assert.equal(interactionClipGuard({ ...group, sourceVerified }, action).allowed, false);
    assert.equal(interactionClipGuard(group, { ...action, sourceVerified }).allowed, false);
  }
  const rejected = { ...group, sourceRanges: [{ ...group.sourceRanges[0], sourceVerified: false }] };
  assert.deepEqual(verifiedOccurrenceRanges(rejected), []);
  assert.equal(interactionClipGuard(rejected, action).allowed, false);
  assert.equal(sourceRangeForClip({ sourceVerified: false, sourceRanges: group.sourceRanges }, action), null);
  assert.equal(sourceRangeForClip(rejected, action), null);
});

test('generic movement needs exact source identity and cannot substitute another occurrence', () => {
  const group = genericGroup('a', 0, 10);
  const action = group.movements[0];
  for (const patch of [
    { sourcePositionId: '' }, { sourcePositionId: 'source:b' }, { sourceOccurrenceId: 'occ:b' },
    { subjectId: 'subject-b' }, { partnerId: 'partner-b' }, { routeNamespace: 'route-b' }
  ]) assert.equal(interactionClipGuard(group, { ...action, ...patch }).allowed, false);
  assert.equal(interactionClipGuard(group, action, { occurrenceId: 'occ:b' }).reason, 'OCCURRENCE_MISMATCH');
  assert.equal(interactionClipGuard(group, { ...action, startTime: null }).reason, 'INVALID_SOURCE_INTERVAL');
  assert.equal(interactionClipGuard(group, { ...action, endTime: 5 }).reason, 'CLIP_OUTSIDE_SOURCE');
});

test('sequence range guard does not accept matching time from a different opaque subject or namespace', () => {
  const group = { subjectTrackId: 'subject-a', partnerTrackId: 'partner-a', routeNamespace: 'route-a',
    sourceRanges: [{ id: 'raw', occurrenceId: 'occ:a', startTime: 0, endTime: 10 }] };
  assert.ok(sourceRangeForClip(group, clip('valid', 0, 10)));
  for (const patch of [{ subjectTrackId: 'subject-b' }, { routeNamespace: 'route-b' },
    { sourceOccurrenceId: 'occ:b' }, { endTime: 5 }, { startTime: null }]) {
    assert.equal(sourceRangeForClip(group, { ...clip('invalid', 0, 10), ...patch }), null);
  }
});

test('adjacent opaque occurrences consolidate their tab while preserving exact ranges and source aliases', () => {
  const first = genericGroup('a', 713, 782.260);
  const next = genericGroup('b', 782.263, 830);
  const groups = consolidateInteractionOccurrences([next, first]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, first.label);
  assert.deepEqual(groups[0].sourceGroupIds, ['a', 'b']);
  assert.deepEqual(groups[0].sourceOccurrenceIds, ['occ:a', 'occ:b']);
  assert.deepEqual(groups[0].sourceRanges.map(range => [range.startTime, range.endTime]), [[713, 782.260], [782.263, 830]]);
  assert.equal(interactionClipGuard(groups[0], clip('bridge', 782, 783, 'source:a')).allowed, false);
  assert.equal(interactionClipGuard(groups[0], next.movements[0]).allowed, true);
  assert.deepEqual(consolidateInteractionOccurrences(groups), groups);
  assert.equal(first.sourceRanges.length, 1);
});

test('consolidation compares every opaque identity field without reclassifying provider labels', () => {
  const first = genericGroup('a', 0, 10);
  for (const key of ['groupType', 'subjectId', 'partnerId', 'phase', 'routeNamespace']) {
    const next = genericGroup('b', 10, 20, { [key]: `${key}-other`, label: 'Keep exactly this' });
    const groups = consolidateInteractionOccurrences([first, next]);
    assert.equal(groups.length, 2, key);
    assert.equal(groups[1].label, next.label);
    assert.equal(groups[1][key], next[key]);
  }
});

test('verified groups missing type metadata remain addressable without inferring a shared type', () => {
  const first = genericGroup('a', 0, 10, { groupType: undefined });
  const next = genericGroup('b', 10, 20, { groupType: undefined });
  const groups = consolidateInteractionOccurrences([first, next]);
  assert.equal(groups.length, 2);
  assert.equal(interactionClipGuard(groups[0], first.movements[0]).allowed, true);
  assert.equal(interactionClipGuard(groups[1], next.movements[0]).allowed, true);
});

test('distant occurrence return remains separate and never provides a playable envelope', () => {
  const groups = consolidateInteractionOccurrences([
    genericGroup('a', 374, 391), genericGroup('b', 713, 830)
  ]);
  assert.equal(groups.length, 2);
  assert.equal(interactionClipGuard(groups[0], clip('jump', 380, 720, 'source:a')).allowed, false);
  assert.equal(interactionClipGuard(groups[0], groups[1].movements[0]).allowed, false);
  assert.equal(interactionClipGuard(groups[1], groups[0].movements[0]).allowed, false);
});

test('preexisting disjoint ranges split before adjacent merge instead of using the parent envelope', () => {
  const first = genericGroup('a', 0, 100, { sourceRanges: [
    { id: 'source:a', startTime: 0, endTime: 10 }, { id: 'source:a', startTime: 90, endTime: 100 }
  ], movements: [clip('first', 0, 10, 'source:a'), clip('return', 90, 100, 'source:a')] });
  const groups = consolidateInteractionOccurrences([first, genericGroup('b', 40, 50)]);
  assert.deepEqual(groups.map(group => [group.startTime, group.endTime]), [[0, 10], [40, 50], [90, 100]]);
  assert.equal(new Set(groups.map(group => group.occurrenceId)).size, 3);
  assert.equal(interactionClipGuard(groups[0], first.movements[1]).allowed, false);
  assert.deepEqual(consolidateInteractionOccurrences(groups), groups);
});

test('a movement card keeps only its own verified variants in the same continuous occurrence', () => {
  const first = genericGroup('a', 0, 10);
  const distant = genericGroup('b', 90, 100);
  const group = { ...first, endTime: 100, sourceRanges: [...first.sourceRanges, ...distant.sourceRanges] };
  const card = { variants: [first.movements[0], distant.movements[0],
    { ...first.movements[0], id: 'unverified', sourceVerified: false }] };
  assert.deepEqual(interactionMovementVariants(group, card).map(action => action.id), ['clip:a']);
  assert.deepEqual(interactionMovementVariants(first, { variants: [] }), []);
  assert.deepEqual(interactionMovementVariants(first, { variants: [first.movements[0]] }).map(action => action.id), ['clip:a']);
});

test('tiny adjacent provider split allows both card variants but never allows a clip spanning the gap', () => {
  const first = genericGroup('a', 713, 782.260);
  const next = genericGroup('b', 782.263, 830);
  const [group] = consolidateInteractionOccurrences([first, next]);
  const bridge = clip('bridge', 782, 783, 'source:a');
  const card = { variants: [first.movements[0], next.movements[0], bridge] };
  assert.deepEqual(interactionMovementVariants(group, card).map(action => action.id), ['clip:a', 'clip:b']);
  assert.equal(interactionClipGuard(group, bridge).allowed, false);
  assert.equal(consolidateInteractionOccurrences([genericGroup('a', 0, 10), genericGroup('b', 11, 20)],
    { adjacencyTolerance: 1000 }).length, 2);
});

test('group entry selects one verified entry or the earliest exact range without chaining internal cards', () => {
  const group = genericGroup('a', 0, 20, { movements: [clip('late', 10, 15, 'source:a')] });
  const entry = interactionEntryClip(group);
  assert.equal(entry.startTime, 0);
  assert.equal(entry.entryOnly, true);
  assert.equal(entry.variants, undefined);
  assert.equal(interactionClipGuard(group, entry).allowed, true);
  const entryClip = { ...clip('entry', 1, 3, 'source:a'), sourceOccurrenceId: 'occ:a' };
  assert.deepEqual(interactionEntryClip({ ...group, entryClip }), entryClip);
  assert.equal(interactionEntryClip({ ...group, sourceVerified: false }), null);
  assert.equal(interactionEntryClip({ ...group, sourceRanges: [] }), null);
});
