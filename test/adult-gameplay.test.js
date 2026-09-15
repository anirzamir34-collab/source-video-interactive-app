import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adultPositionFamily,
  verifiedAdultPositionFamily,
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  buildVerifiedMovementChoices,
  consolidateVerifiedPositions,
  computeAdultSelectionDelta,
  dedupeVerifiedTimelineActions,
  expandVerifiedMovementVariants,
  computeWarmupSelectionDelta,
  findAdultSceneForTimeline,
  isOutcomeUnlocked,
  groupVerifiedMovementsByTempo,
  isEnergeticSexMoment,
  MIN_CORE_PLAY_SECONDS_FOR_OUTCOME,
  monotonicAdultPhase,
  normalizeOutcomeUnlockProgress,
  playbackRateForTapTempo,
  pickNearbyRhythmVariant,
  pickNextChronologicalVariant,
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
    { id: 'doggy-long', label: 'Doggy-style ritmi', loopStartTime: 120, loopEndTime: 300 }
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


test('keeps disconnected occurrences of one family isolated', () => {
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
  assert.deepEqual(result.map(item => item.id), [
    'position:cowgirl:continuous-10000',
    'position:cowgirl:continuous-40000'
  ]);
  assert.deepEqual(result[0].movements.map(item => item.id), ['slow-a']);
  assert.deepEqual(result[1].movements.map(item => item.id), ['fast-a']);
});

test('sex control requires verified fast, hard or deep evidence', () => {
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'fast' }), true);
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'slow', label: 'Derin hareket' }), true);
  assert.equal(isEnergeticSexMoment({ sourceVerified: true, movementTempo: 'moderate', label: 'Normal tempo' }), false);
  assert.equal(isEnergeticSexMoment({ sourceVerified: false, movementTempo: 'fast' }), false);
});

test('builds at most four subchoices and keeps multiple clips in each choice pool', () => {
  const movements = [
    { id: 'a', label: 'Kovboy Pozisyonu · Sekans 1', movementTempo: 'slow', loopStartTime: 0, sourceVerified: true },
    { id: 'b', label: 'Kovboy Pozisyonu · Sekans 2', movementTempo: 'slow', loopStartTime: 12, sourceVerified: true },
    { id: 'c', label: 'Öpüşerek devam', movementTempo: 'moderate', loopStartTime: 24, sourceVerified: true },
    { id: 'd', label: 'Öpüşerek devam', movementTempo: 'moderate', loopStartTime: 36, sourceVerified: true },
    { id: 'e', label: 'Temas değişimi', movementTempo: 'fast', loopStartTime: 48, sourceVerified: true }
  ];

  const choices = buildVerifiedMovementChoices(movements, 'Kovboy Pozisyonu', 4);
  assert.ok(choices.length <= 4);
  const slow = choices.find(choice => choice.tempo === 'slow');
  const kiss = choices.find(choice => choice.label === 'Öpüşerek devam');
  assert.equal(slow.label, 'Yavaş hareket');
  assert.deepEqual(slow.variants.map(item => item.id), ['a', 'b']);
  assert.deepEqual(kiss.variants.map(item => item.id), ['c', 'd']);
});

test('position family ignores furniture, kissing and ordinary hand-contact wording', () => {
  assert.equal(adultPositionFamily('Kadını koltuğun arkasına yönlendir'), '');
  assert.equal(adultPositionFamily('Kadını ağzından öp'), '');
  assert.equal(adultPositionFamily('Eliyle belini tut'), '');
  assert.equal(adultPositionFamily('Ayakta arkadan pozisyon'), 'standing-rear');
  assert.equal(adultPositionFamily('Doggy style'), 'rear');
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
  assert.equal(choices[0].label, 'Kovboy Pozisyonu sekansını oynat');
  assert.doesNotMatch(choices[0].label, /Pozisyon içi hareket|Kesit\s+\d/i);
});


test('never mixes separate occurrences and groups matching clips under one local card', () => {
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
  assert.equal(choices.length, 1);
  assert.ok(choices.every(choice => choice.variants.length <= 3));
  assert.ok(choices.every(choice =>
    new Set(choice.variants.map(item => item.sourcePositionId)).size === 1
  ));
  assert.ok(choices.every(choice => choice.sourcePositionId === 'occurrence-a'));
});


test('joins overlapping raw detections but keeps later returns as separate positions', () => {
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
  assert.deepEqual(
    positions.map(position =>
      buildVerifiedMovementChoices(position.movements, position.label, 3)
        .flatMap(choice => choice.variants.map(item => item.id))
    ),
    [['a', 'b'], ['c']]
  );
});
