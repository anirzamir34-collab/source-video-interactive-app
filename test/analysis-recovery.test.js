import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStoryboardResponse, generateStoryboardWithRetry, storyboardFailureReason, isTerminalStoryboardFailure,
  hasDeclaredPartialCoverage } from '../public/analysis-recovery.js';
import { reviewAndHardenAnalysis } from '../public/engine-hardening.js';
import { serializeReviewCandidates } from '../public/classification-integrity.js';

for (const response of [
  { text: 'I cannot fulfill this request.' },
  { text: 'The submitted material cannot be processed.' },
  { text: '', candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] },
  { text: '', promptFeedback: { blockReason: 'SAFETY' } }
]) {
  test(`provider refusal is classified before JSON parsing and is never resent: ${JSON.stringify(response)}`, async () => {
    let requests = 0;
    const delays = [];
    await assert.rejects(generateStoryboardWithRetry(async () => { requests += 1; return response; }, {
      wait: async delay => delays.push(delay)
    }), error => error.code === 'GEMINI_CONTENT_RESTRICTED');
    assert.equal(requests, 1);
    assert.deepEqual(delays, []);
  });
}

test('unstructured prose is not misreported as an empty successful chapter', () => {
  assert.throws(() => parseStoryboardResponse({ text: 'No structured analysis is available.' }),
    error => error.code === 'MODEL_UNSTRUCTURED_RESPONSE');
  assert.deepEqual(parseStoryboardResponse({ text: '```json\n{"actions": []}\n```' }), { actions: [] });
  assert.throws(() => parseStoryboardResponse({ text: '{"message":"not available"}' }),
    error => error.code === 'GEMINI_INVALID_JSON');
});

test('truncated JSON is retried within a fixed budget and can recover', async () => {
  let requests = 0;
  const delays = [];
  const result = await generateStoryboardWithRetry(async () => ({ text: ++requests === 1
    ? '{"actions":[' : '{"actions":[{"label":"Walk","startTime":10,"endTime":20}]}' }), {
    wait: async delay => delays.push(delay)
  });
  assert.equal(requests, 2);
  assert.deepEqual(delays, [1800]);
  assert.equal(result.actions[0].label, 'Walk');
});

test('numeric quota errors remain terminal and do not create a retry storm', async () => {
  let requests = 0;
  await assert.rejects(generateStoryboardWithRetry(async () => {
    requests += 1;
    throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { code: 429 });
  }), error => storyboardFailureReason(error) === 'GEMINI_QUOTA_OR_CREDITS');
  assert.equal(requests, 1);
});

const partial = () => ({ videoDuration: 30, chunkCount: 2, expectedChunkCount: 3,
  processedChunkCount: 3, partial: true,
  analysisGaps: [{ chunkIndex: 1, startTime: 10, endTime: 20, reason: 'MODEL_UNSTRUCTURED_RESPONSE' }],
  actions: [
    { actionId: 'before', label: 'Walk', startTime: 1, endTime: 8, confidence: 0.95, sourceVerified: true },
    { actionId: 'after', label: 'Read', startTime: 22, endTime: 28, confidence: 0.95, sourceVerified: true }
  ] });

test('explicit partial coverage preserves verified actions and stays labelled partial', () => {
  const input = partial();
  assert.equal(hasDeclaredPartialCoverage(input), true);
  const result = reviewAndHardenAnalysis(input);
  assert.equal(result.integrity.fatal, false);
  assert.equal(result.analysis.partial, true);
  assert.equal(result.analysis.chunkCount, 2);
  assert.equal(result.analysis.analysisGaps.length, 1);
  assert.deepEqual(result.analysis.actions.map(item => item.actionId), ['before', 'after']);
});

test('partial coverage requires complete accounting and valid distinct gap intervals', () => {
  for (const input of [
    { ...partial(), partial: false },
    { ...partial(), processedChunkCount: 2 },
    { ...partial(), analysisGaps: [] },
    { ...partial(), chunkCount: 3 },
    { ...partial(), analysisGaps: [{ chunkIndex: 9, startTime: 10, endTime: 20 }] },
    { ...partial(), analysisGaps: [{ chunkIndex: 1, startTime: 10, endTime: 40 }] },
    { ...partial(), analysisGaps: [partial().analysisGaps[0], partial().analysisGaps[0]] }
  ]) {
    assert.equal(hasDeclaredPartialCoverage(input), false);
    assert.equal(reviewAndHardenAnalysis(input).integrity.fatal, true);
  }
});

test('actions cannot enter a gap and parent time ranges cannot bridge it', () => {
  const input = partial();
  input.actions[0].positionStartTime = 0;
  input.actions[0].positionEndTime = 30;
  input.actions[1].adultSceneStartTime = 0;
  input.actions[1].adultSceneEndTime = 30;
  input.actions.push({ actionId: 'cross-gap', label: 'Unverified', startTime: 8, endTime: 22, confidence: 1 });
  const result = reviewAndHardenAnalysis(input);
  assert.deepEqual(result.analysis.actions.map(item => item.actionId), ['before', 'after']);
  assert.equal(result.analysis.actions[0].positionEndTime, 10);
  assert.equal(result.analysis.actions[1].adultSceneStartTime, 20);
  assert.ok(result.integrity.issues.some(issue => issue.code === 'ACTION_OVERLAPS_ANALYSIS_GAP'));
});

test('the live server handler reports refused chapters without retrying or splitting their images', async () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = server.indexOf("app.post('/api/gemini-storyboard-analyze'");
  const start = server.indexOf('async (req, res) => {', route);
  const end = server.indexOf("\napp.post('/api/external-analyze'", start);
  const handlerSource = server.slice(start, end).trim().replace(/\);$/, '');
  for (const chunkIndex of [9, 11]) {
    let requests = 0;
    const handler = vm.runInNewContext(`(${handlerSource})`, {
      GoogleGenAI: class { models = { generateContent: async () => {
        requests += 1;
        return { text: 'I cannot fulfill this request.', usageMetadata: { totalTokenCount: 10 } };
      } }; },
      resolveGeminiApiKey: () => 'test-only', emptyGeminiUsage: () => ({ requests: 0 }),
      addGeminiUsage: usage => { usage.requests += 1; },
      storyboardFailureReason, generateStoryboardWithRetry, isTerminalStoryboardFailure, serializeReviewCandidates,
      process: { env: {} }, console: { warn() {}, error() {} }
    });
    const req = { body: { chunkIndex, chunkCount: 12, chunkStart: chunkIndex * 12,
      chunkEnd: (chunkIndex + 1) * 12, duration: 144, timestamps: '[108,109,110,111]' },
      files: [0, 1].map(() => ({ buffer: Buffer.from('test image'), mimetype: 'image/jpeg' })) };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res);
    assert.equal(requests, 1);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.available, false);
    assert.equal(res.body.retryable, false);
    assert.equal(res.body.reason, 'GEMINI_CONTENT_RESTRICTED');
    assert.equal(res.body.aiUsage.requests, 1);
    assert.equal(res.body.analysisGaps[0].startTime, chunkIndex * 12);
  }
});
