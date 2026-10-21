import test from 'node:test';
import assert from 'node:assert/strict';
import { repairableAnalysisGaps, retryableAnalysisGaps, mergeRepairedAnalysis } from '../public/analysis-gap-repair.js';

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
  // A remaining part reported past the interval's edge is kept inside it
  // instead of failing the whole save.
  const clamped = mergeRepairedAnalysis(original, [{ gap, result: {
    available: true, analysisGaps: [{ startTime: 20, endTime: 70 }]
  } }], 90);
  assert.deepEqual(clamped.analysisGaps.map(item => [item.startTime, item.endTime]), [[20, gap.endTime]]);
  // Seconds relative to the interval are moved into it.
  const relative = mergeRepairedAnalysis(original, [{ gap, result: {
    available: true, analysisGaps: [{ startTime: 0, endTime: 5 }],
    actions: [{ startTime: gap.startTime + 6, endTime: gap.startTime + 9, sourceVerified: true }]
  } }], 90);
  assert.deepEqual(relative.analysisGaps.map(item => [item.startTime, item.endTime]), [[gap.startTime, gap.startTime + 5]]);
  // An entry that cannot be read keeps the whole interval missing.
  const unreadable = mergeRepairedAnalysis(original, [{ gap, result: {
    available: true, analysisGaps: [{ startTime: 'x', endTime: 5 }] } }], 90);
  assert.deepEqual(unreadable.analysisGaps.map(item => [item.startTime, item.endTime]), [[gap.startTime, gap.endTime]]);
});

test('repair removes stale unreadable warning but keeps unresolved coverage visible', () => {
  const gap = { chunkIndex: 1, startTime: 94.7, endTime: 189.3, reason: 'GEMINI_CONTENT_RESTRICTED' };
  const analysis = { actions: [], analysisGaps: [gap], partial: true,
    warnings: ['Bölüm 2 (94.7–189.3 sn) okunamadı; bu aralık için seçenek üretilmedi.', 'Başka uyarı'] };
  const repaired = mergeRepairedAnalysis(analysis, [{ gap, result: { available: true,
    actions: [{ startTime: 112, endTime: 120, sourceVerified: true }],
    analysisGaps: [{ startTime: 140, endTime: 150, reason: 'GEMINI_CONTENT_RESTRICTED' }]
  } }], 200);
  assert.equal(repaired.partial, true);
  assert.deepEqual(repaired.warnings, ['Başka uyarı', 'Aralık 140.0–150.0 sn hâlâ doğrulanmadı; seçenek üretilmedi.']);
});

test('provider-restricted gaps remain explicitly retryable only when a saved-game user requests repair', () => {
  const analysis = { analysisGaps: [
    { startTime: 10, endTime: 20, reason: 'GEMINI_CONTENT_RESTRICTED' },
    { startTime: 20, endTime: 30, reason: 'GEMINI_TEMPORARILY_UNAVAILABLE' }
  ] };
  assert.equal(repairableAnalysisGaps(analysis, 40).length, 2);
  assert.deepEqual(retryableAnalysisGaps(analysis, 40).map(gap => gap.startTime), [10, 20]);
  assert.deepEqual(retryableAnalysisGaps({ analysisGaps: [analysis.analysisGaps[0]] }, 40).map(gap => gap.startTime), [10]);
});
