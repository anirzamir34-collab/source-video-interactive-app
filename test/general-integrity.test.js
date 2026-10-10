import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourceChoiceCards } from '../public/choice-groups.js';
import { choiceSurfaceForAction } from '../public/choice-routing.js';
import { createInteractionState, completeInteractionSelection, switchInteractionScene } from '../public/interaction-engine.js';

const clip = { id: 'source-1', sourceVerified: true, startTime: 0, endTime: 10,
  choiceSurface: 'story', actionType: 'dialogue', subjectTrackId: 'actor-a', label: 'Konuşmayı dinle' };
const variants = rows => groupSourceChoiceCards(rows).flatMap(card => card.variants);

test('exact record deduplication preserves different actors, categories, routes and source origins', () => {
  for (const change of [
    { subjectTrackId: 'actor-b' }, { partnerTrackId: 'actor-c' }, { primaryCharacterId: 'actor-c' },
    { choiceSurface: 'other-surface' }, { routeNamespace: 'different-route' },
    { sourceActionId: 'another-observation' }, { involvedCharacterIds: ['actor-c'] },
    { actionType: 'story' }
  ]) {
    const other = { ...clip, ...change };
    assert.deepEqual(variants([clip, { ...clip }, other, { ...other }]), [clip, other]);
  }
  const later = { ...clip, startTime: 30, endTime: 40 };
  assert.deepEqual(variants([clip, later]).map(row => row.startTime), [0, 30]);
});

test('participant ordering alone does not manufacture a new source record', () => {
  const first = { ...clip, participantTrackIds: ['actor-a', 'actor-b'] };
  assert.equal(variants([first, { ...first, participantTrackIds: ['actor-b', 'actor-a'] }]).length, 1);
});

test('ordinary dialogue ignores stale parent metadata and retains the verified source range', () => {
  const spoken = { ...clip, label: 'Seks yapalım mı diye sor', adultScene: true, outcomeType: 'climax' };
  assert.equal(choiceSurfaceForAction(spoken, { panelFamily: 'inherited-parent' }), 'story');
  assert.deepEqual([spoken.startTime, spoken.endTime], [0, 10]);
  assert.equal(choiceSurfaceForAction({ ...spoken, sourceVerified: false }), 'unverified');
});

const row = (id, startTime, endTime, phase = 'APPROACH') => ({
  id, phase, sourceVerified: true, sourceRanges: [{ id: `${id}-source`, occurrenceId: `${id}-occurrence`,
    startTime, endTime, sourceVerified: true }]
});
const scene = { id: 'training-video', choices: [row('a', 0, 10), row('b', 20, 30), row('c', 40, 50)],
  groups: [row('next-chapter', 80, 100, 'CORE')] };

test('all six generic selection orders unlock the next chapter without consuming the intervening gap', () => {
  for (const order of [['a','b','c'], ['a','c','b'], ['b','a','c'], ['b','c','a'], ['c','a','b'], ['c','b','a']]) {
    let state = createInteractionState(scene, { progressBudget: true });
    const rejected = completeInteractionSelection(state, order[0], { playing: false });
    assert.equal(rejected.progressionValue, 0);
    for (const id of order) {
      state = completeInteractionSelection(state, id);
      const before = state.progressionValue;
      state = completeInteractionSelection(state, id);
      assert.equal(state.progressionValue, before, 'repeated source coverage cannot add points');
    }
    assert.equal(state.progressionValue, 100);
    assert.deepEqual(state.unlockedGroupIds, ['next-chapter']);
    const next = switchInteractionScene(state, { ...scene, id: 'different-source' }, 0, { progressBudget: true });
    assert.equal(next.progressionValue, 0);
    assert.deepEqual(next.unlockedGroupIds, []);
  }
});
