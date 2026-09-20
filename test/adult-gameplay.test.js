import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adultPositionFamily,
  assignAdultSceneOccurrenceIds,
  adultPlaybackProgressDelta,
  verifiedAdultPositionFamily,
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  buildVerifiedMovementChoices,
  summarizeMovementChoiceCoverage,
  consolidateVerifiedPositions,
  computeAdultSelectionDelta,
  dedupeVerifiedTimelineActions,
  expandVerifiedMovementVariants,
  computeWarmupSelectionDelta,
  findAdultSceneForTimeline,
  isOutcomeUnlocked,
  groupVerifiedMovementsByTempo,
  initialWarmupBeforeFirstPosition,
  selectSequentialApproachChoices,
  movementsForPositionOccurrence,
  isEnergeticSexMoment,
  isPlayableVerifiedPositionDuration,
  FEMALE_ORGASM_CYCLE_SECONDS,
  MALE_ORGASM_CYCLE_SECONDS,
  MIN_CORE_PLAY_SECONDS_FOR_OUTCOME,
  monotonicAdultPhase,
  maleOrgasmPlaybackMultiplier,
  movementBelongsToVerifiedPosition,
  normalizeOutcomeUnlockProgress,
  playbackRateForTapTempo,
  pickNearbyRhythmVariant,
  pickNextChronologicalVariant,
  pickNextVariant,
  positionUnlockProgress,
  requiredCorePlaySecondsForOutcome,
  requiredWarmupDiscoveries,
  resolveVerifiedAdultPosition,
  shouldAdvanceMaleOrgasm,
  summarizeAdultSceneGraph,
  nearestAvailableTempo,
  positionOccurrenceGroups,
  positionOccurrenceForMovement,
  tapRhythm,
  verifiedPartnerTransition
} from '../public/adult-gameplay.js';

test('averageAdultProgress clamps both values and averages them', () => {
  assert.equal(averageAdultProgress(120, -10), 50);
  assert.equal(averageAdultProgress(80, 60), 70);
});

test('short source-verified positions remain playable without accepting flashes', () => {
  assert.equal(isPlayableVerifiedPositionDuration(20, 23), true);
  assert.equal(isPlayableVerifiedPositionDuration(20, 22.99), false);
  assert.equal(isPlayableVerifiedPositionDuration('bad', 30), false);
});

test('approach choices advance through verified source chronology instead of staying on the first cards', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    kind: 'foreplay', id: `warmup-${index + 1}`, label: `Warmup ${index + 1}`,
    startTime: index * 10, endTime: index * 10 + 8, playCount: index === 2 ? 1 : 0
  }));

  assert.deepEqual(
    selectSequentialApproachChoices(candidates, { timelineFloor: 0, limit: 5 }).map(item => item.id),
    ['warmup-1', 'warmup-2', 'warmup-4', 'warmup-5', 'warmup-6']
  );
  assert.deepEqual(
    selectSequentialApproachChoices(candidates, { timelineFloor: 28, limit: 5 }).map(item => item.id),
    ['warmup-4', 'warmup-5', 'warmup-6', 'warmup-7', 'warmup-8']
  );
});

test('lust and orgasm progression remains bounded and uses balanced cycle lengths', () => {
  const delta = adultPlaybackProgressDelta({ elapsed: 0.25, maleRate: 1, femaleRate: 1 });
  assert.ok(delta.lust < 0.06);
  assert.ok(delta.maleOrgasm > 0);
  assert.ok(delta.femaleOrgasm > 0);
  assert.ok(FEMALE_ORGASM_CYCLE_SECONDS >= 150);
  assert.ok(MALE_ORGASM_CYCLE_SECONDS >= 140);
  assert.ok(MALE_ORGASM_CYCLE_SECONDS <= 190);

  const warmup = adultPlaybackProgressDelta({ elapsed: 0.25, warmup: true });
  assert.equal(warmup.maleOrgasm, 0);
  assert.equal(warmup.femaleOrgasm, 0);
  assert.equal(shouldAdvanceMaleOrgasm(34.9, 0), false);
  assert.equal(shouldAdvanceMaleOrgasm(35, 0), true);
  assert.equal(shouldAdvanceMaleOrgasm(0, 1), true);
});

test('male orgasm starts around the middle and follows verified movement intensity', () => {
  const base = {
    requiredCorePlaySeconds: 100,
    coreVisitedCount: 1,
    maleRate: 1
  };
  assert.equal(maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 25, movementTempo: 'moderate'
  }), 0);
  assert.ok(maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 43, movementTempo: 'moderate'
  }) > 0);
  assert.ok(maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 38, movementTempo: 'fast'
  }) > 0);
  assert.equal(maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 38, movementTempo: 'slow'
  }), 0);

  const slow = maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 60, movementTempo: 'slow'
  });
  const moderate = maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 60, movementTempo: 'moderate'
  });
  const fast = maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 60, movementTempo: 'fast'
  });
  assert.ok(slow < moderate);
  assert.ok(moderate < fast);
  assert.ok(slow >= 0.7);
  assert.ok(fast <= 1.45);
  assert.equal(maleOrgasmPlaybackMultiplier({
    ...base, corePlaySeconds: 100, coreVisitedCount: 0, movementTempo: 'fast'
  }), 0);
});

test('adult graph report exposes duplicate family tabs and movement variants', () => {
  const report = summarizeAdultSceneGraph([{
    id: 'scene-a', startTime: 100, endTime: 180,
    positions: [
      {
        id: 'reverse-a', familyId: 'reverse-cowgirl', occurrenceId: 'occ-a',
        label: 'Ters Kovboy', startTime: 120, endTime: 140,
        sourcePositionIds: ['raw-a'], movements: [{ id: 'm1' }],
        movementChoices: [{ id: 'c1', label: 'Ritmi sürdür', variants: [{ id: 'm1', loopStartTime: 121, loopEndTime: 130 }] }]
      },
      {
        id: 'reverse-b', familyId: 'reverse-cowgirl', occurrenceId: 'occ-b',
        label: 'Ters Kovboy', startTime: 145, endTime: 170,
        sourcePositionIds: ['raw-b'], movements: [{ id: 'm2' }, { id: 'm3' }],
        movementChoices: [{ id: 'c2', label: 'Hızlı hareket', variants: [{ id: 'm2' }, { id: 'm3' }] }]
      }
    ]
  }]);

  assert.equal(report.positionCount, 2);
  assert.equal(report.movementCount, 3);
  assert.equal(report.duplicateFamilies.length, 1);
  assert.equal(report.duplicateFamilies[0].familyId, 'reverse-cowgirl');
  assert.equal(report.scenes[0].positions[1].movementChoices[0].variantCount, 2);
});

test('same verified family returns merge into one tab across the encounter', () => {
  const positions = consolidateVerifiedPositions([
    {
      id: 'missionary-a', familyId: 'missionary', progressionRole: 'core',
      partnerTrackId: 'PARTNER_A', startTime: 100, endTime: 120,
      movements: [{ id: 'm-a', sourceVerified: true, loopStartTime: 100, loopEndTime: 120 }]
    },
    {
      id: 'missionary-b', familyId: 'missionary', progressionRole: 'core',
      partnerTrackId: 'PARTNER_A', startTime: 300, endTime: 330,
      movements: [{ id: 'm-b', sourceVerified: true, loopStartTime: 300, loopEndTime: 330 }]
    }
  ], { mergeDistantReturns: true });

  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0].movements.map(item => item.id), ['m-a', 'm-b']);
  assert.equal(positions[0].sourceRanges.length, 2);
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
  assert.ok(repeated.male >= 0.4);
});

test('warmup progress can build lust but repeated farming loses value', () => {
  const first = computeWarmupSelectionDelta({ repeatCount: 0, comboCount: 2 });
  const repeated = computeWarmupSelectionDelta({ repeatCount: 5, comboCount: 0 });
  assert.ok(first.male > repeated.male);
  assert.ok(first.female > repeated.female);
});

test('verified source pacing controls how quickly warmup progress grows', () => {
  const calm = computeWarmupSelectionDelta({ repeatCount: 0, femaleRate: 0.45 });
  const neutral = computeWarmupSelectionDelta({ repeatCount: 0, femaleRate: 1 });
  const energetic = computeWarmupSelectionDelta({ repeatCount: 0, femaleRate: 1.8 });
  assert.ok(calm.female < neutral.female);
  assert.ok(neutral.female < energetic.female);

  const calmPlayback = adultPlaybackProgressDelta({ elapsed: 0.25, femaleRate: 0.45, warmup: true });
  const energeticPlayback = adultPlaybackProgressDelta({ elapsed: 0.25, femaleRate: 1.8, warmup: true });
  assert.ok(calmPlayback.lust < energeticPlayback.lust);
});

test('position unlocks are progressive and special categories arrive later', () => {
  assert.equal(positionUnlockProgress({ categoryId: 'oral', index: 3 }), 0);
  assert.equal(positionUnlockProgress({ categoryId: 'vaginal', index: 0 }), 35);
  assert.equal(positionUnlockProgress({ categoryId: 'position', familyId: 'prone-bone', index: 0 }), 35);
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
    { id: 'doggy-long', label: 'Doggy-style ritmi', loopStartTime: 120, loopEndTime: 300, sourceVerified: true }
  ], 120, 300);
  assert.equal(variants.length, 4);
  assert.ok(variants.every(item => item.loopEndTime - item.loopStartTime >= 10));
  assert.deepEqual(variants.map(item => item.loopStartTime), [120, 165, 210, 255]);
});

test('duplicate movement detections become distinct non-overlapping position sequences', () => {
  const duplicate = {
    id: 'prone-repeat',
    label: 'Prone Bone',
    loopStartTime: 100,
    loopEndTime: 180,
    sourceVerified: true,
    movementTempo: 'slow'
  };
  const variants = expandVerifiedMovementVariants([
    duplicate,
    { ...duplicate, id: 'prone-repeat-2' },
    { ...duplicate, id: 'prone-repeat-3' }
  ], 100, 180, { baseLabel: 'Prone Bone Pozisyonu' });
  assert.equal(variants.length, 4);
  assert.equal(new Set(variants.map(item => item.loopStartTime)).size, 4);
  assert.deepEqual(variants.map(item => [item.loopStartTime, item.loopEndTime]), [
    [100, 120], [120, 140], [140, 160], [160, 180]
  ]);
  assert.ok(variants.every((item, index) => item.label === `Prone Bone Pozisyonu · Sekans ${index + 1}`));
});

test('prone bone stays a separate canonical position family', () => {
  assert.equal(adultPositionFamily('Pronebone'), 'prone-bone');
  assert.equal(adultPositionFamily('Yüzüstü arkadan pozisyon'), 'prone-bone');
  assert.equal(adultPositionFamily('Doggy style'), 'rear');
});

test('legs-up provider ids and Turkish labels resolve to one canonical family', () => {
  assert.equal(adultPositionFamily('legs-up'), 'legs-up');
  assert.equal(adultPositionFamily('Bacak havada birleşme'), 'legs-up');
  assert.equal(adultPositionFamily('Bacaklar yukarıda vajinal birleşme'), 'legs-up');
});

test('later partner transitions never appear in the initial Lust warm-up choices', () => {
  const result = initialWarmupBeforeFirstPosition([
    { id: 'kiss', startTime: 260, endTime: 275 },
    { id: 'switch', actionType: 'partner_transition', startTime: 471.134, endTime: 487.241 }
  ], [
    { id: 'partner-b-first', startTime: 289.929, endTime: 471.134 },
    { id: 'partner-a-later', startTime: 547.643, endTime: 676.5 }
  ]);

  assert.deepEqual(result.map(item => item.id), ['kiss']);
});

test('partner transitions use general identity and chronology rules instead of video-specific names or times', () => {
  const verified = verifiedPartnerTransition({
    actionId: 'switch-any-video',
    actionType: 'partner_transition',
    sourceVerified: true,
    groupScene: true,
    partnerSwitch: true,
    previousPartnerTrackId: 'PARTNER_X',
    partnerTrackId: 'PARTNER_Y',
    startTime: 913.25,
    endTime: 921.75,
    label: "Partner Y'ye geç"
  });
  assert.equal(verified.previousPartnerTrackId, 'PARTNER_X');
  assert.equal(verified.partnerTrackId, 'PARTNER_Y');
  assert.equal(verified.startTime, 913.25);

  assert.equal(verifiedPartnerTransition({
    actionType: 'partner_transition', sourceVerified: true, groupScene: true,
    partnerSwitch: true, previousPartnerTrackId: 'PARTNER_A', partnerTrackId: 'PARTNER_A',
    startTime: 10, endTime: 20
  }), null);
  assert.equal(verifiedPartnerTransition({
    actionType: 'partner_transition', sourceVerified: true, groupScene: true,
    partnerSwitch: true, partnerTrackId: 'PARTNER_B', startTime: 10, endTime: 20
  }), null);
});

test('extra movements remain inside the active continuous occurrence', () => {
  const position = {
    sourceRanges: [
      { id: 'early-a', startTime: 100, endTime: 120 },
      { id: 'early-b', startTime: 120, endTime: 140 },
      { id: 'later-return', startTime: 300, endTime: 330 }
    ],
    movements: [
      { id: 'm1', sourceVerified: true, sourcePositionId: 'early-a', loopStartTime: 104, loopEndTime: 112 },
      { id: 'm2', sourceVerified: true, sourcePositionId: 'early-b', loopStartTime: 124, loopEndTime: 136 },
      { id: 'm3', sourceVerified: true, sourcePositionId: 'later-return', loopStartTime: 305, loopEndTime: 318 }
    ]
  };

  const groups = positionOccurrenceGroups(position);
  assert.deepEqual(groups.map(item => [item.id, item.startTime, item.endTime]), [
    ['early-a', 100, 140],
    ['later-return', 300, 330]
  ]);
  assert.deepEqual(
    movementsForPositionOccurrence(position, 'early-a').map(item => item.id),
    ['m1', 'm2']
  );
  assert.deepEqual(
    movementsForPositionOccurrence(position, 'later-return').map(item => item.id),
    ['m3']
  );
});

test('a repeated scene id becomes a new occurrence after another scene intervenes', () => {
  const ids = assignAdultSceneOccurrenceIds([
    { adultScene: true, adultSceneId: 'scene-a', startTime: 100, endTime: 140 },
    { adultScene: true, adultSceneId: 'scene-a', startTime: 140, endTime: 170 },
    { adultScene: true, adultSceneId: 'scene-b', startTime: 180, endTime: 220 },
    { adultScene: true, adultSceneId: 'scene-a', startTime: 230, endTime: 270 }
  ]);
  assert.deepEqual(ids, ['scene-a', 'scene-a', 'scene-b', 'scene-a#2']);
});

test('a long silent gap splits a reused scene id without relying on video-specific timestamps', () => {
  const ids = assignAdultSceneOccurrenceIds([
    { adultScene: true, adultSceneId: 'scene-x', startTime: 10, endTime: 20 },
    { adultScene: true, adultSceneId: 'scene-x', startTime: 90, endTime: 110 }
  ]);
  assert.deepEqual(ids, ['scene-x', 'scene-x#2']);
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

test('chronological variant navigation never wraps back to an earlier segment', () => {
  const variants = [
    { id: 'middle', loopStartTime: 40, loopEndTime: 55 },
    { id: 'first', loopStartTime: 10, loopEndTime: 25 },
    { id: 'last', loopStartTime: 80, loopEndTime: 95 }
  ];
  assert.equal(pickNextChronologicalVariant(variants, null)?.id, 'first');
  assert.equal(pickNextChronologicalVariant(variants, 'first')?.id, 'middle');
  assert.equal(pickNextChronologicalVariant(variants, 'last'), null);
});

test('rhythm switching stays local and never seeks backward or to a distant ending', () => {
  const current = { id: 'current', loopStartTime: 100, loopEndTime: 115 };
  const variants = [
    { id: 'past', loopStartTime: 50, loopEndTime: 65 },
    { id: 'near', loopStartTime: 125, loopEndTime: 140 },
    { id: 'ending', loopStartTime: 220, loopEndTime: 235 }
  ];
  assert.equal(pickNearbyRhythmVariant(variants, current, 110)?.id, 'near');
  assert.equal(pickNearbyRhythmVariant([variants[0], variants[2]], current, 110), null);
});

test('timeline routes generic actions inside a prepared adult scene to its dedicated panel', () => {
  const scenes = [{
    id: 'scene-main',
    sourceSceneIds: ['scene-main', 'scene-fragment-2'],
    startTime: 100,
    endTime: 240
  }];
  assert.equal(findAdultSceneForTimeline(scenes, {
    action: { adultSceneId: 'scene-fragment-2', startTime: 210, endTime: 220 }
  })?.id, 'scene-main');
  assert.equal(findAdultSceneForTimeline(scenes, {
    action: { startTime: 145, endTime: 155 }
  })?.id, 'scene-main');
  assert.equal(findAdultSceneForTimeline(scenes, {
    action: { startTime: 145, endTime: 155 },
    completedSceneIds: new Set(['scene-main'])
  }), null);
});

test('timeline dedupe preserves overlapping parent positions and child movement loops', () => {
  const actions = dedupeVerifiedTimelineActions([
    { actionId: 'position', label: 'Pozisyon', startTime: 100, endTime: 180, confidence: 0.92 },
    { actionId: 'movement-1', label: 'Yavaş ritim', startTime: 105, endTime: 125, confidence: 0.88 },
    { actionId: 'movement-2', label: 'Hızlı ritim', startTime: 125, endTime: 150, confidence: 0.9 },
    { actionId: 'movement-1', label: 'Eski kopya', startTime: 105, endTime: 125, confidence: 0.6 }
  ]);
  assert.deepEqual(actions.map(item => item.actionId), ['position', 'movement-1', 'movement-2']);
  assert.equal(actions.find(item => item.actionId === 'movement-1')?.label, 'Yavaş ritim');
});

test('tap rhythm reacts to slow, moderate and fast touch cadence', () => {
  assert.equal(tapRhythm([0, 700, 1400], 1400).tempo, 'slow');
  assert.equal(tapRhythm([0, 1500, 3000], 3000).tempo, 'slow');
  assert.equal(tapRhythm([0, 350, 700, 1050], 1050).tempo, 'moderate');
  assert.equal(tapRhythm([0, 180, 360, 540], 540).tempo, 'fast');
  assert.equal(tapRhythm([100], 100).tempo, 'unclear');
  assert.equal(playbackRateForTapTempo('slow'), 0.88);
  assert.equal(playbackRateForTapTempo('moderate'), 1);
  assert.equal(playbackRateForTapTempo('fast'), 1.12);
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


test('distant returns become chronological occurrences instead of one backward-seeking tab', () => {
  const positions = [
    {
      id: 'cowgirl-1',
      familyId: 'cowgirl',
      label: 'Kovboy Pozisyonu',
      categoryId: 'vaginal',
      startTime: 10,
      endTime: 25,
      movements: [{ id: 'slow-a', loopStartTime: 10, loopEndTime: 20, sourceVerified: true }]
    },
    {
      id: 'cowgirl-2',
      familyId: 'cowgirl',
      label: 'Kovboy Pozisyonu',
      categoryId: 'vaginal',
      startTime: 40,
      endTime: 58,
      movements: [{ id: 'fast-a', loopStartTime: 42, loopEndTime: 54, sourceVerified: true }]
    }
  ];

  const result = consolidateVerifiedPositions(positions);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'position:cowgirl');
  assert.equal(result[1].id, 'position:cowgirl:occ-2');
  assert.deepEqual(result[0].sourcePositionIds, ['cowgirl-1']);
  assert.deepEqual(result[1].sourcePositionIds, ['cowgirl-2']);
});

test('panel mode collapses distant returns into one canonical position tab', () => {
  const positions = consolidateVerifiedPositions([
    {
      id: 'standing-rear-1', familyId: 'standing-rear', label: 'Ayakta Arkadan Pozisyon',
      partnerTrackId: 'PARTNER_A', progressionRole: 'core', startTime: 266.5, endTime: 318.9,
      movements: [{ id: 'entry', label: 'Ayakta arkadan gir', loopStartTime: 266.5,
        loopEndTime: 272.75, sourceVerified: true }]
    },
    {
      id: 'standing-rear-2', familyId: 'standing-rear', label: 'Ayakta Arkadan Pozisyon',
      partnerTrackId: 'PARTNER_A', progressionRole: 'core', startTime: 374.5, endTime: 398.7,
      movements: [{ id: 'later', label: 'Öne eğilmiş şekilde devam et', loopStartTime: 374.5,
        loopEndTime: 386.5, sourceVerified: true }]
    },
    {
      id: 'standing-rear-3', familyId: 'standing-rear', label: 'Ayakta Arkadan Pozisyon',
      partnerTrackId: 'PARTNER_A', progressionRole: 'core', startTime: 517, endTime: 583.5,
      movements: [{ id: 'latest', label: 'Ritmik şekilde devam et', loopStartTime: 532,
        loopEndTime: 546, sourceVerified: true }]
    }
  ], { mergeDistantReturns: true });

  assert.equal(positions.length, 1);
  assert.equal(positions[0].label, 'Ayakta Arkadan Pozisyon');
  assert.equal(positions[0].entryMovementId, 'entry');
  assert.equal(positionOccurrenceGroups(positions[0]).length, 3);
  assert.deepEqual(positions[0].movements.map(item => item.id), ['entry', 'later', 'latest']);
  assert.equal(positionOccurrenceForMovement(positions[0], positions[0].movements[2]).id, 'standing-rear-3');
});

test('same family remains separate for different partners even in panel mode', () => {
  const positions = consolidateVerifiedPositions([
    { id: 'rear-a', familyId: 'rear', partnerTrackId: 'PARTNER_A', progressionRole: 'core',
      startTime: 10, endTime: 20, movements: [] },
    { id: 'rear-b', familyId: 'rear', partnerTrackId: 'PARTNER_B', progressionRole: 'core',
      startTime: 21, endTime: 31, movements: [] }
  ], { mergeDistantReturns: true });
  assert.equal(positions.length, 2);
});

test('same verified position with different group partners becomes separate playable tabs', () => {
  const result = consolidateVerifiedPositions([
    {
      id: 'cowgirl-partner-a', familyId: 'cowgirl', label: 'Kovboy Pozisyonu · Partner A',
      partnerTrackId: 'PARTNER_A', partnerLabel: 'Partner A', groupScene: true,
      startTime: 10, endTime: 25,
      movements: [{ id: 'a', loopStartTime: 10, loopEndTime: 20, sourceVerified: true }]
    },
    {
      id: 'cowgirl-partner-b', familyId: 'cowgirl', label: 'Kovboy Pozisyonu · Partner B',
      partnerTrackId: 'PARTNER_B', partnerLabel: 'Partner B', groupScene: true,
      startTime: 40, endTime: 58,
      movements: [{ id: 'b', loopStartTime: 42, loopEndTime: 54, sourceVerified: true }]
    }
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map(item => item.partnerTrackId), ['PARTNER_A', 'PARTNER_B']);
  assert.deepEqual(result.map(item => item.id), [
    'position:cowgirl:PARTNER_A',
    'position:cowgirl:PARTNER_B'
  ]);
});

test('sex control requires verified fast, hard or deep evidence', () => {
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'fast' }), true);
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'slow', label: 'Derin hareket' }), true);
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'moderate', label: 'Normal tempo' }), false);
  assert.equal(isEnergeticSexMoment({ sourceVerified: false, movementTempo: 'fast' }), false);
});

test('builds tempo-consistent subchoices and keeps every clip in its energy pool', () => {
  const movements = [
    { id: 'a', label: 'Kovboy Pozisyonu · Sekans 1', movementTempo: 'slow', loopStartTime: 0, loopEndTime: 10, sourceVerified: true },
    { id: 'b', label: 'Kovboy Pozisyonu · Sekans 2', movementTempo: 'slow', loopStartTime: 12, loopEndTime: 22, sourceVerified: true },
    { id: 'c', label: 'Öpüşerek devam', movementTempo: 'moderate', loopStartTime: 24, loopEndTime: 34, sourceVerified: true },
    { id: 'd', label: 'Öpüşerek devam', movementTempo: 'moderate', loopStartTime: 36, loopEndTime: 46, sourceVerified: true },
    { id: 'e', label: 'Temas değişimi', movementTempo: 'fast', loopStartTime: 48, loopEndTime: 58, sourceVerified: true }
  ].map(item => ({ ...item, sourcePositionId: 'observed-occurrence' }));

  const choices = buildVerifiedMovementChoices(movements, 'Kovboy Pozisyonu', 4);
  assert.equal(choices.length, 3);
  const slow = choices.find(choice => choice.intensityBand === 'slow');
  const steady = choices.find(choice => choice.intensityBand === 'steady');
  const intense = choices.filter(choice => choice.intensityBand === 'intense');
  assert.equal(slow.label, 'Kovboy Pozisyonu');
  assert.deepEqual(choices.filter(choice => choice.intensityBand === 'slow').flatMap(choice => choice.variants.map(item => item.id)), ['a', 'b']);
  assert.deepEqual(steady.variants.map(item => item.id), ['c', 'd']);
  assert.deepEqual(intense.flatMap(choice => choice.variants.map(item => item.id)), ['e']);
  assert.ok(choices.every(choice => choice.hasTempoShift === false));
});

test('position family ignores furniture, kissing and ordinary hand-contact wording', () => {
  assert.equal(adultPositionFamily('Kadını koltuğun arkasına yönlendir'), '');
  assert.equal(adultPositionFamily('Kadını ağzından öp'), '');
  assert.equal(adultPositionFamily('Eliyle belini tut'), '');
  assert.equal(adultPositionFamily('Ayakta arkadan pozisyon'), 'standing-rear');
  assert.equal(adultPositionFamily('Doggy style'), 'rear');
  assert.equal(adultPositionFamily('Kucağındaki kadını öperek ritmik şekilde hareket et'), 'seated-facing');
});

test('verified position labels work even when optional position metadata is missing or stale', () => {
  assert.equal(verifiedAdultPositionFamily({
    sourceVerified: true,
    label: 'Ters kovboy pozisyonunda devam et'
  }), 'reverse-cowgirl');
  assert.equal(verifiedAdultPositionFamily({
    sourceVerified: true,
    positionId: 'cowgirl',
    positionLabel: 'Kovboy Pozisyonu',
    label: 'Ters kovboy pozisyonunda devam et'
  }), 'reverse-cowgirl');
  assert.equal(verifiedAdultPositionFamily({
    sourceVerified: false,
    label: 'Ters kovboy pozisyonunda devam et'
  }), '');

  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    positionId: 'cowgirl',
    positionLabel: 'Kovboy Pozisyonu',
    label: 'Ters cowgirl pozisyonunda ritmik tempoyu sürdür'
  }), { family: 'reverse-cowgirl', correctedFromAction: true });

  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    positionId: 'cowgirl',
    positionLabel: 'Kovboy Pozisyonu',
    label: 'Kucağındaki kadını öperek ritmik şekilde hareket et'
  }), { family: 'cowgirl', correctedFromAction: false });

  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    positionId: 'cowgirl',
    positionLabel: 'Kucakta yüz yüze (Cowgirl)',
    label: 'Kucağındaki kadını öperek sarıl',
    movementType: 'ritmik hareket'
  }), { family: 'cowgirl', correctedFromAction: false });

  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    positionId: 'seated-facing',
    positionLabel: 'Kucakta Yüz Yüze Pozisyon',
    label: 'Kısa cowgirl pozisyonunda ritmik harekete geç'
  }), { family: 'cowgirl', correctedFromAction: true });
});

test('direct body configuration corrects confused cowgirl and prone-bone metadata', () => {
  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    positionId: 'prone-bone', positionLabel: 'Prone Bone',
    receiverBodyOrientation: 'on_top_facing', receiverSupport: 'straddling',
    positionConfigurationConfidence: 0.96, positionEvidence: 'partner visibly remains above and straddling'
  }), { family: 'cowgirl', correctedFromAction: true });
});

test('an explicitly named source interval cannot jump from cowgirl to missionary because of one conflicting posture field', () => {
  const action = {
    sourceVerified: true,
    positionId: 'cowgirl', positionLabel: 'Kovboy Pozisyonu',
    label: 'Cowgirl pozisyonunda ritmi sürdür', movementType: 'rhythmic',
    receiverBodyOrientation: 'on_back', receiverSupport: 'back_flat',
    positionConfigurationConfidence: 0.93, positionEvidence: 'receiver back touches the surface'
  };
  assert.deepEqual(resolveVerifiedAdultPosition(action), { family: 'cowgirl', correctedFromAction: false });
  assert.equal(movementBelongsToVerifiedPosition(action, 'cowgirl'), false);
  assert.equal(movementBelongsToVerifiedPosition(action, 'missionary'), false);
});

test('verified oral activity cannot be overwritten by missionary-like body support', () => {
  assert.deepEqual(resolveVerifiedAdultPosition({
    sourceVerified: true,
    actionType: 'position',
    positionId: 'missionary',
    positionLabel: 'Misyoner Pozisyonu',
    activityType: 'oral',
    activityTypeConfidence: 0.94,
    activityEvidence: 'direct visible oral contact',
    receiverBodyOrientation: 'on_back',
    receiverSupport: 'back_flat',
    positionConfigurationConfidence: 0.91,
    positionEvidence: 'one participant is visibly lying on their back'
  }), { family: 'oral', correctedFromAction: true });
});

test('movement choice grouping retains every verified clip', () => {
  const movements = Array.from({ length: 11 }, (_, index) => ({
    id: `reverse-${index}`,
    label: index % 2 ? 'Ters kovboy pozisyonunda ritmi sürdür' : 'Kadının kalçasını tut',
    movementType: index % 2 ? 'rhythmic' : 'hold',
    movementTempo: index % 3 === 0 ? 'fast' : 'moderate',
    loopStartTime: 490 + index * 11,
    loopEndTime: 500 + index * 11,
    sourceVerified: true,
    sourcePositionId: 'reverse-occurrence'
  }));
  const choices = buildVerifiedMovementChoices(movements, 'Ters Kovboy Pozisyonu', 4);
  assert.ok(choices.length < movements.length);
  assert.ok(choices.every(choice => choice.variants.length <= 6));
  assert.deepEqual(
    choices.flatMap(choice => choice.variants).map(item => item.id).sort(),
    movements.map(item => item.id).sort()
  );
});

test('tempo cards prioritize intensity evidence without mixing energy levels', () => {
  const movements = [
    { id: 'slow', label: 'Yavaşça devam et', movementType: 'ritmik hareket', movementTempo: 'slow',
      loopStartTime: 10, loopEndTime: 20, sourceVerified: true },
    { id: 'steady', label: 'Ritmik şekilde devam et', movementType: 'ritmik hareket', movementTempo: 'moderate',
      loopStartTime: 20, loopEndTime: 30, sourceVerified: true },
    { id: 'provider-moderate-fast', label: 'Ritmi hızlandır', movementType: 'hızlı hareket', movementTempo: 'moderate',
      loopStartTime: 30, loopEndTime: 40, sourceVerified: true },
    { id: 'provider-moderate-deep', label: 'Derin hareketi sürdür', movementType: 'hareket', movementTempo: 'moderate',
      loopStartTime: 35, loopEndTime: 45, sourceVerified: true },
    { id: 'fast', label: 'Yoğun şekilde sürdür', movementType: 'hareket', movementTempo: 'fast',
      loopStartTime: 40, loopEndTime: 50, sourceVerified: true }
  ];
  const choices = buildVerifiedMovementChoices(movements, 'Aynı Pozisyon', 5);
  assert.deepEqual(choices.map(choice => choice.intensityBand), ['slow', 'steady', 'intense', 'intense', 'intense']);
  assert.deepEqual(choices[0].variants.map(item => item.id), ['slow']);
  assert.deepEqual(choices[1].variants.map(item => item.id), ['steady']);
  assert.deepEqual(choices.slice(2).map(choice => choice.variants.map(item => item.id)), [
    ['provider-moderate-fast'], ['provider-moderate-deep'], ['fast']
  ]);
  assert.equal(new Set(choices.flatMap(choice => choice.variants).map(item => item.id)).size, movements.length);
});

test('a transition label cannot be hidden inside a tempo card', () => {
  const movements = [
    { id: 'local', label: 'Ritmi sürdür', movementType: 'ritmik hareket', movementTempo: 'moderate',
      loopStartTime: 10, loopEndTime: 20, sourceVerified: true },
    { id: 'transition', label: 'Başka pozisyona geçiş', movementType: 'transition', movementTempo: 'fast',
      loopStartTime: 20, loopEndTime: 30, sourceVerified: true }
  ].map(item => ({ ...item, sourcePositionId: 'cowgirl-occurrence' }));
  const position = { id: 'cowgirl', occurrenceId: 'cowgirl-occurrence', startTime: 10, endTime: 30,
    sourceRanges: [{ id: 'cowgirl-occurrence', startTime: 10, endTime: 30 }], movements };
  const choices = buildVerifiedMovementChoices(movements, 'Kovboy Pozisyonu', 5, position);
  assert.deepEqual(choices.flatMap(choice => choice.variants).map(item => item.id), ['local']);
});

test('keeps verified activity and contact actions inside their position panel', () => {
  assert.equal(movementBelongsToVerifiedPosition({
    label: 'Ters cowgirl pozisyonunda vajinal tempoyu koru',
    movementType: 'rhythmic'
  }, 'reverse-cowgirl'), true);
  assert.equal(movementBelongsToVerifiedPosition({
    label: 'Kadının boynunu öperek sarıl',
    movementType: 'kiss'
  }, 'cowgirl'), true);
  assert.equal(movementBelongsToVerifiedPosition({
    label: 'Ters cowgirl pozisyonuna geçiş',
    movementType: 'transition'
  }, 'cowgirl'), false);
  assert.equal(movementBelongsToVerifiedPosition({
    label: 'Ritmi sürdür', movementType: 'rhythmic',
    receiverBodyOrientation: 'on_top_facing', receiverSupport: 'straddling',
    positionConfigurationConfidence: 0.95, positionEvidence: 'partner visibly straddles MAIN_MALE'
  }, 'prone-bone'), false);
});

test('movement cards keep concrete action text and remove sensory metadata', () => {
  const choices = buildVerifiedMovementChoices([{
    id: 'fast-kiss',
    label: 'Öperek hızlı hareket et · Yoğun nefes · Uzun bakış',
    movementTempo: 'fast',
    loopStartTime: 10,
    loopEndTime: 22,
    sourceVerified: true,
    sourcePositionId: 'occurrence-a'
  }], 'Kovboy Pozisyonu', 3);
  assert.equal(choices[0].label, 'Öperek hızlı hareket et');
  assert.doesNotMatch(choices[0].label, /nefes|bakış|kesit|sekans|\d+:\d+/i);
});

test('position-only evidence stays one honest playable card without generic cut labels', () => {
  const choices = buildVerifiedMovementChoices([{
    id: 'cowgirl-position-only',
    label: 'Kovboy Pozisyonu sekansını oynat',
    movementTempo: 'unclear',
    loopStartTime: 382,
    loopEndTime: 430,
    sourceVerified: true,
    sourcePositionId: 'cowgirl-occurrence',
    positionOnlyFallback: true
  }], 'Kovboy Pozisyonu', 3);

  assert.equal(choices.length, 1);
  assert.equal(choices[0].label, 'Kovboy Pozisyonu oynat');
  assert.doesNotMatch(choices[0].label, /Pozisyon içi hareket|Kesit\s+\d/i);
});


test('movement cards keep each occurrence separate instead of merging all clips', () => {
  const movements = Array.from({ length: 20 }, (_, index) => ({
    id: `clip-${index}`,
    label: 'Kovboy Pozisyonu · Sekans 1',
    movementTempo: 'moderate',
    loopStartTime: index * 12,
    loopEndTime: index * 12 + 10,
    sourceVerified: true,
    sourcePositionId: index < 10 ? 'occurrence-a' : 'occurrence-b'
  }));

  const choices = buildVerifiedMovementChoices(movements, 'Kovboy Pozisyonu', 4);
  assert.equal(choices.length, 4);
  assert.equal(choices.flatMap(choice => choice.variants).length, 20);
  assert.deepEqual(
    choices.map(choice => [...new Set(choice.variants.map(item => item.sourcePositionId))]),
    [['occurrence-a'], ['occurrence-a'], ['occurrence-b'], ['occurrence-b']]
  );
});

test('movement coverage reports every verified variant across source action cards', () => {
  const movements = Array.from({ length: 26 }, (_, index) => ({
    id: `verified-${index + 1}`,
    label: `Observed action ${index + 1}`,
    loopStartTime: index * 5,
    loopEndTime: index * 5 + 4,
    sourceVerified: true
  }));
  const choices = buildVerifiedMovementChoices(movements, 'Observed position', 3);

  assert.deepEqual(summarizeMovementChoiceCoverage(choices), {
    choiceCount: 26,
    variantCount: 26,
    uniqueVariantCount: 26
  });
});


test('joins overlap but keeps a distant return chronological', () => {
  const positions = consolidateVerifiedPositions([
    {
      id: 'raw-a', familyId: 'cowgirl', label: 'Kovboy Pozisyonu',
      startTime: 10, endTime: 24,
      movements: [{ id: 'a', label: 'Kovboy Pozisyonu · Sekans 1', movementTempo: 'slow', loopStartTime: 10, loopEndTime: 20, sourceVerified: true }]
    },
    {
      id: 'raw-b', familyId: 'cowgirl', label: 'Kovboy Pozisyonu',
      startTime: 23.5, endTime: 38,
      movements: [{ id: 'b', label: 'Kovboy Pozisyonu · Sekans 2', movementTempo: 'slow', loopStartTime: 24, loopEndTime: 34, sourceVerified: true }]
    },
    {
      id: 'raw-c', familyId: 'cowgirl', label: 'Kovboy Pozisyonu',
      startTime: 70, endTime: 84,
      movements: [{ id: 'c', label: 'Kovboy Pozisyonu · Sekans 3', movementTempo: 'slow', loopStartTime: 70, loopEndTime: 80, sourceVerified: true }]
    }
  ]);

  assert.equal(positions.length, 2);
  assert.equal(positions[0].sourcePositionIds.length, 2);
  assert.equal(positions[1].sourcePositionIds.length, 1);
  assert.deepEqual(
    buildVerifiedMovementChoices(positions[0].movements, positions[0].label, 3)
      .flatMap(choice => choice.variants.map(item => item.id)),
    ['a', 'b']
  );
});

test('keeps early warmup oral separate from later bonus oral', () => {
  const positions = consolidateVerifiedPositions([
    {
      id: 'oral-early', familyId: 'oral', label: 'Oral Seks', progressionRole: 'foreplay',
      startTime: 100, endTime: 140, movements: []
    },
    {
      id: 'oral-late', familyId: 'oral', label: 'Oral Seks', progressionRole: 'bonus',
      startTime: 220, endTime: 235, movements: []
    }
  ]);

  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map(item => item.progressionRole).sort(), ['bonus', 'foreplay']);
  assert.notEqual(positions[0].id, positions[1].id);
});

test('splits each verified movement into repeatable real subclips', () => {
  const variants = expandVerifiedMovementVariants([{
    id: 'fast-action',
    label: 'Hızlı hareketi sürdür',
    movementTempo: 'fast',
    loopStartTime: 100,
    loopEndTime: 121,
    sourceVerified: true,
    sourcePositionId: 'cowgirl-a'
  }], 100, 121, {
    minSeconds: 5,
    maxVariants: 24,
    splitEachMovement: true
  });

  assert.equal(variants.length, 3);
  assert.ok(variants.every(item => item.loopEndTime - item.loopStartTime >= 5));
  assert.ok(variants.every(item => item.derivedFromVerifiedSegment === 'fast-action'));
  assert.deepEqual(
    variants.map(item => [item.loopStartTime, item.loopEndTime]),
    [[100, 107], [107, 114], [114, 121]]
  );
});
