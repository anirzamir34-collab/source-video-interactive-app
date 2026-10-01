import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDialogueTiming, requireDialogueTiming, normalizeDialogueTimeline } from '../public/dialogue-integrity.js';
import { activeDubSegments } from '../public/dub-overlap.js';

// Neutral reproduction of the uploaded report: many different replies were
// cached in one short interval. No source words or replacement times are guessed.
const collapsed = () => Array.from({ length: 21 }, (_, i) => ({
  segmentId: `line-${i}`, speakerId: i % 5 ? 'voice-a' : 'voice-b',
  startTime: 3.04, endTime: 3.44, originalText: `Reply number ${i}`, turkishText: `Yanıt ${i}`
}));
test('the reported 21-row collision explains why only two voices became eligible', () => {
  const rows = collapsed();
  assert.equal(activeDubSegments(rows, 3.1).length, 2);
  const report = inspectDialogueTiming(rows, 900);
  assert.equal(report.valid, false);
  assert.equal(report.reason, 'SAME_SPEAKER_COLLAPSED_INTERVALS');
  assert.equal(report.distinctIntervalCount, 1);
  assert.equal(report.segmentCount, 21);
  assert.equal(report.maxSameSpeakerIntervalCount, 16);
  assert.equal(report.requiresSourceRetiming, true);
});
test('invalid collapsed timestamps never become playable, even with an explicit seconds marker', () => {
  const rows = collapsed();
  const result = normalizeDialogueTimeline({ segments: rows, dubSegments: rows, timestampUnit: 'seconds' }, 900);
  assert.deepEqual(result.segments, []);
  assert.deepEqual(result.dubSegments, []);
  assert.equal(result.unresolvedSegments.length, 21);
  assert.equal(result.unresolvedSegments[0].startTime, 3.04);
  assert.equal(result.unresolvedSegments[0].originalText, rows[0].originalText);
  assert.equal(result.timingIntegrity.valid, false);
  assert.deepEqual(normalizeDialogueTimeline(result, 900), result);
});
test('two real overlapping speakers and distinct early second timestamps stay unchanged', () => {
  const overlap = ['a', 'b'].map(speakerId => ({ speakerId, startTime: 3.04, endTime: 4,
    originalText: 'Hello', turkishText: 'Merhaba' }));
  assert.equal(inspectDialogueTiming(overlap, 900).valid, true);
  const rows = collapsed().map((row, i) => ({ ...row, startTime: 3 + i, endTime: 3.4 + i }));
  const result = normalizeDialogueTimeline({ segments: rows, timestampUnit: 'seconds' }, 900);
  assert.equal(result.timingIntegrity.valid, true);
  assert.equal(result.segments.length, 21);
  assert.equal(result.segments[0].startTime, 3);
});
test('repeated identical observations are not mistaken for distinct simultaneous turns', () => {
  const row = { speakerId: 'a', startTime: 1, endTime: 2, originalText: 'Hello' };
  assert.equal(inspectDialogueTiming(Array(21).fill(row), 900).valid, true);
});
test('invalid ranges expose a timing error without inventing timestamps', () => {
  for (const row of [{ startTime: 4, endTime: 3 }, { startTime: null, endTime: 5 },
    { startTime: 4, endTime: 901 }, { startTime: 4, endTime: 4 }]) {
    assert.throws(() => requireDialogueTiming([row], 900), error =>
      error.code === 'DIALOGUE_TIMING_INVALID' && error.timingIntegrity.requiresSourceRetiming);
  }
});
