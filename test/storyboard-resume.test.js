import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { analysisCheckpointKey, storyboardSourceKey, createAnalysisResponseCache } from '../public/analysis-response-cache.js';

const FRAME = new Blob([new Uint8Array([0xff, 0xd8, 13, 27, 59, 0xff, 0xd9])], { type: 'image/jpeg' });
const SAMPLE = { sheets: [FRAME], timestamps: [0, 4.5, 9], duration: 30,
  motionProfile: [], sceneBoundaries: [], skippedTimestamps: [], totalBytes: FRAME.size };

test('same source bytes recover identical storyboard across refreshed cache instances', async () => {
  const source = new Blob([new Uint8Array(900000).map((_, i) => i % 227)]);
  const copy = new Blob([await source.arrayBuffer()]);
  const key = await storyboardSourceKey(source, { crypto: webcrypto });
  assert.equal(key, await storyboardSourceKey(copy, { crypto: webcrypto }));
  const first = createAnalysisResponseCache({ indexedDB });
  assert.equal(await first.saveStoryboard(key, SAMPLE), true);
  const mode = JSON.stringify({ model: 'gemini-3.8-flash', chapters: 40 });
  const checkpoint = await analysisCheckpointKey({ ...SAMPLE, mode, crypto: webcrypto });
  const chapter = { available: true, actions: [{ actionId: 'verified-1', sourceVerified: true,
    startTime: 0, endTime: 9 }] };
  for (let index = 0; index < 40; index++)
    assert.equal(await first.saveCheckpoint(checkpoint, index, chapter), true);
  await first.close();

  const next = createAnalysisResponseCache({ indexedDB });
  const restored = await next.readStoryboard(key);
  assert.ok(restored);
  assert.deepEqual(restored.timestamps, SAMPLE.timestamps);
  assert.deepEqual(new Uint8Array(await restored.sheets[0].arrayBuffer()),
    new Uint8Array(await FRAME.arrayBuffer()));
  assert.equal(await analysisCheckpointKey({ ...restored, mode, crypto: webcrypto }), checkpoint);
  for (let index = 0; index < 40; index++) {
    const recoveredChapter = await next.readCheckpoint(checkpoint, index);
    assert.equal(recoveredChapter.actions[0].actionId, 'verified-1');
  }
  await next.close();
});

test('different source bytes never retrieve the wrong storyboard', async () => {
  const first = new Blob([Uint8Array.from({ length: 260000 }, (_, i) => i % 251)]);
  const secondBytes = new Uint8Array(await first.arrayBuffer());
  secondBytes[130000] ^= 4;
  const second = new Blob([secondBytes]);
  const key1 = await storyboardSourceKey(first, { crypto: webcrypto });
  const key2 = await storyboardSourceKey(second, { crypto: webcrypto });
  assert.notEqual(key1, key2);
  const cache = createAnalysisResponseCache({ indexedDB });
  await cache.saveStoryboard(key1, SAMPLE);
  assert.equal(await cache.readStoryboard(key2), null);
  await cache.close();
});

test('same source speech context persists with the storyboard and respects expiry', async () => {
  let now = 1000;
  const key = 'transcript-stability-fixture';
  const cache = createAnalysisResponseCache({ indexedDB, now: () => now, ttlMs: 3600 });
  const transcript = { segments: [{ segmentId: 'speaker-0', startTime: 11, text: 'Test' }] };
  assert.equal(await cache.saveSourceTranscript(key, transcript), true);
  assert.deepEqual(await cache.readSourceTranscript(key), transcript);
  assert.equal(await cache.saveStoryboard(key, SAMPLE), true);
  await cache.close();
  const loaded = createAnalysisResponseCache({ indexedDB, now: () => now, ttlMs: 3600 });
  assert.deepEqual(await loaded.readSourceTranscript(key), transcript);
  assert.ok(await loaded.readStoryboard(key));
  now = 5000;
  assert.equal(await loaded.readSourceTranscript(key), null);
  assert.equal(await loaded.readStoryboard(key), null);
  await loaded.close();
});

test('storage unavailable causes a detectable failure instead of pretending to protect paid chapters', async () => {
  const cache = createAnalysisResponseCache({ indexedDB: null });
  assert.equal(await cache.saveStoryboard('x', SAMPLE), false);
  assert.equal(await cache.saveCheckpoint('x', 0, { available: true, actions: [] }), false);
  assert.equal(await cache.readStoryboard('x'), null);
  assert.equal(await cache.readCheckpoint('x', 0), null);
});
