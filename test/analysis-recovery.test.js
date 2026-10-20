import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStoryboardResponse, generateStoryboardWithRetry, storyboardFailureReason, isTerminalStoryboardFailure,
  hasDeclaredPartialCoverage, chunkGapResult } from '../public/analysis-recovery.js';
import { buildGapRepairPrompt, GAP_REPAIR_PROMPT_VERSION, GAP_REPAIR_VALIDATOR_VERSION, GAP_REPAIR_SYSTEM_INSTRUCTION, inspectNeutralRepairActions, verifiedNeutralRepairActions } from '../public/neutral-gap-repair.js';

test('restricted source interval reports its provider reason and never fabricates choices', () => {
  const gap = chunkGapResult({ reason: 'GEMINI_CONTENT_RESTRICTED', retryable: false }, 1, 94.7, 189.3);
  assert.deepEqual(gap.actions, []);
  assert.equal(gap.analysisGaps[0].reason, 'GEMINI_CONTENT_RESTRICTED');
  assert.match(gap.warnings[0], /içerik kısıtlaması/);
});
import { reviewAndHardenAnalysis } from '../public/engine-hardening.js';
import { serializeReviewCandidates } from '../public/classification-integrity.js';
import { geminiQuotaFailure } from '../public/gemini-quota.js';
import { createAnalysisRequestCache, storyboardRequestKey } from '../lib/analysis-request-cache.js';
import { geminiGenerationConfig } from '../lib/gemini-generation-config.js';
import { hasFamilyOrSpouseContext } from '../public/relationship-roles.js';
import { analysisModelCandidates, analysisTierFromRequest } from '../lib/analysis-model-routing.js';
import { buildAnalysisPrompt } from '../lib/analysis-prompt.js';
import { isGeminiFileUri, absoluteClipTimes, geminiVideoMime } from '../lib/gemini-video.js';
import { ensureProtagonistTrack } from '../lib/protagonist-track.js';
import { buildLegacyAnalysisPrompt } from '../lib/analysis-prompt-legacy.js';

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
  }), error => storyboardFailureReason(error) === 'GEMINI_RATE_LIMITED');
  assert.equal(requests, 1);
});

test('provider status distinguishes authorization and unavailable model from a transient outage', async () => {
  for (const [status, reason] of [[401, 'GEMINI_AUTH_ERROR'], [403, 'GEMINI_AUTH_ERROR'],
    [404, 'GEMINI_MODEL_UNAVAILABLE'], [503, 'GEMINI_TEMPORARILY_UNAVAILABLE']]) {
    let requests = 0;
    const error = Object.assign(new Error('Provider request failed'), { status });
    assert.equal(storyboardFailureReason(error), reason);
    await assert.rejects(generateStoryboardWithRetry(async () => { requests++; throw error; }, {
      wait: async () => {}
    }), error);
    assert.equal(requests, status === 503 ? 2 : 1);
  }
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
      geminiAnalysisSafetySettings: [], GEMINI_VISUAL_SYSTEM_INSTRUCTION: 'test visual instruction', buildAnalysisPrompt, buildLegacyAnalysisPrompt, ANALYSIS_PROMPT_STYLE: 'compact', isGeminiFileUri, absoluteClipTimes, geminiVideoMime, ensureProtagonistTrack, GEMINI_VIDEO_FPS: 2,
      geminiQuotaFailure, storyboardRequestKey, geminiGenerationConfig, hasFamilyOrSpouseContext,
      analysisModelCandidates, analysisTierFromRequest, storyboardRequestCache: createAnalysisRequestCache(),
      GEMINI_DEFAULT_MODEL: 'gemini-test-model', ANALYSIS_MODEL: 'gemini-3.1-pro-preview',
      process: { env: {} }, console: { warn() {}, error() {}, info() {} }
    });
    const req = { body: { chunkIndex, chunkCount: 12, analysisTier: 'deep', chunkStart: chunkIndex * 12,
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



test('provider restriction diagnostics preserve only allowlisted feedback metadata', () => {
  const provider = {
    text: 'sensitive source content must never be logged',
    promptFeedback: {
      blockReason: 'SAFETY',
      safetyRatings: [{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', blocked: true },
        { category: 'USER_OR_SECRET', blocked: true }]
    }
  };
  assert.throws(() => parseStoryboardResponse(provider), error => {
    assert.equal(error.code, 'GEMINI_CONTENT_RESTRICTED');
    assert.deepEqual(error.safetyDiagnostic, {
      origin: 'prompt_feedback', promptBlockReason: 'SAFETY',
      candidateFinishReason: null, blockedCategories: ['HARM_CATEGORY_SEXUALLY_EXPLICIT']
    });
    assert.doesNotMatch(JSON.stringify(error.safetyDiagnostic), /sensitive source|USER_OR_SECRET/);
    return true;
  });
  assert.throws(() => parseStoryboardResponse({ candidates: [{
    finishReason: 'PROHIBITED_CONTENT', safetyRatings: []
  }] }), error => {
    assert.deepEqual(error.safetyDiagnostic, {
      origin: 'candidate_finish', promptBlockReason: null,
      candidateFinishReason: 'PROHIBITED_CONTENT', blockedCategories: []
    });
    return true;
  });
  assert.throws(() => parseStoryboardResponse({ text: 'I cannot fulfill this request.' }), error => {
    assert.equal(error.safetyDiagnostic.origin, 'model_text_refusal');
    assert.equal(error.safetyDiagnostic.candidateFinishReason, null);
    return true;
  });
});

test('restriction diagnostics are logged without any additional paid Gemini call', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /\[gemini-restriction-diagnostic\]/);
  assert.match(source, /stage: reviewMode \? 'review' : 'analysis'/);
  assert.match(source, /error\?\.safetyDiagnostic/);
});

test('empty saved-game repairs fail HTTP 422 and are not cached as successful analysis', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.indexOf("app.post('/api/gemini-storyboard-analyze'");
  const start = source.indexOf('async (req, res) => {', route);
  const end = source.indexOf("\napp.post('/api/external-analyze'", start);
  const handlerSource = source.slice(start, end).trim().replace(/\);$/, '');
  let calls = 0;
  const handler = vm.runInNewContext(`(${handlerSource})`, {
    GoogleGenAI: class { models = { generateContent: async () => {
      calls += 1;
      return { text: '{"available":true,"actions":[],"analysisGaps":[],"warnings":[]}',
        usageMetadata: { totalTokenCount: 80 } };
    } }; },
    resolveGeminiApiKey: () => 'test-only',
    emptyGeminiUsage: () => ({ requests: 0 }),
    addGeminiUsage: usage => { usage.requests += 1; },
    storyboardFailureReason, generateStoryboardWithRetry, isTerminalStoryboardFailure,
    serializeReviewCandidates, geminiQuotaFailure, storyboardRequestKey,
    geminiAnalysisSafetySettings: [], geminiGenerationConfig,
    hasFamilyOrSpouseContext, analysisModelCandidates, analysisTierFromRequest,
    isGeminiModelName: value => /^gemini-/.test(value),
    storyboardRequestCache: createAnalysisRequestCache(),
    GEMINI_VISUAL_SYSTEM_INSTRUCTION: 'normal analysis instructions', buildAnalysisPrompt, buildLegacyAnalysisPrompt, ANALYSIS_PROMPT_STYLE: 'compact', isGeminiFileUri, absoluteClipTimes, geminiVideoMime, ensureProtagonistTrack, GEMINI_VIDEO_FPS: 2,
    GAP_REPAIR_PROMPT_VERSION, GAP_REPAIR_VALIDATOR_VERSION,
    GAP_REPAIR_SYSTEM_INSTRUCTION, buildGapRepairPrompt, verifiedNeutralRepairActions, inspectNeutralRepairActions,
    ANALYSIS_MODEL: 'gemini-3.8-flash', process: { env: {} },
    console: { warn() {}, error() {}, info() {} }
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const req = {
      body: { repairMode: '1', analysisTier: 'deep',
        deepAnalysisModel: 'gemini-3.8-flash', chunkIndex: 0,
        chunkCount: 5, chunkStart: 276.5, chunkEnd: 331.8, duration: 900,
        timestamps: '[276.5,279.5,282.5]', motionProfile: '[]',
        sceneBoundaries: '[]' },
      files: [{ buffer: Buffer.from('test neutral image'), mimetype: 'image/jpeg' }]
    };
    const res = { statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler(req, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.available, false);
    assert.equal(res.body.reason, 'GEMINI_NO_VERIFIED_EVENTS');
    assert.equal(res.body.analysisGaps[0].startTime, 276.5);
    assert.equal(res.body.aiUsage.requests, 1);
    assert.equal(res.body.aiUsage.cacheHits || 0, 0);
    assert.equal(res.body.repairTelemetry.modelRawActionsCount, 0);
    assert.equal(res.body.repairTelemetry.repairValidatorAcceptedCount, 0);
    assert.equal(res.body.repairTelemetry.stageReached, 'REPAIR_VALIDATOR_EMPTY');
  }
  // Two separate user invocations cannot reuse a falsely successful empty result.
  assert.equal(calls, 2);
});

test('repair endpoint tracks validator and server normalization drops without logging labels', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(server, /serverNormalizerRejected: normalizerRejected/);
  assert.match(server, /repairTelemetry = \{ \.\.\.inspection\.diagnostics/);
  assert.match(server, /GAP_REPAIR_VALIDATOR_VERSION/);
  assert.match(app, /clientNormalizerDroppedCount/);
  assert.match(app, /mergedActionsCount: count/);
  assert.match(app, /planSavedGapRepair\(previous, gap, repairModel/);
});

test('a short reply the model deliberately finished as broken JSON is not repeated', async () => {
  let requests = 0;
  await assert.rejects(generateStoryboardWithRetry(async () => {
    requests += 1;
    return { text: '{"actions": [ {"label": "x", ', candidates: [{ finishReason: 'STOP' }] };
  }, { wait: async () => {} }), error => error.code === 'MODEL_UNSTRUCTURED_RESPONSE');
  assert.equal(requests, 1);
  let truncated = 0;
  await assert.rejects(generateStoryboardWithRetry(async () => {
    truncated += 1;
    return { text: '{"actions": [', candidates: [{ finishReason: 'MAX_TOKENS' }] };
  }, { wait: async () => {} }), error => error.code === 'GEMINI_INVALID_JSON');
  assert.equal(truncated, 2, 'a length-truncated reply keeps its retry');
});
