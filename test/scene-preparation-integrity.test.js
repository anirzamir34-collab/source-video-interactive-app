import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as gameplay from '../public/adult-gameplay.js';
import { sourceRangeForClip } from '../public/sequence-integrity.js';
import { matchSceneIntroductions } from '../public/scene-entry.js';
import { isAdultSocialRelationshipRole } from '../public/relationship-roles.js';
import { sourceIdentityLabel } from '../public/choice-groups.js';

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
    ...gameplay, state, ENGINE_VERSION: 'test', matchSceneIntroductions, isAdultSocialRelationshipRole, sourceIdentityLabel,
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

test('short source evidence does not authorize a longer parent fallback', () => {
  const state = prepare([action('short', 10, 11)]);
  assert.equal(state.adultScenes.length, 0);
});

test('wide parent declarations preserve only the exact accepted source intervals', () => {
  const state = prepare([
    action('first', 10, 30, { sourcePositionId: 'provider-parent' }), action('later', 90, 110),
    action('unverified', 35, 85, { sourceVerified: false })
  ]);
  assert.equal(state.adultScenes.length, 1);
  const positions = state.adultScenes[0].positions;
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.deepEqual(Array.from(p.sourceRanges, r => [r.startTime, r.endTime]), [[10, 30], [90, 110]]);
  assert.ok(p.movements.every(m => sourceRangeForClip(p, m)));
  assert.equal(p.movements.some(m => m.positionOnlyFallback), false);
  assert.equal(p.movementChoices.flatMap(c => c.variants).some(m => m.id === p.entryMovementId), false);
  assert.equal(new Set([p.entryMovementId, ...p.movementChoices.flatMap(c => c.variants).map(m => m.id)]).size,
    p.movements.length);
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
