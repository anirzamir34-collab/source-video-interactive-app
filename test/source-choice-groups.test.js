import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourceChoiceCards } from '../public/choice-groups.js';
import { buildVerifiedMovementChoices, findAdultSceneForTimeline } from '../public/adult-gameplay.js';

const clip = (index, extra = {}) => ({ id: `clip-${index}`, sourceVerified: true,
  label: `Patikada yürü · Sekans ${index + 1}`, actionType: 'movement',
  movementTempo: 'moderate', sourcePositionId: 'trail-a',
  partnerTrackId: 'person-a', participantTrackIds: ['person-a', 'person-b'],
  loopStartTime: index * 5, loopEndTime: index * 5 + 5, ...extra });

test('eighteen compatible source clips form several bounded cards without losing or changing a clip', () => {
  const clips = Array.from({ length: 18 }, (_, i) => clip(i));
  const before = structuredClone(clips);
  const cards = buildVerifiedMovementChoices(clips, 'Yürüyüş', 5);
  assert.equal(cards.length, 5);
  assert.ok(cards.every(card => card.variants.length >= 2 && card.variants.length <= 6));
  assert.ok(cards.every(card => card.label === 'Patikada yürü'));
  assert.deepEqual(cards.flatMap(card => card.variants), clips);
  assert.ok(cards.flatMap(card => card.variants).every(item => clips.includes(item)));
  assert.deepEqual(clips, before);
});

test('repeated parts of an observed action stay together while distinct tracks, tempos and returns stay separate', () => {
  const clips = [clip(0, { derivedFromVerifiedSegment: 'source-a' }),
    clip(1, { derivedFromVerifiedSegment: 'source-a' }),
    clip(2, { movementTempo: 'slow' }), clip(3, { partnerTrackId: 'person-c' }),
    clip(4, { sourcePositionId: 'trail-return' }), clip(5, { actionType: 'touch' })];
  const cards = groupSourceChoiceCards(clips);
  assert.equal(cards.length, 5);
  assert.deepEqual(cards[0].variants.map(item => item.id), ['clip-0', 'clip-1']);
  assert.equal(cards.flatMap(card => card.variants).length, clips.length);
});

test('an explicit parent cannot group across an unverified gap even if the provider reused its ID', () => {
  const clips = [clip(0), clip(1), clip(20), clip(21)];
  const parent = { startTime: 0, endTime: 110, partnerTrackId: 'person-a',
    sourceRanges: [{ id: 'trail-a', startTime: 0, endTime: 10 },
      { id: 'trail-a', startTime: 100, endTime: 110 }] };
  const cards = buildVerifiedMovementChoices(clips, 'Yürüyüş', 5, parent);
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)), [['clip-0', 'clip-1'], ['clip-20', 'clip-21']]);
  const invalid = clip(3, { sourcePositionId: 'missing-source' });
  assert.deepEqual(buildVerifiedMovementChoices([invalid], 'Yürüyüş', 5, parent), []);
});

test('an earlier source action is not owned solely by a reused scene ID', () => {
  const scene = { id: 'section-a', sourceSceneIds: ['provider-a'], startTime: 100, endTime: 150 };
  for (const adultSceneId of ['section-a', 'provider-a']) {
    assert.equal(findAdultSceneForTimeline([scene], { action: { adultSceneId, startTime: 20, endTime: 30 } }), null);
    assert.equal(findAdultSceneForTimeline([scene], { action: { adultSceneId, startTime: 105, endTime: 115 } }), scene);
  }
});

test('unknown context does not merge independently observed actions on label similarity alone', () => {
  const clips = [clip(0, { sourcePositionId: '' }), clip(1, { sourcePositionId: '' }),
    clip(2, { sourceVerified: false }), clip(3, { loopEndTime: null })];
  assert.deepEqual(groupSourceChoiceCards(clips).map(card => card.variants.map(item => item.id)), [['clip-0'], ['clip-1']]);
});
