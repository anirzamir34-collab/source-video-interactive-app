import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITION_IDS, isVerifiedReviewWithinSource, serializeReviewCandidates } from '../public/classification-integrity.js';
import { adultPositionFamily, movementBelongsToVerifiedPosition } from '../public/adult-gameplay.js';
import { secondPassReviewCandidates, mergeSecondPassReview, reviewAndHardenAnalysis } from '../public/engine-hardening.js';

const classified = (id = 'a', extra = {}) => ({
  actionId: id, startTime: 10, endTime: 20, sourceVerified: true, confidence: 0.99,
  positionId: 'standing-rear', positionLabel: 'Ayakta Arkadan',
  positionEvidence: 'Source configuration is visible', positionConfigurationConfidence: 0.95,
  receiverBodyOrientation: 'bent_over', receiverSupport: 'standing', ...extra
});

test('every existing canonical identifier round-trips without inventing another family', () => {
  for (const id of POSITION_IDS) assert.equal(adultPositionFamily(id), id);
});

test('an independently verified activity class is not rejected by the support/posture dimension', () => {
  for (const id of ['oral', 'manual']) {
    const action = classified('activity', { positionId: id, positionLabel: id, label: 'Recorded activity',
      movementType: 'Observed movement', receiverBodyOrientation: 'on_back', receiverSupport: 'back_flat' });
    assert.equal(movementBelongsToVerifiedPosition(action, id), true);
    assert.equal(movementBelongsToVerifiedPosition({ ...action, actionType: 'camera_transition' }, id), false);
    assert.equal(movementBelongsToVerifiedPosition({ ...action, sourceVerified: false }, id), false);
  }
});

test('general direction wording preserves the specific declared parent', () => {
  for (const label of ['Arkadan hareket temposunu artır', 'Arkadan ritmik hareket et', 'Arkadan pozisyonda devam et']) {
    const action = classified('a', { label, movementType: 'ritmik hareket' });
    assert.equal(movementBelongsToVerifiedPosition(action, 'standing-rear'), true);
    assert.equal(movementBelongsToVerifiedPosition(action, 'prone-bone'), false);
  }
});

test('specific conflicting labels and transitions remain outside a parent card', () => {
  assert.equal(movementBelongsToVerifiedPosition(classified('a', { label: 'Prone Bone Pozisyonu' }), 'standing-rear'), false);
  assert.equal(movementBelongsToVerifiedPosition(classified('a', { label: 'Doggy style' }), 'standing-rear'), false);
  assert.equal(movementBelongsToVerifiedPosition(classified('a', { label: 'Ayakta arkadan pozisyona geçiş' }), 'standing-rear'), false);
  assert.equal(movementBelongsToVerifiedPosition(classified('a', { label: 'Ayakta arkadan', actionType: 'body_transition' }), 'standing-rear'), false);
});

test('high confidence cannot bypass classification review for single or multiple families', () => {
  const dialogue = { actionId: 'talk', startTime: 0, endTime: 5, confidence: 0.99, actionType: 'other' };
  const actions = [classified('one'), classified('two', { positionId: 'prone-bone', startTime: 25, endTime: 35 })];
  assert.deepEqual(secondPassReviewCandidates({ actions: [dialogue, ...actions] }).map(a => a.actionId), ['one', 'two']);
  assert.deepEqual(secondPassReviewCandidates({ actions: [dialogue, actions[0]] }).map(a => a.actionId), ['one']);
});

test('review cannot move a candidate to another source interval or accept an invented class', () => {
  const source = classified();
  assert.equal(isVerifiedReviewWithinSource(classified(), source), true);
  for (const extra of [
    { startTime: 9 }, { endTime: 30 }, { loopStartTime: 5 }, { loopEndTime: 25 },
    { positionId: 'other-stable-99' }, { sourceVerified: false }, { positionEvidence: '' },
    { positionConfigurationConfidence: 0.5 }
  ]) assert.equal(isVerifiedReviewWithinSource(classified('a', extra), source), false);
});

test('review corrections remain local and rejected guesses do not survive the merge', () => {
  const a = classified('a'), b = classified('b', { startTime: 25, endTime: 35, positionId: 'prone-bone' });
  const corrected = { ...b, positionId: 'standing-rear', positionLabel: 'Ayakta Arkadan' };
  const merged = mergeSecondPassReview({ actions: [a, b] }, { actions: [a, corrected, corrected, classified('invented')] }, [a, b]);
  assert.deepEqual(merged.actions.map(x => [x.actionId, x.positionId, x.classificationReview]), [
    ['a', 'standing-rear', 'verified'], ['b', 'standing-rear', 'verified']
  ]);
  const omitted = mergeSecondPassReview({ actions: [a, b] }, { actions: [a] }, [a, b]);
  assert.deepEqual(omitted.actions.map(x => x.actionId), ['a']);
  assert.deepEqual(omitted.classificationReviewRejectedIds, ['b']);
  assert.equal(omitted.warnings.length, 1);
});

test('large review payload stays valid JSON and retains the last candidate', () => {
  const candidates = Array.from({ length: 60 }, (_, i) => classified(`a-${i}`, { label: 'a'.repeat(900), extraDebug: 'x'.repeat(2000) }));
  const serialized = serializeReviewCandidates(JSON.stringify(candidates));
  assert.ok(serialized.length > 18000);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.length, 60);
  assert.equal(parsed.at(-1).actionId, 'a-59');
  assert.ok(parsed.every(a => a.label.length === 500 && !('extraDebug' in a)));
  assert.throws(() => serializeReviewCandidates('{broken'));
});

test('new analyses cannot turn unchecked or unknown classes into playable results', () => {
  const result = reviewAndHardenAnalysis({ schemaVersion: 6, videoDuration: 60, actions: [
    classified('unchecked'), classified('unknown', { positionId: 'custom-name', classificationReview: 'verified', startTime: 25, endTime: 35 }),
    classified('verified', { classificationReview: 'verified', startTime: 40, endTime: 50 })
  ] });
  assert.deepEqual(result.analysis.actions.map(a => a.actionId), ['verified']);
  assert.equal(result.integrity.issues.filter(i => i.code === 'UNVERIFIED_CLASSIFICATION').length, 2);
});
