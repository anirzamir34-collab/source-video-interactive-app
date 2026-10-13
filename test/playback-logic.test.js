import test from 'node:test';
import assert from 'node:assert/strict';

import { canvasBlob, hasRemainingVideo, analysisGapBridgeTarget, isCompleteChunkAnalysis, sceneExitTime, nextVerifiedActionBoundary, seekMediaTo, playMedia } from '../public/playback-logic.js';

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

test('pending browser playback times out and a new seek cancels old play ownership', async () => {
  const video = new TestMedia();
  video.paused = true;
  video.play = () => new Promise(() => {});
  await assert.rejects(playMedia(video, { timeoutMs: 5 }), /zaman aşımına/);
  const pending = playMedia(video, { timeoutMs: 100 });
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  await seekMediaTo(video, 30);
  await cancelled;
  video.play = async () => { video.paused = false; };
  await playMedia(video, { timeoutMs: 20 });
});

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

test('the media element supersedes an older seek even across independent controllers', async () => {
  const video = new TestMedia();
  video.mode = 'stalled';
  const oldSeek = seekMediaTo(video, 10, { timeoutMs: 100 });
  const cancelled = assert.rejects(oldSeek, { name: 'AbortError' });
  video.mode = 'sync';
  assert.equal(await seekMediaTo(video, 60, { timeoutMs: 20 }), 60);
  await cancelled;
  video.dispatchEvent(new Event('seeked'));
  assert.equal(video.currentTime, 60);
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


test('a continuing dialogue never consumes the next verified chronological choice', () => {
  const first = { actionId: 'smile', sourceVerified: true, startTime: 4.8, endTime: 14.4 };
  const next = { actionId: 'take', sourceVerified: true, startTime: 14.4, endTime: 24 };
  const later = { actionId: 'leave', sourceVerified: true, startTime: 24, endTime: 36 };
  assert.equal(nextVerifiedActionBoundary([first, next, later], first), 14.4);
  assert.equal(nextVerifiedActionBoundary([first, { ...next, sourceVerified: false }, later], first), 24);
  assert.equal(nextVerifiedActionBoundary([first], first), null);
});

test('co-temporal alternatives and overlapping observations do not move playback boundaries', () => {
  const current = { actionId: 'first', sourceVerified: true, startTime: 10, endTime: 20 };
  const same = { actionId: 'alternative', sourceVerified: true, startTime: 10, endTime: 24 };
  const overlapping = { actionId: 'overlap', sourceVerified: true, startTime: 15, endTime: 21 };
  const next = { actionId: 'next', sourceVerified: true, startTime: 20, endTime: 29 };
  assert.equal(nextVerifiedActionBoundary([current, same, overlapping, next], current), 20);
  assert.equal(nextVerifiedActionBoundary([current, same, overlapping], current), null);
  assert.equal(nextVerifiedActionBoundary([], current), null);
});
