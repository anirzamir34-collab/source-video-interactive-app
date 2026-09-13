import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dialogueSegmentAt,
  dubSegmentKey,
  fittedDubPlaybackRate,
  isCompleteChunkAnalysis,
  mapVideoTimeToDubTime,
  nextDialogueSegments
} from '../public/playback-logic.js';

test('partial chunk analysis is never considered complete', () => {
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 2, expectedChunkCount: 10 }), false);
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 10, expectedChunkCount: 10, failed: true }), false);
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 10, expectedChunkCount: 10 }), true);
});

test('dialogueSegmentAt returns only the segment matching the current video time', () => {
  const segments = [
    { segmentId: 'a', startTime: 10, endTime: 12, turkishText: 'Bir' },
    { segmentId: 'b', startTime: 20, endTime: 23, turkishText: 'İki' }
  ];
  assert.equal(dialogueSegmentAt(segments, 10.5)?.segmentId, 'a');
  assert.equal(dialogueSegmentAt(segments, 21)?.segmentId, 'b');
  assert.equal(dialogueSegmentAt(segments, 15), null);
});

test('dub time maps proportionally inside the matching dialogue segment', () => {
  assert.equal(mapVideoTimeToDubTime({
    videoTime: 21.5,
    segmentStart: 20,
    segmentEnd: 23,
    audioDuration: 6
  }), 3);
});

test('dub playback rate is bounded and follows segment duration', () => {
  assert.equal(fittedDubPlaybackRate({ audioDuration: 3, segmentDuration: 3, videoPlaybackRate: 1 }), 1);
  assert.equal(fittedDubPlaybackRate({ audioDuration: 10, segmentDuration: 2, videoPlaybackRate: 1 }), 1.35);
  assert.equal(fittedDubPlaybackRate({ audioDuration: 1, segmentDuration: 4, videoPlaybackRate: 1 }), 0.8);
});

test('next dialogue prefetch starts from current or future segments', () => {
  const segments = [
    { segmentId: 'a', startTime: 10, endTime: 12, turkishText: 'Bir' },
    { segmentId: 'b', startTime: 20, endTime: 23, turkishText: 'İki' },
    { segmentId: 'c', startTime: 30, endTime: 31, turkishText: 'Üç' }
  ];
  assert.deepEqual(nextDialogueSegments(segments, 19, 2).map(x => x.segmentId), ['b', 'c']);
  assert.equal(dubSegmentKey(segments[1]), 'b');
});
