import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexedDB } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import {
  analysisRequestKey, analysisCheckpointKey, createAnalysisResponseCache
} from '../public/analysis-response-cache.js';

const sha = webcrypto;
const image = (text, name = 'frame.jpg') => new File([text], name, { type: 'image/jpeg' });
const settings = '{"analysisTier":"economy","quality":"ultra","chunks":15}';
const evidence = [image('unmodified source frame 001'), image('unmodified source frame 120')];

test('successful visual analysis requests are credential-independent on one device; evidence and model revision are not', async () => {
  const form = new FormData();
  form.append('storyboards', image('real image evidence', 'first.jpg'));
  form.append('analysisTier', 'economy');
  form.append('chunkIndex', '1');
  const first = await analysisRequestKey({
    revision: 'same-model-version', path: '/api/gemini-storyboard-analyze', form,
    headers: { 'X-Gemini-Api-Key': 'old-exhausted-secret' }, crypto: sha
  });
  const second = await analysisRequestKey({
    revision: 'same-model-version', path: '/api/gemini-storyboard-analyze', form,
    headers: { 'X-Gemini-Api-Key': 'new-valid-secret' }, crypto: sha
  });
  assert.equal(first, second, 'key changes must not re-bill verified scene input');
  assert.notEqual(first, await analysisRequestKey({
    revision: 'changed-model-revision', path: '/api/gemini-storyboard-analyze', form,
    headers: {}, crypto: sha
  }), 'changing prompt/model implementation invalidates exact HTTP response cache');
  form.set('chunkIndex', '2');
  assert.notEqual(first, await analysisRequestKey({
    revision: 'same-model-version', path: '/api/gemini-storyboard-analyze', form,
    headers: {}, crypto: sha
  }));
  assert.doesNotMatch(first, /old-exhausted-secret|new-valid-secret/);
});

test('15 verified sections resume instantly across new cache instance and key replacement', async t => {
  let now = 500000;
  const first = createAnalysisResponseCache({ indexedDB, now: () => now });
  const prefix = await analysisCheckpointKey({
    sheets: evidence, timestamps: [0, 15, 120], duration: 120, mode: settings, crypto: sha
  });
  assert.ok(prefix);
  t.after(() => first.close());
  for (let i = 0; i < 15; i++) assert.equal(await first.saveCheckpoint(prefix, i, {
    available: true, actions: [{ actionId: 'verified-action-' + i, startTime: i, endTime: i + .5 }],
    warnings: [], chunkIndex: i, secondPassReviewed: true
  }), true);
  await first.close();
  const newSession = createAnalysisResponseCache({ indexedDB, now: () => now });
  t.after(() => newSession.close());
  const results = [];
  for (let i = 0; i < 15; i++) results.push(await newSession.readCheckpoint(prefix, i));
  assert.equal(results.filter(r => r?.available).length, 15);
  assert.equal(results[14].actions[0].actionId, 'verified-action-14');
  results[0].actions[0].actionId = 'tampered';
  assert.equal((await newSession.readCheckpoint(prefix, 0)).actions[0].actionId, 'verified-action-0',
    'mutating a returned chapter cannot poison the stored checkpoint');
  now += 86400000;
  assert.equal(await newSession.readCheckpoint(prefix, 3), null,
    'checkpoint age is bounded to 24h');
});

test('checkpoint identity depends on actual source bytes and analysis settings, not filename or Gemini key', async () => {
  const key = args => analysisCheckpointKey({ sheets: args.sheets, timestamps: [0, 15, 120],
    duration: 120, mode: args.mode, crypto: sha });
  const a = await key({ sheets: evidence, mode: settings });
  assert.equal(a, await key({ sheets: evidence.map(asyncImpossible => image(asyncImpossible === evidence[0]
    ? 'unmodified source frame 001' : 'unmodified source frame 120')), mode: settings }));
  assert.notEqual(a, await key({ sheets: [image('altered different video'), evidence[1]], mode: settings }));
  assert.notEqual(a, await key({ sheets: evidence, mode: '{"analysisTier":"deep"}' }));
});

test('never checkpoint failed, truncated or blocked provider outputs; code retains source soundtrack on blocked translation', async t => {
  const cache = createAnalysisResponseCache({ indexedDB });
  t.after(() => cache.close());
  const prefix = 'blocked-provider-case';
  for (const body of [
    { available: false, actions: [{ id: 'fake' }] },
    { available: true },
    { available: false, reason: 'GEMINI_CONTENT_RESTRICTED', actions: [] }
  ]) assert.equal(await cache.saveCheckpoint(prefix, 0, body), false);
  assert.equal(await cache.readCheckpoint(prefix, 0), null);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /analysisCheckpointKey\(/);
  assert.match(app, /await analysisResponseCache\.readCheckpoint\(checkpointPrefix, index\)/);
  assert.match(app, /await analysisResponseCache\.saveCheckpoint\(checkpointPrefix, chunkIndex, chunkBody\)/);
  assert.match(app, /error\?\.code !== 'TRANSLATION_BLOCKED'/);
  assert.match(app, /sourceAudioOnly = true/);
  assert.match(app, /mediaClient\.reset\(\{ cancelJob: false \}\)/);
  assert.match(app, /Gemini konuşma çevirisini engelledi/);
});
