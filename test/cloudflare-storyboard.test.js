import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { cloudflareCredentials, runCloudflareStoryboard, CLOUDFLARE_STORYBOARD_MODEL } from '../lib/cloudflare-storyboard.js';
import { analysisRequestKey } from '../public/analysis-response-cache.js';
import { parseStoryboardResponse, generateStoryboardWithRetry, storyboardFailureReason, isTerminalStoryboardFailure } from '../public/analysis-recovery.js';
import { createAnalysisRequestCache, storyboardRequestKey } from '../lib/analysis-request-cache.js';
import { serializeReviewCandidates } from '../public/classification-integrity.js';

const accountId = '0123456789abcdef0123456789abcdef';
const token = 'a-secure-test-token-that-is-long-enough';

test('Cloudflare requires both a valid account ID and a user token', () => {
  const req = headers => ({ get: name => headers[name] });
  assert.deepEqual(cloudflareCredentials(req({ 'x-cloudflare-account-id': accountId,
    'x-cloudflare-api-token': token })), { accountId, token });
  assert.equal(cloudflareCredentials(req({ 'x-cloudflare-account-id': '../escape',
    'x-cloudflare-api-token': token })), null);
  assert.equal(cloudflareCredentials(req({ 'x-cloudflare-account-id': accountId,
    'x-cloudflare-api-token': 'missing' })), null);
});

test('Cloudflare sends source sheets with the timestamp prompt and parses a verified response', async () => {
  let called = 0;
  const fetchImpl = async (url, options) => {
    called++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_STORYBOARD_MODEL}`);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[0].text, 'timestamps [12]');
    assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,ZnJhbWU=');
    return { ok: true, json: async () => ({ success: true, result: {
      response: JSON.stringify({ available: true, actions: [{ actionId: 'a', startTime: 12, endTime: 25 }] }),
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    } }) };
  };
  const response = await runCloudflareStoryboard({ accountId, token, prompt: 'timestamps [12]',
    files: [{ mimetype: 'image/jpeg', buffer: Buffer.from('frame') }], fetchImpl });
  assert.equal(called, 1);
  assert.equal(response.usageMetadata.totalTokenCount, 140);
  assert.equal(parseStoryboardResponse(response).actions[0].actionId, 'a');
});

test('Cloudflare quota and malformed output remain failures with no implicit Gemini call', async () => {
  await assert.rejects(runCloudflareStoryboard({ accountId, token, prompt: 'a', files: [],
    fetchImpl: async () => ({ ok: false, status: 429,
      json: async () => ({ errors: [{ message: 'daily allocation exceeded' }] }) }) }),
  { code: 'CLOUDFLARE_QUOTA', statusCode: 429 });
  const malformed = await runCloudflareStoryboard({ accountId, token, prompt: 'a', files: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: { response: 'plain text' } }) }) });
  assert.throws(() => parseStoryboardResponse(malformed), { code: 'MODEL_UNSTRUCTURED_RESPONSE' });
});

test('browser response cache separates Cloudflare token, account and Gemini', async () => {
  const form = new FormData(); form.append('chunkStart', '12');
  const key = headers => analysisRequestKey({ revision: 'r', path: '/api/gemini-storyboard-analyze',
    headers, form, crypto: webcrypto });
  const cf = { 'x-analysis-provider': 'cloudflare', 'x-cloudflare-account-id': accountId,
    'x-cloudflare-api-token': token };
  const original = await key(cf);
  assert.notEqual(original, await key({ ...cf, 'x-cloudflare-api-token': token + '2' }));
  assert.notEqual(original, await key({ ...cf, 'x-cloudflare-account-id': 'abcdef0123456789abcdef0123456789' }));
  assert.notEqual(original, await key({ 'x-gemini-api-key': token }));
});

function cloudflareRoute(generate) {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async (req, res) => {', source.indexOf("app.post('/api/gemini-storyboard-analyze'"));
  const end = source.indexOf("\napp.post('/api/external-analyze'", start);
  let geminiCalls = 0, cloudflareCalls = 0;
  const handler = vm.runInNewContext(`(${source.slice(start, end).trim().replace(/\);$/, '')})`, {
    cloudflareCredentials, CLOUDFLARE_STORYBOARD_MODEL,
    runCloudflareStoryboard: async () => { cloudflareCalls++; return generate(); },
    GoogleGenAI: class { constructor() { geminiCalls++; } },
    resolveGeminiApiKey: () => { geminiCalls++; return 'paid-gemini-key'; },
    emptyGeminiUsage: () => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHits: 0 }),
    addGeminiUsage: usage => { usage.requests++; }, storyboardRequestKey,
    storyboardRequestCache: createAnalysisRequestCache(),
    geminiGenerationConfig: () => ({}), generateStoryboardWithRetry, parseStoryboardResponse,
    storyboardFailureReason, isTerminalStoryboardFailure, geminiQuotaFailure: () => null,
    serializeReviewCandidates, withChoiceSurface: action => action,
    dedupeVerifiedTimelineActions: actions => actions,
    ANALYSIS_SCHEMA_VERSION: 6, ANALYSIS_ENGINE_VERSION: 'gemini-test',
    process: { env: {} }, console: { info() {}, warn() {}, error() {} }
  });
  const req = { get: name => ({ 'x-analysis-provider': 'cloudflare',
    'x-cloudflare-account-id': accountId, 'x-cloudflare-api-token': token })[name],
  body: { duration: '30', chunkStart: '0', chunkEnd: '30', timestamps: '[0,2,4]' },
  files: [{ mimetype: 'image/jpeg', buffer: Buffer.from('frame') }] };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  return { handler, req, res, usage: () => ({ geminiCalls, cloudflareCalls }) };
}

test('actual analysis route keeps Cloudflare isolated and returns a valid result', async () => {
  const run = cloudflareRoute(async () => ({ text: JSON.stringify({ available: true, actions: [
    { label: 'Yürü', startTime: 0, endTime: 20, sourceVerified: true, confidence: 0.91 }
  ] }) }));
  await run.handler(run.req, run.res);
  assert.equal(run.res.statusCode, 200, JSON.stringify(run.res.body));
  assert.equal(run.res.body.engineVersion, 'cloudflare-qwen-storyboard-experiment-v1');
  assert.equal(run.res.body.actions.length, 1);
  assert.equal(run.res.body.actions[0].sourceStart, 0);
  assert.deepEqual(run.usage(), { geminiCalls: 0, cloudflareCalls: 1 });
});

test('Cloudflare quota stops the chapter without Gemini fallback or split retries', async () => {
  const run = cloudflareRoute(async () => { throw Object.assign(Error('daily allocation exceeded'),
    { code: 'CLOUDFLARE_QUOTA', statusCode: 429 }); });
  await run.handler(run.req, run.res);
  assert.equal(run.res.statusCode, 429);
  assert.equal(run.res.body.retryable, false);
  assert.equal(run.res.body.reason, 'CLOUDFLARE_QUOTA');
  assert.deepEqual(run.usage(), { geminiCalls: 0, cloudflareCalls: 1 });
});
