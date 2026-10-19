import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSourceChoiceCards, sourceIdentityLabel, sourceDisplayLabel,
  bundleAdjacentSourceCards, groupVerifiedApproachChoices, approachStageChoices } from '../public/choice-groups.js';
import { buildVerifiedMovementChoices, exclusiveControlClipIds, findAdultSceneForTimeline,
  forwardLocalMovementClips, splitSparseMovementChoiceCards } from '../public/adult-gameplay.js';

test('a rich source group retains every distinct option after card display preparation', () => {
  const movements = Array.from({ length: 12 }, (_, index) => ({
    id: `source-clip-${index}`, sourceActionId: `observed-action-${index}`, sourceVerified: true,
    sourcePositionId: 'recorded-range', actionType: 'movement', movementType: 'recorded-kind',
    label: `Recorded choice ${index + 1}`, startTime: index * 6, endTime: index * 6 + 5,
    loopStartTime: index * 6, loopEndTime: index * 6 + 5
  }));
  const position = { id: 'source-group', sourceVerified: true, startTime: 0, endTime: 72,
    sourceRanges: [{ id: 'recorded-range', startTime: 0, endTime: 72 }], movements };
  const cards = splitSparseMovementChoiceCards(buildVerifiedMovementChoices(movements, 'Recorded group', 8, position), 8);
  assert.equal(cards.length, 12);
  assert.deepEqual(cards.flatMap(card => card.variants.map(item => item.id)), movements.map(item => item.id));
});

test('an old position return exposes only nearby forward source clips', () => {
  const movements = [clip(0, { loopStartTime: 443, loopEndTime: 462 }),
    clip(1, { loopStartTime: 778, loopEndTime: 795 }),
    clip(2, { loopStartTime: 795, loopEndTime: 812 })];
  const position = { id: 'oral', startTime: 443, endTime: 812, movements,
    sourceRanges: [{ id: 'trail-a', startTime: 443, endTime: 462 },
      { id: 'trail-a', startTime: 778, endTime: 812 }] };
  assert.deepEqual(forwardLocalMovementClips(position, 734).map(item => item.id), []);
  assert.deepEqual(forwardLocalMovementClips(position, 778).map(item => item.id), ['clip-1', 'clip-2']);
  assert.deepEqual(forwardLocalMovementClips(position, 779).map(item => item.id), ['clip-1', 'clip-2']);
  assert.deepEqual(forwardLocalMovementClips(position, 839).map(item => item.id), []);
});

const clip = (index, extra = {}) => ({ id: `clip-${index}`, sourceVerified: true,
  label: `Patikada yürü · Sekans ${index + 1}`, actionType: 'movement',
  movementTempo: 'moderate', sourcePositionId: 'trail-a',
  partnerTrackId: 'person-a', participantTrackIds: ['person-a', 'person-b'],
  loopStartTime: index * 5, loopEndTime: index * 5 + 5, ...extra });

test('identical verified source records are idempotent but later distinct clips remain available', () => {
  const first = clip(0, { label: 'Parkta yürümeye başla' });
  const second = clip(1, { label: 'Yürüyüşü sürdür' });
  const duplicate = { ...first };
  const cards = groupSourceChoiceCards([first, duplicate, second, { ...first }]);
  assert.deepEqual(cards.flatMap(card => card.variants.map(variant => variant.id)),
    ['clip-0', 'clip-1']);
  assert.equal(groupSourceChoiceCards([first]).flatMap(card => card.variants).length, 1);
  // A valid second occurrence with a reused source ID must never disappear.
  const later = { ...first, loopStartTime: 30, loopEndTime: 35 };
  const separate = groupSourceChoiceCards([first, later]);
  assert.deepEqual(separate.flatMap(card => card.variants.map(item => item.loopStartTime)),
    [0, 30]);
});

test('distinct observed labels remain distinct within one verified occurrence', () => {
  const movements = Array.from({ length: 20 }, (_, index) => clip(index, {
    label: `Kaynak hareket ${index + 1}`, sourcePositionId: 'same-occurrence'
  }));
  const position = { id: 'parent', occurrenceId: 'same-occurrence', partnerTrackId: 'person-a',
    startTime: 0, endTime: 100, movements,
    sourceRanges: [{ id: 'same-occurrence', startTime: 0, endTime: 100 }] };
  const cards = buildVerifiedMovementChoices(movements, 'Kaynak pozisyonu', 5, position);
  assert.equal(cards.length, movements.length);
  assert.ok(cards.every(card => card.variants.length === 1));
  assert.deepEqual(cards.flatMap(card => card.variants), movements);
});

test('eighteen adjacent cuts of one action form one card without losing or changing a clip', () => {
  const clips = Array.from({ length: 18 }, (_, i) => clip(i));
  const before = structuredClone(clips);
  const cards = buildVerifiedMovementChoices(clips, 'Yürüyüş', 5);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].variants.length, 18);
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

test('a rich verified occurrence forms truthful tempo cards with three or four movements each', () => {
  const specs = [
    ...Array.from({ length: 4 }, () => ({ label: 'Yavaşça devam et', movementTempo: 'slow' })),
    ...Array.from({ length: 4 }, () => ({ label: 'Ritmik hareketi sürdür', movementTempo: 'moderate' })),
    ...Array.from({ length: 3 }, () => ({ label: 'Derin hareketi sürdür', movementTempo: 'moderate' })),
    ...Array.from({ length: 3 }, () => ({ label: 'Hızlı hareketlerle devam et', movementTempo: 'fast' }))
  ];
  const movements = specs.map((spec, index) => clip(index, {
    ...spec,
    sourcePositionId: 'same-occurrence',
    receiverBodyOrientation: index % 2 ? 'camera-left' : 'camera-right',
    receiverSupport: index % 3 ? 'supported' : 'unknown',
    partnerTrackId: index % 2 ? 'partner-a' : '',
    subjectTrackId: index % 2 ? 'subject-a' : '',
    loopStartTime: index * 6,
    loopEndTime: index * 6 + 5
  }));
  const position = {
    id: 'position:cowgirl:partner-a', occurrenceId: 'cowgirl:partner-a', partnerTrackId: 'partner-a',
    startTime: 0, endTime: 84, movements,
    sourceRanges: [{ id: 'same-occurrence', startTime: 0, endTime: 84 }]
  };

  const cards = buildVerifiedMovementChoices(movements, 'Kovboy Pozisyonu', 5, position);
  assert.deepEqual(cards.map(card => card.energyFlavor), ['slow', 'steady', 'deep', 'fast']);
  assert.deepEqual(cards.map(card => card.energyLabel), ['YAVAŞ', 'RİTMİK', 'DERİN', 'HIZLI']);
  assert.deepEqual(cards.map(card => card.variants.length), [4, 4, 3, 3]);
  assert.equal(cards.flatMap(card => card.variants).length, movements.length);
  assert.ok(cards.every(card => new Set(card.variants.map(item => item.sourcePositionId)).size === 1));
});

test('five minute source keeps slow and intense movements in distinct cards despite a display target', () => {
  const movements = Array.from({ length: 6 }, (_, index) => clip(index, {
    label: index < 3 ? 'Yavaş hareket' : 'Hızlı hareket',
    movementTempo: index < 3 ? 'slow' : 'fast',
    sourcePositionId: 'one-position',
    loopStartTime: index * 50, loopEndTime: (index + 1) * 50
  }));
  const position = { id: 'one-position', startTime: 0, endTime: 300, movements,
    sourceRanges: [{ id: 'one-position', startTime: 0, endTime: 300 }] };
  const cards = bundleAdjacentSourceCards(buildVerifiedMovementChoices(movements, 'Pozisyon', 4, position),
    { targetCount: 1 });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.intensityBand), ['slow', 'intense']);
  assert.deepEqual(cards.map(card => card.variants.length), [3, 3]);
});

test('a requested card count does not merge different observed movements', () => {
  const clips = [clip(0, { label: 'Başını çevir' }), clip(1, { label: 'Elini uzat' })];
  const cards = bundleAdjacentSourceCards(groupSourceChoiceCards(clips), { targetCount: 1 });
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)), [['clip-0'], ['clip-1']]);
});

test('four minute opening groups repeated adjacent actions without inventing intervals', () => {
  const clips = Array.from({ length: 8 }, (_, index) => ({
    id: `opening-${index}`, sourceVerified: true, actionType: index < 4 ? 'kiss' : 'touch',
    label: index < 4 ? 'Yakınlaşma' : 'Temas', locationId: 'salon',
    startTime: index * 30, endTime: (index + 1) * 30
  }));
  const cards = groupVerifiedApproachChoices(clips);
  assert.deepEqual(cards.map(card => card.variants.length), [4, 4]);
  assert.deepEqual(cards.flatMap(card => card.variants.map(item => item.id)), clips.map(item => item.id));
  assert.equal(groupVerifiedApproachChoices(clips.slice(0, 1))[0].variants.length, 1);
});

test('verified rhythmic actions with distinct labels retain their own movement cards', () => {
  const movements = [
    clip(0, { actionType: 'position', movementType: 'ritmik temas', label: 'İlk ritmik kesit' }),
    clip(1, { actionType: 'position', movementType: 'ritmik hareket', label: 'Aynı ritmi sürdür',
      loopStartTime: 9.6, loopEndTime: 14.6 }),
    clip(2, { actionType: 'tempo_change', movementType: 'hızlı hareket', label: 'Hızlanan hareket',
      movementTempo: 'fast', loopStartTime: 14.6, loopEndTime: 19.6 })
  ];
  const position = { id: 'observed-pose', occurrenceId: 'observed-occurrence',
    startTime: 0, endTime: 19.6, sourceRanges: [
      { id: 'trail-a', sourceVerified: true, startTime: 0, endTime: 5 },
      { id: 'trail-a', sourceVerified: true, startTime: 9.6, endTime: 19.6 }
    ], movements };
  const cards = buildVerifiedMovementChoices(movements, 'Observed pose', 4, position);
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    [['clip-0'], ['clip-1'], ['clip-2']]);
  assert.deepEqual(cards[0].variants.map(item => [item.loopStartTime, item.loopEndTime]),
    [[0, 5]]);
  const differentCast = movements.map((item, index) => index === 1
    ? { ...item, partnerTrackId: 'person-c' } : item);
  assert.deepEqual(buildVerifiedMovementChoices(differentCast,
    'Observed pose', 4, { ...position, movements: differentCast })
    .map(card => card.variants.length), [1, 1, 1]);
  const longGap = movements.map((item, index) => index === 1
    ? { ...item, loopStartTime: 11, loopEndTime: 14.6 } : item);
  assert.deepEqual(buildVerifiedMovementChoices(longGap,
    'Observed pose', 4, { ...position, movements: longGap })
    .map(card => card.variants.length), [1, 1, 1]);
});

test('opening variants separate a calm and an intense rendition of the same action', () => {
  const clips = [
    { id: 'calm', sourceVerified: true, label: 'Yakınlaşma', actionType: 'kiss',
      movementTempo: 'slow', femaleProgressRate: 0.5, startTime: 0, endTime: 10 },
    { id: 'intense', sourceVerified: true, label: 'Yakınlaşma', actionType: 'kiss',
      movementTempo: 'fast', femaleProgressRate: 1.8, startTime: 10, endTime: 20 }
  ];
  assert.deepEqual(groupVerifiedApproachChoices(clips).map(card => card.variants.map(item => item.id)),
    [['calm'], ['intense']]);
});

test('minor analyzed rate variation within one steady motion keeps source cuts on one card', () => {
  const clips = [0.94, 1.02, 1.08].map((femaleProgressRate, index) => ({
    id: `steady-${index}`, sourceVerified: true, label: 'Yakınlaşma', actionType: 'kiss',
    movementTempo: 'moderate', femaleProgressRate,
    startTime: index * 10, endTime: (index + 1) * 10
  }));
  assert.deepEqual(groupVerifiedApproachChoices(clips).map(card => card.variants.map(item => item.id)),
    [['steady-0', 'steady-1', 'steady-2']]);
});

test('location and clothing stages retire old cards without erasing current stage replays', () => {
  const clips = [
    { id: 'salon', startTime: 0, endTime: 30, locationId: 'salon', beforeState: { clothing: 'dressed' } },
    { id: 'room-dressed', startTime: 30, endTime: 60, locationId: 'bedroom', beforeState: { clothing: 'dressed' } },
    { id: 'room-changed', startTime: 60, endTime: 90, locationId: 'bedroom', beforeState: { clothing: 'changed' } }
  ];
  assert.deepEqual(approachStageChoices(clips, 40).map(item => item.id), ['room-dressed']);
  assert.deepEqual(approachStageChoices(clips, 75).map(item => item.id), ['room-changed']);
  assert.deepEqual(approachStageChoices([clips[0], { ...clips[0], id: 'again', startTime: 30, endTime: 60 }], 60)
    .map(item => item.id), ['salon', 'again']);
});

test('declared scene transition retires old cards when room and outfit data are absent', () => {
  const clips = [
    { id: 'old', sceneId: 'scene-a', actionType: 'kiss', startTime: 0, endTime: 10 },
    { id: 'cut', sceneId: 'scene-a', actionType: 'scene_transition', startTime: 10, endTime: 12 },
    { id: 'new', sceneId: 'scene-b', actionType: 'kiss', startTime: 12, endTime: 22 }
  ];
  assert.deepEqual(approachStageChoices(clips, 20).map(item => item.id), ['new']);
  assert.deepEqual(approachStageChoices(clips.map(item => ({ ...item, sceneId: '' })), 20)
    .map(item => item.id), ['new']);
});

test('adjacent verified opening transitions offer the next source card without replaying the old stage', () => {
  const clips = [
    { id: 'wardrobe', sourceVerified: true, choiceSurface: 'approach',
      sceneId: 'chapter-a', actionType: 'clothing', startTime: 71.5, endTime: 82.5 },
    { id: 'approach', sourceVerified: true, choiceSurface: 'approach',
      sceneId: 'chapter-a', actionType: 'body_transition', movementType: 'approach',
      subjectTrackId: 'actor', partnerTrackId: 'partner', startTime: 82.5, endTime: 96 },
    { id: 'pose', sourceVerified: true, choiceSurface: 'approach',
      sceneId: 'chapter-a', actionType: 'body_transition', movementType: 'sit',
      subjectTrackId: 'actor', partnerTrackId: 'partner', startTime: 96, endTime: 110.598 },
    { id: 'different-room', sourceVerified: true, choiceSurface: 'approach',
      sceneId: 'chapter-b', actionType: 'body_transition',
      subjectTrackId: 'actor', partnerTrackId: 'partner', startTime: 110.598, endTime: 124 }
  ];
  assert.deepEqual(approachStageChoices(clips, 82.5).map(item => item.id), ['approach', 'pose']);
  assert.deepEqual(approachStageChoices(clips, 96).map(item => item.id), ['pose']);
  assert.deepEqual(approachStageChoices(clips, 110.598).map(item => item.id), ['different-room']);
});

test('a source gap, cast change or clothing change prevents a forward transition preview', () => {
  const base = { sourceVerified: true, choiceSurface: 'approach', sceneId: 'chapter-a',
    subjectTrackId: 'actor', partnerTrackId: 'partner', actionType: 'body_transition' };
  const first = { ...base, id: 'first', startTime: 10, endTime: 20 };
  for (const second of [
    { startTime: 25, endTime: 30 },
    { startTime: 20, endTime: 30, partnerTrackId: 'another' },
    { startTime: 20, endTime: 30, actionType: 'clothing' },
    { startTime: 20, endTime: 30, beforeState: { clothing: 'changed' } }
  ]) {
    assert.deepEqual(approachStageChoices([first, { ...base, id: 'second', ...second }], 10)
      .map(item => item.id), ['first']);
  }
});

test('the contextual control reserves later energetic source clips without duplicating cards', () => {
  const movements = [clip(0, { movementTempo: 'slow' }),
    clip(1, { movementTempo: 'fast' }), clip(2, { movementTempo: 'fast' }),
    clip(3, { movementTempo: 'fast' })];
  const position = { id: 'trail', startTime: 0, endTime: 20,
    sourceRanges: [{ id: 'trail-a', startTime: 0, endTime: 20 }], movements };
  const reserved = exclusiveControlClipIds(position);
  assert.deepEqual([...reserved], ['clip-2', 'clip-3']);
  const cards = buildVerifiedMovementChoices(movements.filter(item => !reserved.has(item.id)), 'Yürüyüş', 5, position);
  assert.deepEqual(cards.flatMap(card => card.variants.map(item => item.id)), ['clip-0', 'clip-1']);
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

test('verified identity follows a source action into every adult card without exposing placeholders', () => {
  const identified = clip(0, { label: 'Ritmi sürdür', identityResolution: 'verified', primaryCharacterLabel: 'Deniz' });
  const cards = buildVerifiedMovementChoices([identified], 'Aynı Pozisyon', 5);
  assert.equal(cards[0].label, 'Ritmi sürdür · Deniz');
  assert.equal(sourceIdentityLabel('Ritmi sürdür', identified), 'Ritmi sürdür · Deniz');
  assert.equal(sourceIdentityLabel('Ritmi sürdür · Deniz', identified), 'Ritmi sürdür · Deniz');
  assert.equal(sourceIdentityLabel('Ritmi sürdür', { ...identified, primaryCharacterLabel: 'Karakter A' }), 'Ritmi sürdür');
});

test('internal track aliases never appear as user-facing names without verified identity', () => {
  const tracked = clip(0, {
    label: 'Ritmi sürdür',
    partnerTrackId: 'PARTNER_B',
    identityResolution: 'unknown',
    primaryCharacterLabel: 'Karakter B'
  });
  assert.equal(sourceIdentityLabel('Ritmi sürdür', tracked), 'Ritmi sürdür');
  assert.equal(sourceIdentityLabel('Ritmi sürdür', {
    ...tracked,
    primaryCharacterLabel: 'Karakter A'
  }), 'Ritmi sürdür');
  assert.equal(sourceIdentityLabel('Karakter B ile konuş', tracked), 'Onunla konuş');
  assert.equal(sourceIdentityLabel('Onunla konuş', {
    ...tracked, identityResolution: 'verified', primaryCharacterLabel: 'Deniz'
  }), 'Onunla konuş · Deniz');
});

test('an already verified adult partner relationship remains the card identity instead of duplicating the proper name', () => {
  const spouse = clip(0, { label: 'Eşiyle ritmi sürdür', identityResolution: 'verified',
    primaryCharacterLabel: 'Meral', relationshipResolution: 'verified', relationshipRoleLabel: 'eşi' });
  assert.equal(buildVerifiedMovementChoices([spouse], 'Aynı Pozisyon', 5)[0].label, 'Eşiyle ritmi sürdür');
});

test('five declared source actions stay independently addressable even when the card preference is smaller', () => {
  const actions = Array.from({ length: 5 }, (_, index) => clip(index, {
    label: `Source action ${index + 1}`, sourceActionId: `observed:${index}`,
    actionType: 'opaque-kind', sourceOccurrenceId: 'occurrence:a'
  }));
  const before = structuredClone(actions);
  const cards = groupSourceChoiceCards(actions, {
    preferredCount: 2, contextFor: () => 'occurrence:a', mergeWithinContext: true
  });
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map(card => card.label), actions.map(action => action.label));
  assert.deepEqual(cards.flatMap(card => card.variants), actions);
  assert.deepEqual(actions, before);
});

test('opaque action types remain distinct inside one trusted display context', () => {
  const actions = [clip(0, { actionType: 'type:A' }), clip(1, { actionType: 'type:A' }),
    clip(2, { actionType: 'type:B' }), clip(3, { actionType: 'type:B' })];
  const cards = groupSourceChoiceCards(actions, { contextFor: () => 'same', mergeWithinContext: true });
  assert.deepEqual(cards.map(card => card.variants.map(action => action.actionType)),
    [['type:A', 'type:A'], ['type:B', 'type:B']]);
});

test('five adjacent parts of the same observed action form one card', () => {
  const parts = Array.from({ length: 5 }, (_, index) => clip(index, {
    derivedFromVerifiedSegment: 'observed:a', label: 'Chapter A'
  }));
  const cards = groupSourceChoiceCards(parts);
  assert.deepEqual(cards.map(card => card.variants.length), [5]);
  assert.ok(cards.every(card => card.label === 'Chapter A'));
  assert.deepEqual(cards.flatMap(card => card.variants), parts);
  const [single] = groupSourceChoiceCards([parts[0]]);
  assert.equal(single.label, 'Chapter A');
  assert.deepEqual(single.variants, [parts[0]]);
});

test('reused source and action IDs cannot combine declared different occurrences', () => {
  const actions = [clip(0, { sourceOccurrenceId: 'occurrence:a', derivedFromVerifiedSegment: 'observed:a' }),
    clip(20, { sourceOccurrenceId: 'occurrence:b', derivedFromVerifiedSegment: 'observed:a' })];
  const cards = groupSourceChoiceCards(actions);
  assert.deepEqual(cards.map(card => card.variants.map(action => action.id)), [['clip-0'], ['clip-20']]);
  assert.deepEqual(cards.flatMap(card => card.variants).map(action => [action.loopStartTime, action.loopEndTime]),
    [[0, 5], [100, 105]]);
});

test('verified provider display labels remain opaque and partner distinction is explicit', () => {
  const group = { sourceVerified: true, positionLabel: 'Chapter A', partnerLabel: 'Participant B' };
  assert.equal(sourceDisplayLabel(group, 'Existing fallback'), 'Chapter A');
  assert.equal(sourceDisplayLabel(group, 'Existing fallback', { distinguishPartner: true }),
    'Chapter A');
  assert.equal(sourceDisplayLabel({ ...group, partnerLabel: 'Meral' }, 'Existing fallback',
    { distinguishPartner: true }), 'Chapter A · Meral');
  assert.equal(sourceDisplayLabel({ ...group, positionLabel: 'Chapter A · Participant B' }, '',
    { distinguishPartner: true }), 'Chapter A · Participant B');
  assert.equal(sourceDisplayLabel({ ...group, sourceVerified: false }, 'Existing fallback'), 'Existing fallback');
  assert.equal(sourceDisplayLabel({ ...group, positionLabel: '' }, 'Existing fallback'), 'Existing fallback');
});


test('distinct labels and unverified gaps do not merge just because the intensity matches', () => {
  const specs = [
    { id: 'fast-a', start: 10, end: 16, label: 'Hızlan', tempo: 'fast' },
    { id: 'fast-b', start: 18.4, end: 24, label: 'Hızlı sürdür', tempo: 'fast' },
    { id: 'fast-c', start: 26.4, end: 32, label: 'Hızlı hareket', tempo: 'fast' },
    { id: 'intense-a', start: 34.4, end: 40, label: 'Yoğunlaştır', tempo: 'fast' }
  ];
  const clips = specs.map(spec => ({ id: spec.id, sourceActionId: spec.id,
    sourceVerified: true, sourcePositionId: 'same-occurrence',
    positionOccurrenceId: 'same-occurrence', actionType: 'movement',
    movementType: spec.label, label: spec.label, movementTempo: spec.tempo,
    startTime: spec.start, endTime: spec.end,
    loopStartTime: spec.start, loopEndTime: spec.end }));
  const parent = { id: 'position', occurrenceId: 'same-occurrence',
    partnerTrackId: 'partner-a', startTime: 10, endTime: 40,
    sourceRanges: specs.map(spec => ({ id: 'same-occurrence', startTime: spec.start, endTime: spec.end })) };
  const cards = buildVerifiedMovementChoices(clips, 'Recorded activity', 5, parent);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    [['fast-a'], ['fast-b'], ['fast-c'], ['intense-a']]);
  assert.equal(new Set(cards.flatMap(card => card.variants.map(item => item.id))).size, 4);
});

test('adjacent changes stay distinct while adjacent matching cuts share one bounded card', () => {
  const clips = [
    clip(0, { label: 'Patikada yürü', loopStartTime: 10, loopEndTime: 20 }),
    clip(1, { label: 'Patikada yürü', loopStartTime: 20, loopEndTime: 30 }),
    clip(2, { label: 'Dur ve etrafa bak', loopStartTime: 30, loopEndTime: 40 }),
    clip(3, { label: 'Patikada yürü', loopStartTime: 40, loopEndTime: 50 }),
    clip(4, { label: 'Patikada yürü', loopStartTime: 60, loopEndTime: 70 })
  ];
  const position = { id: 'trail', startTime: 10, endTime: 70,
    sourceRanges: [{ id: 'trail-a', startTime: 10, endTime: 50 },
      { id: 'trail-a', startTime: 60, endTime: 70 }] };
  const cards = buildVerifiedMovementChoices(clips, 'Yürüyüş', 5, position);
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    [['clip-0', 'clip-1'], ['clip-2'], ['clip-3'], ['clip-4']]);
  assert.deepEqual(cards.map(card => card.label),
    ['Patikada yürü', 'Dur ve etrafa bak', 'Patikada yürü', 'Patikada yürü']);
});

test('eight distinct source actions remain eight cards even with a smaller display target', () => {
  const clips = Array.from({ length: 8 }, (_, index) => clip(index, {
    label: `Recorded action ${index + 1}`,
    sourceOccurrenceId: 'one-occurrence',
    loopStartTime: 10 + index * 10,
    loopEndTime: 20 + index * 10
  }));
  const atomic = groupSourceChoiceCards(clips);
  const cards = bundleAdjacentSourceCards(atomic, { targetCount: 4 });
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    clips.map(item => [item.id]));
  assert.deepEqual(cards[0].sourceLabels, ['Recorded action 1']);
  assert.deepEqual(cards.flatMap(card => card.variants), clips);
});

test('card density never joins a source gap or a different occurrence', () => {
  const clips = Array.from({ length: 6 }, (_, index) => clip(index, {
    label: `Recorded action ${index + 1}`,
    sourceOccurrenceId: index < 3 ? 'first' : 'second',
    loopStartTime: index < 3 ? index * 10 : 100 + (index - 3) * 10,
    loopEndTime: index < 3 ? (index + 1) * 10 : 110 + (index - 3) * 10
  }));
  const cards = bundleAdjacentSourceCards(groupSourceChoiceCards(clips), { targetCount: 2 });
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    clips.map(item => [item.id]));
  const distant = clips.map((item, index) => ({ ...item,
    loopStartTime: item.loopStartTime + index * 3,
    loopEndTime: item.loopEndTime + index * 3 }));
  assert.equal(bundleAdjacentSourceCards(groupSourceChoiceCards(distant), { targetCount: 2 }).length, 6);
});
