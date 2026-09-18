import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the application's actual chunk loop with an ordinary chapter response
// and a simulated provider. This never calls a paid service.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('for (let chunkIndex = chunkResults.length; chunkIndex < chunkCount; chunkIndex += 1)');
const end = source.indexOf('const completeChunkAnalysis', start);
assert.ok(start >= 0 && end > start);
const loop = source.slice(start, end);

function runChunks({ completed = 0, total = 1, review = false, fetch }) {
  const chunkResults = Array.from({ length: completed }, () => ({ actions: [] }));
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
    state: { dialogue: null }, session: { chunkResults }, modes: { quality: 'ultra' },
    els: { analysisTitle: {}, analysisState: {}, analysisOutput: {} },
    protagonistProfile: '', storyContextMemory: {}, failureBody: null, body: null, response: null,
    geminiRequestHeaders: () => ({}), recordAiUsage() {},
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
  return vm.runInContext(`(async () => { ${loop}; return { chunkResults, failureBody }; })()`, scope)
    .then(result => ({ ...result, delays, requests }));
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
  assert.deepEqual(result.requests.map(request => request.review), [false, true, false, true]);
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
