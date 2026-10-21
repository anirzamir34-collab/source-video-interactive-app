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
  assert.equal(hair.label, 'Saçını tut', 'cards are named after the grip');
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

test('first full Lust opens 1 position for short videos, 2-3 for videos with many', async () => {
  const { adultFirstUnlockCount } = await import('../public/adult-gameplay.js');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(adultFirstUnlockCount), [1, 1, 1, 2, 2, 3, 3]);
});

test('cards group by where his hands are; moves without a grip share one card when crowded', async () => {
  const { movementGrip } = await import('../public/movement-tempo.js');
  assert.deepEqual(movementGrip('Elini boynuna koyarak ritmik itişleri sürdür'), { key: 'boyun', title: 'Boynunu tut' });
  assert.equal(movementGrip('Karnını ve bacağını tutarak devam et').key, 'karin');
  assert.equal(movementGrip('Temponu artırarak devam et'), null);
  const clipAt = (id, start) => clip(id, start);
  const cards = ['Boynunu kavrayarak hızlan', 'Elini boynuna koyup devam et', 'Bacağını tutarak devam et',
    'Karnına bastırarak devam et', 'Saçını tutarak devam et', 'Göğsünü tutarak devam et', 'Ritmik devam et', 'Temponu koru']
    .map((label, index) => ({ id: `c${index}`, label, sourcePositionId: 'doggy', variants: [clipAt(`v${index}`, index * 12)] }));
  const result = movementCardsWithTempo(cards, { maxCards: 6 });
  assert.equal(result.filter(card => card.label === 'Boynunu tut').length, 1);
  assert.ok(result.some(card => card.label === 'Devam et' && card.variants.length === 2));
  assert.equal(result.flatMap(card => card.variants).length, 8);
});

test('a tempo button is offered only where the next real part changes pace', async () => {
  const { nextTempoPrompt } = await import('../public/movement-tempo.js');
  const part = (id, start, extra = {}) => ({ id, loopStartTime: start, loopEndTime: start + 12, sourceVerified: true, ...extra });
  const steady = part('a', 0), faster = part('b', 12, { movementTempo: 'fast' }), calm = part('c', 24), later = part('d', 60, { movementChange: 'deeper' });
  assert.deepEqual([nextTempoPrompt(steady, [steady, faster, calm]).label, nextTempoPrompt(steady, [steady, faster, calm]).movement.id], ['Hızlan', 'b']);
  assert.equal(nextTempoPrompt(faster, [steady, faster, calm]).label, 'Sakinleş', 'calming down after a hot part');
  assert.equal(nextTempoPrompt(calm, [calm, part('e', 36)]), null, 'just going on offers nothing');
  assert.equal(nextTempoPrompt(calm, [calm, later]), null, 'a far later part is not the next moment');
  assert.equal(nextTempoPrompt(steady, [steady, faster], { sameOccurrence: item => item.id !== 'b' }), null, 'another occurrence never counts');
  assert.equal(nextTempoPrompt(part('x', 0), [part('y', 12, { movementChange: 'harder' })]).label, 'Sertleş');
});
