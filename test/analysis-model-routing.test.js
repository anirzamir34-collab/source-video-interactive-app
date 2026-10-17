import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analysisTierFromRequest, analysisModelCandidates, isSupportedDeepAnalysisModel, isGeminiModelName, isVideoQuestAnalysisModel, preferredRepairAnalysisModels, PREFERRED_REPAIR_ANALYSIS_MODELS,
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


test('saved-game catalog lists only Gemini visual JSON-capable general analysis models', () => {
  const eligible = name => ({ name: 'models/' + name, supportedActions: ['generateContent'],
    inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], outputTokenLimit: 16384 });
  for (const name of ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.6-flash',
    'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.1-pro-preview']) {
    assert.equal(isVideoQuestAnalysisModel(eligible(name)), true, name);
  }
  for (const name of ['gemini-3.8-flash-tts', 'gemini-3.8-live', 'gemini-3.1-flash-image',
    'gemini-embedding-001', 'gemini-2.5-computer-use', 'gemini-3.5-audio',
    'gemini-omni-flash', 'imagen-4', 'gemini-2.5-flash-native-audio']) {
    assert.equal(isVideoQuestAnalysisModel(eligible(name)), false, name);
  }
  assert.equal(isVideoQuestAnalysisModel({ ...eligible('gemini-3.8-flash'), supportedActions: ['embedContent'] }), false);
  assert.equal(isVideoQuestAnalysisModel({ ...eligible('gemini-3.8-flash'), inputModalities: ['TEXT'] }), false);
  assert.equal(isVideoQuestAnalysisModel({ ...eligible('gemini-3.8-flash'), outputModalities: ['IMAGE'] }), false);
  assert.equal(isVideoQuestAnalysisModel({ ...eligible('gemini-3.8-flash'), outputTokenLimit: 1024 }), false);
  assert.equal(isVideoQuestAnalysisModel({
    ...eligible('gemini-3.8-flash'), supportedActions: undefined,
    supportedGenerationMethods: ['generateContent']
  }), true);
  assert.match(server, /isVideoQuestAnalysisModel\(\{ \.\.\.model, name \}\)/);
  const ui = readFileSync(new URL('../public/saved-games-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /let repairModels = \[\]/);
  assert.doesNotMatch(ui, /\.\.\.models, \.\.\.repairModels/);
});


test('saved-game repairs offer the available Gemini model catalog and send the selected model', () => {
  const ui = readFileSync(new URL('../public/saved-games-ui.js', import.meta.url), 'utf8');
  assert.equal(isGeminiModelName('gemini-2.5-flash-lite'), true);
  assert.equal(isGeminiModelName('gemini-4-argon'), true);
  assert.equal(isGeminiModelName('other-provider'), false);
  assert.match(ui, /button\.dataset\.action = action/);
  assert.match(ui, /saved-game-model-picker/);
  assert.match(ui, /repairGame\(game, update => message\(update\), model\)/);
  assert.match(app, /retryableAnalysisGaps\(previous, game\.duration\)/);
  assert.match(app, /form\.append\('analysisTier', 'deep'\)/);
  assert.match(app, /form\.append\('deepAnalysisModel', repairModel\)/);
  assert.match(app, /form\.append\('repairMode', '1'\)/);
  assert.match(server, /app\.get\('\/api\/gemini-analysis-models'/);
  assert.match(server, /savedGameRepair \? \[deepAnalysisModel\]/);
});

test('repair catalog prefers only tested general multimodal model families', () => {
  const meta = name => ({ name: 'models/' + name, supportedActions: ['generateContent'],
    inputModalities: ['IMAGE', 'TEXT'], outputModalities: ['TEXT'], outputTokenLimit: 16384 });
  assert.deepEqual(PREFERRED_REPAIR_ANALYSIS_MODELS,
    ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-4-argon']);
  assert.deepEqual(preferredRepairAnalysisModels([
    meta('gemini-2.5-flash'), meta('gemini-4-argon'), meta('gemini-3.1-flash-lite'),
    meta('gemini-3.8-flash'), meta('gemini-2.5-flash-preview-tts')
  ]), PREFERRED_REPAIR_ANALYSIS_MODELS);
  assert.match(server, /repairProbeImage/);
  assert.match(server, /maxOutputTokens: 256/);
  assert.match(server, /parsed\?\.ok === true/);
  assert.match(server, /repairCatalogCache/);
  assert.match(server, /const models = checks\.filter\(Boolean\)/);
});

test('saved game repair displays per-gap errors and suppresses repeated provider rejection', () => {
  const ui = readFileSync(new URL('../public/saved-games-ui.js', import.meta.url), 'utf8');
  assert.match(app, /skipped_previous_rejection/);
  assert.match(app, /skipped_model_error/);
  assert.match(app, /lastRepairAttempt:/);
  assert.match(app, /lastAttempt\?\.model === repairModel/);
  assert.match(app, /technicalStop\.has\(reason\)/);
  assert.match(ui, /describeSavedGameRepair\(analysis\)/);
  assert.match(ui, /saved-game-repair-report/);
  assert.match(ui, /HTTP/);
});

test('initial economy and deep storyboard analyses expose loss counters without changing provider policy', () => {
  assert.match(server, /const analysisTelemetry = \{/);
  assert.match(server, /modelRawActionsCount: Array\.isArray\(parsed\.actions\)/);
  assert.match(server, /serverNormalizerAcceptedCount: dedupedActions\.length/);
  assert.match(server, /serverNormalizerRejected: \{ \.\.\.normalizerRejected \}/);
  assert.match(server, /analysisTelemetry,\s*\.\.\.\(savedGameRepair/);
  assert.match(app, /analysisDiagnostics: \{/);
  assert.match(app, /clientNormalizerAcceptedCount: beforeHardeningCount/);
  assert.match(app, /hardeningAcceptedCount: normalized\.actions\.length/);
  assert.match(app, /state\.analysis = normalized/);
  assert.match(server, /safetySettings: geminiAnalysisSafetySettings/);
  assert.match(server, /savedGameRepair \? GAP_REPAIR_SYSTEM_INSTRUCTION : GEMINI_VISUAL_SYSTEM_INSTRUCTION/);
  assert.match(server, /savedGameRepair \? \[deepAnalysisModel\] : analysisModelCandidates/);
});
