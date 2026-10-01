import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as gameplay from '../public/adult-gameplay.js';
import { sourceRangeForClip } from '../public/sequence-integrity.js';
import { matchSceneIntroductions } from '../public/scene-entry.js';
import { isAdultSocialRelationshipRole } from '../public/relationship-roles.js';
import { sourceIdentityLabel, sourceDisplayLabel } from '../public/choice-groups.js';
import { interactionEntryGuard, interactionClipGuard } from '../public/interaction-timeline.js';

test('verified action time repairs zeroed position and loop metadata', () => {
  const repaired = gameplay.normalizeSourceActionTimes({ startTime: 332.653, endTime: 345.5,
    positionStartTime: 0, positionEndTime: 0, loopStartTime: 0, loopEndTime: 0 });
  assert.deepEqual([repaired.positionStartTime, repaired.positionEndTime,
    repaired.loopStartTime, repaired.loopEndTime], [332.653, 345.5, 332.653, 345.5]);
  const valid = gameplay.normalizeSourceActionTimes({ startTime: 10, endTime: 12,
    positionStartTime: 8, positionEndTime: 15, loopStartTime: 10.2, loopEndTime: 11.8 });
  assert.deepEqual([valid.positionStartTime, valid.positionEndTime,
    valid.loopStartTime, valid.loopEndTime], [8, 15, 10.2, 11.8]);
});

test('conversation and ordinary posture cannot open the sex panel', () => {
  assert.equal(gameplay.playableAdultPanelFamily({ sourceVerified: true, adultScene: false,
    label: 'Twister oyununu izle', actionType: 'other', receiverBodyOrientation: 'standing',
    positionConfigurationConfidence: 0.95, positionEvidence: 'Ayakta duruyor.' }), '');
  assert.equal(gameplay.playableAdultPanelFamily({ sourceVerified: true, adultScene: true,
    label: 'Kanepede konuş', actionType: 'other', receiverBodyOrientation: 'seated',
    positionId: '', positionLabel: '' }), '');
  assert.equal(gameplay.playableAdultPanelFamily({ sourceVerified: true, adultScene: true,
    label: 'Kaynakta doğrulanan hareket', actionType: 'position', positionId: 'oral' }), 'oral');
});

// Run the actual graph preparation with a neutral classifier stub. These tests
// concern provenance and timeline integrity, not visual classification quality.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function prepareAdultScenes()');
const end = source.indexOf('\nfunction adultAnalysisTraceText()', start);
const handler = source.slice(start, end);
const action = (id, start, end, extra = {}) => ({
  actionId: id, label: `Observed action ${id}`, sourceVerified: true, confidence: 0.95,
  adultScene: true, adultSceneId: 'scene-a', adultSceneStartTime: 0, adultSceneEndTime: 200,
  positionId: 'chapter', positionLabel: 'Chapter', positionOccurrenceId: 'chapter-a',
  positionStartTime: 0, positionEndTime: 200, startTime: start, endTime: end,
  loopStartTime: start, loopEndTime: end, ...extra
});

function prepare(actions, overrides = {}) {
  const state = { analysis: { actions }, analysisFingerprint: 'test' };
  const scope = vm.createContext({
    ...gameplay, state, ENGINE_VERSION: 'test', matchSceneIntroductions, isAdultSocialRelationshipRole,
    sourceIdentityLabel, sourceDisplayLabel, interactionEntryGuard,
    bindActionCharacter: item => item,
    verifiedAdultPositionFamily: item => item.sourceVerified ? 'chapter' : '',
    playableAdultPanelFamily: item => item.sourceVerified && item.adultScene && item.positionId ? 'chapter' : '',
    canonicalAdultPosition: () => ({ id: 'chapter', label: 'Chapter' }),
    adultCategoryFor: () => ({ id: 'chapter', label: 'Chapter' }),
    activityOccurrenceNamespace: () => 'unclear',
    activityDisplayLabel: label => label,
    normalizeAdultLabel: value => String(value).toLowerCase(),
    movementBelongsToVerifiedPosition: item => item.sourceVerified === true && item.accepted !== false,
    mergeAdultSceneFragments: scenes => scenes,
    isWarmupPosition: () => false, isBonusPosition: () => false,
    renderAdultAnalysisTrace() {},
    ...overrides
  });
  vm.runInContext(`${handler}\nprepareAdultScenes();`, scope);
  return state;
}

test('preparation never fabricates a verified full-parent clip from rejected evidence', () => {
  const state = prepare([action('rejected', 10, 30, { accepted: false })]);
  assert.equal(state.adultScenes.length, 0);
});

test('ordinary observation and opening dialogue stay outside the panel', () => {
  const ordinary = action('watch', 48, 55, { adultScene: false, adultSceneId: '',
    positionId: '', positionLabel: '', actionType: 'other', label: 'Twister oyununu izle' });
  const talk = action('talk', 332, 344, { positionId: '', positionLabel: '',
    actionType: 'other', label: 'Kanepede konuş', adultSceneStartTime: 332,
    adultSceneEndTime: 420 });
  const kiss = action('kiss', 344, 362, { positionId: '', positionLabel: '',
    actionType: 'kiss', adultSceneStartTime: 332, adultSceneEndTime: 420 });
  const dialogue = action('listen', 362, 380, { positionId: '', positionLabel: '',
    actionType: 'other', label: 'Kuralları dinle', adultSceneStartTime: 332,
    adultSceneEndTime: 420 });
  const core = action('core', 390, 408, { actionType: 'position', positionId: 'oral',
    positionStartTime: 390, positionEndTime: 408, adultSceneStartTime: 332,
    adultSceneEndTime: 420 });
  const state = prepare([ordinary, talk, kiss, dialogue, core], {
    playableAdultPanelFamily: gameplay.playableAdultPanelFamily
  });
  assert.equal(state.adultScenes.length, 1);
  assert.equal(state.adultScenes[0].startTime, 332);
  assert.deepEqual(Array.from(state.adultScenes[0].foreplay, item => item.id), ['talk', 'kiss', 'listen']);
  assert.equal(state.adultScenes[0].positions[0].startTime, 390);
  assert.equal(state.adultAnalysisTrace.actions[0].route, 'NOT_ROUTED');
});

test('a verified introduction with a different scene ID opens the panel before its first position', () => {
  const cast = { subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A' };
  const warmup = [action('approach', 217.5, 230, { ...cast, adultSceneId: 'intro',
    adultSceneStartTime: 217.5, adultSceneEndTime: 319.3, actionType: 'kiss',
    positionId: '', positionLabel: '' }),
  action('continue', 230, 319.3, { ...cast, adultSceneId: 'intro',
    adultSceneStartTime: 217.5, adultSceneEndTime: 319.3, actionType: 'touch',
    positionId: '', positionLabel: '' }),
  action('transition', 319.3, 328, { ...cast, adultSceneId: 'main',
    adultSceneStartTime: 319.3, adultSceneEndTime: 400, actionType: 'body_transition',
    positionId: '', positionLabel: '' })];
  const core = action('core', 328, 346, { ...cast, adultSceneId: 'main', actionType: 'position',
    adultSceneStartTime: 319.3, adultSceneEndTime: 400,
    positionStartTime: 328, positionEndTime: 346 });
  const state = prepare([...warmup, core]);
  assert.equal(state.adultScenes.length, 1);
  assert.equal(state.adultScenes[0].startTime, 217.5);
  assert.deepEqual(Array.from(state.adultScenes[0].foreplay, item => item.id),
    ['approach', 'continue', 'transition']);
});

test('preparation routes a verified same-cast introduction into its adjacent scene without changing source times', () => {
  const intro = action('intro', 5, 10, { actionType: 'touch', positionId: '', positionLabel: '',
    adultScene: false, adultSceneId: '', adultSceneStartTime: undefined, adultSceneEndTime: undefined,
    subjectTrackId: 'a', partnerTrackId: 'b' });
  const core = action('main', 10, 20, { subjectTrackId: 'a', partnerTrackId: 'b',
    adultSceneStartTime: 10, adultSceneEndTime: 20, positionStartTime: 10, positionEndTime: 20 });
  const classifier = { verifiedAdultPositionFamily: item => item.positionId ? 'chapter' : '' };
  const state = prepare([intro, core], classifier);
  assert.equal(state.adultScenes.length, 1);
  assert.equal(state.adultScenes[0].foreplay.length, 1);
  assert.deepEqual([state.adultScenes[0].foreplay[0].startTime, state.adultScenes[0].foreplay[0].endTime], [5, 10]);
  assert.equal(intro.adultScene, false);
  assert.equal(intro.adultSceneId, '');
  assert.equal(state.adultAnalysisTrace.actions[0].route, 'FOREPLAY');
  assert.equal(state.adultAnalysisTrace.warnings.some(row => row.code === 'CHARACTER_CONTEXT_MISSING'), true);
  const ordinaryFamily = prepare([{ ...intro, relationshipResolution: 'verified', relationshipRoleLabel: 'kızı' }, core], classifier);
  assert.equal(ordinaryFamily.adultScenes[0].foreplay.length, 0);
});

for (const example of [
  { name: 'starts after the first action', sceneStart: 90, sceneEnd: 100,
    intervals: [[80, 90], [90, 100]] },
  { name: 'ends before the action', sceneStart: 0, sceneEnd: 80,
    intervals: [[90, 100]] }
]) {
  test(`verified introduction intervals survive provider scene metadata that ${example.name}`, () => {
    const cast = { subjectTrackId: 'actor-a', partnerTrackId: 'actor-b' };
    const metadata = { ...cast, adultSceneStartTime: example.sceneStart,
      adultSceneEndTime: example.sceneEnd };
    const introductions = example.intervals.map(([start, end], index) =>
      action(`approach-${index}`, start, end, { ...metadata,
        actionType: 'touch', positionId: '', positionLabel: '' }));
    const rejected = action('unverified-approach', 70, 80, { ...metadata,
      sourceVerified: false, actionType: 'touch', positionId: '', positionLabel: '' });
    const core = action('chapter', 100, 120, { ...metadata, actionType: 'position',
      positionStartTime: 100, positionEndTime: 120 });
    const actions = [rejected, ...introductions, core];
    const original = structuredClone(actions);
    const state = prepare(actions, {
      verifiedAdultPositionFamily: item => item.sourceVerified && item.positionId ? 'chapter' : ''
    });

    assert.equal(state.adultScenes.length, 1);
    const scene = state.adultScenes[0];
    assert.deepEqual(Array.from(scene.foreplay, item =>
      [item.id, item.startTime, item.endTime, item.sourceVerified]),
    example.intervals.map(([start, end], index) => [`approach-${index}`, start, end, true]));
    assert.equal(scene.startTime, example.intervals[0][0]);
    assert.equal(scene.endTime, 120);
    assert.deepEqual(Array.from(scene.positions[0].sourceRanges,
      item => [item.startTime, item.endTime]), [[100, 120]]);
    assert.ok(scene.positions[0].movements.every(item => sourceRangeForClip(scene.positions[0], item)));
    assert.equal(scene.positions[0].movements.some(item => item.positionOnlyFallback), false);
    assert.equal(state.adultAnalysisTrace.actions.find(item =>
      item.actionId === 'unverified-approach').route, 'REJECTED');
    assert.deepEqual(actions, original);
  });
}

test('introduction routing still rejects unverified actions, a different cast, and a large source gap', () => {
  const cast = { subjectTrackId: 'actor-a', partnerTrackId: 'actor-b' };
  const core = action('chapter', 100, 120, { ...cast, actionType: 'position',
    adultSceneStartTime: 90, adultSceneEndTime: 100,
    positionStartTime: 100, positionEndTime: 120 });
  const examples = [
    action('unverified', 90, 100, { ...cast, sourceVerified: false }),
    action('different-cast', 90, 100, { ...cast, partnerTrackId: 'actor-c' }),
    action('large-gap', 10, 20, cast)
  ];
  for (const example of examples) {
    const introduction = { ...example, actionType: 'touch', positionId: '', positionLabel: '',
      adultScene: false, adultSceneId: '', adultSceneStartTime: undefined,
      adultSceneEndTime: undefined };
    const actions = [introduction, core];
    const original = structuredClone(actions);
    const state = prepare(actions, {
      verifiedAdultPositionFamily: item => item.sourceVerified && item.positionId ? 'chapter' : ''
    });
    assert.equal(state.adultScenes.length, 1, example.actionId);
    assert.equal(state.adultScenes[0].foreplay.length, 0, example.actionId);
    assert.equal(state.adultScenes[0].startTime, 100, example.actionId);
    assert.deepEqual(Array.from(state.adultScenes[0].positions[0].sourceRanges,
      item => [item.startTime, item.endTime]), [[100, 120]], example.actionId);
    assert.equal(state.adultAnalysisTrace.actions[0].route, 'NOT_ROUTED', example.actionId);
    assert.deepEqual(actions, original, example.actionId);
  }
});

test('adjacent same-label introductions retain separate source intervals for different casts', () => {
  const metadata = { adultSceneStartTime: 90, adultSceneEndTime: 100,
    subjectTrackId: 'actor-a' };
  const actions = [
    action('first-approach', 80, 90, { ...metadata, partnerTrackId: 'actor-b',
      label: 'Observed action', actionType: 'touch', positionId: '', positionLabel: '' }),
    action('second-approach', 90, 100, { ...metadata, partnerTrackId: 'actor-c',
      label: 'Observed action', actionType: 'touch', positionId: '', positionLabel: '' }),
    action('chapter', 100, 120, { ...metadata, partnerTrackId: 'actor-c',
      actionType: 'position', positionStartTime: 100, positionEndTime: 120 })
  ];
  const original = structuredClone(actions);
  const state = prepare(actions);

  assert.equal(state.adultScenes.length, 1);
  assert.deepEqual(Array.from(state.adultScenes[0].foreplay, item =>
    [item.id, item.startTime, item.endTime, item.subjectTrackId, item.partnerTrackId]), [
    ['first-approach', 80, 90, 'actor-a', 'actor-b'],
    ['second-approach', 90, 100, 'actor-a', 'actor-c']
  ]);
  assert.deepEqual(actions, original);
});

test('adjacent same-label dialogue and introduction retain their separate progress roles', () => {
  const metadata = { adultSceneStartTime: 90, adultSceneEndTime: 100,
    subjectTrackId: 'actor-a', partnerTrackId: 'actor-b' };
  const actions = [
    action('dialogue', 80, 90, { ...metadata, label: 'Observed action',
      actionType: 'other', positionId: '', positionLabel: '' }),
    action('approach', 90, 100, { ...metadata, label: 'Observed action',
      actionType: 'touch', positionId: '', positionLabel: '' }),
    action('chapter', 100, 120, { ...metadata, actionType: 'position',
      positionStartTime: 100, positionEndTime: 120 })
  ];
  const original = structuredClone(actions);
  const state = prepare(actions);

  assert.equal(state.adultScenes.length, 1);
  assert.deepEqual(Array.from(state.adultScenes[0].foreplay, item =>
    [item.id, item.startTime, item.endTime, item.nonIntimate]), [
    ['dialogue', 80, 90, true],
    ['approach', 90, 100, false]
  ]);
  assert.deepEqual(actions, original);
});

test('short source evidence does not authorize a longer parent fallback', () => {
  const state = prepare([action('short', 10, 11)]);
  assert.equal(state.adultScenes.length, 0);
});

test('wide parent declarations preserve only the exact accepted source intervals', () => {
  const state = prepare([
    action('first', 10, 30, { sourcePositionId: 'provider-parent' }), action('later', 90, 110),
    action('unverified', 35, 85, { sourceVerified: false })
  ]);
  assert.equal(state.adultScenes.length, 2);
  assert.deepEqual(Array.from(state.adultScenes, scene => [scene.startTime, scene.endTime]), [[10, 30], [90, 110]]);
  const positions = state.adultScenes.flatMap(scene => scene.positions);
  assert.equal(positions.length, 2);
  assert.deepEqual(Array.from(positions.flatMap(position => position.sourceRanges),
    range => [range.startTime, range.endTime]), [[10, 30], [90, 110]]);
  for (const p of positions) {
    assert.ok(p.movements.every(m => sourceRangeForClip(p, m)));
    assert.equal(p.movements.some(m => m.positionOnlyFallback || m.sourceActionId === 'unverified'), false);
    const cardMovements = p.movementChoices.flatMap(c => c.variants);
    assert.equal(cardMovements.filter(m => m.id === p.entryMovementId).length, 1);
    assert.deepEqual(cardMovements.map(m => m.id).sort(), p.movements.map(m => m.id).sort());
    assert.equal(cardMovements.every(m => sourceRangeForClip(p, m) && p.movements.includes(m)), true);
  }
});

test('separate scenes retain separate parent cards and source intervals', () => {
  const state = prepare([
    action('first', 10, 30),
    action('last', 310, 330, { adultSceneId: 'scene-b', adultSceneStartTime: 300,
      adultSceneEndTime: 400, positionStartTime: 300, positionEndTime: 400 })
  ]);
  assert.equal(state.adultScenes.length, 2);
  assert.equal(state.adultScenes[0].positions[0].movements.every(m => m.loopEndTime <= 30), true);
  assert.equal(state.adultScenes[1].positions[0].movements.every(m => m.loopStartTime >= 310), true);
});

test('verified opaque position labels survive scene preparation with the original source intervals', () => {
  const state = prepare([action('source-a', 10, 30, { positionLabel: 'Chapter A' })]);
  const position = state.adultScenes[0].positions[0];
  assert.equal(position.positionLabel, 'Chapter A');
  assert.equal(position.label, 'Chapter A');
  assert.deepEqual(Array.from(position.sourceRanges, range => [range.startTime, range.endTime]), [[10, 30]]);
  const corrected = prepare([action('source-a', 10, 30, { positionLabel: 'Chapter A' })], {
    canonicalAdultPosition: () => ({ id: 'chapter', label: 'Verified correction', correctedFromAction: true })
  });
  assert.equal(corrected.adultScenes[0].positions[0].label, 'Verified correction');
  assert.equal(corrected.adultScenes[0].positions[0].positionLabel, '');
});

test('a verified adjacent transition opens a group without becoming core evidence or hiding the entry movement', () => {
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  const transition = action('entry:a', 6, 9.9, { ...cast, adultScene: false, adultSceneId: 'intro:a',
    actionType: 'body_transition', positionId: '', positionLabel: '' });
  const core = action('core:a', 10, 20, { ...cast, adultSceneId: 'core:a', actionType: 'position',
    positionLabel: 'Chapter A', positionStartTime: 10, positionEndTime: 20 });
  const original = structuredClone([transition, core]);
  const state = prepare([transition, core]);
  const position = state.adultScenes[0].positions[0];
  assert.equal(state.adultScenes[0].startTime, 6);
  assert.deepEqual([position.entryRange.startTime, position.entryRange.endTime], [6, 9.9]);
  assert.equal(position.entryRange.entryForGroupId, position.id);
  const sourceRanges = gameplay.positionOccurrenceGroups(position).flatMap(occurrence =>
    occurrence.sourceRanges.map(range => ({ ...range, occurrenceId: occurrence.id })));
  const group = { ...position, sourceRanges };
  assert.equal(interactionEntryGuard(group, position.entryClip).allowed, true);
  assert.equal(interactionClipGuard(group, position.entryClip).allowed, false);
  assert.deepEqual(Array.from(sourceRanges, range => [range.startTime, range.endTime]), [[10, 20]]);
  assert.equal(position.movementChoices.flatMap(card => card.variants)
    .filter(item => item.id === position.entryMovementId).length, 1);
  assert.deepEqual([transition, core], original);
  assert.equal(state.adultAnalysisTrace.actions[0].membershipReason, 'VERIFIED_SAME_CAST_INTRODUCTION');
});

test('a preceding transition cannot become an entry across another cast, a wide gap or rejected proof', () => {
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  const core = action('core:a', 10, 20, { ...cast, actionType: 'position',
    positionStartTime: 10, positionEndTime: 20 });
  for (const patch of [{ partnerTrackId: 'partner:b' }, { endTime: 9.5, loopEndTime: 9.5 },
    { sourceVerified: false }, { startTime: null }]) {
    const transition = action('entry:a', 6, 9.9, { ...cast, actionType: 'body_transition',
      positionId: '', positionLabel: '', ...patch });
    const state = prepare([transition, core]);
    const position = state.adultScenes[0].positions[0];
    assert.equal(position.entryRange, undefined);
    assert.deepEqual(Array.from(position.sourceRanges, range => [range.startTime, range.endTime]), [[10, 20]]);
  }
});

test('a rejected verified introduction reports its source times and membership reason', () => {
  const core = action('core:a', 100, 120, { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a',
    positionStartTime: 100, positionEndTime: 120 });
  const intro = action('intro:a', 10, 20, { adultScene: false, adultSceneId: '', actionType: 'touch',
    positionId: '', positionLabel: '', subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' });
  const state = prepare([intro, core]);
  const warning = state.adultAnalysisTrace.warnings.find(item => item.code === 'VERIFIED_APPROACH_REJECTED');
  assert.equal(warning.actionId, 'intro:a');
  assert.equal(warning.membershipReason, 'SOURCE_GAP_TOO_LARGE');
  assert.deepEqual([warning.sourceStartTime, warning.sourceEndTime], [10, 20]);
});

test('nearby scene fragments with a different opaque cast remain separate', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const scene = (id, startTime, subject, partner) => ({ id, startTime, endTime: startTime + 10,
    postSceneTime: startTime + 10, positions: [{ subjectTrackId: subject, partnerTrackId: partner }],
    foreplay: [], outcomes: [] });
  assert.equal(mergeFragments([scene('a', 10, 'subject:a', 'partner:a'),
    scene('b', 22, 'subject:a', 'partner:a')]).length, 1);
  for (const [subject, partner] of [['subject:b', 'partner:a'], ['subject:a', 'partner:b'], ['partner:a', 'subject:a']]) {
    assert.equal(mergeFragments([scene('a', 10, 'subject:a', 'partner:a'), scene('b', 22, subject, partner)]).length, 2);
  }
});

test('a wide provider position envelope cannot merge distant exact source chapters', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  const actions = [
    action('source:a', 10, 30, { ...cast, adultSceneId: 'scene:a', positionStartTime: 0, positionEndTime: 1000,
      adultSceneStartTime: 0, adultSceneEndTime: 1000, positionLabel: 'Chapter A' }),
    action('source:b', 400, 420, { ...cast, adultSceneId: 'scene:b', positionStartTime: 400, positionEndTime: 420,
      adultSceneStartTime: 400, adultSceneEndTime: 420, positionLabel: 'Chapter B' })
  ];
  const original = structuredClone(actions);
  const state = prepare(actions, { mergeAdultSceneFragments: mergeFragments });
  assert.equal(state.adultScenes.length, 2);
  assert.deepEqual(Array.from(state.adultScenes, scene => [scene.startTime, scene.endTime]), [[10, 30], [400, 420]]);
  assert.deepEqual(Array.from(state.adultScenes, scene => Array.from(scene.positions[0].sourceRanges,
    range => [range.startTime, range.endTime])), [[[10, 30]], [[400, 420]]]);
  assert.ok(state.adultScenes.every(scene => scene.positions.every(position =>
    position.movements.every(movement => sourceRangeForClip(position, movement)))));
  assert.deepEqual(actions, original);
});

test('unverified scene-tagged provider rows cannot join a distant introduction to a core occurrence', () => {
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  for (const sourceVerified of [false, undefined, 'true', 1]) {
    const intro = action('intro:a', 10, 20, { ...cast, actionType: 'touch', positionId: '', positionLabel: '' });
    const bridges = Array.from({ length: 9 }, (_, index) => {
      const startTime = 40 + index * 40;
      return action(`provider:${index}`, startTime, startTime + 40, { ...cast, sourceVerified,
        actionType: 'touch', positionId: '', positionLabel: '' });
    });
    const core = action('core:a', 400, 420, { ...cast, positionStartTime: 400, positionEndTime: 420 });
    const actions = [intro, ...bridges, core];
    const original = structuredClone(actions);
    const state = prepare(actions);
    assert.equal(state.adultScenes.length, 1);
    const [scene] = state.adultScenes;
    assert.deepEqual([scene.startTime, scene.endTime], [400, 420]);
    assert.equal(scene.foreplay.length, 0);
    assert.deepEqual(Array.from(scene.positions[0].sourceRanges, range => [range.startTime, range.endTime]), [[400, 420]]);
    assert.ok(scene.positions[0].movements.every(movement => sourceRangeForClip(scene.positions[0], movement)));
    const warning = state.adultAnalysisTrace.warnings.find(item => item.code === 'VERIFIED_APPROACH_REJECTED' &&
      item.actionId === 'intro:a');
    assert.ok(warning);
    assert.deepEqual([warning.sourceStartTime, warning.sourceEndTime], [10, 20]);
    assert.deepEqual(actions, original);
  }
});
