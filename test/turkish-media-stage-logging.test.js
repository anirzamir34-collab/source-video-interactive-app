import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageLogger, configuredLogSecrets } from '../lib/turkish-media/stage-logging.js';
import { MediaError } from '../lib/turkish-media/errors.js';

function fixture(options = {}) {
  const entries = [];
  let wall = Date.UTC(2026, 9, 2, 12);
  let tick = 100;
  const logger = createStageLogger({ jobId: 'job-example', write: entry => entries.push(entry),
    now: () => wall, monotonic: () => tick, ...options });
  return { entries, logger, advance(ms) { wall += ms; tick += ms; }, wall(ms) { wall += ms; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('stage events use UTC wall clocks and monotonic duration while preserving the work result', async () => {
  const f = fixture();
  const result = { actualAudio: true };
  assert.equal(await f.logger.run('FORCED_ALIGNMENT', { segmentId: 'segment-1', model: 'alignment', count: 1 }, async () => {
    f.advance(22.5);
    f.wall(5000);
    return result;
  }), result);
  const [start, end] = f.entries;
  assert.equal(start.event, 'media_stage_start');
  assert.equal(end.event, 'media_stage_end');
  assert.equal(start.timestamp, '2026-10-02T12:00:00.000Z');
  assert.equal(end.timestamp, '2026-10-02T12:00:05.022Z');
  assert.equal(end.startedAt, start.timestamp);
  assert.equal(end.endedAt, end.timestamp);
  assert.equal(end.durationMs, 22.5);
  assert.equal(end.outcome, 'completed');
  assert.equal(start.operationId, end.operationId);
  assert.match(start.operationId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(end.segmentId, 'segment-1');
  assert.equal(end.jobId, 'job-example');
});

test('concurrent operations in the same stage retain independent start timers and IDs', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  const a = f.logger.run('GENERATING_DUB', { segmentId: 'a' }, () => first.promise);
  f.advance(10);
  const b = f.logger.run('GENERATING_DUB', { segmentId: 'b' }, () => second.promise);
  f.advance(5);
  second.resolve('b-audio');
  assert.equal(await b, 'b-audio');
  f.advance(20);
  first.resolve('a-audio');
  assert.equal(await a, 'a-audio');
  const starts = f.entries.filter(entry => entry.event === 'media_stage_start');
  const ends = f.entries.filter(entry => entry.event === 'media_stage_end');
  assert.notEqual(starts[0].operationId, starts[1].operationId);
  assert.equal(ends.find(entry => entry.segmentId === 'a').durationMs, 35);
  assert.equal(ends.find(entry => entry.segmentId === 'b').durationMs, 5);
  for (const end of ends) assert.equal(end.operationId, starts.find(start => start.segmentId === end.segmentId).operationId);
});

test('cache and shared work outcomes report what happened without inventing a provider operation', async () => {
  const f = fixture();
  f.logger.instant('TRANSCRIBING', { cacheScope: 'source', count: 4 }, { outcome: 'cache_hit' });
  f.logger.instant('DUBBING', {}, { outcome: 'skipped', reason: 'not_requested' });
  await f.logger.run('TRANSLATING', { purpose: 'scene' }, async ({ setOutcome }) => { setOutcome('shared_result'); });
  const ends = f.entries.filter(entry => entry.event === 'media_stage_end');
  assert.deepEqual(ends.map(entry => entry.outcome), ['cache_hit', 'skipped', 'shared_result']);
  assert.equal(ends[0].cacheScope, 'source');
  assert.equal(ends[1].reason, 'not_requested');
  assert.equal(ends[2].purpose, 'scene');
  assert.equal(f.entries.length, 6);
});

test('metadata and errors only serialize allowlisted primitive fields', async () => {
  const f = fixture();
  const failure = new MediaError('PROVIDER_HTTP_429', 'Rate limit', { status: 429, retryable: true });
  failure.body = { sourceText: 'private body' };
  failure.headers = { authorization: 'private header' };
  failure.response = { toJSON: () => assert.fail('response must not be serialized') };
  await assert.rejects(f.logger.run('TRANSCRIBING', { segmentId: 'a', segmentIds: ['a', 'b', { sourceText: 'unsafe' }],
    count: 2, cacheScope: 'transcription', model: 'scribe_v2', purpose: 'source', reason: 'provider',
    sourceText: 'private source', voiceId: 'private voice', headers: failure.headers, event: 'spoofed', jobId: 'spoofed' },
  async () => { throw failure; }), error => error === failure);
  const end = f.entries.at(-1);
  assert.equal(end.event, 'media_stage_end');
  assert.equal(end.jobId, 'job-example');
  assert.deepEqual(end.segmentIds, ['a', 'b']);
  assert.equal(end.error.code, 'PROVIDER_HTTP_429');
  assert.equal(end.error.status, 429);
  assert.equal(end.error.retryable, true);
  for (const key of ['sourceText', 'voiceId', 'headers', 'body', 'response']) {
    assert.equal(key in end, false);
    assert.equal(key in end.error, false);
  }
});

test('full long errors retain their tail while redacting credentials and quoted authorization', () => {
  const f = fixture({ secrets: ['configured-secret', 'escaped-"secret'] });
  const text = 'x'.repeat(5000) + ' Tail survives. configured-secret ' +
    '{"authorization":"Bearer quoted-token", "xi-api-key":"quoted key with spaces", "api_key":"json-token"} ' +
    "{'Authorization':'Basic basic-token', 'api-key':'single-token'} " +
    'Bearer plain-token xi-api-key: header-token api_key=bare-token ' + JSON.stringify('escaped-"secret');
  const error = new Error(text);
  f.logger.error('PROVIDER_REQUEST', error);
  const entry = f.entries[0];
  assert.equal(entry.outcome, 'failed');
  assert.ok(entry.error.message.includes('x'.repeat(5000)));
  assert.ok(entry.error.message.includes('Tail survives.'));
  assert.ok(entry.error.stack.length > 5000);
  const logged = JSON.stringify(entry);
  for (const secret of ['configured-secret', 'quoted-token', 'quoted key with spaces', 'json-token', 'basic-token',
    'single-token', 'plain-token', 'header-token', 'bare-token', 'escaped-']) assert.ok(!logged.includes(secret), secret);
  assert.ok(logged.includes('[REDACTED]'));
});

test('private values are read at failure time and raw and JSON escaped source/Turkish text is redacted', async () => {
  const source = 'Source says "hello"\nagain.';
  const turkish = 'Türkçe "merhaba"\ntekrar.';
  let privateTexts = [];
  const f = fixture({ privateValues: () => privateTexts });
  await assert.rejects(f.logger.run('TRANSLATING', { purpose: 'source' }, async () => {
    privateTexts = [source, turkish];
    throw new Error(`Provider echoed ${source}; ${turkish}; ${JSON.stringify(source)}; ${JSON.stringify(turkish)}`);
  }));
  const { message, stack } = f.entries.at(-1).error;
  for (const value of [source, turkish, JSON.stringify(source).slice(1, -1), JSON.stringify(turkish).slice(1, -1)]) {
    assert.ok(!message.includes(value));
    assert.ok(!stack.includes(value));
  }
  assert.equal(message.split('[REDACTED]').length - 1, 4);
});

test('failed and cancelled errors keep sanitized cause evidence with a bounded cause depth', async () => {
  const f = fixture({ secrets: ['cause-secret'] });
  let cause = new Error('excluded cause-depth-four');
  for (let i = 3; i >= 0; i--) cause = new MediaError(`DEPTH_${i}`, `depth ${i} cause-secret`, { cause, status: 502 });
  await assert.rejects(f.logger.run('TRANSLATING', {}, async () => { throw cause; }), error => error === cause);
  const failure = f.entries.at(-1);
  assert.equal(failure.outcome, 'failed');
  assert.equal(failure.error.cause.cause.cause.code, 'DEPTH_3');
  assert.equal(failure.error.cause.cause.cause.cause, undefined);
  assert.ok(!JSON.stringify(failure).includes('cause-secret'));
  const cancelled = new DOMException('Cancelled cause-secret', 'AbortError');
  await assert.rejects(f.logger.run('ALIGNING', {}, async () => { throw cancelled; }), error => error === cancelled);
  assert.equal(f.entries.at(-1).outcome, 'cancelled');
  assert.equal(f.entries.at(-1).error.name, 'AbortError');
  const circular = new Error('cyclic');
  circular.cause = circular;
  f.logger.error('CYCLIC', circular);
  assert.equal(f.entries.at(-1).error.cause.message, '[Circular cause]');
});

test('synchronous or asynchronous logging sink failures do not alter success or original failure', async () => {
  for (const write of [() => { throw new Error('sink unavailable'); }, () => Promise.reject(new Error('async sink unavailable'))]) {
    const logger = createStageLogger({ jobId: 'job', write });
    const value = { ready: true };
    assert.equal(await logger.run('DONE', {}, async () => value), value);
    const original = new Error('provider failed');
    await assert.rejects(logger.run('FAILED', {}, async () => { throw original; }), error => error === original);
    assert.doesNotThrow(() => logger.instant('CACHE', {}, { outcome: 'cache_hit' }));
    assert.doesNotThrow(() => logger.error('JOB', original));
  }
});

test('configured logging secrets include backend credential categories without retaining unrelated environment values', () => {
  const secrets = configuredLogSecrets({ elevenLabs: { apiKey: 'config-eleven' }, translation: { apiKey: 'config-openai' } }, {
    APP_PASSWORD: 'app-password', GEMINI_API_KEY: 'gemini-key', ELEVENLABS_API_KEY: 'config-eleven',
    SERVICE_ACCESS_TOKEN: 'access', SERVICE_REFRESH_TOKEN: 'refresh', SERVICE_AUTH_TOKEN: 'auth',
    SERVICE_SECRET: 'secret', SERVICE_PASSWORD: 'password', SERVICE_PRIVATE_KEY: 'private',
    SERVICE_SIGNING_KEY: 'signing', AWS_SECRET_ACCESS_KEY: 'aws-secret', AWS_SESSION_TOKEN: 'aws-session',
    PORT: '10000', GEMINI_MODEL: 'visible-model', DUB_CACHE_DIRECTORY: '/tmp/cache', TOKEN_BUDGET: '4096',
  });
  assert.deepEqual(new Set(secrets), new Set(['config-eleven', 'config-openai', 'app-password', 'gemini-key', 'access',
    'refresh', 'auth', 'secret', 'password', 'private', 'signing', 'aws-secret', 'aws-session']));
  assert.equal(secrets.filter(value => value === 'config-eleven').length, 1);
  assert.ok(!secrets.includes('10000'));
  assert.ok(!secrets.includes('visible-model'));
});
