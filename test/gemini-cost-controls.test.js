import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAnalysisRequestCache, storyboardRequestKey } from '../lib/analysis-request-cache.js';
import { createAnalysisResponseCache, analysisRequestKey } from '../public/analysis-response-cache.js';
import { geminiQuotaFailure } from '../public/gemini-quota.js';
import { storyboardFailureReason, generateStoryboardWithRetry } from '../public/analysis-recovery.js';
import { isTerminalStoryboardFailure } from '../public/analysis-recovery.js';
import { serializeReviewCandidates } from '../public/classification-integrity.js';

const result = () => ({ status: 200, body: { available: true, actions: [{ actionId: 'walk', startTime: 0, endTime: 4 }],
  aiUsage: { requests: 1, inputTokens: 50, outputTokens: 20, totalTokens: 70 } } });
const form = (context = 'source dialogue', image = 'frames') => {
  const data = new FormData();
  data.append('storyboards', new Blob([image], { type: 'image/jpeg' }), 'image.jpg');
  data.append('dialogueContext', context); data.append('chunkStart', '0');
  return data;
};

test('server shares a running model call, clones results, and charges no new call on reuse', async () => {
  const cache = createAnalysisRequestCache();
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const load = async () => { calls++; await pending; return { actions: [{ actionId: 'walk' }] }; };
  const a = cache.run('same', load), b = cache.run('same', load);
  release();
  const [first, second] = await Promise.all([a, b]);
  first.value.actions[0].actionId = 'mutated';
  const third = await cache.run('same', load);
  assert.equal(calls, 1); assert.equal(second.outcome, 'shared_result'); assert.equal(third.outcome, 'cache_hit');
  assert.equal(second.value.actions[0].actionId, 'walk'); assert.equal(third.value.actions[0].actionId, 'walk');
});

test('server never reuses failures and expires or evicts completed results', async () => {
  let time = 0, calls = 0;
  const cache = createAnalysisRequestCache({ now: () => time, ttlMs: 10, maxEntries: 1 });
  await assert.rejects(cache.run('a', async () => { throw Error('network'); }));
  const load = async () => { calls++; return { actions: [] }; };
  await cache.run('a', load); time = 10; await cache.run('a', load);
  await cache.run('b', load); await cache.run('a', load);
  assert.equal(calls, 4);
});

test('server request identity changes with account, model, prompt and image evidence', () => {
  const request = { apiKey: 'account', model: 'model', prompt: 'dialogue', files: [{ buffer: Buffer.from('frame'), mimetype: 'image/jpeg' }] };
  const key = storyboardRequestKey(request);
  for (const patch of [{ apiKey: 'other' }, { model: 'other' }, { prompt: 'review' },
    { files: [{ buffer: Buffer.from('other frame'), mimetype: 'image/jpeg' }] }]) assert.notEqual(storyboardRequestKey({ ...request, ...patch }), key);
  assert.match(key, /^[a-f0-9]{64}$/);
});

test('browser response cache survives a new connection without retaining or recounting paid usage', async () => {
  const indexedDB = new IDBFactory();
  const first = createAnalysisResponseCache({ indexedDB });
  let calls = 0;
  const load = async () => { calls++; return result(); };
  await first.run('same', load); await first.close();
  const afterReload = createAnalysisResponseCache({ indexedDB });
  const reused = await afterReload.run('same', load);
  assert.equal(calls, 1); assert.equal(reused.outcome, 'cache_hit');
  assert.equal(reused.body.aiUsage.requests, 0); assert.equal(reused.body.aiUsage.totalTokens, 0);
  assert.equal(reused.body.aiUsage.cacheHits, 1); assert.equal(reused.body.actions[0].actionId, 'walk');
  await afterReload.close();
});

test('browser cache identity invalidates changed revision, account, source dialogue and frames', async () => {
  const request = { revision: 'release-1', path: '/api/gemini-storyboard-analyze', headers: {}, form: form(), crypto: webcrypto };
  const key = await analysisRequestKey(request);
  for (const patch of [{ revision: 'release-2' }, { headers: { 'x-gemini-api-key': 'other-account' } },
    { form: form('changed dialogue') }, { form: form('source dialogue', 'different frames') }])
    assert.notEqual(await analysisRequestKey({ ...request, ...patch }), key);
  assert.equal(await analysisRequestKey({ ...request, revision: null }), null);
});

test('expired browser results and failed or malformed responses must call the provider again', async () => {
  let time = 0, calls = 0;
  const cache = createAnalysisResponseCache({ indexedDB: new IDBFactory(), now: () => time, ttlMs: 10 });
  const load = async () => { calls++; return result(); };
  await cache.run('ok', load); time = 10; await cache.run('ok', load);
  for (const body of [{ available: false }, { available: true }]) {
    const bad = async () => { calls++; return { status: 200, body }; };
    await cache.run('bad', bad); await cache.run('bad', bad);
  }
  assert.equal(calls, 6); await cache.close();
});

test('storage failure cannot prevent analysis and an aborted cache lookup never calls the provider', async () => {
  const cache = createAnalysisResponseCache({ indexedDB: null });
  let calls = 0;
  assert.equal((await cache.run('a', async () => { calls++; return result(); })).status, 200);
  await assert.rejects(cache.run('b', async () => { calls++; return result(); }, {
    signal: AbortSignal.abort(new DOMException('cancel', 'AbortError'))
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('rate, daily and monetary exhaustion are distinct and never automatically resent', async () => {
  for (const [message, reason] of [
    ['429 RESOURCE_EXHAUSTED quota exceeded, retryDelay: "12.5s"', 'GEMINI_RATE_LIMITED'],
    ['429 RESOURCE_EXHAUSTED GenerateRequestsPerDay quota exceeded', 'GEMINI_DAILY_LIMIT'],
    ['402 prepayment credits are depleted', 'GEMINI_CREDITS_DEPLETED']
  ]) {
    let calls = 0;
    await assert.rejects(generateStoryboardWithRetry(async () => { calls++; throw Error(message); }),
      error => storyboardFailureReason(error) === reason);
    assert.equal(calls, 1); assert.equal(geminiQuotaFailure(Error(message)).reason, reason);
  }
  assert.equal(geminiQuotaFailure(Error('quota retryDelay: "12.5s"')).retryAfterSeconds, 13);
  assert.equal(geminiQuotaFailure(Error('503 temporarily unavailable')), null);
});

test('actual browser upload path reuses exact successful requests and preserves response accounting', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const analysisResponseCache =');
  const end = source.indexOf('\nconst mediaClient =', start);
  let requests = 0;
  const scope = vm.createContext({ createAnalysisResponseCache: () => createAnalysisResponseCache({ indexedDB: new IDBFactory() }),
    analysisRequestKey: args => analysisRequestKey({ ...args, crypto: webcrypto }),
    analysisAbortController: null, analysisProgress: { update() {} }, AbortSignal, Response, JSON, globalThis: {},
    fetch: async path => path === '/health' ? new Response(JSON.stringify({ analysisRevision: 'same' }))
      : (requests++, new Response(JSON.stringify(result().body))),
  });
  vm.runInContext(source.slice(start, end), scope);
  const first = await (await scope.postAnalysisForm('/api/gemini-storyboard-analyze', form())).json();
  const repeat = await (await scope.postAnalysisForm('/api/gemini-storyboard-analyze', form())).json();
  assert.equal(requests, 1); assert.equal(first.aiUsage.requests, 1); assert.equal(repeat.aiUsage.requests, 0);
});

function serverHandler(generateContent) {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.indexOf("app.post('/api/gemini-storyboard-analyze'");
  const start = source.indexOf('async (req, res) => {', route);
  const end = source.indexOf("\napp.post('/api/external-analyze'", start);
  return vm.runInNewContext(`(${source.slice(start, end).trim().replace(/\);$/, '')})`, {
    GoogleGenAI: class { models = { generateContent }; },
    resolveGeminiApiKey: () => 'test-account', emptyGeminiUsage: () => ({ requests: 0 }),
    addGeminiUsage: usage => { usage.requests++; },
    storyboardFailureReason, isTerminalStoryboardFailure, serializeReviewCandidates, geminiQuotaFailure, storyboardRequestKey,
    storyboardRequestCache: createAnalysisRequestCache(), GEMINI_DEFAULT_MODEL: 'test-model',
    generateStoryboardWithRetry: (load, options) => generateStoryboardWithRetry(load, { ...options, wait: async () => {} }),
    process: { env: {} }, console: { warn() {}, error() {}, info() {} }
  });
}
const serverRequest = () => ({ body: { duration: 120, chunkEnd: 120, timestamps: JSON.stringify(Array.from({ length: 20 }, (_, i) => i * 6)) },
  files: Array.from({ length: 20 }, (_, i) => ({ buffer: Buffer.from(`frame-${i}`), mimetype: 'image/jpeg' })) });
const serverResponse = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('provider outage never fans twenty sheets into additional model calls', async () => {
  let calls = 0;
  const handler = serverHandler(async () => { calls++; throw Error('503 UNAVAILABLE'); });
  const response = serverResponse(); await handler(serverRequest(), response);
  assert.equal(calls, 2); assert.equal(response.statusCode, 503); assert.equal(response.body.retryable, false);
  assert.equal(response.body.reason, 'GEMINI_TEMPORARILY_UNAVAILABLE');
});

test('quota exhaustion during recovery stops all not-yet-started sheet calls', async () => {
  let calls = 0;
  const handler = serverHandler(async () => {
    calls++;
    if (calls <= 2) return { text: '{', usageMetadata: {} };
    throw Error('429 RESOURCE_EXHAUSTED quota exceeded');
  });
  const response = serverResponse(); await handler(serverRequest(), response);
  assert.ok(calls <= 4); assert.equal(response.statusCode, 429);
  assert.equal(response.body.reason, 'GEMINI_RATE_LIMITED'); assert.equal(response.body.retryable, false);
});

test('old tabs polling key status spend zero inference calls; an explicit test calls once', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.indexOf("app.post('/api/gemini-key-status'");
  const start = source.indexOf('async (req, res) => {', route);
  const end = source.indexOf("\napp.get('/health'", start);
  let calls = 0;
  const handler = vm.runInNewContext(`(${source.slice(start, end).trim().replace(/\);$/, '')})`, {
    clientGeminiApiKey: () => 'test-account', GEMINI_DEFAULT_MODEL: 'test-model',
    GoogleGenAI: class { models = { generateContent: async () => { calls++; return { usageMetadata: {} }; } }; },
    addGeminiUsage: usage => { usage.requests++; return usage; }, emptyGeminiUsage: () => ({ requests: 0 }),
    process: { env: {} }, console: { info() {} }, quotaRetrySeconds: () => 0
  });
  for (let i = 0; i < 60; i++) {
    const response = serverResponse(); await handler({ body: {} }, response);
    assert.equal(response.body.providerAccessVerified, false);
  }
  assert.equal(calls, 0);
  const response = serverResponse(); await handler({ body: { verify: true } }, response);
  assert.equal(calls, 1); assert.equal(response.body.state, 'available');
});
