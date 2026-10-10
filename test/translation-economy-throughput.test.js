import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMediaConfig } from '../lib/turkish-media/config.js';
import { createTranslationProvider, translationScenes } from '../lib/turkish-media/translation.js';
import { MediaError } from '../lib/turkish-media/errors.js';

const utterance = (i, text = 'This is an ordinary spoken sentence with context.') => ({
  segmentId: `segment-${i}`, speakerId: i % 2 ? 'female' : 'male',
  sourceText: text, sourceStart: i * 2, sourceEnd: i * 2 + 1.6,
  words: Array.from({ length: 100 }, (_, j) => ({ text: 'word', start: i * 2 + j / 100 })),
  language: 'eng'
});
const transcript = rows => ({ utterances: rows, speakers: [
  { speakerId: 'male', gender: 'male', age: null, emotion: null },
  { speakerId: 'female', gender: 'female', age: null, emotion: null }
] });
const response = scene => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    translations: scene.utterances.map(u => ({ segmentId: u.segmentId, text: 'Türkçe konuşma.' }))
  }) }] } }]
});

test('translation batching is bounded upfront; 33 old mega-scenes cannot hide sequential splitting', () => {
  const rows = Array.from({ length: 250 }, (_, i) => utterance(i, 'Speaker dialogue '.repeat(10)));
  const scenes = translationScenes(transcript(rows));
  assert.ok(scenes.length >= 21);
  assert.ok(scenes.every(scene => scene.utterances.length <= 12));
  assert.ok(scenes.every(scene => scene.utterances.reduce((n, row) => n + row.sourceText.length, 0) <= 1600));
  assert.deepEqual(scenes.flatMap(scene => scene.utterances.map(row => row.segmentId)), rows.map(row => row.segmentId));
  assert.equal(scenes[1].previousContext.at(-1).segmentId, scenes[0].utterances.at(-1).segmentId);
  assert.equal(scenes[0].nextContext[0].segmentId, scenes[1].utterances[0].segmentId);
  assert.equal(scenes.at(-1).utterances.at(-1).sourceEnd, rows.at(-1).sourceEnd);
  assert.equal(rows[0].words.length, 100, 'source word evidence remains intact');
});

test('translation forwards only spoken neighboring context without Scribe word payload', async () => {
  const full = transcript([utterance(0), utterance(1), utterance(2)]);
  const scene = translationScenes(full)[0];
  const context = { ...scene, previousContext: [utterance(22)], nextContext: [utterance(24)] };
  let requestBody;
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  const provider = createTranslationProvider({ config, request: async (url, opts) => {
    assert.match(url, /gemini-2\.5-flash-lite:generateContent$/);
    requestBody = JSON.parse(opts.body);
    return response(scene);
  } });
  const result = await provider.translateScene(context);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(row => row.segmentId), full.utterances.map(u => u.segmentId));
  const payload = JSON.parse(requestBody.contents[0].parts[0].text);
  assert.equal(payload.previousContext[0].sourceText, utterance(22).sourceText);
  assert.equal(payload.previousContext[0].speakerId, 'male');
  assert.equal(payload.previousContext[0].words, undefined);
  assert.equal(payload.nextContext[0].words, undefined);
  assert.equal(payload.speakers[0].gender, 'male');
  assert.equal(payload.utterances[1].targetDuration, full.utterances[1].sourceEnd - full.utterances[1].sourceStart);
  assert.equal(requestBody.generationConfig.thinkingConfig, undefined);
});

test('one unsupported 2.5 Lite selects 3.1 Lite once for subsequent turns; minimal thinking', async () => {
  const attempts = [], configs = [];
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  const one = { ...translationScenes(transcript([utterance(0)]))[0] };
  const provider = createTranslationProvider({ config, request: async (url, options) => {
    const model = /models\/(.+):generateContent/.exec(url)?.[1];
    attempts.push(model); configs.push(JSON.parse(options.body).generationConfig);
    if (model === 'gemini-2.5-flash-lite') throw new MediaError('PROVIDER_HTTP_404', 'Model not available', { status: 404 });
    return response(one);
  } });
  await provider.translateScene(one);
  await provider.translateScene(one);
  assert.deepEqual(attempts, ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']);
  assert.deepEqual(configs[1].thinkingConfig, { thinkingLevel: 'minimal' });
  assert.deepEqual(configs[2].thinkingConfig, { thinkingLevel: 'minimal' });
});

test('quota errors, safety and malformed responses never substitute a second model', async () => {
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  const scene = translationScenes(transcript([utterance(0)]))[0];
  for (const code of ['PROVIDER_HTTP_429', 'PROVIDER_HTTP_503', 'PROVIDER_HTTP_403']) {
    let calls = 0;
    const provider = createTranslationProvider({ config, request: async () => {
      calls++; throw new MediaError(code, 'Provider temporarily unavailable', { status: Number(code.slice(-3)) });
    } });
    await assert.rejects(provider.translateScene(scene), { code });
    assert.equal(calls, 1, `${code}: no automatic model fallback`);
  }
  let calls = 0;
  const blocked = createTranslationProvider({ config, request: async () => {
    calls++;
    return { ...response(scene), promptFeedback: { blockReason: 'SAFETY' } };
  } });
  await assert.rejects(blocked.translateScene(scene), { code: 'TRANSLATION_BLOCKED' });
  assert.equal(calls, 1);
});

test('explicit translation model bypasses economy fallback and preserves operator choice', async () => {
  const config = loadMediaConfig({
    GEMINI_API_KEY: 'key', GEMINI_MODEL: 'gemini-3.8-flash',
    TRANSLATION_MODEL: 'gemini-custom-model'
  });
  assert.equal(config.translation.model, 'gemini-custom-model');
  assert.equal(config.translation.fallbackModel, '');
  let calls = 0;
  const provider = createTranslationProvider({ config, request: async url => {
    calls++; assert.match(url, /gemini-custom-model:generateContent$/);
    throw new MediaError('PROVIDER_HTTP_404', 'No model', { status: 404 });
  } });
  await assert.rejects(provider.translateScene(translationScenes(transcript([utterance(0)]))[0]),
    { code: 'PROVIDER_HTTP_404' });
  assert.equal(calls, 1);
});
