import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canContinuePastChunkFailure, chunkGapResult } from '../public/analysis-recovery.js';
import { isCompleteChunkAnalysis } from '../public/playback-logic.js';
import { reviewAndHardenAnalysis } from '../public/engine-hardening.js';

// Run the application's actual chunk loop with an ordinary chapter response
// and a simulated provider. This never calls a paid service.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1)', source.indexOf('const chunkResults = session.chunkResults'));
const end = source.indexOf('\n  if (\n    body?.available', start);
assert.ok(start >= 0 && end > start);
const loop = source.slice(start, end);

function runChunks({ completed = 0, total = 1, review = false, fetch, session: existingSession }) {
  const session = existingSession || { chunkResults: Array.from({ length: completed }, () => ({ available: true, actions: [] })), firstPassResults: {} };
  const chunkResults = session.chunkResults;
  const delays = [];
  const requests = [];
  const scope = vm.createContext({
    FormData, AbortSignal, console,
    chunkResults, chunkCount: total, sheetsPerChunk: 1, framesPerSheet: 12,
    storyboard: {
      sheets: Array.from({ length: total }, () => new Blob(['image'])),
      timestamps: Array.from({ length: total * 12 }, (_, index) => index),
      duration: total * 12, interval: 1
    },
    state: { dialogue: null }, session, modes: { quality: 'ultra' },
    els: { analysisTitle: {}, analysisState: {}, analysisOutput: {} },
    protagonistProfile: '', storyContextMemory: {}, failureBody: null, failedChunk: null, body: null, response: null,
    geminiRequestHeaders: () => ({}), recordAiUsage() {},
    canContinuePastChunkFailure, chunkGapResult, isCompleteChunkAnalysis,
    skippedFrameCount: 0, ANALYSIS_SCHEMA_VERSION: 5, ENGINE_VERSION: 'test',
    normalizeChunkActionTimes: actions => ({ actions, rebased: false }),
    secondPassReviewCandidates: () => review ? [{ actionId: 'walk' }] : [],
    mergeSecondPassReview: body => body, mergeStoryContexts: () => ({}),
    setTimeout: (callback, delay) => { delays.push(delay); callback(); },
    fetch: async (_url, options) => {
      const request = {
        chunk: Number(options.body.get('chunkIndex')),
        review: options.body.has('reviewMode')
      };
      requests.push(request);
      const body = fetch(request, requests.length);
      return { ok: body.available, json: async () => body };
    }
  });
  return vm.runInContext(`(async () => { ${loop}; return { chunkResults, failureBody, body }; })()`, scope)
    .then(result => ({ ...result, delays, requests, session }));
}

test('transient review failure waits before retrying and preserves the successful result', async () => {
  let failed = false;
  const result = await runChunks({ review: true, fetch: request => {
    if (request.review && !failed) {
      failed = true;
      return { available: false, retryable: true, reason: 'TEMPORARY', message: 'Busy' };
    }
    return { available: true, actions: [{ actionId: 'walk', startTime: 0, endTime: 10 }] };
  } });
  assert.deepEqual(result.delays, [1800]);
  assert.deepEqual(result.requests.map(request => request.review), [false, true, true]);
  assert.equal(result.chunkResults.length, 1);
  assert.equal(result.failureBody, null);
});

test('resuming six of eleven chapters never repeats completed chapters or marks partial data ready', async () => {
  const result = await runChunks({ completed: 6, total: 11, fetch: () => ({
    available: false, retryable: true, reason: 'NETWORK_ERROR', message: 'Connection lost'
  }) });
  assert.deepEqual(result.requests.map(request => request.chunk), [6, 6, 6, 6]);
  assert.equal(result.chunkResults.length, 6);
  assert.equal(result.failureBody.reason, 'NETWORK_ERROR');
  assert.deepEqual(result.delays, [1800, 3600, 7200]);
});

test('non-retryable provider response is preserved without another request', async () => {
  const result = await runChunks({ fetch: () => ({
    available: false, retryable: false, reason: 'GEMINI_CREDITS_DEPLETED', message: 'Credits exhausted'
  }) });
  assert.equal(result.requests.length, 1);
  assert.equal(result.delays.length, 0);
  assert.equal(result.failureBody.reason, 'GEMINI_CREDITS_DEPLETED');
});

const ordinaryChapter = index => ({ available: true, actions: [{ actionId: `walk-${index}`,
  label: 'Walk', sourceVerified: true, confidence: 0.95, startTime: index * 12, endTime: index * 12 + 10 }] });

test('a refused tenth chapter preserves nine completed chapters and still analyses eleven and twelve', async () => {
  const result = await runChunks({ completed: 9, total: 12, fetch: request => request.chunk === 9
    ? { available: false, retryable: false, reason: 'GEMINI_CONTENT_RESTRICTED' }
    : ordinaryChapter(request.chunk) });
  assert.deepEqual(result.requests.map(request => request.chunk), [9, 10, 11]);
  assert.equal(result.delays.length, 0);
  assert.equal(result.body.available, true);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.chunkCount, 11);
  assert.equal(result.body.processedChunkCount, 12);
  assert.equal(result.body.analysisCoverage, 11 / 12);
  assert.equal(result.body.analysisGaps.length, 1);
  assert.equal(result.body.analysisGaps[0].startTime, 108);
  assert.equal(result.body.analysisGaps[0].endTime, 120);
  assert.equal(result.body.actions.length, 2);
  assert.equal(reviewAndHardenAnalysis(result.body).integrity.fatal, false);

  const repeat = await runChunks({ total: 12, session: result.session, fetch: () => { throw Error('Completed or refused chapter must not be resent'); } });
  assert.equal(repeat.requests.length, 0);
  assert.equal(repeat.body.chunkCount, 11);
  assert.equal(repeat.body.partial, true);
});

test('a temporarily unreadable chapter is retried alone while later successful chapters remain cached', async () => {
  const first = await runChunks({ total: 3, fetch: request => request.chunk === 1
    ? { available: false, retryable: true, reason: 'CHUNK_ANALYSIS_GAP' }
    : ordinaryChapter(request.chunk) });
  assert.deepEqual(first.requests.map(request => request.chunk), [0, 1, 1, 1, 1, 2]);
  assert.equal(first.body.partial, true);
  assert.equal(first.body.chunkCount, 2);
  const lastResult = first.chunkResults[2];
  const second = await runChunks({ total: 3, session: first.session, fetch: request => ordinaryChapter(request.chunk) });
  assert.deepEqual(second.requests.map(request => request.chunk), [1]);
  assert.equal(second.body.partial, false);
  assert.equal(second.body.analysisCoverage, 1);
  assert.equal(second.chunkResults[2], lastResult);
  assert.equal(second.body.actions.length, 3);
});

test('a failed review keeps the first pass even across a manual retry', async () => {
  const first = await runChunks({ total: 2, review: true, fetch: request =>
    request.chunk === 0 && request.review
      ? { available: false, retryable: true, reason: 'SECOND_PASS_REVIEW_FAILED' }
      : ordinaryChapter(request.chunk) });
  assert.equal(first.requests.filter(request => request.chunk === 0 && !request.review).length, 1);
  assert.equal(first.body.partial, true);
  const second = await runChunks({ total: 2, review: true, session: first.session, fetch: request => ordinaryChapter(request.chunk) });
  assert.deepEqual(second.requests, [{ chunk: 0, review: true }]);
  assert.equal(second.body.partial, false);
});

test('no refused interval produces a synthetic action or full coverage', async () => {
  const result = await runChunks({ total: 2, fetch: () => ({ available: false,
    retryable: false, reason: 'MODEL_UNSTRUCTURED_RESPONSE' }) });
  assert.equal(result.requests.length, 2);
  assert.equal(result.body.actions.length, 0);
  assert.equal(result.body.chunkCount, 0);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.analysisCoverage, 0);
  assert.equal(result.body.analysisGaps.length, 2);
});
