import test from 'node:test';
import assert from 'node:assert/strict';
import { clipRange, timelineRange, normalizedSourceRanges, sourceRangeForClip } from '../public/sequence-integrity.js';
import {
  consolidateVerifiedPositions, positionOccurrenceGroups, positionOccurrenceForMovement,
  movementsForPositionOccurrence, expandVerifiedMovementVariants, buildVerifiedMovementChoices
} from '../public/adult-gameplay.js';
import { canPlayAction } from '../public/engine-hardening.js';

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
