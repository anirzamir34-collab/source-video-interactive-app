import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInteractionState, advanceInteraction, transitionInteraction, interactionTrace,
  selectVerifiedChoiceQueue, selectInteractionChoice, selectInteractionGroup
} from '../public/interaction-engine.js';
import {
  interactionClipGuard, interactionEntryGuard, interactionMovementVariants, interactionFamilyViews
} from '../public/interaction-timeline.js';
import { groupSourceChoiceCards, sourceDisplayLabel } from '../public/choice-groups.js';
import { neutralInteractionFixture } from './fixtures/interaction-timeline.js';

class FakeSourceVideo {
  constructor(fixture) {
    this.currentTime = 0;
    this.paused = false;
    this.playbackRate = 1;
    this.seeks = [];
    this.runtime = createInteractionState(fixture.scene, { progressBudget: true });
  }

  advance(currentTime) {
    const startTime = this.currentTime;
    this.currentTime = currentTime;
    if (!this.paused && currentTime > startTime) this.runtime = transitionInteraction(this.runtime,
      { type: 'playback', startTime, endTime: currentTime, playing: true });
    this.runtime = transitionInteraction(this.runtime, { type: 'source-time', currentTime });
    return interactionTrace(this.runtime, { overlayCount: 1 });
  }

  seek(currentTime) {
    const rewind = currentTime < this.currentTime;
    this.currentTime = currentTime;
    this.seeks.push(currentTime);
    this.runtime = transitionInteraction(this.runtime, { type: 'source-time', currentTime, rewind });
    return interactionTrace(this.runtime, { overlayCount: 1 });
  }

  queue() {
    return selectVerifiedChoiceQueue(this.runtime.scene.choices.filter(choice => choice.phase === 'APPROACH'), {
      timelineFloor: this.currentTime, firstCoreTime: this.runtime.firstCoreTime,
      activeEndTime: this.runtime.pendingSelection?.endTime, choicePlayCounts: this.runtime.choicePlayCounts,
      castIds: ['performer-left', 'performer-right'], chainId: 'opening-chain', limit: 5
    });
  }
}

test('scripted natural playback advances a neutral opening, refreshes choices, and reveals exact core without repeats or seeks', () => {
  const fixture = neutralInteractionFixture();
  const video = new FakeSourceVideo(fixture);
  assert.equal(video.queue().length, 5);
  assert.deepEqual(video.queue().map(choice => choice.id), ['approach-a', 'approach-b', 'dialogue', 'approach-c', 'approach-d']);
  const first = video.advance(8);
  assert.ok(first.progressionValue > 0 && first.progressionValue < 25);
  assert.equal(first.uniqueApproachCount, 6);
  assert.equal(first.playedUniqueApproachCount, 1);
  assert.ok(!first.remainingApproachIds.includes('dialogue'));
  assert.deepEqual(first.unlockedCoreIds, []);
  const second = video.advance(16);
  assert.ok(second.progressionValue > first.progressionValue);
  assert.equal(second.playedUniqueApproachCount, 2);
  const afterDialogue = video.advance(20);
  assert.equal(afterDialogue.progressionValue, second.progressionValue);
  assert.equal(afterDialogue.playedUniqueApproachCount, 2);
  assert.deepEqual(video.queue().map(choice => choice.id), ['approach-c', 'approach-d', 'approach-e', 'entry-a']);
  for (const time of [28, 36, 42]) video.advance(time);
  assert.ok(video.runtime.progressionValue < 100);
  const boundary = video.advance(44);
  assert.equal(boundary.progressionValue, 100);
  assert.equal(boundary.currentPhase, 'CORE');
  assert.equal(boundary.panelVisible, true);
  assert.equal(boundary.overlayCount, 1);
  assert.deepEqual(boundary.unlockedCoreIds, ['core-a']);
  assert.deepEqual(boundary.visibleCoreIds, ['core-a']);
  assert.equal(boundary.playedUniqueApproachCount, boundary.uniqueApproachCount);
  assert.deepEqual(boundary.remainingApproachIds, []);
  assert.equal(boundary.progressBudget.firstCoreTime, 44);
  assert.equal(boundary.progressBudget.openingDuration, 44);
  assert.equal(boundary.progressBudget.verifiedDuration, 40);
  assert.equal(boundary.progressBudget.verifiedChoiceCount, 6);
  assert.equal(boundary.activeSourceRange.startTime, 44);
  assert.equal(boundary.activeSourceRange.endTime, 76);
  assert.equal(boundary.activeOccurrenceId, 'core-a-visit');
  assert.equal(boundary.lastSeekTarget, null);
  assert.deepEqual(video.runtime.choicePlayCounts, {});
  assert.deepEqual(video.seeks, []);
  assert.equal(video.playbackRate, 1);
});

test('natural interlude preserves core and rewind recomputes opening while earned future core remains clickable', () => {
  const video = new FakeSourceVideo(neutralInteractionFixture());
  video.advance(44);
  const interlude = video.advance(80);
  assert.equal(interlude.currentPhase, 'CORE');
  assert.equal(video.runtime.sourcePhase, 'APPROACH');
  assert.equal(interlude.activeGroupId, 'core-a');
  assert.deepEqual(interlude.unlockedCoreIds, ['core-a']);
  const nextBoundary = video.advance(96);
  assert.deepEqual(nextBoundary.unlockedCoreIds, ['core-a', 'core-b']);
  assert.deepEqual(nextBoundary.visibleCoreIds, ['core-a', 'core-b']);
  assert.equal(nextBoundary.activeGroupId, 'core-b');
  assert.equal(nextBoundary.activeSourceRange.startTime, 96);
  const rewind = video.seek(8);
  assert.equal(rewind.currentPhase, 'APPROACH');
  assert.ok(rewind.progressionValue < 100);
  assert.equal(rewind.activeGroupId, null);
  assert.deepEqual(rewind.unlockedCoreIds, ['core-a', 'core-b']);
  assert.deepEqual(rewind.remainingApproachIds, ['approach-b', 'approach-c', 'approach-d', 'approach-e', 'entry-a']);
  const returned = selectInteractionGroup(video.runtime, 'core-b');
  assert.equal(returned.blockedReason, null);
  assert.equal(returned.target.startTime, 94);
  assert.equal(returned.target.endTime, 96);
  assert.equal(returned.target.sourceOccurrenceId, 'core-b-entry-visit');
  assert.equal(returned.state.activeOccurrenceId, 'core-b-visit');
  assert.equal(returned.state.activeMovementId, null);
  assert.equal(video.currentTime, 8, 'pure selection returns one target and does not seek the fake video');
  const forward = video.seek(97);
  assert.equal(forward.currentPhase, 'CORE');
  assert.equal(forward.activeGroupId, 'core-b');
  assert.equal(forward.activeOccurrenceId, 'core-b-visit');
  assert.equal(forward.panelVisible, true);
  assert.deepEqual(video.seeks, [8, 97]);
});

test('unverified records and tab entry cannot enter movement cards or authorize another occurrence', () => {
  const fixture = neutralInteractionFixture();
  const video = new FakeSourceVideo(fixture);
  assert.equal(selectInteractionChoice(video.runtime, 'unverified-choice').target, null);
  assert.equal(selectInteractionGroup(video.runtime, 'unverified-core').target, null);
  video.advance(96);
  assert.ok(!video.runtime.unlockedGroupIds.includes('unverified-core'));
  const entry = selectInteractionGroup(video.runtime, 'core-b').target;
  assert.equal(interactionEntryGuard(fixture.second, entry).allowed, true);
  assert.equal(interactionClipGuard(fixture.second, entry).allowed, false);
  assert.equal(interactionClipGuard(fixture.first, fixture.invalidMovement).allowed, false);
  const cards = groupSourceChoiceCards([...fixture.first.movements, ...fixture.second.movements], {
    contextFor: movement => movement.sourceOccurrenceId, labelFor: movement => movement.label
  });
  assert.equal(cards.length, 4, 'two verified provider actions in each separate occurrence');
  assert.equal(cards.flatMap(card => card.variants).length, 6);
  assert.ok(cards.every(card => card.variants.every(variant => variant.sourceVerified === true)));
  assert.ok(cards.every(card => new Set(card.variants.map(variant => variant.sourceOccurrenceId)).size === 1));
  assert.ok(cards.every(card => card.label === card.variants[0].label));
  assert.ok(!cards.some(card => card.variants.includes(fixture.invalidMovement)));
  const firstCard = cards.find(card => card.occurrenceId === 'core-a-visit');
  assert.equal(interactionMovementVariants(fixture.first, firstCard, { occurrenceId: 'core-a-visit' }).length, 2);
  assert.deepEqual(interactionMovementVariants(fixture.second, firstCard, { occurrenceId: 'core-b-visit' }), []);
  const families = interactionFamilyViews([fixture.first, fixture.second], { labelFor: group => sourceDisplayLabel(group) });
  assert.equal(families.length, 1);
  assert.equal(families[0].label, 'Provider family Ω');
  assert.deepEqual(families[0].occurrences.map(group => group.id), ['core-a', 'core-b']);
  assert.equal(families[0].sourceRanges, undefined, 'a display family never invents a playable envelope');
});

test('cached interaction index queries two thousand source intervals without rereading provider timestamps', () => {
  const groups = Array.from({ length: 2_000 }, (_, index) => ({
    id: `occurrence-${index}`, phase: 'CORE', sourceVerified: true, occurrenceId: `visit-${index}`,
    sourceRanges: [{ id: `source-${index}`, occurrenceId: `visit-${index}`, sourceVerified: true,
      startTime: index * 4, endTime: index * 4 + 2 }], movements: []
  }));
  let state = createInteractionState({ id: 'large-neutral-timeline', groups, choices: [] });
  for (const group of groups) Object.defineProperties(group.sourceRanges[0], {
    startTime: { get() { throw new Error('provider start timestamp rescanned'); } },
    endTime: { get() { throw new Error('provider end timestamp rescanned'); } }
  });
  for (const index of [1_000, 1_950, 1_999]) {
    state = advanceInteraction(state, index * 4 + 1, { rewind: false });
    assert.equal(state.activeGroupId, `occurrence-${index}`);
    assert.equal(state.activeOccurrenceId, `visit-${index}`);
    assert.equal(state.activeSourceRange.startTime, index * 4);
    assert.equal(state.activeSourceRange.endTime, index * 4 + 2);
  }
  state = advanceInteraction(state, 4_001, { rewind: true });
  assert.equal(state.activeGroupId, 'occurrence-1000');
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.lastSeekTarget, null);
});

test('indexed overlapping records keep deterministic source priority and half-open boundaries', () => {
  const group = (id, phase, startTime, endTime) => ({ id, phase, sourceVerified: true,
    occurrenceId: id, sourceRanges: [{ id, occurrenceId: id, startTime, endTime, sourceVerified: true }] });
  const scene = { id: 'priority', choices: [group('choice', 'APPROACH', 5, 15)], groups: [
    group('first-core', 'CORE', 5, 10), group('second-core', 'CORE', 5, 10),
    group('outcome', 'OUTCOME', 10, 12)
  ] };
  const active = createInteractionState(scene, { currentTime: 6 });
  assert.equal(active.currentPhase, 'CORE');
  assert.equal(active.activeGroupId, 'first-core');
  const boundary = advanceInteraction(active, 10);
  assert.equal(boundary.currentPhase, 'OUTCOME');
  assert.equal(boundary.activeGroupId, 'outcome');
  assert.equal(boundary.activeSourceRange.startTime, 10);
  assert.equal(advanceInteraction(boundary, 12).activeSourceGroupId, 'choice');
});
