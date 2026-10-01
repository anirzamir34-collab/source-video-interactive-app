import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from '../public/model-json.js';
import { parseStoryboardResponse } from '../public/analysis-recovery.js';

test('provider fences and nested trailing commas are repaired without changing quoted speech', () => {
  for (const fence of ['json', '']) {
    const parsed = parseModelJson('```' + fence + '\n{"segments":[{"text":"Keep ,} and ,] exactly",},],}\n```');
    assert.deepEqual(parsed, { segments: [{ text: 'Keep ,} and ,] exactly' }] });
  }
});
test('escaped quotes and backslashes do not change parser string boundaries', () => {
  const text = 'A quote " then ,} and a slash \\ then ,]';
  const input = '{"text":' + JSON.stringify(text) + ',}';
  assert.equal(parseModelJson(input).text, text);
});
test('truncated objects and unquoted properties remain errors rather than invented data', () => {
  assert.throws(() => parseModelJson('{"segments":['), SyntaxError);
  assert.throws(() => parseModelJson('{segments:[]}'), SyntaxError);
  assert.throws(() => parseModelJson(''), /GEMINI_EMPTY_JSON_RESPONSE/);
});
test('storyboard uses the same repair helper and retains terminal provider refusal', () => {
  assert.deepEqual(parseStoryboardResponse({ text: '{"actions":[],}' }), { actions: [] });
  assert.throws(() => parseStoryboardResponse({ text: '{"actions":[],}', candidates: [{ finishReason: 'SAFETY' }] }), /GEMINI_CONTENT_RESTRICTED/);
});
