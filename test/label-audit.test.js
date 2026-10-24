import test from 'node:test';
import assert from 'node:assert/strict';
import { labelAuditCandidates, mergeLabelAudit, auditReasons, labelPositionFamily } from '../public/label-audit.js';
import { mergeSecondPassReview } from '../public/engine-hardening.js';
import { serializeReviewCandidates } from '../public/classification-integrity.js';

const base = { sourceVerified: true, startTime: 10, endTime: 30, loopStartTime: 12, loopEndTime: 28,
  positionStartTime: 10, positionEndTime: 30, positionConfigurationConfidence: 0.9, positionEvidence: 'visible' };

test('a 69 written as missionary and an unproven vaginal route are audited; a consistent part is not', () => {
  const actions = [
    { ...base, actionId: 'a', positionId: 'missionary', label: '69 pozisyonunda devam et', receiverBodyOrientation: 'on_back' },
    { ...base, actionId: 'b', positionId: 'rear', label: 'Arkadan devam et', receiverBodyOrientation: 'hands_knees',
      activityType: 'vaginal', activityTypeConfidence: 0.6, activityEvidence: '' },
    { ...base, actionId: 'c', positionId: 'cowgirl', label: 'Üstüne çıkmasına izin ver', receiverBodyOrientation: 'on_top_facing' },
    { ...base, actionId: 'd', label: 'Odaya gir' }
  ];
  const picked = labelAuditCandidates({ actions });
  assert.deepEqual(picked.map(row => row.actionId), ['a', 'b']);
  assert.ok(picked[0].auditReasons.includes('sixty_nine_mismatch'));
  assert.ok(picked[1].auditReasons.includes('route_unproven'));
  assert.equal(labelPositionFamily('Ters kovboyda kalçasını tut'), 'reverse-cowgirl');
});

test('a trans woman cast sends even a confident vaginal route to the audit', () => {
  const action = { ...base, actionId: 'x', positionId: 'cowgirl', receiverBodyOrientation: 'on_top_facing',
    label: 'Üstüne çıkmasına izin ver', activityType: 'vaginal', activityTypeConfidence: 0.95, activityEvidence: 'seen' };
  assert.deepEqual(auditReasons(action), []);
  assert.deepEqual(auditReasons(action, { transWomanCast: true }), ['route_trans_review']);
});

test('the audit corrects what it confirms and never deletes what it does not return', () => {
  const first = { available: true, rewardMoments: [{ id: 'r' }], warnings: ['w1'], actions: [
    { ...base, actionId: 'a', positionId: 'missionary', label: '69', classificationReview: 'first_pass' },
    { ...base, actionId: 'b', positionId: 'rear', label: 'Arkadan', activityType: 'vaginal', activityTypeConfidence: 0.5 },
    { ...base, actionId: 'c', startTime: 40, endTime: 50, label: 'Odaya gir' }] };
  const candidates = labelAuditCandidates(first);
  const review = { available: true, rewardMoments: [], actions: [
    { ...base, actionId: 'a', positionId: 'oral', oralGiver: 'mutual', label: '69 pozisyonunda devam et',
      receiverBodyOrientation: 'unclear' }] };
  const merged = mergeLabelAudit(first, review, candidates, mergeSecondPassReview);
  const byId = Object.fromEntries(merged.actions.map(row => [row.actionId, row]));
  assert.equal(byId.a.positionId, 'oral');
  assert.equal(byId.a.labelAudit, 'verified');
  assert.equal(byId.b.activityType, 'other', 'an unconfirmed route becomes neutral');
  assert.equal(byId.b.labelAudit, 'unconfirmed');
  assert.ok(byId.c, 'untouched parts stay');
  assert.deepEqual(merged.rewardMoments, [{ id: 'r' }], 'only actions come from the audit');
  assert.equal(merged.actions.length, 3);
});

test('audit reasons reach Gemini with the candidate', () => {
  const serialized = JSON.parse(serializeReviewCandidates([{ actionId: 'a', auditReasons: ['sixty_nine_mismatch'], oralGiver: 'mutual' }]));
  assert.deepEqual(serialized[0].auditReasons, ['sixty_nine_mismatch']);
  assert.equal(serialized[0].oralGiver, 'mutual');
});

test('a cowgirl claim while the man stands or kneels behind her is re-checked', () => {
  const cowgirl = { ...base, actionId: 'k', positionId: 'cowgirl', receiverBodyOrientation: 'on_top_facing',
    label: 'Kucağında inip kalkmasına izin ver', mainMalePosture: 'standing' };
  assert.ok(auditReasons(cowgirl).includes('male_posture_mismatch'));
  assert.deepEqual(auditReasons({ ...cowgirl, mainMalePosture: 'lying_back' }), []);
  assert.ok(auditReasons({ ...cowgirl, mainMalePosture: 'unclear' }).includes('male_posture_unclear'));
  assert.deepEqual(auditReasons({ ...base, positionId: 'rear', receiverBodyOrientation: 'hands_knees', label: 'Arkadan devam et',
    mainMalePosture: 'kneeling' }), []);
});
