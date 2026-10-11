import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { analysisCheckpointKey, createAnalysisResponseCache } from '../public/analysis-response-cache.js';

const source = value => new Blob([value], { type: 'video/mp4' });
const sheets = (...values) => values.map(value => new Blob([value], { type: 'image/jpeg' }));
const input = (video, jpeg) => ({
  source: video, sheets: sheets(jpeg),
  timestamps: [0, 2, 4, 6, 8, 10], duration: 12,
  mode: JSON.stringify({ model: 'economy', pipeline: 4, dialogue: 'same-verified-speech' }),
  crypto: webcrypto
});

test('the original video identity survives regenerated JPEG sheets and a new Gemini credential', async () => {
  const video = source('video-content-identical-even-when-rendered-jpegs-differ');
  const first = await analysisCheckpointKey(input(video, 'jpeg-from-first-video-element'));
  const rotated = await analysisCheckpointKey(input(video, 'jpeg-from-reinitialized-video-element'));
  assert.equal(first, rotated, 'JPEG encoding differences must not re-bill 15 chapters');
  assert.equal(first.length, 64);
});

test('different video files with the same metadata and duration cannot share verified checkpoints', async () => {
  const a = source('video-AAAAA-identical-size');
  const b = source('video-BBBBB-identical-size');
  assert.equal(a.size, b.size);
  assert.notEqual(await analysisCheckpointKey(input(a, 'identical-jpeg')), await analysisCheckpointKey(input(b, 'identical-jpeg')));
  assert.notEqual(await analysisCheckpointKey(input(a, 'identical-jpeg')),
    await analysisCheckpointKey({ ...input(a, 'identical-jpeg'), mode: 'different-analysis-contract' }));
  assert.notEqual(await analysisCheckpointKey(input(a, 'identical-jpeg')),
    await analysisCheckpointKey({ ...input(a, 'identical-jpeg'), timestamps: [0, 2, 5, 7, 9, 11] }));
});

test('all fifteen previously verified chapters survive browser cache reopening and a new JPEG encode', async () => {
  const indexedDB = new IDBFactory();
  const video = source('same-verified-video-for-all-fifteen-chapter-checkpoints');
  const prefix = await analysisCheckpointKey(input(video, 'first-encoding'));
  const original = createAnalysisResponseCache({ indexedDB });
  for (let index = 0; index < 15; index++) {
    assert.equal(await original.saveCheckpoint(prefix, index, { available: true,
      actions: [{ actionId: 'chapter-' + index, sourceVerified: true }] }), true);
  }
  await original.close();
  const reopened = createAnalysisResponseCache({ indexedDB });
  const identicalSource = source('same-verified-video-for-all-fifteen-chapter-checkpoints');
  const rotated = await analysisCheckpointKey(input(identicalSource, 'new-encoding-different-jpeg'));
  assert.equal(prefix, rotated);
  for (let index = 0; index < 15; index++) {
    const result = await reopened.readCheckpoint(rotated, index);
    assert.equal(result?.actions[0]?.actionId, 'chapter-' + index);
  }
  await reopened.close();
});

test('legacy sheet-only checkpoint remains readable for one-time migration', async () => {
  const values = { sheets: sheets('original-render'), timestamps: [0,1,2],
    duration: 3, mode: 'legacy-current-analysis', crypto: webcrypto };
  const legacy = await analysisCheckpointKey(values);
  const newSource = await analysisCheckpointKey({ ...values, source: source('actual-video-bytes') });
  assert.notEqual(legacy, newSource);
  const store = createAnalysisResponseCache({ indexedDB: new IDBFactory() });
  assert.equal(await store.saveCheckpoint(legacy, 0, { available: true, actions: [{ actionId: 'earlier-pass' }] }), true);
  assert.equal((await store.readCheckpoint(legacy, 0))?.actions[0].actionId, 'earlier-pass');
  await store.close();
});
