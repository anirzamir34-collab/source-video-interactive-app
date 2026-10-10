import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElevenLabsProvider } from '../lib/turkish-media/elevenlabs.js';
import { configuredDictionaryLocators } from '../lib/turkish-media/pronunciation.js';
import { MediaError } from '../lib/turkish-media/errors.js';

function configuration(overrides = {}) {
  return { language: 'tr', qualityMode: 'quality', maxRetries: 2, requestTimeoutMs: 10000,
    elevenLabs: { apiKey: 'server-only-key', baseUrl: 'https://api.elevenlabs.io', dubModel: 'eleven_v4',
      fastModel: 'eleven_v4_turbo', sttModel: 'scribe_v2', outputFormat: 'mp3_44100_128',
      pronunciationDictionaryId: '', pronunciationDictionaryVersionId: '', ...overrides } };
}

const catalog = (changes = {}) => [{ model_id: 'eleven_v4', can_do_text_to_speech: true,
  maximum_text_length_per_request: 2000, languages: [{ language_id: 'tr', name: 'Turkish' }], ...changes }];
const inputs = [{ text: 'Selam.', voice_id: 'voice-man', speakerId: 'speaker-1', segmentId: 'segment-1' },
  { text: 'Merhaba.', voice_id: 'voice-woman', speakerId: 'speaker-2', segmentId: 'segment-2' }];
function nativeAudio() {
  return { audio_base64: Buffer.from('mock-mp3-bytes').toString('base64'),
    alignment: { characters: [...'Selam.Merhaba.'], character_start_times_seconds: Array.from({ length: 14 }, (_, i) => i / 10),
      character_end_times_seconds: Array.from({ length: 14 }, (_, i) => (i + 1) / 10) },
    voice_segments: [{ voice_id: 'voice-man', start_time_seconds: 0, end_time_seconds: 0.6,
      character_start_index: 0, character_end_index: 6, dialogue_input_index: 0 },
    { voice_id: 'voice-woman', start_time_seconds: 0.6, end_time_seconds: 1.4,
      character_start_index: 6, character_end_index: 14, dialogue_input_index: 1 }] };
}

function nativeWave(sampleRate) {
  const wave = Buffer.alloc(44 + Math.round(sampleRate * 1.4) * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  return { ...nativeAudio(), audio_base64: wave.toString('base64') };
}
function harness(handler, overrides) {
  const calls = [];
  const provider = createElevenLabsProvider({ config: configuration(overrides), request: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return handler(new URL(url), options, calls);
  } });
  return { provider, calls };
}

test('quality sends only official REST fields, server key and generated-audio ranges', async () => {
  const { provider, calls } = harness((url, options) => {
    if (url.pathname === '/v1/models') return catalog();
    assert.equal(url.pathname, '/v1/text-to-dialogue/with-timestamps');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { inputs: inputs.map(({ text, voice_id }) => ({ text, voice_id })),
      model_id: 'eleven_v4', language_code: 'tr' });
    assert.equal(options.headers['xi-api-key'], 'server-only-key');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
    assert.equal(options.retries, 2);
    return nativeAudio();
  });
  const result = await provider.synthesizeDialogue(inputs, { apiKey: 'ignored-client-key' });
  assert.equal(calls.length, 2);
  assert.equal(result.audio.toString(), 'mock-mp3-bytes');
  assert.equal(result.voiceSegments[1].dialogue_input_index, 1);
  assert.equal(result.voiceSegments[1].start, 0.6);
  assert.equal(result.voiceSegments[1].end, 1.4);
  assert.equal(result.model, 'eleven_v4');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.deepEqual(result.alignment, nativeAudio().alignment);
});

test('a corrupt isolated v4 dialogue uses the SAME voice and measured TTS character clock', async () => {
  const requested = [];
  const { provider } = harness((url, options) => {
    requested.push({ pathname: url.pathname, body: options.body ? JSON.parse(options.body) : null });
    if (url.pathname === '/v1/models') return catalog();
    if (url.pathname === '/v1/text-to-dialogue/with-timestamps') {
      return { ...nativeAudio(), voice_segments: [{
        ...nativeAudio().voice_segments[0], voice_id: 'wrong-voice'
      }] };
    }
    assert.equal(url.pathname, '/v1/text-to-speech/voice-man/with-timestamps');
    assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
    const body = JSON.parse(options.body);
    assert.equal(body.model_id, 'eleven_v4');
    assert.equal(body.language_code, 'tr');
    assert.equal(body.text, 'Selam.');
    return { audio_base64: Buffer.from('valid-isolated-v4-voice').toString('base64'),
      alignment: { characters: [...'Selam.'],
        character_start_times_seconds: [0, .1, .2, .3, .4, .5],
        character_end_times_seconds: [.1, .2, .3, .4, .5, .6] } };
  });
  const result = await provider.synthesizeDialogue([inputs[0]]);
  assert.equal(result.audio.toString(), 'valid-isolated-v4-voice');
  assert.equal(result.isolatedVoiceFallback, true);
  assert.equal(result.voiceSegments.length, 1);
  assert.equal(result.voiceSegments[0].voice_id, 'voice-man');
  assert.equal(result.voiceSegments[0].dialogue_input_index, 0);
  assert.equal(result.voiceSegments[0].end_time_seconds, .6);
  assert.deepEqual(result.alignment.characters, [...'Selam.']);
  assert.equal(requested.length, 3);
});

test('isolated invalid v4 alignment is never repaired with fictitious text or speaker timing', async () => {
  let paid = 0;
  const { provider } = harness(url => {
    if (url.pathname === '/v1/models') return catalog();
    paid++;
    if (url.pathname.includes('text-to-dialogue')) return {
      ...nativeAudio(), voice_segments: [{ ...nativeAudio().voice_segments[0], character_end_index: 99 }]
    };
    return { audio_base64: Buffer.from('bytes').toString('base64'),
      alignment: { characters: [...'Other words'], character_start_times_seconds: Array(11).fill(0),
        character_end_times_seconds: Array(11).fill(.2) } };
  });
  await assert.rejects(provider.synthesizeDialogue([inputs[0]]), {
    code: 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID'
  });
  assert.equal(paid, 2);
});

test('unavailable model, missing Turkish or false capability prevents paid synthesis', async () => {
  for (const models of [[], catalog({ languages: [{ language_id: 'en' }] }),
    catalog({ can_do_text_to_speech: false }), catalog({ languages: undefined })]) {
    const { provider, calls } = harness(() => models);
    await assert.rejects(provider.synthesizeDialogue(inputs), error =>
      ['DUB_MODEL_UNAVAILABLE', 'DUB_LANGUAGE_UNAVAILABLE'].includes(error.code));
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('fast mode fails visibly before any provider request and never substitutes old TTS', async () => {
  const { provider, calls } = harness(() => assert.fail('unexpected provider call'));
  await assert.rejects(provider.synthesizeDialogue(inputs, { qualityMode: 'fast' }), { code: 'FAST_MODEL_PROTOCOL_UNVERIFIED' });
  assert.equal(calls.length, 0);
});

test('model limit and ten-voice limit prevent truncated or invalid dialogue requests', async () => {
  const { provider, calls } = harness(() => catalog({ maximum_text_length_per_request: 10 }));
  await assert.rejects(provider.synthesizeDialogue(inputs), { code: 'DIALOGUE_TEXT_LIMIT' });
  assert.equal(calls.length, 1);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ text: 'a', voice_id: `voice-${i}` }));
  await assert.rejects(provider.synthesizeDialogue(eleven), { code: 'DIALOGUE_VOICE_LIMIT' });
  assert.equal(calls.length, 1);
  const second = harness(() => catalog({ maximum_text_length_per_request: 10000 }));
  await assert.rejects(second.provider.synthesizeDialogue([{ text: 'a'.repeat(2001), voice_id: 'one' }]), { code: 'DIALOGUE_TEXT_LIMIT' });
});

test('failed catalog reads are not cached and returned metadata cannot mutate validation', async () => {
  let count = 0;
  const { provider } = harness(() => {
    count += 1;
    if (count === 1) throw new MediaError('PROVIDER_HTTP_503', 'temporary', { retryable: true });
    return catalog();
  });
  await assert.rejects(provider.getModels());
  const models = await provider.getModels();
  models[0].languages.length = 0;
  assert.equal((await provider.validateCapabilities()).language, 'tr');
  assert.equal(count, 2);
});

test('voice catalog uses v2 pagination and retains real gender metadata', async () => {
  const { provider, calls } = harness(url => {
    assert.equal(url.pathname, '/v2/voices');
    assert.equal(url.searchParams.get('page_size'), '100');
    return url.searchParams.get('next_page_token') === 'second'
      ? { voices: [{ voice_id: 'woman', labels: { gender: 'female' } }], has_more: false }
      : { voices: [{ voice_id: 'man', labels: { gender: 'male' } }], has_more: true, next_page_token: 'second' };
  });
  const voices = await provider.listVoices();
  assert.equal(calls.length, 2);
  assert.equal(voices[1].labels.gender, 'female');
  voices[0].labels.gender = 'changed';
  assert.equal((await provider.listVoices())[0].labels.gender, 'male');
  assert.equal(calls.length, 2);
});

test('voice catalog rejects repeated page tokens rather than looping', async () => {
  const { provider, calls } = harness(() => ({ voices: [], has_more: true, next_page_token: 'same' }));
  await assert.rejects(provider.listVoices(), { code: 'PROVIDER_INVALID_RESPONSE' });
  assert.equal(calls.length, 2);
});

test('Scribe preserves verbatim words with fresh multipart bodies and cached source bytes', async () => {
  const speech = { text: 'Uh, hello.', language_code: 'en', words: [{ text: 'Uh,', start: 0, end: 0.3,
    type: 'word', speaker_id: 'speaker_0' }] };
  const bytes = Buffer.from([1, 2, 3, 4]); // A pooled Buffer must not upload its entire backing ArrayBuffer.
  const { provider, calls } = harness(async (url, options) => {
    assert.equal(url.pathname, '/v1/speech-to-text');
    assert.equal(options.body, undefined);
    const first = await options.bodyFactory();
    const second = await options.bodyFactory();
    assert.notEqual(first, second);
    assert.deepEqual([...first.keys()].sort(), ['diarize', 'diarization_threshold', 'file', 'file_format', 'model_id', 'no_verbatim',
      'tag_audio_events', 'timestamps_granularity'].sort());
    assert.equal(first.get('diarize'), 'true');
    assert.equal(first.get('diarization_threshold'), '0.32');
    assert.equal(first.get('no_verbatim'), 'false');
    assert.equal(first.get('model_id'), 'scribe_v2');
    assert.equal(first.get('file_format'), 'other');
    assert.equal(first.get('timestamps_granularity'), 'word');
    assert.deepEqual(Buffer.from(await first.get('file').arrayBuffer()), bytes);
    return speech;
  });
  assert.equal(await provider.transcribe(bytes), speech);
  assert.equal(calls.length, 1);
});

test('local file upload uses its actual bytes, source language hint and filesystem blob', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'videoquest-eleven-test-'));
  try {
    const filename = path.join(directory, 'source.wav');
    await writeFile(filename, 'source-wav-bytes');
    const { provider } = harness(async (_url, options) => {
      const forms = [await options.bodyFactory(), await options.bodyFactory()];
      assert.notEqual(forms[0], forms[1]);
      assert.notEqual(forms[0].get('file'), forms[1].get('file'));
      for (const form of forms) {
        assert.equal(form.get('language_code'), 'en');
        assert.equal(form.get('file').name, 'source.wav');
        assert.equal(form.get('file').type, 'audio/wav');
        assert.equal(await form.get('file').text(), 'source-wav-bytes');
      }
      return { words: [] };
    });
    await provider.transcribe(filename, { languageCode: 'en' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Forced Alignment uploads only generated speech and its text, with fresh bodies', async () => {
  const response = { words: [{ text: 'Selam.', start: 0, end: 0.6, loss: 2.1 }], characters: [], loss: 2.1 };
  const { provider } = harness(async (url, options) => {
    assert.equal(url.pathname, '/v1/forced-alignment');
    const form = await options.bodyFactory();
    assert.deepEqual([...form.keys()].sort(), ['file', 'text']);
    assert.equal(form.get('text'), 'Selam.');
    assert.equal(await form.get('file').text(), 'generated-turkish-audio');
    assert.notEqual(await options.bodyFactory(), form);
    return response;
  });
  assert.equal(await provider.align(Buffer.from('generated-turkish-audio'), 'Selam.'), response);
});

test('Forced Alignment reopens its fitted audio file for every fresh multipart body', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'videoquest-eleven-align-'));
  try {
    const filename = path.join(directory, 'fitted-turn.wav');
    const bytes = Buffer.from('fitted-turkish-audio');
    await writeFile(filename, bytes);
    const response = { words: [{ text: 'Selam.', start: 0, end: 0.6, loss: 0 }] };
    const { provider } = harness(async (url, options) => {
      assert.equal(url.pathname, '/v1/forced-alignment');
      const forms = [await options.bodyFactory(), await options.bodyFactory()];
      assert.notEqual(forms[0], forms[1]);
      assert.notEqual(forms[0].get('file'), forms[1].get('file'));
      for (const form of forms) {
        assert.deepEqual([...form.keys()].sort(), ['file', 'text']);
        assert.equal(form.get('text'), 'Selam.');
        assert.equal(form.get('file').name, 'fitted-turn.wav');
        assert.equal(form.get('file').type, 'audio/wav');
        assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), bytes);
      }
      return response;
    });
    assert.equal(await provider.align({ path: filename }, 'Selam.'), response);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing, malformed or mismatched native turn metadata cannot fabricate segments', async () => {
  const variants = [
    { ...nativeAudio(), voice_segments: undefined },
    { ...nativeAudio(), voice_segments: nativeAudio().voice_segments.slice(0, 1) },
    { ...nativeAudio(), voice_segments: [{ ...nativeAudio().voice_segments[0], voice_id: 'wrong-voice' }] },
    { ...nativeAudio(), alignment: { characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [] } },
    { ...nativeAudio(), audio_base64: 'not%base64' },
  ];
  for (const variant of variants) {
    const { provider } = harness(url => url.pathname === '/v1/models' ? catalog() : variant);
    await assert.rejects(provider.synthesizeDialogue(inputs), error =>
      ['PROVIDER_DIALOGUE_ALIGNMENT_INVALID', 'PROVIDER_INVALID_RESPONSE'].includes(error.code));
  }
});

test('optional absent native character alignment leaves actual-audio Forced Alignment available', async () => {
  const response = { ...nativeAudio(), alignment: null, normalized_alignment: null };
  const { provider } = harness(url => url.pathname === '/v1/models' ? catalog() : response);
  const generated = await provider.synthesizeDialogue(inputs);
  assert.equal(generated.alignment, null);
  assert.equal(generated.voiceSegments.length, 2);
  assert.ok(generated.audio.length);
});

test('configured PCM requests documented headered WAV with the exact requested sample rate', async () => {
  for (const sampleRate of [8000, 16000, 22050, 24000, 32000, 44100, 48000]) {
    const { provider, calls } = harness(url => {
      if (url.pathname === '/v1/models') return catalog();
      assert.equal(url.searchParams.get('output_format'), `wav_${sampleRate}`);
      assert.equal(url.pathname, '/v1/text-to-dialogue/with-timestamps');
      return nativeWave(sampleRate);
    }, { outputFormat: `pcm_${sampleRate}` });
    const result = await provider.synthesizeDialogue(inputs);
    assert.equal(result.requestedOutputFormat, `pcm_${sampleRate}`);
    assert.equal(result.outputFormat, `wav_${sampleRate}`);
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.audio.readUInt32LE(24), sampleRate);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('configured A-law and mu-law request headered 8 kHz WAV without guessing raw channel counts', async () => {
  for (const outputFormat of ['alaw_8000', 'ulaw_8000']) {
    const { provider, calls } = harness((url, options) => {
      if (url.pathname === '/v1/models') return catalog();
      assert.equal(url.pathname, '/v1/text-to-dialogue/with-timestamps');
      assert.equal(url.searchParams.get('output_format'), 'wav_8000');
      const body = JSON.parse(options.body);
      assert.equal(body.model_id, 'eleven_v4');
      assert.deepEqual(body.inputs, inputs.map(({ text, voice_id }) => ({ text, voice_id })));
      return nativeWave(8000);
    }, { outputFormat });
    const result = await provider.synthesizeDialogue(inputs);
    assert.equal(result.requestedOutputFormat, outputFormat);
    assert.equal(result.outputFormat, 'wav_8000');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.audio.readUInt32LE(24), 8000);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('explicit rejected WAV format may use MP3, while model and server errors never fall back', async () => {
  for (const outputFormat of ['pcm_44100', 'alaw_8000', 'ulaw_8000']) {
    const { provider, calls } = harness((url, options) => {
      if (url.pathname === '/v1/models') return catalog();
      assert.equal(JSON.parse(options.body).model_id, 'eleven_v4');
      if (url.searchParams.get('output_format').startsWith('wav_')) {
        throw new MediaError('PROVIDER_HTTP_422', 'output_format is not supported');
      }
      return nativeAudio();
    });
    const result = await provider.synthesizeDialogue(inputs, { outputFormat });
    assert.equal(result.requestedOutputFormat, outputFormat);
    assert.equal(result.outputFormat, 'mp3_44100_128');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
  }
  for (const error of [new MediaError('PROVIDER_HTTP_422', 'model_id is not supported'),
    new MediaError('PROVIDER_HTTP_503', 'output_format unsupported', { retryable: true })]) {
    const instance = harness(url => { if (url.pathname === '/v1/models') return catalog(); throw error; });
    await assert.rejects(instance.provider.synthesizeDialogue(inputs, { outputFormat: 'pcm_44100' }), error);
    assert.equal(instance.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('pronunciation is a pinned dictionary locator without changing submitted text', async () => {
  assert.deepEqual(configuredDictionaryLocators(configuration()), []);
  assert.throws(() => configuredDictionaryLocators(configuration({ pronunciationDictionaryId: 'dict' })),
    { code: 'PRONUNCIATION_DICTIONARY_INVALID' });
  const { provider } = harness((url, options) => {
    if (url.pathname === '/v1/models') return catalog();
    const body = JSON.parse(options.body);
    assert.deepEqual(body.pronunciation_dictionary_locators,
      [{ pronunciation_dictionary_id: 'dict', version_id: 'version-7' }]);
    assert.equal(body.inputs[0].text, inputs[0].text);
    return nativeAudio();
  }, { pronunciationDictionaryId: 'dict', pronunciationDictionaryVersionId: 'version-7' });
  await provider.synthesizeDialogue(inputs);
});

test('missing server key and cancellation issue no provider requests', async () => {
  const missing = harness(() => assert.fail('unexpected provider call'), { apiKey: '' });
  await assert.rejects(missing.provider.transcribe(Buffer.from('source')), { code: 'ELEVENLABS_NOT_CONFIGURED' });
  assert.equal(missing.calls.length, 0);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const cancelled = harness(() => assert.fail('unexpected provider call'));
  await assert.rejects(cancelled.provider.synthesizeDialogue(inputs, { signal: controller.signal }), /cancelled/);
  assert.equal(cancelled.calls.length, 0);
});
