import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analysisTierFromRequest, analysisModelCandidates,
  DEEP_ANALYSIS_MODEL, ECONOMY_ANALYSIS_MODEL, ECONOMY_FALLBACK_MODEL
} from '../lib/analysis-model-routing.js';
import { geminiGenerationConfig } from '../lib/gemini-generation-config.js';
import { adaptiveAnalysisChunkPlan, storyboardSamplingPlan } from '../public/storyboard.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('economy analysis selects cheapest Lite first with compatible Lite fallback', () => {
  assert.deepEqual(analysisModelCandidates('economy', {}), [ECONOMY_ANALYSIS_MODEL, ECONOMY_FALLBACK_MODEL]);
  assert.equal(ECONOMY_ANALYSIS_MODEL, 'gemini-2.5-flash-lite');
  assert.equal(ECONOMY_FALLBACK_MODEL, 'gemini-3.1-flash-lite');
  assert.equal(analysisTierFromRequest('economy'), 'economy');
  assert.equal(analysisTierFromRequest('unknown'), 'economy');
  assert.equal(analysisTierFromRequest(null), 'economy');
  assert.ok(geminiGenerationConfig(ECONOMY_ANALYSIS_MODEL, {}).maxOutputTokens >= 16384);
});

test('deep analysis explicitly keeps strongest current model without Lite fallback', () => {
  assert.deepEqual(analysisModelCandidates('deep', {}), [DEEP_ANALYSIS_MODEL]);
  assert.equal(DEEP_ANALYSIS_MODEL, 'gemini-3.8-flash');
  assert.equal(analysisTierFromRequest('deep'), 'deep');
  assert.equal(geminiGenerationConfig(DEEP_ANALYSIS_MODEL, {}).thinkingConfig.thinkingLevel, 'low');
});

test('server operators can set compatible overrides without changing user modes', () => {
  assert.deepEqual(analysisModelCandidates('economy', {
    GEMINI_ECONOMY_MODEL: 'custom-lite', GEMINI_ECONOMY_FALLBACK_MODEL: 'custom-lite'
  }), ['custom-lite']);
  assert.deepEqual(analysisModelCandidates('deep', {
    GEMINI_ANALYSIS_MODEL: 'custom-strong'
  }), ['custom-strong']);
});

test('UI offers Deep only and always keeps maximum visual sampling/analysis detail', () => {
  assert.match(html, /id="deepAnalysisMode" type="checkbox"/);
  assert.doesNotMatch(html, /id="qualityMode"/);
  assert.match(app, /quality: 'ultra'/);
  assert.match(app, /analysisTier: els\.deepAnalysisMode\?\.checked \? 'deep' : 'economy'/);
  assert.match(app, /form\.append\('analysisTier', modes\.analysisTier\)/);
  assert.match(app, /analysisTier: modes\.analysisTier/);
  assert.match(server, /const qualityMode = 'ultra'/);
  assert.match(server, /analysisTierFromRequest\(req\.body\?\.analysisTier\)/);
  assert.match(server, /storyboardRequestKey\(\{ apiKey, model,/);
  assert.match(server, /storyboardFailureReason\(error\) !== 'GEMINI_MODEL_UNAVAILABLE'/);
  assert.deepEqual(storyboardSamplingPlan(1200, false), { baseCount: 228, focusedCount: 0 });
  assert.deepEqual(storyboardSamplingPlan(1200, true), { baseCount: 160, focusedCount: 56 });
  assert.equal(adaptiveAnalysisChunkPlan(19, 1200, 'ultra').chunkCount, 12);
  assert.equal(adaptiveAnalysisChunkPlan(18, 1200, 'ultra').chunkCount, 12);
});
