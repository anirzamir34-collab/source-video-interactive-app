import test from 'node:test';
import assert from 'node:assert/strict';
import { repairableAnalysisGaps, mergeRepairedAnalysis } from '../public/analysis-gap-repair.js';

const original = { actions: [
  { actionId: 'old', startTime: 0, endTime: 12, sourceVerified: true },
  { actionId: 'later', startTime: 40, endTime: 60, sourceVerified: true }
], analysisGaps: [{ startTime: 12, endTime: 40, reason: 'unreadable' }], partial: true };

test('only explicit missing intervals qualify; a quiet scene does not', () => {
  assert.deepEqual(repairableAnalysisGaps(original, 90).map(gap => [gap.startTime, gap.endTime]), [[12, 40]]);
  assert.deepEqual(repairableAnalysisGaps({ actions: original.actions }, 90), []);
});

test('repair preserves old evidence and accepts verified actions inside the missing range', () => {
  const gap = original.analysisGaps[0];
  const repaired = mergeRepairedAnalysis(original, [{ gap, result: { available: true, actions: [
    { actionId: 'new', startTime: 18, endTime: 25, sourceVerified: true },
    { actionId: 'overlap', startTime: 10, endTime: 17, sourceVerified: true },
    { actionId: 'invented', startTime: 26, endTime: 31, sourceVerified: false }
  ] } }], 90);
  assert.deepEqual(repaired.actions.map(item => item.actionId), ['old', 'new', 'later']);
  assert.equal(repaired.actions[0], original.actions[0]);
  assert.equal(repaired.partial, false);
  assert.deepEqual(repaired.analysisGaps, []);
});

test('failed or partially recovered ranges stay repairable without deleting verified actions', () => {
  const gap = original.analysisGaps[0];
  const failed = mergeRepairedAnalysis(original, [{ gap, result: { available: false } }], 90);
  assert.deepEqual(failed.analysisGaps, [gap]);
  const partial = mergeRepairedAnalysis(original, [{ gap, result: {
    available: true, analysisGaps: [{ startTime: 20, endTime: 40 }],
    actions: [{ startTime: 14, endTime: 19, sourceVerified: true },
      { startTime: 25, endTime: 30, sourceVerified: true }]
  } }], 90);
  assert.deepEqual(partial.analysisGaps.map(item => [item.startTime, item.endTime]), [[20, 40]]);
  assert.deepEqual(partial.actions.map(item => item.startTime), [0, 14, 40]);
  assert.throws(() => mergeRepairedAnalysis(original, [{ gap, result: {
    available: true, analysisGaps: [{ startTime: 20, endTime: 70 }]
  } }], 90), /tutarsız/);
});
