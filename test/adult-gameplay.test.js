import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  computeAdultSelectionDelta,
  expandVerifiedMovementVariants,
  computeWarmupSelectionDelta,
  isOutcomeUnlocked,
  groupVerifiedMovementsByTempo,
  MIN_CORE_PLAY_SECONDS_FOR_OUTCOME,
  monotonicAdultPhase,
  normalizeOutcomeUnlockProgress,
  pickNextVariant,
  positionUnlockProgress,
  requiredCorePlaySecondsForOutcome,
  requiredWarmupDiscoveries,
  nearestAvailableTempo,
  tapRhythm
} from '../public/adult-gameplay.js';

test('averageAdultProgress clamps both values and averages them', () => {
  assert.equal(averageAdultProgress(120, -10), 50);
  assert.equal(averageAdultProgress(80, 60), 70);
});

test('selection progress rewards novelty and reduces repeated farming', () => {
  const novel = computeAdultSelectionDelta({
    repeatCount: 0,
    positionNew: true,
    positionChanged: true,
    movementNew: true,
    comboCount: 2,
    maleRate: 1,
    femaleRate: 1
  });
  const repeated = computeAdultSelectionDelta({
    repeatCount: 4,
    positionNew: false,
    positionChanged: false,
    movementNew: false,
    comboCount: 0,
    maleRate: 1,
    femaleRate: 1
  });

  assert.ok(novel.male > repeated.male);
  assert.ok(novel.female > repeated.female);
  assert.ok(repeated.male >= 0.75);
});

test('warmup progress can build lust but repeated farming loses value', () => {
  const first = computeWarmupSelectionDelta({ repeatCount: 0, comboCount: 2 });
  const repeated = computeWarmupSelectionDelta({ repeatCount: 5, comboCount: 0 });
  assert.ok(first.male > repeated.male);
  assert.ok(first.female > repeated.female);
});

test('position unlocks are progressive and special categories arrive later', () => {
  assert.equal(positionUnlockProgress({ categoryId: 'oral', index: 3 }), 0);
  assert.equal(positionUnlockProgress({ categoryId: 'vaginal', index: 0 }), 35);
  assert.equal(positionUnlockProgress({ categoryId: 'vaginal', index: 1 }), 47);
  assert.equal(positionUnlockProgress({ categoryId: 'anal', index: 0 }), 78);
  assert.equal(positionUnlockProgress({ categoryId: 'vaginal', bootstrap: true }), 0);
});

test('outcome pacing scales with scene length and remains deliberately slow', () => {
  assert.equal(requiredCorePlaySecondsForOutcome(60), 75);
  assert.equal(requiredCorePlaySecondsForOutcome(480), 297.6);
  assert.equal(requiredCorePlaySecondsForOutcome(1000), 300);
});

test('long verified position becomes four playable variants of at least ten seconds', () => {
  const variants = expandVerifiedMovementVariants([
    { id: 'doggy-long', label: 'Doggy-style ritmi', loopStartTime: 120, loopEndTime: 300 }
  ], 120, 300);
  assert.equal(variants.length, 4);
  assert.ok(variants.every(item => item.loopEndTime - item.loopStartTime >= 10));
  assert.deepEqual(variants.map(item => item.loopStartTime), [120, 165, 210, 255]);
});

test('discovery phase moves from warmup to positions, rewards, then final', () => {
  assert.equal(adultDiscoveryPhase({ flow: 18 }), 'foreplay');
  assert.equal(adultDiscoveryPhase({ flow: 40, hasCoreUnlocked: true }), 'positions');
  assert.equal(adultDiscoveryPhase({ flow: 74, hasBonusUnlocked: true }), 'reward');
  assert.equal(adultDiscoveryPhase({ flow: 85, hasOutcomeUnlocked: true }), 'final');
});

test('pickNextVariant avoids the active variant and prefers least-played real segment', () => {
  const variants = [
    { id: 'a', loopStartTime: 10, loopEndTime: 22 },
    { id: 'b', loopStartTime: 30, loopEndTime: 45 },
    { id: 'c', loopStartTime: 50, loopEndTime: 65 }
  ];
  const counts = new Map([['a', 0], ['b', 3], ['c', 1]]);
  assert.equal(pickNextVariant(variants, 'a', counts)?.id, 'c');
  assert.equal(pickNextVariant([variants[0]], 'a', counts)?.id, 'a');
});

test('tap rhythm reacts to slow, moderate and fast touch cadence', () => {
  assert.equal(tapRhythm([0, 700, 1400], 1400).tempo, 'slow');
  assert.equal(tapRhythm([0, 1500, 3000], 3000).tempo, 'slow');
  assert.equal(tapRhythm([0, 350, 700, 1050], 1050).tempo, 'moderate');
  assert.equal(tapRhythm([0, 180, 360, 540], 540).tempo, 'fast');
  assert.equal(tapRhythm([100], 100).tempo, 'unclear');
});

test('rhythm control uses only source-verified explicitly classified variants', () => {
  const groups = groupVerifiedMovementsByTempo([
    { id: 'slow', movementTempo: 'slow', sourceVerified: true, loopStartTime: 0, loopEndTime: 12 },
    { id: 'fast', movementTempo: 'fast', sourceVerified: true, loopStartTime: 20, loopEndTime: 35 },
    { id: 'invented', movementTempo: 'moderate', sourceVerified: false, loopStartTime: 40, loopEndTime: 55 }
  ]);
  assert.deepEqual(groups.slow.map(item => item.id), ['slow']);
  assert.deepEqual(groups.moderate, []);
  assert.deepEqual(groups.fast.map(item => item.id), ['fast']);
  assert.equal(nearestAvailableTempo('moderate', groups), 'slow');
});

test('outcomes unlock only after the configured verified-scene progress threshold', () => {
  const outcome = { unlockProgress: 82 };
  assert.equal(isOutcomeUnlocked(outcome, 90, 74), true);
  assert.equal(isOutcomeUnlocked(outcome, 80, 70), false);
  assert.equal(normalizeOutcomeUnlockProgress(10), 60);
  assert.equal(normalizeOutcomeUnlockProgress(150), 100);
});

test('final cannot unlock from Lust alone before real core-position play', () => {
  const outcome = { unlockProgress: 82 };
  assert.equal(canUnlockOutcome({
    outcome,
    climaxProgress: 100,
    coreVisitedCount: 0,
    corePlaySeconds: 999
  }), false);
  assert.equal(canUnlockOutcome({
    outcome,
    climaxProgress: 100,
    coreVisitedCount: 1,
    corePlaySeconds: MIN_CORE_PLAY_SECONDS_FOR_OUTCOME - 0.1
  }), false);
  assert.equal(canUnlockOutcome({
    outcome,
    climaxProgress: 81,
    coreVisitedCount: 1,
    corePlaySeconds: MIN_CORE_PLAY_SECONDS_FOR_OUTCOME + 5
  }), false);
  assert.equal(canUnlockOutcome({
    outcome,
    climaxProgress: 82,
    coreVisitedCount: 1,
    corePlaySeconds: MIN_CORE_PLAY_SECONDS_FOR_OUTCOME
  }), true);
});

test('core positions wait for both Lust and enough unique warm-up discovery', () => {
  assert.equal(requiredWarmupDiscoveries(8), 6);
  assert.equal(canUnlockCorePositions({ flow: 50, warmupTotal: 8, warmupUniquePlayed: 5 }), false);
  assert.equal(canUnlockCorePositions({ flow: 34, warmupTotal: 8, warmupUniquePlayed: 8 }), false);
  assert.equal(canUnlockCorePositions({ flow: 50, warmupTotal: 8, warmupUniquePlayed: 6 }), true);
  assert.equal(canUnlockCorePositions({ flow: 0, warmupTotal: 0, warmupUniquePlayed: 0 }), true);
});

test('bonus positions require reward-level Lust and at least one core visit when core positions exist', () => {
  assert.equal(canUnlockBonusPositions({ flow: 80, coreVisitedCount: 0, corePositionCount: 3 }), false);
  assert.equal(canUnlockBonusPositions({ flow: 71, coreVisitedCount: 2, corePositionCount: 3 }), false);
  assert.equal(canUnlockBonusPositions({ flow: 80, coreVisitedCount: 1, corePositionCount: 3 }), true);
  assert.equal(canUnlockBonusPositions({ flow: 0, coreVisitedCount: 0, corePositionCount: 0, bootstrap: true }), true);
});

test('discovery phases are content-driven and never regress once a later phase was reached', () => {
  assert.equal(adultDiscoveryPhase({ flow: 99 }), 'foreplay');
  assert.equal(adultDiscoveryPhase({ hasCoreUnlocked: true }), 'positions');
  assert.equal(adultDiscoveryPhase({ hasCoreUnlocked: true, hasBonusUnlocked: true }), 'reward');
  assert.equal(monotonicAdultPhase('foreplay', 'positions'), 'positions');
  assert.equal(monotonicAdultPhase('positions', 'reward'), 'reward');
});
