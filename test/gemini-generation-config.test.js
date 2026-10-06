import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiGenerationConfig } from '../lib/gemini-generation-config.js';

test('Gemini 3 uses low effort without shrinking detailed structured output', () => {
  for (const model of ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview']) {
    const config = geminiGenerationConfig(model, {});
    assert.equal(config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(config.maxOutputTokens, 16384);
    assert.equal(config.responseMimeType, 'application/json');
    assert.deepEqual(config.httpOptions, { timeout: 90000, retryOptions: { attempts: 1 } });
  }
});

test('custom and older models do not receive an unsupported effort parameter', () => {
  for (const model of ['gemini-2.5-flash', 'custom-model']) {
    assert.equal(geminiGenerationConfig(model, {}).thinkingConfig, undefined);
  }
});

test('operators can choose supported effort levels and invalid levels fail explicitly', () => {
  for (const level of ['low', 'medium', 'high']) {
    assert.equal(geminiGenerationConfig('gemini-3.8-flash', {
      GEMINI_ANALYSIS_THINKING_LEVEL: level
    }).thinkingConfig.thinkingLevel, level);
  }
  assert.throws(() => geminiGenerationConfig('gemini-3.8-flash', {
    GEMINI_ANALYSIS_THINKING_LEVEL: 'minimal'
  }), /must be/);
});
