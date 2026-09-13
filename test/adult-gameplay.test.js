import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  computeAdultSelectionDelta,
  computeWarmupSelectionDelta,
  isOutcomeUnlocked,
  monotonicAdultPhase,
  normalizeOutcomeUnlockProgress,
  pickNextVariant,
  positionUnlockProgress,
  requiredWarmupDiscoveries
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
  assert.equal(positionUnlockProgress({ categoryId: 'anal', index: 0 }), 72);
  assert.equal(positionUnlockProgress({ categoryId: 'vaginal', bootstrap: true }), 0);
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

test('outcomes unlock only after the configured verified-scene progress threshold', () => {
  const outcome = { unlockProgress: 82 };
  assert.equal(isOutcomeUnlocked(outcome, 90, 74), true);
  assert.equal(isOutcomeUnlocked(outcome, 80, 70), false);
  assert.equal(normalizeOutcomeUnlockProgress(10), 60);
  assert.equal(normalizeOutcomeUnlockProgress(150), 100);
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
