import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canvasBlob,
  buildDubBlocks,
  dialogueSegmentAt,
  dialogueSegmentsAt,
  dialogueSegmentsForTarget,
  dialogueSegmentsForTargets,
  decisionBoundaryAfterDialogue,
  dubMasterClockCorrection,
  dubSegmentKey,
  fittedDubPlaybackRate,
  hasRemainingVideo,
  analysisGapBridgeTarget,
  isCompleteChunkAnalysis,
  isDubStartTimely,
  mapVideoTimeToDubTime,
  nextDialogueSegments,
  resolveDubGender,
  sceneExitTime,
  seekMediaTo
} from '../public/playback-logic.js';

test('scene exit preserves adjacent footage and only actual video end is terminal', () => {
  assert.equal(sceneExitTime(24, 100), 24);
  assert.equal(sceneExitTime(120, 100), 100);
  assert.equal(sceneExitTime(24, NaN), 24);
  assert.equal(hasRemainingVideo(24, 100), true);
  assert.equal(hasRemainingVideo(100, 100), false);
});

class TestMedia extends EventTarget {
  duration = 100;
  readyState = 4;
  seeking = false;
  time = 0;
  mode = 'sync';
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value;
    this.seeking = this.mode === 'stalled';
    if (this.mode === 'sync') this.dispatchEvent(new Event('seeked'));
    if (this.mode === 'error') this.dispatchEvent(new Event('error'));
  }
}

test('seek listener catches immediate events and repeated same-time navigation', async () => {
  const video = new TestMedia();
  assert.equal(await seekMediaTo(video, 25, { timeoutMs: 20 }), 25);
  assert.equal(await seekMediaTo(video, 25, { timeoutMs: 20 }), 25);
});

test('missing seek event succeeds only if a decoded frame actually reached the target', async () => {
  const video = new TestMedia();
  video.mode = 'silent';
  assert.equal(await seekMediaTo(video, 20, { timeoutMs: 5 }), 20);
  video.mode = 'stalled';
  await assert.rejects(seekMediaTo(video, 30, { timeoutMs: 5 }), /beklenen sürede/);
});

test('failed media seek rejects instead of leaving navigation locked', async () => {
  const video = new TestMedia();
  video.mode = 'error';
  await assert.rejects(seekMediaTo(video, 40, { timeoutMs: 10 }), /yüklenemedi/);
});

test('superseded seek is cancelled and cannot settle the new navigation', async () => {
  const video = new TestMedia();
  video.mode = 'stalled';
  const controller = new AbortController();
  const oldSeek = seekMediaTo(video, 10, { signal: controller.signal, timeoutMs: 20 });
  controller.abort();
  await assert.rejects(oldSeek, { name: 'AbortError' });
  video.mode = 'sync';
  assert.equal(await seekMediaTo(video, 50, { timeoutMs: 20 }), 50);
});

test('same-time seek waits for decoded image data, including the first frame', async () => {
  const video = new TestMedia();
  video.readyState = 1;
  const pending = seekMediaTo(video, 0, { timeoutMs: 50 });
  let completed = false;
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  video.readyState = 2;
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(await pending, 0);
});

test('image encoding fails promptly, handles abort, and ignores late callbacks', async () => {
  await assert.rejects(canvasBlob({ toBlob() {} }, { timeoutMs: 5 }), /zaman aşımına/);
  await assert.rejects(canvasBlob({ toBlob(callback) { callback(null); } }), /oluşturulamadı/);
  const controller = new AbortController();
  let callback;
  const pending = canvasBlob({ toBlob(fn) { callback = fn; } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  callback(new Blob(['late']));
  const expected = new Blob(['image']);
  assert.equal(await canvasBlob({ toBlob(fn) { fn(expected); } }), expected);
});

test('partial chunk analysis is never considered complete', () => {
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 2, expectedChunkCount: 10 }), false);
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 10, expectedChunkCount: 10, failed: true }), false);
  assert.equal(isCompleteChunkAnalysis({ completedChunkCount: 10, expectedChunkCount: 10 }), true);
});

test('failed analysis ranges bridge to the next verified route or media end', () => {
  const gaps = [{ startTime: 12, endTime: 20 }];
  assert.equal(analysisGapBridgeTarget(gaps, 10, [11, 30], 100), null);
  assert.equal(analysisGapBridgeTarget(gaps, 11, [30, 60], 100), 30);
  assert.equal(analysisGapBridgeTarget(gaps, 15, [30], 100), 30);
  assert.equal(analysisGapBridgeTarget(gaps, 11, [], 100), 100);
  assert.equal(analysisGapBridgeTarget(gaps, 21, [30], 100), null);
  assert.equal(analysisGapBridgeTarget([], 11, [30], 100), null);
});

test('line-level dub gender overrides stale speaker memory', () => {
  assert.equal(resolveDubGender('female', 'male', 'male'), 'female');
  assert.equal(resolveDubGender('male', 'female', 'female'), 'male');
  assert.equal(resolveDubGender('uncertain', 'female', 'male'), 'male');
  assert.equal(resolveDubGender('', 'female', ''), 'female');
});

test('late dub audio is skipped instead of shifting later dialogue', () => {
  const segment = { startTime: 10, endTime: 13 };
  assert.equal(isDubStartTimely(10.4, segment), true);
  assert.equal(isDubStartTimely(11, segment), false);
  assert.equal(isDubStartTimely(13.1, segment), false);
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

test('adjacent subtitle lines retain independent timed speech by default', () => {
  const blocks = buildDubBlocks([
    { segmentId: 'a', speakerId: 'woman-a', startTime: 10, endTime: 12, turkishText: 'Birinci cümle.' },
    { segmentId: 'b', speakerId: 'woman-a', startTime: 12.2, endTime: 14, turkishText: 'İkinci cümle.' },
    { segmentId: 'c', speakerId: 'man-a', startTime: 14.1, endTime: 16, turkishText: 'Yanıt.' }
  ]);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].turkishText, 'Birinci cümle.');
  assert.deepEqual(blocks[0].sourceSegmentIds, ['a']);
  assert.equal(blocks[1].startTime, 12.2);
  assert.equal(blocks[2].speakerId, 'man-a');
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
