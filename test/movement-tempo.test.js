import test from 'node:test';
import assert from 'node:assert/strict';
import { movementFlavor, movementBaseKey, mergeSameMovementCards, attachTempoOptions, movementCardsWithTempo } from '../public/movement-tempo.js';

const clip = (id, start, extra = {}) => ({ id, loopStartTime: start, loopEndTime: start + 12, sourceVerified: true,
  sourcePositionId: 'doggy', positionOccurrenceId: 'occ-1', ...extra });

test('flavor follows the reported change first, then tempo and wording', () => {
  assert.equal(movementFlavor({ movementChange: 'deeper', movementTempo: 'fast' }), 'deep');
  assert.equal(movementFlavor({ movementTempo: 'fast' }), 'fast');
  assert.equal(movementFlavor({ label: 'Daha sert devam et' }), 'hard');
  assert.equal(movementFlavor({ movementTempo: 'moderate', label: 'Saçını tutarak devam et' }), 'steady');
});

test('pace words do not make a different movement', () => {
  assert.equal(movementBaseKey('Saçını tutarak devam et'), movementBaseKey('Saçını tutarak hızlan'));
  assert.notEqual(movementBaseKey('Saçını tutarak devam et'), movementBaseKey('Kalçasını kavrayarak devam et'));
});

test('one movement card gets tempo buttons only for paces the video really has', () => {
  const cards = [
    { id: 'a', label: 'Saçını tutarak devam et', sourcePositionId: 'doggy', variants: [clip('s1', 0), clip('s2', 12)] },
    { id: 'b', label: 'Saçını tutarak hızlan', sourcePositionId: 'doggy', variants: [clip('f1', 24, { movementTempo: 'fast' })] },
    { id: 'c', label: 'Kalçasını kavrayarak devam et', sourcePositionId: 'doggy', variants: [clip('k1', 36)] }
  ];
  const result = movementCardsWithTempo(cards);
  assert.equal(result.length, 2);
  const hair = result[0];
  assert.equal(hair.label, 'Saçını tutarak devam et');
  assert.deepEqual(hair.baseVariants.map(item => item.id), ['s1', 's2']);
  assert.deepEqual(hair.tempoOptions.map(option => [option.label, option.variants.map(item => item.id)]), [['Hızlan', ['f1']]]);
  assert.deepEqual(result[1].tempoOptions, [], 'no pace change in the video, no tempo button');
});

test('the same movement in another position or occurrence stays a separate card', () => {
  const cards = [
    { id: 'a', label: 'Devam et yavaşça', sourcePositionId: 'doggy', variants: [clip('a1', 0)] },
    { id: 'b', label: 'Devam et yavaşça', sourcePositionId: 'doggy', variants: [clip('b1', 100, { positionOccurrenceId: 'occ-2' })] }
  ];
  assert.equal(mergeSameMovementCards(cards).length, 2);
  assert.deepEqual(attachTempoOptions({ variants: [] }).tempoOptions, []);
});
