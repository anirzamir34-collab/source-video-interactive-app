import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationProvider } from '../lib/turkish-media/translation.js';
import { loadMediaConfig, GEMINI_DEFAULT_MODEL, publicMediaConfig } from '../lib/turkish-media/config.js';
import { createMediaRequest } from '../lib/turkish-media/http.js';

const scene = { utterances: [{ segmentId: 'source-1', speakerId: 'speaker-0', sourceText: 'Hello again.', sourceStart: 2, sourceEnd: 4 }],
  previousContext: [{ sourceText: 'Earlier source words.' }], nextContext: [], speakers: [{ speakerId: 'speaker-0', gender: null }],
  sceneContext: [{ evidence: 'visual context is not speech evidence' }] };
const response = translations => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] }, finishReason: 'STOP' }] });
const translated = [{ segmentId: 'source-1', text: 'Yine merhaba.' }];

test('translation reports actual usage including thinking even when a completed response cannot publish', async () => {
  const usage = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 40, totalTokenCount: 190 };
  const observed = [];
  const provider = createTranslationProvider({ config: loadMediaConfig({ GEMINI_API_KEY: 'key' }),
    request: async () => ({ ...response(translated), usageMetadata: usage }), onUsage: value => observed.push(value) });
  await provider.translateScene(scene);
  assert.deepEqual(observed, [usage]);
  const blocked = createTranslationProvider({ config: loadMediaConfig({ GEMINI_API_KEY: 'key' }),
    request: async () => ({ ...response(translated), usageMetadata: usage, promptFeedback: { blockReason: 'SAFETY' } }),
    onUsage: value => observed.push(value) });
  await assert.rejects(blocked.translateScene(scene), { code: 'TRANSLATION_BLOCKED' });
  assert.deepEqual(observed, [usage, usage]);
});

test('Gemini is the only translation provider and model precedence follows existing Gemini configuration', () => {
  const config = loadMediaConfig({ GEMINI_API_KEY: ' server-key ', OPENAI_API_KEY: 'ignored-legacy-key' });
  assert.equal(config.translation.provider, 'gemini');
  assert.equal(config.translation.apiKey, 'server-key');
  assert.equal(config.translation.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(config.translation.model, GEMINI_DEFAULT_MODEL);
  assert.equal(config.translationVersion, 'scene-tr-gemini-v2');
  assert.equal(loadMediaConfig({ GEMINI_MODEL: 'gemini-custom' }).translation.model, 'gemini-custom');
  assert.equal(loadMediaConfig({ TRANSLATION_MODEL: 'gemini-translation', GEMINI_MODEL: 'gemini-custom' }).translation.model, 'gemini-translation');
  assert.throws(() => loadMediaConfig({ TRANSLATION_PROVIDER: 'openai' }), /gemini/);
  const missing = publicMediaConfig(loadMediaConfig({}));
  assert.equal(missing.serverMediaConfigured, false);
  assert.deepEqual(missing.browserKeysSupported, { gemini: true, elevenLabs: true });
});

test('Gemini joins output parts, skips thought text and retains source durations during shortening', async () => {
  let body;
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  const provider = createTranslationProvider({ config, request: async (_url, options) => {
    body = JSON.parse(options.body);
    const text = JSON.stringify({ translations: translated });
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private model reasoning' },
      { text: text.slice(0, 15) }, { text: text.slice(15) }] } }] };
  } });
  const result = await provider.translateScene(scene, { shorten: true, measuredDurations: { 'source-1': 3.7 } });
  assert.equal(result[0].speakerId, 'speaker-0');
  assert.equal(result[0].translatedText, 'Yine merhaba.');
  assert.equal(result[0].targetDuration, 2);
  const payload = JSON.parse(body.contents[0].parts[0].text);
  assert.equal(payload.utterances[0].measuredDubDuration, 3.7);
  assert.equal(payload.utterances[0].sourceText, scene.utterances[0].sourceText);
  assert.deepEqual(payload.sceneContext, scene.sceneContext);
  assert.match(body.systemInstruction.parts[0].text, /Rephrase more briefly without omitting meaning/);
  assert.equal(body.generationConfig.responseSchema.properties.translations.items.properties.text.type, 'STRING');
});

test('blocked and truncated Gemini responses fail explicitly even when text looks like valid translations', async () => {
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  for (const [value, code] of [
    [{ ...response(translated), promptFeedback: { blockReason: 'SAFETY' } }, 'TRANSLATION_BLOCKED'],
    [{ candidates: [{ ...response(translated).candidates[0], finishReason: 'SAFETY' }] }, 'TRANSLATION_BLOCKED'],
    [{ candidates: [{ ...response(translated).candidates[0], finishReason: 'MAX_TOKENS' }] }, 'TRANSLATION_INCOMPLETE'],
  ]) {
    let calls = 0;
    const provider = createTranslationProvider({ config, request: async () => { calls++; return value; } });
    await assert.rejects(provider.translateScene(scene), { code, retryable: false });
    assert.equal(calls, 1, 'a blocked answer never falls back to another provider or model');
  }
});

test('Gemini missing content, invalid rows and added performance fields cannot publish translated speech', async () => {
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  const variants = [{}, { candidates: [{ content: { parts: {} } }] },
    { candidates: [{ content: { parts: [null] } }] },
    { candidates: [{ content: { parts: [{ thought: true, text: JSON.stringify({ translations: translated }) }] } }] },
    response([null]), response([{ ...translated[0], emotion: 'invented' }]), response([{ segmentId: 'source-1', text: ' ' }])];
  for (const value of variants) {
    const provider = createTranslationProvider({ config, request: async () => value });
    await assert.rejects(provider.translateScene(scene), error => ['TRANSLATION_INVALID_JSON', 'TRANSLATION_SEGMENT_MISMATCH'].includes(error.code));
  }
});

test('missing Gemini key, invalid model and cancellation do not call any provider', async () => {
  let calls = 0;
  const request = async () => { calls++; return response(translated); };
  await assert.rejects(createTranslationProvider({ config: loadMediaConfig({}), request }).translateScene(scene), { code: 'GEMINI_NOT_CONFIGURED' });
  await assert.rejects(createTranslationProvider({ config: loadMediaConfig({ GEMINI_API_KEY: 'key', TRANSLATION_MODEL: '../other' }), request })
    .translateScene(scene), { code: 'TRANSLATION_MODEL_INVALID' });
  const config = loadMediaConfig({ GEMINI_API_KEY: 'key' });
  await assert.rejects(createTranslationProvider({ config, request }).translateScene(scene,
    { signal: AbortSignal.abort(new DOMException('cancel', 'AbortError')) }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('Gemini HTTP requests use bounded shared retries and keep credentials out of their URLs', async () => {
  let calls = 0;
  const config = loadMediaConfig({ GEMINI_API_KEY: 'browser-effective-key' });
  const request = createMediaRequest({ maxRetries: 1, random: () => 0, sleep: async () => {}, secrets: [config.translation.apiKey],
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(new URL(url).search, '');
      assert.ok(!url.includes(config.translation.apiKey));
      assert.equal(options.headers['x-goog-api-key'], config.translation.apiKey);
      return calls === 1 ? new Response('limited', { status: 429 }) : Response.json(response(translated));
    } });
  const provider = createTranslationProvider({ config, request });
  assert.equal((await provider.translateScene(scene))[0].translatedText, 'Yine merhaba.');
  assert.equal(calls, 2);
});
