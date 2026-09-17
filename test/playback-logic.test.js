import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDubBlocks,
  dialogueSegmentAt,
  dialogueSegmentsAt,
  dialogueSegmentsForTarget,
  dialogueSegmentsForTargets,
  decisionBoundaryAfterDialogue,
  dubMasterClockCorrection,
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

test('dialogueSegmentAt immediately switches to the newest overlapping speaker', () => {
  const segments = [
    { segmentId: 'father', startTime: 10, endTime: 13, speakerName: 'Baba' },
    { segmentId: 'son', startTime: 12.4, endTime: 15, speakerName: 'Erkek kardeş' }
  ];
  assert.equal(dialogueSegmentAt(segments, 12.5)?.segmentId, 'son');
});

test('dialogueSegmentsAt preserves overlap metadata while dialogueSegmentAt selects one dub owner', () => {
  const segments = [
    { segmentId: 'a', speakerId: 'woman-a', startTime: 10, endTime: 14, turkishText: 'Bir' },
    { segmentId: 'b', speakerId: 'man-a', startTime: 12, endTime: 15, turkishText: 'İki' },
    { segmentId: 'c', speakerId: 'woman-b', startTime: 16, endTime: 18, turkishText: 'Üç' }
  ];
  assert.deepEqual(dialogueSegmentsAt(segments, 12.5).map(item => item.segmentId), ['a', 'b']);
  assert.equal(dialogueSegmentAt(segments, 12.5, 0.12)?.segmentId, 'b');
});

test('adjacent lines from the same speaker become one continuous dub block', () => {
  const blocks = buildDubBlocks([
    { segmentId: 'a', speakerId: 'woman-a', startTime: 10, endTime: 12, turkishText: 'Birinci cümle.' },
    { segmentId: 'b', speakerId: 'woman-a', startTime: 12.2, endTime: 14, turkishText: 'İkinci cümle.' },
    { segmentId: 'c', speakerId: 'man-a', startTime: 14.1, endTime: 16, turkishText: 'Yanıt.' }
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].turkishText, 'Birinci cümle. İkinci cümle.');
  assert.deepEqual(blocks[0].sourceSegmentIds, ['a', 'b']);
  assert.equal(blocks[1].speakerId, 'man-a');
});

test('adult choice target primes the active Turkish line and following line once', () => {
  const segments = [
    { segmentId: 'a', startTime: 10, endTime: 13, turkishText: 'Birinci' },
    { segmentId: 'b', startTime: 14, endTime: 17, turkishText: 'İkinci' },
    { segmentId: 'c', startTime: 18, endTime: 21, turkishText: 'Üçüncü' }
  ];
  assert.deepEqual(
    dialogueSegmentsForTarget(segments, 11, 2).map(item => item.segmentId),
    ['a', 'b']
  );
  assert.deepEqual(
    dialogueSegmentsForTarget(segments, 13.5, 2).map(item => item.segmentId),
    ['b', 'c']
  );
});

test('adult position primes unique Turkish lines for all real extra variants', () => {
  const segments = [
    { segmentId: 'a', startTime: 10, endTime: 13, turkishText: 'Birinci' },
    { segmentId: 'b', startTime: 20, endTime: 23, turkishText: 'İkinci' },
    { segmentId: 'c', startTime: 30, endTime: 33, turkishText: 'Üçüncü' }
  ];
  assert.deepEqual(
    dialogueSegmentsForTargets(segments, [10, 10.5, 20, 30], 12).map(item => item.segmentId),
    ['a', 'b', 'c']
  );
});

test('choice boundary waits for every sentence active at the action end', () => {
  const segments = [
    { startTime: 8, endTime: 12.5, turkishText: 'Devam eden cümle' },
    { startTime: 9.5, endTime: 11.8, turkishText: 'Üst üste konuşma' },
    { startTime: 13, endTime: 15, turkishText: 'Sonraki cümle' }
  ];
  assert.equal(decisionBoundaryAfterDialogue(segments, 10, 30), 12.5);
  assert.equal(decisionBoundaryAfterDialogue(segments, 7, 30), 7);
  assert.equal(decisionBoundaryAfterDialogue(segments, 10, 11), 11);
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

test('master clock holds small drift, rate-corrects medium drift and seeks large drift', () => {
  const common = {
    videoTime: 21.5,
    segmentStart: 20,
    segmentEnd: 23,
    audioDuration: 6,
    videoPlaybackRate: 1
  };
  assert.equal(dubMasterClockCorrection({ ...common, audioTime: 3.05 }).mode, 'hold');
  assert.equal(dubMasterClockCorrection({ ...common, audioTime: 3.25 }).mode, 'rate');
  const hard = dubMasterClockCorrection({ ...common, audioTime: 4 });
  assert.equal(hard.mode, 'seek');
  assert.equal(hard.targetTime, 3);
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
