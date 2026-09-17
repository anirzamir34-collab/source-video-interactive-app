import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSceneBoundaries,
  selectFocusedTimestamps,
  sheetsPerAnalysisChunk,
  storyboardSamplingPlan
} from '../public/storyboard.js';

test('analysis chunk planning reduces calls without dropping storyboard frames', () => {
  assert.equal(sheetsPerAnalysisChunk('ultra'), 3);
  assert.equal(sheetsPerAnalysisChunk('balanced'), 3);
  assert.equal(sheetsPerAnalysisChunk('fast'), 4);
  assert.equal(Math.ceil(20 / sheetsPerAnalysisChunk('ultra')), 7);
});

test('detects spaced visual cuts without treating ordinary motion as a new scene', () => {
  const profile = [
    { time: 0, score: 0 },
    { time: 1, score: 18 },
    { time: 2, score: 52 },
    { time: 3, score: 21 },
    { time: 4, score: 38 },
    { time: 5, score: 20 },
    { time: 6, score: 55 },
    { time: 7, score: 12 }
  ];

  assert.deepEqual(detectSceneBoundaries(profile, 1), [
    { time: 2, score: 52, kind: 'hard-cut' },
    { time: 6, score: 55, kind: 'hard-cut' }
  ]);
});

test('ignores invalid samples and prevents clustered duplicate boundaries', () => {
  const profile = [
    { time: 0, score: 0 },
    { time: 1, score: 50 },
    { time: 2, score: 49 },
    { time: 'bad', score: 99 },
    { time: 4, score: 15 }
  ];

  assert.deepEqual(detectSceneBoundaries(profile, 1), [
    { time: 1, score: 50, kind: 'hard-cut' }
  ]);
});

test('uses adaptive remote sampling while preserving local analysis density', () => {
  assert.deepEqual(storyboardSamplingPlan(120, true), { baseCount: 36, focusedCount: 13 });
  assert.deepEqual(storyboardSamplingPlan(300, true), { baseCount: 50, focusedCount: 18 });
  assert.deepEqual(storyboardSamplingPlan(600, true), { baseCount: 100, focusedCount: 35 });
  assert.deepEqual(storyboardSamplingPlan(1200, true), { baseCount: 160, focusedCount: 56 });
  assert.deepEqual(storyboardSamplingPlan(240, false), { baseCount: 144, focusedCount: 0 });
});

test('remote frame preparation grows with video duration instead of using broad buckets', () => {
  const fiveMinutes = storyboardSamplingPlan(300, true);
  const tenMinutes = storyboardSamplingPlan(600, true);

  assert.equal(fiveMinutes.baseCount + fiveMinutes.focusedCount, 68);
  assert.equal(tenMinutes.baseCount + tenMinutes.focusedCount, 135);
  assert.ok(
    tenMinutes.baseCount + tenMinutes.focusedCount >=
      (fiveMinutes.baseCount + fiveMinutes.focusedCount) * 1.9
  );
});

test('focuses extra remote samples around motion without duplicating base times', () => {
  const profile = [
    { time: 0, score: 0 },
    { time: 4, score: 8 },
    { time: 8, score: 70 },
    { time: 12, score: 12 },
    { time: 16, score: 10 },
    { time: 20, score: 55 }
  ];
  const focused = selectFocusedTimestamps(profile, 20, 4);

  assert.equal(focused.length, 4);
  assert.deepEqual(focused, focused.slice().sort((a, b) => a - b));
  assert.ok(focused.some(time => time > 4 && time < 8));
  assert.ok(focused.every(time => profile.every(item => Math.abs(item.time - time) >= 0.3)));
});
