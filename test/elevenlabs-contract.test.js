import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('ElevenLabs v3 requests use Turkish and supported discrete stability without unsupported fields', async () => {
  const start = source.indexOf('async function elevenLabsSynthesize(');
  const end = source.indexOf('\nfunction elevenLabsErrorResponse', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /model_id:\s*'eleven_v3'/);
  assert.doesNotMatch(block, /previous_text\s*:/);
  assert.doesNotMatch(block, /next_text\s*:/);
  assert.match(block, /language_code:\s*'tr'/);
  const calls = [];
  const scope = vm.createContext({
    Buffer, crypto, elevenLabsAudioCache: new Map(), elevenLabsAudioInflight: new Map(),
    ELEVENLABS_AUDIO_CACHE_TTL_MS: 60000, pruneElevenLabsAudioCache() {},
    elevenLabsVoices: async () => ({ voices: [{ voice_id: 'assigned-turkish-voice', name: 'Conversational' }] }),
    elevenLabsRequest: async (_apiKey, url, request) => {
      const body = JSON.parse(request.body);
      // Simulate the provider rejecting unknown model IDs and V3 parameters.
      assert.equal(body.model_id, 'eleven_v3');
      assert.equal(body.language_code, 'tr');
      assert.deepEqual(body.voice_settings, { stability: 0.5 });
      assert.deepEqual(Object.keys(body).sort(), ['language_code', 'model_id', 'text', 'voice_settings']);
      calls.push({ url, body });
      return { arrayBuffer: async () => Buffer.from('encoded-provider-audio') };
    }
  });
  vm.runInContext(block, scope);
  const result = await scope.elevenLabsSynthesize({ apiKey: 'test-key', voiceId: 'assigned-turkish-voice',
    text: 'Merhaba, nasılsın?', emotion: 'excited', sourceContext: { segmentId: 'one', previousText: 'Hello.' } });
  assert.equal(calls[0].body.text, 'Merhaba, nasılsın?', 'no unverified acting text is spoken');
  assert.match(calls[0].url, /text-to-speech\/assigned-turkish-voice\?output_format=mp3_44100_128/);
  assert.equal(result.model, 'eleven_v3');
  assert.equal(result.voiceId, 'assigned-turkish-voice');
  assert.ok(result.audioBase64);
});

test('Turkish catalog metadata cannot make a narrator outrank a conversational voice', () => {
  const start = source.indexOf('function elevenVoiceGender(');
  const end = source.indexOf('\nasync function elevenLabsVoices(', start);
  const scope = vm.createContext({});
  vm.runInContext(source.slice(start, end), scope);
  const narrator = { name: 'News', labels: { gender: 'male', language: 'turkish' }, description: 'Turkish news narrator' };
  const conversational = { name: 'Dialogue', labels: { gender: 'male', language: 'turkish' }, description: 'Natural casual conversational dialogue' };
  assert.ok(scope.scoreElevenVoice(conversational, 'male') > scope.scoreElevenVoice(narrator, 'male'));
  assert.equal(scope.isElevenDialogueVoice(narrator), false);
  assert.equal(scope.isElevenDialogueVoice(conversational), true);
  assert.equal(scope.isElevenDialogueVoice({ labels: { use_case: 'news' } }), false);
  assert.equal(scope.isElevenDialogueVoice({ description: 'robotic voice' }), false);
});
