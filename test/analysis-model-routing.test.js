import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analysisTierFromRequest, analysisModelCandidates, isSupportedDeepAnalysisModel,
  DEEP_ANALYSIS_MODEL, ARGON_ANALYSIS_MODEL, ECONOMY_ANALYSIS_MODEL
} from '../lib/analysis-model-routing.js';
import { geminiGenerationConfig } from '../lib/gemini-generation-config.js';
import { adaptiveAnalysisChunkPlan, storyboardSamplingPlan } from '../public/storyboard.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('economy skips provider calls to unavailable 2.5 Lite and stays cheap', () => {
  assert.deepEqual(analysisModelCandidates('economy', {}), [ECONOMY_ANALYSIS_MODEL]);
  assert.equal(ECONOMY_ANALYSIS_MODEL, 'gemini-3.1-flash-lite');
  assert.equal(analysisTierFromRequest('economy'), 'economy');
  assert.equal(analysisTierFromRequest('unknown'), 'economy');
  assert.equal(analysisTierFromRequest(null), 'economy');
  assert.ok(geminiGenerationConfig(ECONOMY_ANALYSIS_MODEL, {}).maxOutputTokens >= 16384);
});

test('deep selection explicitly chooses Flash or Argon, never automatic expensive fallback', () => {
  assert.equal(DEEP_ANALYSIS_MODEL, 'gemini-3.8-flash');
  assert.equal(ARGON_ANALYSIS_MODEL, 'gemini-4-argon');
  assert.deepEqual(analysisModelCandidates('deep', {}), [DEEP_ANALYSIS_MODEL]);
  assert.deepEqual(analysisModelCandidates('deep', {}, ARGON_ANALYSIS_MODEL), [ARGON_ANALYSIS_MODEL]);
  assert.deepEqual(analysisModelCandidates('deep', {}, DEEP_ANALYSIS_MODEL), [DEEP_ANALYSIS_MODEL]);
  assert.equal(isSupportedDeepAnalysisModel('gemini-4-argon'), true);
  assert.equal(isSupportedDeepAnalysisModel('gemini-2.5-flash-lite'), false);
  assert.throws(() => analysisModelCandidates('deep', {}, 'unknown-model'), /UNSUPPORTED/);
  assert.equal(analysisTierFromRequest('deep'), 'deep');
  assert.equal(geminiGenerationConfig(DEEP_ANALYSIS_MODEL, {}).thinkingConfig.thinkingLevel, 'low');
});

test('operators retain optional overrides without changing the explicit paid choice', () => {
  assert.deepEqual(analysisModelCandidates('economy', {
    GEMINI_ECONOMY_MODEL: 'custom-lite', GEMINI_ECONOMY_FALLBACK_MODEL: 'backup-lite'
  }), ['custom-lite', 'backup-lite']);
  assert.deepEqual(analysisModelCandidates('deep', { GEMINI_ANALYSIS_MODEL: 'custom-strong' }), ['custom-strong']);
  assert.deepEqual(analysisModelCandidates('deep', { GEMINI_ANALYSIS_MODEL: 'custom-strong' }, ARGON_ANALYSIS_MODEL),
    [ARGON_ANALYSIS_MODEL]);
});

test('UI requires the user to opt into expensive Argon before analysis; long-video coverage grows', () => {
  assert.match(html, /id="deepAnalysisMode" type="checkbox"/);
  assert.match(html, /id="deepAnalysisModel"/);
  assert.match(html, /value="gemini-3\.8-flash" selected/);
  assert.match(html, /value="gemini-4-argon"/);
  assert.match(app, /quality: 'ultra'/);
  assert.match(app, /analysisTier: els\.deepAnalysisMode\?\.checked \? 'deep' : 'economy'/);
  assert.match(app, /form\.append\('analysisTier', modes\.analysisTier\)/);
  assert.match(app, /form\.append\('deepAnalysisModel', modes\.deepAnalysisModel\)/);
  assert.match(app, /deepAnalysisModel: modes\.analysisTier === 'deep' \? modes\.deepAnalysisModel : null/);
  assert.match(server, /analysisTierFromRequest\(req\.body\?\.analysisTier\)/);
  assert.match(server, /isSupportedDeepAnalysisModel\(deepAnalysisModel\)/);
  assert.match(server, /storyboardRequestKey\(\{ apiKey, model,/);
  assert.match(server, /storyboardFailureReason\(error\) !== 'GEMINI_MODEL_UNAVAILABLE'/);
  assert.deepEqual(storyboardSamplingPlan(1200, false), { baseCount: 267, focusedCount: 0 });
  assert.deepEqual(storyboardSamplingPlan(1200, true), { baseCount: 160, focusedCount: 56 });
  assert.equal(adaptiveAnalysisChunkPlan(19, 1200, 'ultra').chunkCount, 12);
});

test('saved-game repair retains the selected Gemini tier and skips content-restricted gaps', () => {
  assert.match(app, /analysisTier: modes\.analysisTier,/);
  assert.match(app, /deepAnalysisModel: modes\.analysisTier === 'deep' \? modes\.deepAnalysisModel : null,/);
  assert.match(app, /retryableAnalysisGaps\(previous, game\.duration\)/);
  assert.match(app, /form\.append\('analysisTier', previous\.analysisTier\)/);
  assert.match(app, /form\.append\('deepAnalysisModel', previous\.deepAnalysisModel\)/);
});
