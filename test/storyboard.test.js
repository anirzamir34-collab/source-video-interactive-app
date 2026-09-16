import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSceneBoundaries, sheetsPerAnalysisChunk } from '../public/storyboard.js';

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
