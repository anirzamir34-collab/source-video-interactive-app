import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as choiceRouting from '../public/choice-routing.js';
import * as gameplay from '../public/adult-gameplay.js';
import { sourceRangeForClip } from '../public/sequence-integrity.js';
import { matchSceneIntroductions } from '../public/scene-entry.js';
import { isAdultSocialRelationshipRole } from '../public/relationship-roles.js';
import { sourceIdentityLabel, sourceDisplayLabel } from '../public/choice-groups.js';
import { interactionEntryGuard, interactionClipGuard } from '../public/interaction-timeline.js';
import { sourceSpeechOverlaps } from '../public/source-transcript.js';
import { canonicalizeActionTrackIds } from '../public/character-identity.js';

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

function prepare(actions, overrides = {}, sourceContext = null, storyContext = {}) {
  const state = { analysis: { actions, storyContext }, analysisFingerprint: 'test', sourceContext };
  const scope = vm.createContext({
    ...gameplay, ...choiceRouting, state, ENGINE_VERSION: 'test', matchSceneIntroductions, isAdultSocialRelationshipRole, sourceSpeechOverlaps,
    canonicalizeActionTrackIds,
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

test('distant verified intimacy remains a separate progressing panel with explicit track aliases', () => {
  const shared = { partnerTrackId: 'actor-b', positionId: '', positionLabel: '',
    adultScene: false, adultSceneId: '', adultSceneStartTime: undefined,
    adultSceneEndTime: undefined };
  const first = action('approach-1', 84, 93, { ...shared, subjectTrackId: 'char-001',
    actionType: 'kiss', label: 'Observed first kiss' });
  const interlude = action('story-interlude', 93, 106, { ...shared,
    subjectTrackId: 'char-001', actionType: 'story', label: 'Observed conversation' });
  const second = action('approach-2', 115, 133, { ...shared,
    subjectTrackId: 'actor-a', actionType: 'kiss', label: 'Observed second kiss' });
  const third = action('approach-3', 160, 202, { ...shared,
    subjectTrackId: 'actor-a', actionType: 'kiss', label: 'Observed embrace' });
  const core = action('core', 373, 395, { subjectTrackId: 'actor-a', partnerTrackId: 'actor-b',
    adultSceneId: 'scene-core', adultSceneStartTime: 373, adultSceneEndTime: 395,
    positionStartTime: 373, positionEndTime: 395 });
  const actions = [first, interlude, second, third, core];
  const original = structuredClone(actions);
  const state = prepare(actions, {}, null, { characters: [
    { id: 'char-001', participantTrackId: 'actor-a' },
    { id: 'actor-b', participantTrackId: 'actor-b' }
  ] });
  assert.equal(state.adultScenes.length, 2);
  const [opening, positionScene] = state.adultScenes;
  assert.deepEqual(Array.from(opening.foreplay, item => item.id),
    ['approach-1', 'approach-2', 'approach-3']);
  assert.deepEqual(Array.from(opening.dialogue, item => item.id), ['story-interlude']);
  assert.deepEqual([opening.startTime, opening.endTime, opening.positions.length], [84, 202, 0]);
  assert.equal(positionScene.startTime, 373);
  assert.deepEqual(Array.from(positionScene.positions[0].sourceRanges,
    item => [item.startTime, item.endTime]), [[373, 395]]);
  assert.equal(state.adultAnalysisTrace.actions[0].membershipReason, 'VERIFIED_STANDALONE_OPENING');
  assert.deepEqual(actions, original);
});

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
  assert.deepEqual(Array.from(state.adultScenes[0].foreplay, item => item.id), ['kiss']);
  assert.deepEqual(Array.from(state.adultScenes[0].dialogue, item => item.id), ['talk', 'listen']);
  assert.equal(state.adultScenes[0].positions[0].startTime, 390);
  assert.equal(state.adultAnalysisTrace.actions[0].route, 'NOT_ROUTED');
});

test('the reported 117–149.5 second dialogue is stored separately from its adjacent opening and panel clips', () => {
  const cast = { subjectTrackId: 'actor-a', partnerTrackId: 'actor-b' };
  const plain = (id, start, end, type, adultScene = false) => action(id, start, end, {
    ...cast, actionType: type, adultScene, adultSceneId: adultScene ? 'scene-a' : '',
    adultSceneStartTime: adultScene ? 149.5 : start, adultSceneEndTime: adultScene ? 207.63 : end,
    positionId: '', positionLabel: ''
  });
  const rows = [
    plain('ordinary-motion', 93, 102, 'body_transition'),
    plain('ordinary-line', 102, 109.5, 'other'),
    plain('tl-009', 109.5, 117, 'touch'),
    plain('tl-010', 117, 126.5, 'other'),
    plain('tl-011', 126.5, 136.5, 'other'),
    plain('tl-012', 136.5, 149.5, 'other'),
    plain('tl-013', 149.5, 153.8, 'clothing', true),
    plain('tl-014', 153.8, 166.62, 'kiss', true),
    plain('tl-015', 166.62, 179.43, 'touch', true),
    plain('tl-016', 179.43, 196, 'touch', true),
    action('panel-control', 196, 207.63, { ...cast, actionType: 'position',
      positionStartTime: 196, positionEndTime: 207.63 })
  ];
  rows.find(row => row.actionId === 'tl-010').label = 'Elini şakağına götürüp konuş';
  const original = structuredClone(rows);
  const state = prepare(rows, {}, { segments: [
    { startTime: 117, endTime: 126.5 }, { startTime: 126.5, endTime: 136.5 }, { startTime: 136.5, endTime: 149.5 }
  ] });
  const scene = state.adultScenes[0];
  assert.deepEqual(Array.from(scene.dialogue, item => item.id), ['tl-010', 'tl-011', 'tl-012']);
  assert.deepEqual(Array.from(scene.foreplay, item => item.id), ['tl-009', 'tl-013', 'tl-014', 'tl-015', 'tl-016']);
  assert.equal(scene.positions.length, 1);
  const categories = [...scene.dialogue, ...scene.foreplay, ...scene.positions.flatMap(item => item.movements)];
  assert.equal(new Set(categories.map(item => item.id)).size, categories.length);
  for (const row of state.adultAnalysisTrace.actions.filter(row => ['tl-010', 'tl-011', 'tl-012'].includes(row.actionId))) {
    assert.equal(row.route, 'DIALOGUE');
    assert.equal(row.choiceSurface, 'story');
  }
  assert.equal(state.adultAnalysisTrace.actions[0].choiceSurface, 'story');
  assert.deepEqual(rows, original);
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
    adultSceneStartTime: 319.3, adultSceneEndTime: 400, actionType: 'body_transition', choiceSurface: 'approach',
    choiceSurfaceEvidence: 'Observed opening transition', choiceSurfaceConfidence: 0.95,
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

test('the reported long opening joins the verified core without losing source movements or duplicate tabs', () => {
  const cast = { subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A' };
  const intro = (id, start, end, actionType, choiceSurface = 'story', adultScene = false) =>
    action(id, start, end, { ...cast, positionId: '', positionLabel: '', actionType,
      adultScene, adultSceneId: adultScene ? 'intro' : '', choiceSurface,
      choiceSurfaceEvidence: 'Visible source interval', choiceSurfaceConfidence: .95,
      adultSceneStartTime: start, adultSceneEndTime: end });
  const core = (id, start, end, positionId, routeNamespace = 'other') =>
    action(id, start, end, { ...cast, positionId, positionLabel: positionId === 'rear' ? 'Arkadan' : 'Yan pozisyon',
      actionType: 'position', classificationReview: 'verified', activityType: routeNamespace,
      receiverBodyOrientation: 'side_lying', receiverSupport: 'side',
      positionConfigurationConfidence: .95, positionEvidence: 'Verified source posture',
      adultSceneId: id.startsWith('rear') ? 'core-a' : 'core-b',
      adultSceneStartTime: start, adultSceneEndTime: end,
      positionStartTime: start, positionEndTime: end,
      label: positionId === 'rear' ? 'Arkadan ritmik devam et' : 'Yan pozisyonda ritmik hareket et' });
  const rows = [
    intro('talk', 45, 78.5, 'dialogue'),
    intro('contact', 78.5, 86.2, 'touch'),
    intro('kiss', 86.2, 91.5, 'kiss'),
    intro('line', 91.5, 104, 'dialogue'),
    intro('posture', 104, 112.5, 'body_transition'),
    intro('approach', 112.5, 203, 'touch'),
    intro('last-contact', 203, 209, 'touch', 'approach', true),
    core('rear-1', 295, 467.5, 'rear'),
    core('rear-2', 467.5, 479.796, 'rear'),
    core('side-1', 479.796, 515.337, 'spoon', 'vaginal'),
    core('side-2', 515.337, 586.418, 'spoon', 'other')
  ];
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const state = prepare(rows, {
    playableAdultPanelFamily: item => item.positionId || '',
    canonicalAdultPosition: item => ({ id: item.positionId, label: item.positionLabel }),
    adultCategoryFor: item => ({ id: item.activityType || 'other', label: 'Source' }),
    activityOccurrenceNamespace: item => item.activityType || 'other',
    movementBelongsToVerifiedPosition: gameplay.movementBelongsToVerifiedPosition,
    mergeAdultSceneFragments: mergeFragments
  });
  assert.equal(state.adultScenes.length, 1);
  const [scene] = state.adultScenes;
  assert.equal(scene.startTime, 45);
  assert.deepEqual(Array.from(scene.foreplay, item => item.id), ['contact', 'kiss', 'approach', 'last-contact']);
  assert.deepEqual(Array.from(scene.dialogue, item => item.id), ['talk', 'line', 'posture']);
  assert.deepEqual(scene.positions.map(position => position.familyId), ['rear', 'spoon']);
  assert.equal(scene.positions.reduce((total, position) => total + position.movements.length, 0) >= 4, true);
  assert.equal(state.adultAnalysisTrace.actions.find(row => row.actionId === 'last-contact').membershipReason,
    'VERIFIED_SAME_CAST_INTRODUCTION');
  assert.equal(state.adultAnalysisTrace.graph.duplicateFamilies.length, 0);
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

test('introduction routing never joins unverified, different-cast, or distant clips to a core position', () => {
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
    const coreScene = state.adultScenes.at(-1);
    assert.equal(state.adultScenes.length, example.actionId === 'unverified' ? 1 : 2, example.actionId);
    assert.equal(coreScene.foreplay.length, 0, example.actionId);
    assert.equal(coreScene.startTime, 100, example.actionId);
    assert.deepEqual(Array.from(coreScene.positions[0].sourceRanges,
      item => [item.startTime, item.endTime]), [[100, 120]], example.actionId);
    if (example.actionId === 'unverified') {
      assert.equal(state.adultAnalysisTrace.actions[0].route, 'NOT_ROUTED');
    } else {
      assert.deepEqual([state.adultScenes[0].startTime, state.adultScenes[0].endTime],
        [introduction.startTime, introduction.endTime]);
      assert.equal(state.adultScenes[0].foreplay[0].id, introduction.actionId);
    }
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
    ['approach', 90, 100, false]
  ]);
  assert.deepEqual(Array.from(state.adultScenes[0].dialogue, item =>
    [item.id, item.startTime, item.endTime, item.nonIntimate]), [['dialogue', 80, 90, true]]);
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
    actionType: 'body_transition', choiceSurface: 'approach',
    choiceSurfaceEvidence: 'Observed opening transition', choiceSurfaceConfidence: 0.95, positionId: '', positionLabel: '' });
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
    const transition = action('entry:a', 6, 9.9, { ...cast, actionType: 'body_transition', choiceSurface: 'approach',
    choiceSurfaceEvidence: 'Observed opening transition', choiceSurfaceConfidence: 0.95,
      positionId: '', positionLabel: '', ...patch });
    const state = prepare([transition, core]);
    const position = state.adultScenes[0].positions[0];
    assert.equal(position.entryRange, undefined);
    assert.deepEqual(Array.from(position.sourceRanges, range => [range.startTime, range.endTime]), [[10, 20]]);
  }
});

test('a distant verified introduction reports a separate opening without changing source times', () => {
  const core = action('core:a', 100, 120, { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a',
    positionStartTime: 100, positionEndTime: 120 });
  const intro = action('intro:a', 10, 20, { adultScene: false, adultSceneId: '', actionType: 'touch',
    positionId: '', positionLabel: '', subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' });
  const state = prepare([intro, core]);
  const [opening, positionScene] = state.adultScenes;
  assert.deepEqual([opening.startTime, opening.endTime, opening.foreplay[0].id], [10, 20, 'intro:a']);
  assert.deepEqual([positionScene.startTime, positionScene.endTime], [100, 120]);
  const trace = state.adultAnalysisTrace.actions.find(item => item.actionId === 'intro:a');
  assert.equal(trace.membershipReason, 'VERIFIED_STANDALONE_OPENING');
  assert.equal(trace.route, 'FOREPLAY');
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

test('a verified same-cast transition joins a 41-second opening-to-core gap without making the gap playable', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  const scene = (id, startTime, endTime, familyId) => ({ id, startTime, endTime, postSceneTime: endTime,
    positions: [{ ...cast, familyId, startTime, endTime, sourceRanges: [
      { id: `${id}:range`, startTime, endTime, sourceVerified: true }
    ] }], foreplay: [], dialogue: [], partnerTransitions: [], outcomes: [] });
  const opening = scene('opening', 382, 510, 'oral');
  const core = scene('core', 551, 628, 'chapter');
  const bridge = { ...cast, sourceVerified: true, actionType: 'body_transition',
    choiceSurface: 'story', startTime: 510, endTime: 521 };

  assert.equal(mergeFragments([opening, core]).length, 2);
  const joined = mergeFragments([opening, core], [bridge]);
  assert.equal(joined.length, 1);
  assert.deepEqual(Array.from(joined[0].positions, position => position.familyId), ['oral', 'chapter']);
  assert.equal(joined[0].positions.some(position => position.sourceRanges.some(range =>
    range.startTime <= 535 && range.endTime > 535)), false);
  assert.equal(mergeFragments([opening, core], [{ ...bridge, actionType: 'scene_transition' }]).length, 2);
  assert.equal(mergeFragments([opening, { ...core, startTime: 556 }], [bridge]).length, 2);
});

test('two same-cast core chapters separated by a quiet 51-second edit stay in one choice panel', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const cast = { subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A' };
  const scene = (id, startTime, endTime, familyId) => ({ id, startTime, endTime, postSceneTime: endTime,
    positions: [{ ...cast, familyId, startTime, endTime, sourceRanges: [
      { id: `${id}:source`, startTime, endTime, sourceVerified: true }
    ] }], foreplay: [], dialogue: [], partnerTransitions: [], outcomes: [] });
  const joined = mergeFragments([scene('rear', 373, 515, 'rear'),
    scene('prone', 566, 853, 'prone-bone')], [], [{ startTime: 515, endTime: 566 }]);
  assert.equal(joined.length, 1);
  assert.deepEqual(Array.from(joined[0].positions, item => item.familyId), ['rear', 'prone-bone']);
  assert.equal(joined[0].positions.some(position => position.sourceRanges.some(range =>
    range.startTime <= 535 && range.endTime > 535)), false);
});

test('separated returns in one encounter unlock as source-ordered position chapters', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const cast = { subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A', actionType: 'position' };
  const sourceChapter = (id, startTime, endTime, family, sceneId) =>
    action(id, startTime, endTime, { ...cast, adultSceneId: sceneId,
      adultSceneStartTime: startTime, adultSceneEndTime: endTime,
      positionId: family, positionLabel: family,
      positionOccurrenceId: id, positionStartTime: startTime, positionEndTime: endTime });
  const state = prepare([
    sourceChapter('rear-1', 373, 515, 'rear', 'scene-a'),
    sourceChapter('rear-2', 566, 688, 'rear', 'scene-b'),
    sourceChapter('prone', 693, 781, 'prone-bone', 'scene-b'),
    sourceChapter('rear-3', 799, 853, 'rear', 'scene-b')
  ], {
    mergeAdultSceneFragments: mergeFragments,
    playableAdultPanelFamily: item => item.positionId || '',
    canonicalAdultPosition: item => ({ id: item.positionId, label: item.positionLabel }),
    adultCategoryFor: (_item, id) => ({ id, label: id })
  });
  assert.equal(state.adultScenes.length, 1);
  const positions = state.adultScenes[0].positions;
  assert.deepEqual(Array.from(positions, position => position.startTime), [373, 566, 693, 799]);
  assert.equal(new Set(positions.map(position => position.id)).size, 4);
  assert.deepEqual(Array.from(positions, position => position.sourceRanges[0].endTime),
    [515, 688, 781, 853]);
});

test('preparation keeps dialogue, opening activity, and first core position in one progressing encounter', () => {
  const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
  const mergeEnd = source.indexOf('\nfunction prepareAdultScenes()', mergeStart);
  const mergeFragments = vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nmergeAdultSceneFragments;`);
  const cast = { subjectTrackId: 'subject:a', partnerTrackId: 'partner:a' };
  const sceneMeta = { adultSceneStartTime: 241, adultSceneEndTime: 628 };
  const dialogue = action('dialogue', 241, 382, { ...cast, ...sceneMeta,
    positionId: '', positionLabel: '', actionType: 'dialogue', choiceSurface: 'story' });
  const opening = action('opening', 393, 510, { ...cast, ...sceneMeta,
    positionId: 'oral', positionLabel: 'Opening activity', positionStartTime: 393, positionEndTime: 510 });
  const transition = action('transition', 510, 521, { ...cast, ...sceneMeta,
    adultSceneId: 'scene-b', positionId: '', positionLabel: '',
    actionType: 'body_transition', choiceSurface: 'story' });
  const core = action('core', 550, 562, { ...cast, ...sceneMeta,
    positionId: 'chapter', positionLabel: 'First core', positionStartTime: 550,
    positionEndTime: 562, loopStartTime: 551, loopEndTime: 562 });
  const state = prepare([dialogue, opening, transition, core], {
    mergeAdultSceneFragments: mergeFragments,
    playableAdultPanelFamily: item => item.sourceVerified === true && item.adultScene && item.positionId ? item.positionId : '',
    canonicalAdultPosition: item => ({ id: item.positionId, label: item.positionLabel }),
    adultCategoryFor: (_item, id) => ({ id, label: id }),
    isWarmupPosition: item => item.progressionRole === 'foreplay'
  });

  assert.equal(state.adultScenes.length, 1);
  const [scene] = state.adultScenes;
  assert.deepEqual(Array.from(scene.positions, item => [item.familyId, item.progressionRole]),
    [['oral', 'foreplay'], ['chapter', 'core']]);
  assert.equal(scene.dialogue.some(item => item.id === 'dialogue'), true);
  assert.equal(scene.foreplay.some(item => item.id === 'dialogue'), false);
  assert.equal(scene.positions.some(item => item.sourceRanges.some(range =>
    range.startTime <= 535 && range.endTime > 535)), false);
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

test('unverified scene-tagged provider rows cannot bridge a standalone opening to core', () => {
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
    assert.equal(state.adultScenes.length, 2);
    const [opening, scene] = state.adultScenes;
    assert.deepEqual([opening.startTime, opening.endTime, opening.foreplay.length], [10, 20, 1]);
    assert.deepEqual([scene.startTime, scene.endTime], [400, 420]);
    assert.equal(scene.foreplay.length, 0);
    assert.deepEqual(Array.from(scene.positions[0].sourceRanges, range => [range.startTime, range.endTime]), [[400, 420]]);
    assert.ok(scene.positions[0].movements.every(movement => sourceRangeForClip(scene.positions[0], movement)));
    assert.equal(state.adultAnalysisTrace.actions[0].route, 'FOREPLAY');
    assert.ok(state.adultAnalysisTrace.actions.slice(1, -1).every(item => item.route !== 'FOREPLAY'));
    assert.deepEqual(actions, original);
  }
});
