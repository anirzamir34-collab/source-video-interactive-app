import test from 'node:test';
import assert from 'node:assert/strict';
import { savedGapSampleTimes } from '../public/storyboard.js';
import { planSavedGapRepair, appendSavedGapRepairHistory } from '../public/analysis-repair-attempts.js';

const gap = { startTime: 478.2, endTime: 557.9 };
const model = 'gemini-3.8-flash';
const prompt = 'neutral-timeline-v2';
const validator = 'neutral-validator-v2';
const plan = analysis => planSavedGapRepair(analysis, gap, model, prompt, validator);

test('saved game empty 422 receives exactly one fresh shifted-sampling retry', () => {
  const legacy = { lastRepairAttempt: { model, promptVersion: prompt,
    validatorVersion: validator, results: [{ ...gap,
      reason: 'GEMINI_NO_VERIFIED_EVENTS', outcome: 'skipped_previous_empty', httpStatus: 422 }] } };
  assert.deepEqual(plan(legacy), { samplingStrategy: 'shifted' });
  const result = { ...gap, reason: 'GEMINI_NO_VERIFIED_EVENTS',
    outcome: 'failed', samplingStrategy: 'shifted', httpStatus: 422 };
  const updated = { ...legacy, repairAttemptHistory:
    appendSavedGapRepairHistory(legacy, model, prompt, validator, [result]) };
  assert.equal(plan(updated).skip, 'skipped_previous_empty');
  assert.equal(updated.repairAttemptHistory.length, 2);
});

test('provider content restriction does not automatically repeat a rejected request', () => {
  const previous = { lastRepairAttempt: { model, promptVersion: prompt,
    validatorVersion: validator, results: [{ ...gap,
      reason: 'GEMINI_CONTENT_RESTRICTED', outcome: 'skipped_previous_rejection', httpStatus: 422 }] } };
  assert.equal(plan(previous).skip, 'skipped_previous_rejection');
  assert.deepEqual(planSavedGapRepair(previous, gap, 'gemini-4-argon', prompt, validator),
    { samplingStrategy: 'baseline' });
});

test('different frame times are chosen without widening the missing interval', () => {
  const baseline = savedGapSampleTimes(gap.startTime, gap.endTime, 'baseline');
  const shifted = savedGapSampleTimes(gap.startTime, gap.endTime, 'shifted');
  assert.ok(baseline.length >= 12);
  assert.ok(shifted.length >= 12);
  assert.notDeepEqual(baseline, shifted);
  assert.ok(shifted.every(time => time >= gap.startTime && time < gap.endTime));
  assert.ok(baseline.every(time => time >= gap.startTime && time < gap.endTime));
});

test('successful repair preserves prior evidence and does not trigger redundant follow-up', () => {
  const result = { ...gap, samplingStrategy: 'baseline',
    outcome: 'processed', reason: '', verifiedActions: 2 };
  const history = appendSavedGapRepairHistory({}, model, prompt, validator, [result]);
  assert.equal(history[0].verifiedActions, 2);
  assert.deepEqual(plan({ repairAttemptHistory: history }), { samplingStrategy: 'baseline' });
});
