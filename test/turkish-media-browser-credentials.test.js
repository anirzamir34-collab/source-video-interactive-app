import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaJobs, validateMediaCredentials } from '../lib/turkish-media/jobs.js';
import { createMediaCache } from '../lib/turkish-media/cache.js';
import { createLimiter } from '../lib/turkish-media/limiter.js';
import { loadMediaConfig } from '../lib/turkish-media/config.js';

// Only the HTTP transport and media encoder are replaced. Jobs instantiate the
// real provider, translation, canonical, disk cache, alignment and subtitle code.
const browserKey = 'browser-eleven-only-test-secret-123456';
const serverGeminiKey = 'server-gemini-only-test-secret-123456';
const userGeminiKey = 'user-gemini-override-test-secret-123456';
const wrongKey = 'wrong-eleven-account-test-secret-123456';
const secretValues = [browserKey, serverGeminiKey, userGeminiKey, wrongKey];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});
const credentials = geminiApiKey => ({ elevenLabsApiKey: browserKey, ...(geminiApiKey ? { geminiApiKey } : {}) });

test('provider credentials accept opaque printable API key formats without assuming provider alphabets', () => {
  const eleven = 'sk_live.v4/+opaque:=credential~1234567890';
  const gemini = 'AIzaSy.example-opaque_key+1234567890';
  assert.deepEqual(validateMediaCredentials({ elevenLabsApiKey: eleven, geminiApiKey: gemini }), {
    elevenLabsApiKey: eleven,
    geminiApiKey: gemini,
  });
  assert.equal(validateMediaCredentials({ elevenLabsApiKey: ' '.repeat(4) + eleven + ' ' }).elevenLabsApiKey, eleven);
});

test('provider credential validation still rejects whitespace, controls, tiny and unbounded values', () => {
  for (const bad of ['short', 'valid-looking-key-but has-space', 'valid-looking-key\nnewline']) {
    assert.throws(() => validateMediaCredentials({ elevenLabsApiKey: bad }), /ElevenLabs API anahtarı/);
  }
  assert.throws(() => validateMediaCredentials({ elevenLabsApiKey: 'x'.repeat(1025) }), /ElevenLabs API anahtarı/);
  assert.throws(() => validateMediaCredentials({ geminiApiKey: 'x'.repeat(513) }), /Gemini API anahtarı/);
});

function wave(duration) {
  const sampleRate = 8000;
  const result = Buffer.alloc(44 + Math.round(duration * sampleRate) * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36);
  result.writeUInt32LE(result.length - 44, 40);
  return result;
}

async function fixture(t, { geminiKey = serverGeminiKey, failAlignmentOnce = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vq-browser-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source-video.mp4');
  await writeFile(sourcePath, 'the-same-real-source-video-bytes');
  const config = loadMediaConfig({ ELEVENLABS_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: serverGeminiKey,
    DUB_CACHE_DIRECTORY: directory, DUB_MAX_RETRIES: '0', DUB_QUALITY_MODE: 'quality' });
  assert.equal(config.elevenLabs.apiKey, '', 'no backend ElevenLabs key exists');
  const cache = createMediaCache({ directory: path.join(directory, 'cache') });
  const limiter = createLimiter(2);
  const calls = [], logs = [], generated = new Map();
  const info = console.info;
  console.info = (...args) => logs.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  t.after(() => { console.info = info; });
  let alignmentFailed = false;
  const fetchImpl = async (address, options = {}) => {
    const url = new URL(address), headers = new Headers(options.headers);
    calls.push({ url: url.href, method: options.method || 'GET', elevenKey: headers.get('xi-api-key'), geminiKey: headers.get('x-goog-api-key') });
    assert.notEqual(url.hostname, 'api.openai.com', 'browser Eleven + Gemini must never call OpenAI');
    if (url.hostname === 'api.elevenlabs.io') {
      if (headers.get('xi-api-key') !== browserKey) {
        return jsonResponse({ detail: `Invalid xi-api-key: ${headers.get('xi-api-key')}` }, 401);
      }
      assert.equal(headers.get('xi-api-key'), browserKey);
      if (url.pathname === '/v1/models') return jsonResponse([{ model_id: 'eleven_v4', can_do_text_to_speech: true,
        languages: [{ language_id: 'tr', name: 'Turkish' }], maximum_text_length_per_request: 2000 }]);
      if (url.pathname === '/v2/voices') return jsonResponse({ has_more: false, voices: [
        { voice_id: 'voice-a', name: 'A', labels: { language: 'tr', gender: 'male' } },
        { voice_id: 'voice-b', name: 'B', labels: { language: 'tr', gender: 'female' } }
      ] });
      if (url.pathname === '/v1/speech-to-text') {
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('model_id'), 'scribe_v2');
        assert.equal(options.body.get('diarize'), 'true');
        assert.equal(options.body.get('timestamps_granularity'), 'word');
        assert.ok((await options.body.get('file').arrayBuffer()).byteLength > 0);
        return jsonResponse({ text: 'Hello. Yes.', language_code: 'en', words: [
          { text: 'Hello.', type: 'word', start: 1, end: 3, speaker_id: 'speaker_0', logprob: -.03 },
          { text: ' ', type: 'spacing', start: 3, end: 3 },
          { text: 'Yes.', type: 'word', start: 3.5, end: 5.5, speaker_id: 'speaker_1', logprob: -.02 },
          { text: '(laughter)', type: 'audio_event', start: 6, end: 6.25 }
        ] });
      }
      if (url.pathname === '/v1/text-to-dialogue/with-timestamps') {
        const body = JSON.parse(options.body);
        assert.equal(body.model_id, 'eleven_v4'); assert.equal(body.language_code, 'tr');
        assert.deepEqual(body.inputs.map(row => row.text), ['Merhaba.', 'Evet.']);
        const audio = wave(body.inputs.length);
        generated.set(sha256(audio), body.inputs);
        const characters = body.inputs.flatMap(row => [...row.text]);
        const starts = body.inputs.flatMap((row, index) => [...row.text].map((_, i) => index + .125 + i * .75 / row.text.length));
        const ends = body.inputs.flatMap((row, index) => [...row.text].map((_, i) => index + .125 + (i + 1) * .75 / row.text.length));
        let characterOffset = 0;
        return jsonResponse({ audio_base64: audio.toString('base64'),
          // A missing native alignment deliberately exercises the FA retry path.
          alignment: failAlignmentOnce ? null : { characters,
            character_start_times_seconds: starts, character_end_times_seconds: ends },
          voice_segments: body.inputs.map((row, index) => {
            const start = characterOffset; characterOffset += row.text.length;
            return { voice_id: row.voice_id, dialogue_input_index: index,
              start_time_seconds: index, end_time_seconds: index + 1,
              character_start_index: start, character_end_index: characterOffset };
          }) });
      }
      if (url.pathname === '/v1/forced-alignment') {
        assert.ok(options.body instanceof FormData);
        const text = options.body.get('text');
        const actual = JSON.parse(await options.body.get('file').text());
        assert.equal(actual.text, text); assert.equal(actual.fitted, true, 'FA consumes the final fitted Turkish audio');
        if (failAlignmentOnce && !alignmentFailed) {
          alignmentFailed = true;
          return jsonResponse({ detail: `Temporary failure xi-api-key: ${browserKey} x-goog-api-key: ${geminiKey}` }, 503);
        }
        return jsonResponse({ loss: .002, characters: [...text].map((character, i) => ({
          text: character, start: .125 + i * 1.75 / text.length, end: .125 + (i + 1) * 1.75 / text.length
        })), words: [{ text, start: .125, end: 1.875 }] });
      }
      assert.fail(`Unexpected ElevenLabs endpoint: ${url.pathname}`);
    }
    assert.equal(url.hostname, 'generativelanguage.googleapis.com');
    assert.match(url.pathname, /\/models\/[^/]+:generateContent$/);
    assert.equal(headers.get('x-goog-api-key'), geminiKey, 'request Gemini overrides server Gemini, otherwise server key is used');
    assert.equal(url.searchParams.has('key'), false, 'Gemini key belongs in its header, not the URL');
    const body = JSON.parse(options.body);
    const text = (body.contents || []).flatMap(content => content.parts || []).map(part => part.text || '').join('\n');
    const ids = [...new Set(text.match(/segment-[a-f0-9]{64}-\d{6}/g) || [])].sort();
    assert.equal(ids.length, 2, 'real canonical segment IDs reach the Gemini translation request');
    return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({
      translations: ids.map((segmentId, i) => ({ segmentId, text: i === 0 ? 'Merhaba.' : 'Evet.' }))
    }) }] } }] });
  };
  const audio = {
    async extractSource(_source, { directory: work }) {
      await mkdir(work, { recursive: true });
      const originalPath = path.join(work, 'original.wav'), sttPath = path.join(work, 'speech.flac');
      await writeFile(originalPath, wave(8)); await writeFile(sttPath, 'the-complete-source-audio');
      return { duration: 8, originalPath, sttPath };
    },
    async splitDialogueTurns(file, { voiceSegments, inputCount, directory: work }) {
      const inputs = generated.get(sha256(await readFile(file)));
      assert.ok(inputs, 'native TTD audio bytes passed through the real provider/cache');
      assert.equal(inputCount, inputs.length); assert.equal(voiceSegments.length, inputCount);
      await mkdir(work, { recursive: true });
      return Promise.all(inputs.map(async (row, index) => {
        assert.equal(voiceSegments[index].dialogue_input_index, index);
        assert.equal(voiceSegments[index].voice_id, row.voice_id);
        const audioPath = path.join(work, `turn-${index}.wav`);
        await writeFile(audioPath, JSON.stringify({ text: row.text, duration: 1 }));
        return { dialogueInputIndex: index, audioPath, duration: 1 };
      }));
    },
    async fitDubSegment(file, { targetDuration }) {
      assert.equal(targetDuration, 2);
      const row = JSON.parse(await readFile(file, 'utf8'));
      const fitted = `${file}.fitted.wav`;
      await writeFile(fitted, JSON.stringify({ ...row, duration: targetDuration, fitted: true }));
      return { path: fitted, duration: targetDuration, tempo: 1, mimeType: 'audio/wav' };
    },
    async mixAudio({ sourceAudio, dubSegments, duration, directory: work, format }) {
      assert.equal(format, 'mp3');
      assert.equal(duration, 8); assert.equal(dubSegments.length, 2);
      assert.ok((await readFile(sourceAudio)).length);
      for (const row of dubSegments) {
        assert.ok((await readFile(row.audioPath)).length);
        assert.ok(row.words.every(word => word.start >= row.start && word.end <= row.end));
      }
      const file = path.join(work, 'final-mix.mp3'); await writeFile(file, wave(duration));
      return { path: file, duration, mimeType: 'audio/mpeg', qa: { mixMode: 'speech-ducking', clipping: false, playbackFormat: 'mp3' } };
    }
  };
  const makeJobs = () => createMediaJobs({ config, cache, limiter, audio, fetchImpl });
  const input = { source: { path: sourcePath }, outputs: { dub: true, subtitles: true }, qualityMode: 'quality' };
  return { directory, sourcePath, config, calls, logs, input, makeJobs, jobs: makeJobs() };
}

async function settled(jobs, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await jobs.get(id);
    if (job && ['READY', 'FAILED', 'CANCELLED'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Real media job did not settle');
}

function assertComplete(job) {
  assert.equal(job.state, 'READY', JSON.stringify(job.error));
  const result = job.result, source = result.sourceTranscript;
  assert.equal(source.utterances.length, 2); assert.equal(source.speakers.length, 2); assert.equal(source.audioEvents.length, 1);
  assert.deepEqual(source.utterances.map(row => row.sourceText), ['Hello.', 'Yes.']);
  for (const rows of [result.translatedUtterances, result.dubSegments]) {
    assert.deepEqual(rows.map(row => [row.segmentId, row.speakerId]), source.utterances.map(row => [row.segmentId, row.speakerId]));
  }
  assert.deepEqual(result.dubSegments.map(row => row.words[0].start), [1.125, 3.625]);
  assert.equal(result.qualityReport.missingDubCount, 0);
  assert.equal(result.qualityReport.generatedDubCount, 2);
  assert.equal(result.qualityReport.alignmentSuccessRate, 1);
  assert.equal(result.subtitles.source_tr.length, 2); assert.equal(result.subtitles.dub_tr.length, 2);
  assert.ok(result.subtitles.source_tr.every(cue => cue.words.length === 0));
  assert.ok(result.subtitles.dub_tr.every(cue => cue.words.length > 0));
}

async function assertNoSecrets(f, value) {
  const diskFiles = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) diskFiles.push(await readFile(filename, 'utf8'));
    }
  }
  await walk(f.directory);
  const serialized = [JSON.stringify(value), ...diskFiles, ...f.logs].join('\n');
  for (const key of secretValues) assert.equal(serialized.includes(key), false, 'credential value cannot enter job/cache/result/log output');
  assert.ok(f.logs.some(entry => entry.includes('media_stage_start')));
  assert.ok(f.logs.some(entry => entry.includes('media_stage_end')));
  assert.equal(f.calls.some(call => new URL(call.url).hostname === 'api.openai.com'), false);
}

test('request-only ElevenLabs plus server Gemini completes the real v4 timestamp pipeline with every canonical segment', async t => {
  const f = await fixture(t);
  const created = await f.jobs.create(f.input, credentials());
  const ready = await settled(f.jobs, created.id);
  assertComplete(ready);
  assert.equal(f.jobs.capabilities(credentials()).configured, true);
  assert.equal(f.jobs.capabilities(credentials()).openAIRequired, false);
  assert.equal(f.jobs.capabilities(credentials()).serverMediaConfigured, false);
  assert.equal((await f.jobs.voices(credentials())).length, 2);
  for (const pathname of ['/v1/speech-to-text', '/v1/text-to-dialogue/with-timestamps']) {
    const requests = f.calls.filter(call => new URL(call.url).pathname === pathname);
    assert.ok(requests.length > 0, pathname);
    assert.ok(requests.every(call => call.elevenKey === browserKey));
  }
  assert.equal(f.calls.some(call => new URL(call.url).pathname === '/v1/forced-alignment'), false);
  assert.deepEqual(ready.result.dubSegments.map(row => row.words[0].end), [1.875, 4.375],
    'native spoken times exclude padding in the fitted two-second audio');
  assert.ok(f.calls.filter(call => new URL(call.url).hostname === 'generativelanguage.googleapis.com')
    .every(call => call.geminiKey === serverGeminiKey));
  await assertNoSecrets(f, ready);
});

test('dubbing-only jobs publish one MP3 asset without four unselected subtitle links', async t => {
  const f = await fixture(t);
  f.input.outputs.subtitles = false;
  const created = await f.jobs.create(f.input, credentials());
  const ready = await settled(f.jobs, created.id);
  assert.equal(ready.state, 'READY', JSON.stringify(ready.error));
  assert.deepEqual(ready.result.subtitles, { source_tr: [], dub_tr: [] });
  assert.ok(ready.result.dubSegments.every(row => row.words.length === 0));
  assert.deepEqual(Object.keys(ready.result.assets), ['mix']);
  assert.match(ready.result.assets.mix.url, /mix\.mp3$/);
  assert.equal(ready.result.assets.mix.mimeType, 'audio/mpeg');
  assert.ok(await f.jobs.artifact(created.id, 'mix.mp3').then(async value => {
    if (!value) return false;
    try { return (await readFile(value.path)).length > 0; }
    finally { value.release(); }
  }));
});

test('request Gemini key takes priority over server Gemini without requiring OpenAI', async t => {
  const f = await fixture(t, { geminiKey: userGeminiKey });
  const created = await f.jobs.create(f.input, credentials(userGeminiKey));
  const ready = await settled(f.jobs, created.id);
  assertComplete(ready);
  const translations = f.calls.filter(call => new URL(call.url).hostname === 'generativelanguage.googleapis.com');
  assert.ok(translations.length > 0 && translations.every(call => call.geminiKey === userGeminiKey));
  await assertNoSecrets(f, ready);
});

test('restart retry must reacquire browser credentials and safely resumes already completed provider stages', async t => {
  const f = await fixture(t, { failAlignmentOnce: true });
  const created = await f.jobs.create(f.input, credentials());
  const failed = await settled(f.jobs, created.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error.code, 'PROVIDER_HTTP_503');
  await assertNoSecrets(f, failed);
  const restarted = f.makeJobs();
  await assert.rejects(restarted.retry(created.id), 'browser credentials are never recovered from the disk job');
  await assert.rejects(restarted.retry(created.id, { elevenLabsApiKey: wrongKey }), 'a different account cannot own this retry');
  const counts = pathname => f.calls.filter(call => new URL(call.url).pathname === pathname).length;
  const before = { scribe: counts('/v1/speech-to-text'), synth: counts('/v1/text-to-dialogue/with-timestamps'),
    translate: f.calls.filter(call => new URL(call.url).hostname === 'generativelanguage.googleapis.com').length };
  await restarted.retry(created.id, credentials());
  const ready = await settled(restarted, created.id);
  assertComplete(ready);
  assert.equal(counts('/v1/speech-to-text'), before.scribe);
  assert.equal(counts('/v1/text-to-dialogue/with-timestamps'), before.synth);
  assert.equal(f.calls.filter(call => new URL(call.url).hostname === 'generativelanguage.googleapis.com').length, before.translate);
  await assertNoSecrets(f, ready);
});

test('a wrong browser ElevenLabs key cannot restore another account final-package cache for the same source', async t => {
  const f = await fixture(t);
  const first = await f.jobs.create(f.input, credentials());
  const ready = await settled(f.jobs, first.id); assertComplete(ready);
  const before = f.calls.length;
  let denied;
  try {
    const created = await f.jobs.create(f.input, { elevenLabsApiKey: wrongKey });
    denied = await settled(f.jobs, created.id);
  } catch (error) { denied = { state: 'FAILED', error }; }
  assert.equal(denied.state, 'FAILED', 'a source-only cache key must not bypass request account validation');
  assert.equal(denied.result, undefined);
  assert.ok(f.calls.slice(before).some(call => call.elevenKey === wrongKey), 'the new account reaches provider authentication instead of another account cache');
  assertComplete(await f.jobs.get(first.id));
  await assertNoSecrets(f, denied);
});
