import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { savedGapSampleTimes } from '../public/storyboard.js';
import { planSavedGapRepair, appendSavedGapRepairHistory } from '../public/analysis-repair-attempts.js';

const gap = { startTime: 478.2, endTime: 557.9 };
const model = 'gemini-3.8-flash';
const prompt = 'neutral-timeline-v4';
const validator = 'neutral-validator-v2';
const plan = analysis => planSavedGapRepair(analysis, gap, model, prompt, validator);

test('older 422 repair history advances from shifted frames to a third fresh sample', () => {
  const legacy = { lastRepairAttempt: { model, promptVersion: prompt,
    validatorVersion: validator, results: [{ ...gap,
      reason: 'GEMINI_NO_VERIFIED_EVENTS', outcome: 'skipped_previous_empty', httpStatus: 422 }] } };
  assert.deepEqual(plan(legacy), { samplingStrategy: 'shifted' });
  const updated = { ...legacy, repairAttemptHistory:
    appendSavedGapRepairHistory(legacy, model, prompt, validator, [{ ...gap,
      reason: 'GEMINI_NO_VERIFIED_EVENTS', outcome: 'failed',
      samplingStrategy: 'shifted', httpStatus: 422 }]) };
  assert.deepEqual(plan(updated), { samplingStrategy: 'alternate-2' });
  assert.equal(updated.repairAttemptHistory.length, 2);
});

test('repeated provider refusals no longer silently block user-requested retries', () => {
  let analysis = {};
  const strategies = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const next = plan(analysis);
    strategies.push(next.samplingStrategy);
    analysis = { repairAttemptHistory: appendSavedGapRepairHistory(analysis,
      model, prompt, validator, [{ ...gap, outcome: 'failed',
        samplingStrategy: next.samplingStrategy, reason: 'GEMINI_CONTENT_RESTRICTED' }]) };
  }
  assert.deepEqual(strategies,
    ['baseline', 'shifted', 'alternate-2', 'alternate-3', 'alternate-4', 'alternate-5']);
  assert.deepEqual(plan(analysis), { samplingStrategy: 'alternate-6' });
  assert.deepEqual(planSavedGapRepair(analysis, gap, 'gemini-4-argon', prompt, validator),
    { samplingStrategy: 'baseline' });
});

test('new video timestamps stay in the same missing interval and never reuse sampled times', () => {
  const all = [];
  for (const strategy of ['baseline', 'shifted', 'alternate-2', 'alternate-3', 'alternate-4']) {
    const samples = savedGapSampleTimes(gap.startTime, gap.endTime, strategy, all);
    assert.ok(samples.length >= 12, strategy);
    assert.ok(samples.every(time => time >= gap.startTime && time < gap.endTime));
    assert.ok(samples.every(time => all.every(old => Math.abs(old - time) >= 0.12)));
    all.push(...samples);
  }
  assert.ok(all.length >= 60);
});

test('network and quota errors do not consume a new sampling strategy', () => {
  const analysis = { repairAttemptHistory:
    appendSavedGapRepairHistory({}, model, prompt, validator, [
      { ...gap, reason: 'GEMINI_CREDITS_DEPLETED', outcome: 'failed', samplingStrategy: 'baseline' },
      { ...gap, reason: 'NETWORK_OR_ANALYSIS_ERROR', outcome: 'failed', samplingStrategy: 'baseline' }
    ]) };
  assert.deepEqual(plan(analysis), { samplingStrategy: 'baseline' });
});

test('successful partial repair keeps prior verified observations and uses new frames on retry', () => {
  const result = { ...gap, samplingStrategy: 'baseline',
    outcome: 'partial', reason: '', verifiedActions: 2 };
  const history = appendSavedGapRepairHistory({}, model, prompt, validator, [result]);
  assert.equal(history[0].verifiedActions, 2);
  assert.deepEqual(plan({ repairAttemptHistory: history }), { samplingStrategy: 'shifted' });
});

test('saved-game retry sends freshly captured timestamps and stores them for the next run', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /repairPreviouslySampledTimes: earlierSamples/);
  assert.match(app, /sampledTimestamps = storyboard\.timestamps/);
  assert.match(app, /modelInspectedFrames \? \{ sampledTimestamps \} : \{\}/);
  assert.doesNotMatch(app.slice(app.indexOf('async function repairSavedGame('),
    app.indexOf('async function loadSavedGameGeminiModels(')), /if \(attempt\.skip\)/);
});
