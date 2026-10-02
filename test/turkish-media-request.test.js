import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRequest } from '../lib/turkish-media/http.js';
import { publicMediaError, MediaError, redactMediaSecrets } from '../lib/turkish-media/errors.js';
import { loadMediaConfig, publicMediaConfig } from '../lib/turkish-media/config.js';
import { createTranslationProvider } from '../lib/turkish-media/translation.js';

test('request retries 429/503 within bounds, honors Retry-After and counts actual attempts', async () => {
  const delays = [], attempts = [], retries = [];
  let calls = 0;
  const request = createMediaRequest({ maxRetries: 2, random: () => 0, sleep: async ms => delays.push(ms),
    onRequest: row => attempts.push(row), onRetry: row => retries.push(row), secrets: ['secret-key'],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limit secret-key', { status: 429, headers: { 'retry-after': '2' } });
      if (calls === 2) return new Response('temporary', { status: 503 });
      return Response.json({ ready: true });
    } });
  assert.deepEqual(await request('https://api.elevenlabs.io/v1/models'), { ready: true });
  assert.equal(calls, 3);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(row => row.attempt), [0, 1, 2]);
  assert.deepEqual(delays, [2000, 1200]);
  assert.deepEqual(retries.map(row => row.code), ['PROVIDER_HTTP_429', 'PROVIDER_HTTP_503']);
});

test('long Retry-After fails with a resumable error without sleeping or hammering the provider', async () => {
  let calls = 0;
  const request = createMediaRequest({ maxRetries: 3, sleep: () => assert.fail('long wait should not start'),
    fetchImpl: async () => { calls += 1; return new Response('rate limit', { status: 429, headers: { 'retry-after': '120' } }); } });
  await assert.rejects(request('https://provider.invalid'), { code: 'PROVIDER_RATE_LIMIT_WAIT', retryable: true });
  assert.equal(calls, 1);
});

test('400 errors do not retry and all public messages redact configured credentials', async () => {
  let calls = 0;
  const request = createMediaRequest({ maxRetries: 4, secrets: ['server-secret'],
    fetchImpl: async () => { calls += 1; return new Response('xi-api-key: server-secret Authorization: Bearer token-abc', { status: 400 }); } });
  let caught;
  try { await request('https://provider.invalid'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'PROVIDER_HTTP_400');
  assert.equal(calls, 1);
  assert.ok(!caught.message.includes('server-secret'));
  assert.ok(!caught.message.includes('token-abc'));
  const exposed = publicMediaError(new MediaError('TEST', 'server-secret Bearer token-abc', { segmentIds: ['s1'] }), ['server-secret']);
  assert.ok(!JSON.stringify(exposed).includes('server-secret'));
  assert.ok(!JSON.stringify(exposed).includes('token-abc'));
  assert.deepEqual(exposed.segmentIds, ['s1']);
  assert.equal(redactMediaSecrets('api_key=private', []), 'api_key=[REDACTED]');
});

test('server provider errors preserve full redacted details while public responses remain bounded', async () => {
  let calls = 0;
  const details = `provider validation ${'diagnostic '.repeat(400)} private-key final-diagnostic-marker`;
  const request = createMediaRequest({ maxRetries: 3, secrets: ['private-key'],
    fetchImpl: async () => { calls += 1; return new Response(details, { status: 400 }); } });
  let caught;
  try { await request('https://provider.invalid'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'PROVIDER_HTTP_400');
  assert.equal(calls, 1);
  assert.ok(caught.message.length > 4000);
  assert.ok(caught.message.endsWith('final-diagnostic-marker'));
  assert.ok(caught.message.includes('[REDACTED]'));
  assert.ok(!caught.message.includes('private-key'));
  assert.equal(publicMediaError(caught).message.length, 1500);
});

test('accepted invalid JSON is not retried as a network failure', async () => {
  let calls = 0;
  const request = createMediaRequest({ maxRetries: 3, sleep: async () => {},
    fetchImpl: async () => { calls += 1; return new Response('{invalid-json', { status: 200 }); } });
  await assert.rejects(request('https://provider.invalid/paid-generation'), { code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
  assert.equal(calls, 1);
});

test('timeout aborts the fetch and caller cancellation retains the original reason', async () => {
  const pendingFetch = async (_url, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const request = createMediaRequest({ fetchImpl: pendingFetch, maxRetries: 0, timeoutMs: 5 });
  await assert.rejects(request('https://provider.invalid'), { code: 'PROVIDER_TIMEOUT', retryable: true });
  const controller = new AbortController();
  const reason = new Error('cancel-this-job');
  const cancelled = request('https://provider.invalid', { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
});

test('pre-aborted requests do not create a body, call fetch or count an attempt', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already-cancelled'));
  const request = createMediaRequest({ fetchImpl: () => assert.fail('fetch should not run'), onRequest: () => assert.fail('count should not run') });
  await assert.rejects(request('https://provider.invalid', { signal: controller.signal,
    bodyFactory: () => assert.fail('body should not run') }), /already-cancelled/);
});

test('fresh multipart bodies survive bounded retry without changing source bytes', async () => {
  const bodies = [];
  let factories = 0;
  const request = createMediaRequest({ maxRetries: 1, random: () => 0, sleep: async () => {},
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      assert.equal(await options.body.get('file').text(), 'source-audio');
      return bodies.length === 1 ? new Response('temporary', { status: 503 }) : Response.json({ words: [] });
    } });
  await request('https://provider.invalid/transcribe', { method: 'POST', bodyFactory: () => {
    factories += 1;
    const body = new FormData();
    body.set('file', new Blob(['source-audio']), 'source.wav');
    return body;
  } });
  assert.equal(factories, 2);
  assert.notEqual(bodies[0], bodies[1]);
});

test('public configuration exposes capability flags and model names without provider keys', () => {
  const config = loadMediaConfig({ ELEVENLABS_API_KEY: 'private-eleven', OPENAI_API_KEY: 'private-openai' });
  const published = publicMediaConfig(config);
  assert.equal(published.configured, true);
  assert.equal(published.models.quality, 'eleven_v4');
  assert.equal(published.models.fast, 'eleven_v4_turbo');
  assert.equal(published.models.transcription, 'scribe_v2');
  assert.ok(!JSON.stringify(published).includes('private-eleven'));
  assert.ok(!JSON.stringify(published).includes('private-openai'));
  assert.throws(() => loadMediaConfig({ ELEVENLABS_DUB_MODEL: 'eleven_v3' }), /eleven_v4/);
  assert.throws(() => loadMediaConfig({ DUB_MAX_CONCURRENCY: '99' }));
});

const scene = { utterances: [
  { segmentId: 's1', speakerId: 'male-source', sourceText: 'Keep the name Paul.', sourceStart: 1, sourceEnd: 3 },
  { segmentId: 's2', speakerId: 'female-source', sourceText: 'Yes.', sourceStart: 3, sourceEnd: 4 },
], previousContext: [{ sourceText: 'Earlier verified dialogue.' }], nextContext: [],
speakers: [{ speakerId: 'male-source', gender: 'male' }], sceneContext: [{ evidence: 'actual source scene' }] };

test('translation preserves every speaker and source segment using structured scene context', async () => {
  const config = loadMediaConfig({ OPENAI_API_KEY: 'server-openai-key' });
  let requestBody;
  const provider = createTranslationProvider({ config, request: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer server-openai-key');
    requestBody = JSON.parse(options.body);
    return { choices: [{ message: { content: JSON.stringify({ translations: [
      { segmentId: 's2', text: 'Evet.' }, { segmentId: 's1', text: "Paul'un adını koru." },
    ] }) } }] };
  } });
  const result = await provider.translateScene(scene);
  assert.deepEqual(result.map(row => row.segmentId), ['s1', 's2']);
  assert.deepEqual(result.map(row => row.speakerId), ['male-source', 'female-source']);
  assert.equal(result[0].targetDuration, 2);
  assert.equal(requestBody.response_format.type, 'json_schema');
  const payload = JSON.parse(requestBody.messages[1].content);
  assert.equal(payload.utterances[0].sourceText, scene.utterances[0].sourceText);
  assert.equal(payload.previousContext[0].sourceText, scene.previousContext[0].sourceText);
  assert.equal(payload.sceneContext[0].evidence, 'actual source scene');
  assert.match(requestBody.messages[0].content, /Never merge, drop or invent/);
  assert.match(requestBody.messages[0].content, /without censorship/);
});

test('missing, duplicate and invented translation IDs cannot authorize generated dialogue', async () => {
  const config = loadMediaConfig({ OPENAI_API_KEY: 'server-key' });
  const variants = [
    [{ segmentId: 's1', text: 'A' }],
    [{ segmentId: 's1', text: 'A' }, { segmentId: 's1', text: 'B' }],
    [{ segmentId: 's1', text: 'A' }, { segmentId: 'invented', text: 'B' }],
  ];
  for (const translations of variants) {
    const provider = createTranslationProvider({ config, request: async () => ({ choices: [{ message: {
      content: JSON.stringify({ translations }),
    } }] }) });
    await assert.rejects(provider.translateScene(scene), error =>
      ['TRANSLATION_MISSING_SEGMENTS', 'TRANSLATION_SEGMENT_MISMATCH'].includes(error.code));
  }
});
