import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInteractionState, createInteractionProgressBudget, computeInteractionProgress,
  observeInteractionPlayback, completeInteractionSelection, transitionInteraction,
  normalizeInteractionRuntime, selectVerifiedChoiceQueue, selectInteractionChoice,
  selectInteractionGroup, advanceInteraction
} from '../public/interaction-engine.js';

const range = (id, startTime, endTime, occurrenceId = id) => ({
  id, startTime, endTime, occurrenceId, sourceVerified: true
});
const row = (id, startTime, endTime, overrides = {}) => ({
  id, phase: 'APPROACH', sourceVerified: true, occurrenceId: `${id}-occurrence`,
  sourceRanges: [range(`${id}-source`, startTime, endTime, `${id}-occurrence`)], ...overrides
});
const opening = (overrides = {}) => ({
  id: 'opaque-scene', choices: [row('a', 0, 30), row('b', 30, 60), row('c', 60, 180)],
  groups: [row('next', 180, 210, { phase: 'CORE' })], ...overrides
});
const budgetState = scene => createInteractionState(scene, { progressBudget: true });

test('budget duration is the union of verified opening ranges before first core', () => {
  const budget = createInteractionProgressBudget(opening({ choices: [
    row('first', 0, 20), row('overlap', 10, 30), row('duplicate', 0, 20),
    row('disabled', 40, 60, { progressionEnabled: false }),
    row('unverified', 60, 90, { sourceVerified: false }), row('later', 250, 300)
  ] }));
  assert.equal(budget.verifiedDuration, 30);
  assert.equal(budget.firstCoreTime, 180);
  assert.equal(budget.openingDuration, 180);
  assert.deepEqual(budget.intervals, [{ startTime: 0, endTime: 30 }]);
});

test('actual natural playback increases progress with no selection and repeated coverage earns nothing', () => {
  let state = budgetState(opening());
  state = observeInteractionPlayback(state, { startTime: 0, endTime: 30 });
  assert.ok(state.progressionValue > 0 && state.progressionValue < 25);
  const initial = state.progressionValue;
  state = observeInteractionPlayback(state, { startTime: 0, endTime: 30 });
  assert.equal(state.progressionValue, initial);
  assert.deepEqual(state.choicePlayCounts, {});
  state = observeInteractionPlayback(state, { startTime: 20, endTime: 40 });
  assert.equal(computeInteractionProgress(state.progressBudget, state.progressObservations).playedDuration, 40);
  assert.ok(state.progressionValue > initial);
});

test('a long opening cannot fill from its first short clips and a verified boundary opens independently', () => {
  let state = budgetState(opening({ choices: [row('first', 0, 10), row('second', 10, 20)],
    groups: [row('next', 300, 330, { phase: 'CORE' })] }));
  state = observeInteractionPlayback(state, { startTime: 0, endTime: 20 });
  state = completeInteractionSelection(state, 'first');
  state = completeInteractionSelection(state, 'second');
  assert.ok(state.progressionValue < 10);
  assert.deepEqual(state.unlockedGroupIds, []);
  const before = state.currentTime;
  state = transitionInteraction(state, { type: 'source-time', currentTime: 301 });
  assert.equal(state.progressionValue, 100);
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.activeGroupId, 'next');
  assert.equal(state.activeSourceRange.startTime, 300);
  assert.deepEqual(state.unlockedGroupIds, ['next']);
  assert.equal(state.lastSeekTarget, null);
  assert.equal(before, 0);
});

test('selection requests and rejected or sought playback earn no budget credit', () => {
  const state = budgetState(opening());
  const requested = selectInteractionChoice(state, 'a').state;
  assert.equal(requested.progressionValue, 0);
  assert.equal(observeInteractionPlayback(requested, { startTime: 0, endTime: 30, playing: false }), requested);
  assert.equal(observeInteractionPlayback(requested, { startTime: 0, endTime: 30, seek: true }), requested);
  assert.equal(completeInteractionSelection(requested, 'a', { startTime: 0, endTime: 10 }), requested);
  assert.equal(completeInteractionSelection(requested, 'a', { playing: false }), requested);
});

test('completed selection contributes at most once for the same source coverage', () => {
  const initial = budgetState(opening());
  const once = completeInteractionSelection(initial, 'a', { startTime: 0, endTime: 30 });
  const repeat = completeInteractionSelection(once, 'a', { startTime: 0, endTime: 30 });
  assert.ok(once.progressionValue > 0);
  assert.equal(repeat.progressionValue, once.progressionValue);
  assert.equal(repeat.choicePlayCounts.a, 2);
  const duplicateScene = opening({ choices: [row('a', 0, 30), row('alias', 0, 30)] });
  const duplicateOnce = completeInteractionSelection(budgetState(duplicateScene), 'a');
  const duplicateTwice = completeInteractionSelection(duplicateOnce, 'alias');
  assert.equal(duplicateTwice.progressionValue, duplicateOnce.progressionValue);
});

test('disabled dialogue cannot grant progress through an overlapping approach group', () => {
  const data = opening({ choices: [row('dialogue', 0, 20, { progressionEnabled: false }), row('a', 20, 40)],
    groups: [row('opening-group', 0, 40), row('next', 60, 90, { phase: 'CORE' })] });
  const state = budgetState(data);
  assert.equal(state.progressBudget.verifiedDuration, 20);
  assert.equal(observeInteractionPlayback(state, { startTime: 0, endTime: 20 }), state);
  assert.equal(completeInteractionSelection(state, 'dialogue'), state);
  assert.ok(observeInteractionPlayback(state, { startTime: 20, endTime: 40 }).progressionValue > 0);
});

test('coverage credits source identity and exact intervals, excluding gaps and forged occurrences', () => {
  const budget = createInteractionProgressBudget(opening({ choices: [row('a', 0, 10), row('b', 20, 30)] }));
  const measured = computeInteractionProgress(budget, { playedRanges: [{ startTime: -10, endTime: 40 }] });
  assert.equal(measured.playedDuration, 20);
  assert.equal(computeInteractionProgress(budget, { playedRanges: [{ startTime: 0, endTime: 30,
    sourcePositionId: 'a-source', sourceOccurrenceId: 'forged' }] }).playedDuration, 0);
  assert.equal(computeInteractionProgress(budget, { playedRanges: [{ startTime: 0, endTime: 30,
    sourcePositionId: 'a-source', sourceOccurrenceId: 'a-occurrence' }] }).playedDuration, 10);
});

test('opening budget is consumed once and cannot refill the next group gate', () => {
  let state = budgetState(opening({ groups: [row('next', 180, 210, { phase: 'CORE' }),
    row('later', 250, 280, { phase: 'CORE' })] }));
  state = observeInteractionPlayback(state, { startTime: 0, endTime: 180 });
  assert.equal(state.progressionValue, 99);
  state = transitionInteraction(state, { type: 'source-time', currentTime: 180 });
  assert.equal(state.progressBudgetConsumed, true);
  state = transitionInteraction(state, { type: 'progress', value: 0 });
  assert.equal(observeInteractionPlayback(state, { startTime: 0, endTime: 180 }), state);
  assert.equal(completeInteractionSelection(state, 'a'), state);
  assert.equal(transitionInteraction(state, { type: 'source-time', currentTime: 181 }).progressionValue, 0);
  assert.deepEqual(state.unlockedGroupIds, ['next']);
});

test('full progress repairs a stale approach phase and hidden panel without seeking', () => {
  const initial = budgetState(opening());
  const repaired = normalizeInteractionRuntime({ ...initial, progressionValue: 100,
    unlockedGroupIds: ['next'], currentPhase: 'APPROACH', phaseOverride: 'APPROACH', panelVisible: false });
  assert.equal(repaired.currentPhase, 'CORE');
  assert.equal(repaired.panelVisible, true);
  assert.equal(repaired.activeGroupId, null);
  assert.equal(repaired.lastSeekTarget, null);
  assert.equal(normalizeInteractionRuntime({ ...repaired, currentPhase: 'OUTCOME',
    sourcePhase: 'APPROACH', outcomePhase: 'idle' }).currentPhase, 'CORE');
});

test('verified post-core approach is an interlude and explicit rewind recomputes the opening', () => {
  const data = opening({ groups: [row('next', 180, 210, { phase: 'CORE' }), row('interlude', 220, 230)] });
  let state = transitionInteraction(budgetState(data), { type: 'source-time', currentTime: 185 });
  state = transitionInteraction(state, { type: 'source-time', currentTime: 225 });
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.sourcePhase, 'APPROACH');
  assert.equal(state.activeGroupId, 'next');
  assert.equal(state.activeSourceGroupId, 'interlude');
  state = transitionInteraction(state, { type: 'source-time', currentTime: 0, rewind: true });
  assert.equal(state.currentPhase, 'APPROACH');
  assert.equal(state.progressionValue, 0);
  assert.deepEqual(state.unlockedGroupIds, ['next']);
  assert.equal(selectInteractionGroup(state, 'next').blockedReason, null);
});

test('native backward observations preserve core while explicit rewinds reset source context', () => {
  const current = transitionInteraction(budgetState(opening()), { type: 'source-time', currentTime: 185 });
  assert.equal(transitionInteraction(current, { type: 'source-time', currentTime: 5 }).currentPhase, 'CORE');
  assert.equal(advanceInteraction(current, 5).currentPhase, 'APPROACH');
});

test('terminal phases require their verified source observation', () => {
  const data = opening({ groups: [row('next', 180, 210, { phase: 'CORE' }),
    row('terminal', 210, 215, { phase: 'OUTCOME' })] });
  let state = transitionInteraction(budgetState(data), { type: 'progress', value: 100 });
  assert.equal(selectInteractionGroup(state, 'terminal').state.currentPhase, 'CORE');
  state = transitionInteraction(state, { type: 'source-time', currentTime: 212 });
  assert.equal(state.currentPhase, 'OUTCOME');
  assert.equal(normalizeInteractionRuntime(state).currentPhase, 'OUTCOME');
});

const queueRow = (id, startTime, endTime, overrides = {}) => ({
  id, startTime, endTime, sourceVerified: true, castIds: ['actor-a', 'actor-b'], chainId: 'chain-a', ...overrides
});
test('queue discovers five successive verified choices beyond a short fixed window', () => {
  const rows = Array.from({ length: 6 }, (_, index) => queueRow(`choice-${index}`, index * 4, index * 4 + 3));
  const queue = selectVerifiedChoiceQueue(rows, { timelineFloor: 0, maxForwardSeconds: 60, limit: 5 });
  assert.deepEqual(queue.map(item => item.id), ['choice-0', 'choice-1', 'choice-2', 'choice-3', 'choice-4']);
  assert.equal(queue[0], rows[0]);
});

test('queue ranks fresh choices ahead of repeats without exposing a cast or chain discontinuity', () => {
  const rows = [queueRow('repeat', 0, 5, { playCount: 10 }), queueRow('fresh-a', 6, 10),
    queueRow('fresh-b', 11, 15), queueRow('other-cast', 16, 20, { castIds: ['actor-c'] }),
    queueRow('too-far-after-gap', 25, 30), queueRow('other-chain', 16, 20, { chainId: 'chain-b' })];
  assert.deepEqual(selectVerifiedChoiceQueue(rows).map(item => item.id), ['fresh-a', 'fresh-b', 'repeat']);
});

test('queue respects first core, verified continuity, unique source ranges and maximum forward safety', () => {
  const observed = range('provider', 0, 5, 'occurrence');
  const rows = [queueRow('first', 0, 5, { sourceRanges: [observed] }),
    queueRow('duplicate', 0, 5, { sourceRanges: [observed] }), queueRow('next', 6, 10),
    queueRow('core-or-later', 11, 15), queueRow('unverified-bridge', 10, 250, { sourceVerified: false }),
    queueRow('distant', 251, 260)];
  assert.deepEqual(selectVerifiedChoiceQueue(rows, { firstCoreTime: 11, maxForwardSeconds: 1000,
    activeEndTime: 250 }).map(item => item.id), ['first', 'next']);
  assert.deepEqual(selectVerifiedChoiceQueue([queueRow('long', 0, 300), queueRow('distant', 301, 310)],
    { activeEndTime: 300, maxForwardSeconds: 1000 }).map(item => item.id), ['long']);
});

test('approach selection keeps a discontinuous provider return in its own occurrence', () => {
  const data = opening({ choices: [row('return', 0, 5, { sourceRanges: [
    range('same-provider', 0, 5, 'first'), range('same-provider', 20, 25, 'return')], occurrenceId: 'logical' })] });
  const state = advanceInteraction(budgetState(data), 21);
  const selected = selectInteractionChoice(state, 'return', { occurrenceId: 'return' });
  assert.equal(selected.target?.startTime, 20);
  assert.equal(selected.target?.endTime, 25);
  assert.equal(selected.target?.sourceOccurrenceId, 'return');
  assert.equal(selected.state.activeOccurrenceId, 'return');
  assert.equal(selectInteractionChoice(state, 'return', { occurrenceId: 'forged' }).target, null);
});
