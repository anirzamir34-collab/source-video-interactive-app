import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveAnalysisChunkPlan,
  detectSceneBoundaries,
  extractStoryboard,
  selectFocusedTimestamps,
  shouldBufferStoryboardSource,
  sheetsPerAnalysisChunk,
  storyboardSamplingPlan
} from '../public/storyboard.js';

test('analysis chunks scale with video length and stay capped at fifteen', () => {
  assert.deepEqual(adaptiveAnalysisChunkPlan(12, 578, 'ultra'), {
    sheetsPerChunk: 2,
    chunkCount: 6
  });
  assert.deepEqual(adaptiveAnalysisChunkPlan(40, 3600, 'ultra'), {
    sheetsPerChunk: 3,
    chunkCount: 14
  });
  assert.equal(adaptiveAnalysisChunkPlan(2, 45, 'ultra').chunkCount, 1);
  assert.ok(adaptiveAnalysisChunkPlan(30, 180, 'ultra').chunkCount <= 3);
  assert.ok(adaptiveAnalysisChunkPlan(40, 773, 'ultra').chunkCount <= 10);
});

test('analysis chunk planning reduces calls without dropping storyboard frames', () => {
  assert.equal(sheetsPerAnalysisChunk('ultra'), 3);
  assert.equal(sheetsPerAnalysisChunk('balanced'), 3);
  assert.equal(sheetsPerAnalysisChunk('fast'), 4);
  assert.equal(sheetsPerAnalysisChunk('ultra', true), 1);
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
async function withMediaFixture(run, { encodeFails = false, duration = 3, onSeek = () => {}, onLoad = () => {} } = {}) {
  const originalDocument = globalThis.document;
  const canvases = [];
  let capturedBeforeDecode = false;
  class Video extends EventTarget {
    duration = duration;
    readyState = 1;
    videoWidth = 320;
    videoHeight = 180;
    time = 0;
    seeking = false;
    unloaded = false;
    get currentTime() { return this.time; }
    set currentTime(value) {
      onSeek(value, this);
      this.time = value;
      this.seeking = true;
      queueMicrotask(() => {
        this.seeking = false;
        this.readyState = 2;
        this.dispatchEvent(new Event('loadeddata'));
        this.dispatchEvent(new Event('seeked'));
      });
    }
    pause() {}
    removeAttribute() { this.unloaded = true; }
    load() {
      if (this.unloaded) return;
      this.time = 0;
      this.readyState = 1;
      onLoad(this);
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    }
  }
  const video = new Video();
  globalThis.document = { createElement(tag) {
    if (tag === 'video') return video;
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({
        drawImage(source) { if (source === video && video.readyState < 2) capturedBeforeDecode = true; },
        fillRect() {}, fillText() {},
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) })
      }),
      toBlob(callback) { callback(encodeFails ? null : new Blob(['image'])); }
    };
    canvases.push(canvas);
    return canvas;
  } };
  try {
    await run({ video, canvases, capturedBeforeDecode: () => capturedBeforeDecode });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

test('frame preparation waits for decoded data and releases frame buffers', async () => {
  await withMediaFixture(async fixture => {
    const result = await extractStoryboard(new Blob(['video']));
    assert.equal(result.timestamps.length, 4);
    assert.equal(result.skippedTimestamps.length, 0);
    assert.equal(fixture.capturedBeforeDecode(), false);
    assert.equal(fixture.video.unloaded, true);
    assert.ok(fixture.canvases.slice(2).every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('failed image encoding releases all frames and the source video', async () => {
  await withMediaFixture(async fixture => {
    await assert.rejects(extractStoryboard(new Blob(['video'])), /oluşturulamadı/);
    assert.equal(fixture.video.unloaded, true);
    assert.ok(fixture.canvases.slice(2).every(canvas => canvas.width === 0 && canvas.height === 0));
  }, { encodeFails: true });
});

test('cancelled frame preparation closes its video source', async () => {
  await withMediaFixture(async fixture => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(extractStoryboard(new Blob(['video']), () => {}, controller.signal), { name: 'AbortError' });
    assert.equal(fixture.video.unloaded, true);
  });
});

test('buffering is restricted to slow streams of known bounded size with enough work remaining', () => {
  const slow = { sourceBytes: 20 * 1024 * 1024, seekAttempts: 2, seekMs: 6000, remainingFrames: 40 };
  assert.equal(shouldBufferStoryboardSource(slow), true);
  for (const change of [{ sourceBytes: 0 }, { sourceBytes: 129 * 1024 * 1024 }, { seekMs: 100 }, { remainingFrames: 3 }]) {
    assert.equal(shouldBufferStoryboardSource({ ...slow, ...change }), false);
  }
});

test('retrying from a cached download preserves the remote sampling plan', async () => {
  let baseline;
  await withMediaFixture(async () => { baseline = await extractStoryboard('/proxy'); }, { duration: 120 });
  await withMediaFixture(async () => {
    const result = await extractStoryboard(new Blob(['cached-video']), () => {}, undefined, { remoteSampling: true });
    assert.deepEqual(result.timestamps, baseline.timestamps);
    assert.deepEqual(result.motionProfile, baseline.motionProfile);
  }, { duration: 120 });
});

test('slow remote seeks switch once to identical local bytes without recapturing or dropping timestamps', async t => {
  let baseline;
  await withMediaFixture(async () => { baseline = await extractStoryboard('/proxy'); }, { duration: 120 });
  let clock = 0;
  let downloads = 0;
  const seeks = [];
  const progress = [];
  t.mock.method(performance, 'now', () => clock);
  await withMediaFixture(async fixture => {
    const result = await extractStoryboard('/proxy', (percent, detail) => progress.push({ percent, detail }), undefined, {
      sourceBytes: 100,
      getLocalSource: async () => { downloads++; clock += 100; return new Blob(['video']); }
    });
    assert.equal(downloads, 1);
    assert.equal(result.performance.sourceMode, 'buffered');
    assert.equal(result.performance.bufferMs, 100);
    assert.deepEqual(result.timestamps, baseline.timestamps);
    assert.deepEqual(result.motionProfile, baseline.motionProfile);
    assert.equal(result.sheets.length, baseline.sheets.length);
    assert.equal(result.skippedTimestamps.length, 0);
    assert.equal(seeks.length, result.timestamps.length);
    assert.equal(seeks.filter(item => item.src === '/proxy').length, 2);
    assert.ok(progress.some(item => item.detail.phase === 'buffering' && item.detail.captured === 2));
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(fixture.video.unloaded, true);
  }, { duration: 120, onSeek(time, video) { seeks.push({ time, src: video.src }); clock += video.src === '/proxy' ? 2500 : 1; } });
});

test('failed buffering is attempted once and all remote frames still complete', async t => {
  let clock = 0;
  let downloads = 0;
  t.mock.method(performance, 'now', () => clock);
  await withMediaFixture(async () => {
    const result = await extractStoryboard('/proxy', () => {}, undefined, {
      sourceBytes: 100,
      getLocalSource: async () => { downloads++; throw new Error('Transfer deadline'); }
    });
    assert.equal(downloads, 1);
    assert.equal(result.performance.sourceMode, 'remote');
    assert.equal(result.skippedTimestamps.length, 0);
    assert.ok(result.timestamps.length >= 36);
    assert.match(result.performance.bufferFailure, /Transfer deadline/);
  }, { duration: 120, onSeek() { clock += 2500; } });
});

test('changed media duration rolls back to the remote source and preserves completed frames', async t => {
  let clock = 0;
  const switched = [];
  t.mock.method(performance, 'now', () => clock);
  await withMediaFixture(async () => {
    const result = await extractStoryboard('/proxy', () => {}, undefined, {
      sourceBytes: 100,
      getLocalSource: async () => new Blob(['different-video'])
    });
    assert.equal(result.performance.sourceMode, 'remote');
    assert.equal(result.skippedTimestamps.length, 0);
    assert.equal(result.duration, 120);
    assert.equal(switched.length, 2);
    assert.equal(switched.at(-1), '/proxy');
    assert.match(result.performance.bufferFailure, /süresi değişti/);
  }, {
    duration: 120, onSeek() { clock += 2500; },
    onLoad(video) { switched.push(video.src); video.duration = video.src === '/proxy' ? 120 : 121; }
  });
});

test('cancelling a buffer transfer stops extraction and releases the source', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  await withMediaFixture(async fixture => {
    const controller = new AbortController();
    await assert.rejects(extractStoryboard('/proxy', () => {}, controller.signal, {
      sourceBytes: 100,
      getLocalSource: async ({ signal }) => { controller.abort(); throw signal.reason; }
    }), { name: 'AbortError' });
    assert.equal(fixture.video.unloaded, true);
  }, { duration: 120, onSeek() { clock += 2500; } });
});
