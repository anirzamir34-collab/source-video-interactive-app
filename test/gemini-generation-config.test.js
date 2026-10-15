import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiGenerationConfig } from '../lib/gemini-generation-config.js';

test('Gemini 3 uses low effort and medium vision without truncating actions', () => {
  for (const model of ['gemini-3.8-flash', 'gemini-3-flash-preview']) {
    const config = geminiGenerationConfig(model, {});
    assert.equal(config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(config.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
    assert.equal(config.maxOutputTokens, 16384);
    assert.equal(config.responseMimeType, 'application/json');
    assert.deepEqual(config.httpOptions, { timeout: 90000, retryOptions: { attempts: 1 } });
  }
});

test('Argon is low thinking, medium vision, no unsupported sampling and bounded output', () => {
  const config = geminiGenerationConfig('gemini-4-argon', {});
  assert.equal(config.thinkingConfig.thinkingLevel, 'low');
  assert.equal(config.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
  assert.equal(config.maxOutputTokens, 16384);
  assert.equal(config.temperature, undefined);
  assert.equal(config.httpOptions.timeout, 210000);
});

test('custom and older models do not receive unsupported settings', () => {
  for (const model of ['gemini-2.5-flash', 'custom-model']) {
    assert.equal(geminiGenerationConfig(model, {}).thinkingConfig, undefined);
    assert.equal(geminiGenerationConfig(model, {}).mediaResolution, undefined);
  }
});

test('operator effort choices validated', () => {
  for (const level of ['low', 'medium', 'high']) {
    assert.equal(geminiGenerationConfig('gemini-3.8-flash', {
      GEMINI_ANALYSIS_THINKING_LEVEL: level
    }).thinkingConfig.thinkingLevel, level);
  }
  assert.throws(() => geminiGenerationConfig('gemini-3.8-flash', {
    GEMINI_ANALYSIS_THINKING_LEVEL: 'minimal'
  }), /must be/);
});

test('Gemini Pro budget stays sufficient', () => {
  const config = geminiGenerationConfig('gemini-3.1-pro-preview', {});
  assert.equal(config.thinkingConfig.thinkingLevel, 'low');
  assert.equal(config.maxOutputTokens, 32768);
  assert.equal(config.httpOptions.timeout, 150000);
});
