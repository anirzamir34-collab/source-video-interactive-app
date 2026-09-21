import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { dialogueUploadLimit, MAX_VIDEO_BYTES } from '../public/media-limits.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { selectExtractorSource, videoErrorDiagnostic } from '../lib/video-url.js';
import { uniqueTimedSpeech, normalizeDialogueSegments } from '../public/dialogue-integrity.js';

// Execute the production handlers with real streams and temporary files;
// upstream providers and the transcoder are replaced to avoid paid calls.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
class ResponseStream extends PassThrough {
  statusCode = 200;
  headers = {};
  headersSent = false;
  chunks = [];
  constructor() { super(); this.on('data', chunk => { this.headersSent = true; this.chunks.push(chunk); }); }
  status(code) { this.statusCode = code; return this; }
  setHeader(key, value) { this.headers[key] = value; }
  setTimeout(ms, callback) { this.idleTimeout = { ms, callback }; }
  json(body) { this.jsonBody = body; this.end(JSON.stringify(body)); return this; }
}
function fixture(code, overrides = {}) {
  const routes = new Map();
  const timers = new Set();
  const errors = [];
  const scope = vm.createContext({
    Buffer, URL, AbortController, AbortSignal, FormData, Blob, Date, uniqueTimedSpeech, normalizeDialogueSegments,
    fs, Readable, pipeline, resolvedVideoSessions: new Map(), dialogueUploadSessions: new Map(),
    dialogueChunkParser() {}, upload: { single: () => () => {} },
    multer: { MulterError: class extends Error {} },
    app: { get: (url, ...handlers) => routes.set(url, handlers.at(-1)), post: (url, ...handlers) => routes.set(url, handlers.at(-1)) },
    setTimeout: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    validatePublicUrl: async value => new URL(value),
    ...overrides
  });
  vm.runInContext(code, scope);
  return { scope, routes, timers, errors };
}
const proxyCode = section("app.get('/api/video-proxy'", '\n\nconst dialogueUpload');
function proxyFixture(overrides) {
  const f = fixture(proxyCode, overrides);
  const req = Object.assign(new EventEmitter(), { query: { url: 'https://example.com/video.mp4' }, headers: {} });
  const res = new ResponseStream();
  return { ...f, req, res, run: () => f.routes.get('/api/video-proxy')(req, res) };
}

test('malformed cookie cannot crash login or authenticated route middleware', () => {
  const f = fixture(section('function readCookie(', '\nfunction isAuthenticated('));
  assert.equal(f.scope.readCookie({ headers: { cookie: 'videoquest_owner=%E0%A4%A' } }, 'videoquest_owner'), '');
  assert.equal(f.scope.readCookie({ headers: { cookie: 'other=x; videoquest_owner=hello%3Dworld' } }, 'videoquest_owner'), 'hello=world');
});

test('Eleven v3 delivery keeps neutral lines clean and maps grounded emotion conservatively', () => {
  const f = fixture(section('function elevenV3DeliveryTag(', '\n\nasync function elevenLabsSynthesize('));
  assert.equal(f.scope.elevenV3DeliveryTag('uncertain'), '');
  assert.equal(f.scope.elevenV3DeliveryTag('neutral'), '');
  assert.equal(f.scope.elevenV3DeliveryTag('excited'), '[excited]');
  assert.equal(f.scope.elevenV3DeliveryTag('soft and relaxed'), '[softly]');
  assert.equal(f.scope.elevenV3DeliveryTag('unrecognized-state'), '');
  assert.match(source, /model_id:\s*'eleven_v3'/);
  assert.match(source, /stability:\s*0\.5/);
  assert.doesNotMatch(section('async function elevenLabsSynthesize(', '\n\nfunction elevenLabsErrorResponse('), /previous_text|next_text/);
  assert.doesNotMatch(source, /model_id:\s*'eleven_multilingual_v2'/);
});

test('ElevenLabs voice pages are combined and cached without dropping later speakers', async () => {
  const calls = [];
  const female = { voice_id: 'f', labels: { gender: 'female' }, description: 'German human narration' };
  const male = { voice_id: 'm', labels: { gender: 'male' } };
  const f = fixture(section('function elevenVoiceGender(', '\nasync function elevenLabsSubscription('), {
    crypto, URLSearchParams, elevenLabsVoiceCache: new Map(),
    elevenLabsRequest: async (_key, url) => {
      calls.push(url);
      return { json: async () => calls.length === 1
        ? { voices: [female], has_more: true, next_page_token: 'page two' }
        : { voices: [female, male], has_more: false } };
    }
  });
  const catalog = await f.scope.elevenLabsVoices('fake-key');
  assert.equal(catalog.voices.length, 2);
  assert.equal(new URL('https://example.com' + calls[1]).searchParams.get('next_page_token'), 'page two');
  assert.equal(f.scope.elevenVoiceGender(female), 'female');
  assert.equal(f.scope.elevenVoiceGender({ description: 'German human narrator' }), 'uncertain');
  assert.equal(await f.scope.elevenLabsVoices('fake-key'), catalog);
  assert.equal(calls.length, 2);
});

test('four speakers use their assigned voices even for identical text; cache never crosses voices', async () => {
  const calls = [];
  const voices = ['one', 'two', 'three', 'four'].map(voice_id => ({ voice_id, name: voice_id }));
  const f = fixture(section('function elevenV3DeliveryTag(', '\n\nfunction elevenLabsErrorResponse('), {
    crypto, elevenLabsAudioCache: new Map(), elevenLabsAudioInflight: new Map(),
    ELEVENLABS_AUDIO_CACHE_TTL_MS: 60000, pruneElevenLabsAudioCache() {},
    elevenLabsVoices: async () => ({ voices }),
    elevenLabsRequest: async (_key, url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { arrayBuffer: async () => Buffer.from(url) };
    }
  });
  const synthesize = voiceId => f.scope.elevenLabsSynthesize({ apiKey: 'fake-key', text: 'Merhaba.', voiceId });
  const output = await Promise.all(voices.map(voice => synthesize(voice.voice_id)));
  assert.equal(new Set(output.map(row => row.audioBase64)).size, 4);
  for (let i = 0; i < output.length; i++) {
    assert.equal(output[i].voiceId, voices[i].voice_id);
    assert.match(calls[i].url, new RegExp(`/text-to-speech/${voices[i].voice_id}\\?`));
    assert.equal(calls[i].body.language_code, 'tr');
    assert.equal(calls[i].body.model_id, 'eleven_v3');
  }
  assert.equal((await synthesize('one')).cacheHit, true);
  assert.equal(calls.length, 4);
  await assert.rejects(synthesize('removed-voice'), { code: 'ELEVENLABS_VOICE_PLAN_UNAVAILABLE' });
  assert.equal(calls.length, 4);
});

test('remote dialogue audio uses compact speech-optimized MP3 settings', () => {
  const f = fixture(section('function remoteDialogueFfmpegArgs(', '\n\nasync function prepareRemoteDialogueAudio('));
  const args = f.scope.remoteDialogueFfmpegArgs({
    sourceUrl: 'https://example.com/video.mp4',
    referer: 'https://example.com/watch',
    userAgent: 'test-agent'
  }, '/tmp/dialogue.mp3', 600);
  assert.deepEqual(Array.from(args.slice(args.indexOf('-map'))), [
    '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1',
    '/tmp/dialogue.mp3'
  ]);
  assert.ok(args.includes('605'));
});

test('expired video token returns 410 without contacting any upstream', async () => {
  const f = proxyFixture({ fetchPublicUrl: () => assert.fail('expired token must not fetch') });
  f.req.query = { token: 'expired', url: 'https://example.com/ignored.mp4' };
  f.scope.resolvedVideoSessions.set('expired', { sourceUrl: 'https://example.com/video.mp4', expiresAt: 1 });
  await f.run(); await tick();
  assert.equal(f.res.statusCode, 410);
  assert.equal(f.res.jsonBody.reason, 'VIDEO_SESSION_EXPIRED');
  assert.equal(f.timers.size, 0);
});

test('disconnect before video headers aborts fetch and does not send a second response', async () => {
  let signal;
  const f = proxyFixture({ fetchPublicUrl: (_url, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = f.run();
  f.res.destroy(); await pending; await tick();
  assert.equal(signal.aborted, true);
  assert.equal(f.res.jsonBody, undefined);
  assert.equal(f.errors.length, 0);
  assert.equal(f.timers.size, 0);
});

test('video header deadline returns a retryable HTTP gateway timeout', async () => {
  const f = proxyFixture({ fetchPublicUrl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = f.run();
  [...f.timers].find(timer => timer.ms === 30000).callback();
  await pending; await tick();
  assert.equal(f.res.statusCode, 504);
  assert.equal(f.res.jsonBody.reason, 'VIDEO_SOURCE_TIMEOUT');
  assert.equal(f.timers.size, 0);
});

test('range response keeps its status and bytes, and releases its deadline', async () => {
  const f = proxyFixture({ fetchPublicUrl: async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=2-4');
    assert.equal(options.headers['If-Range'], '"same-version"');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return { response: new Response('cde', { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3' } }) };
  } });
  f.req.headers.range = 'bytes=2-4';
  f.req.headers['if-range'] = '"same-version"';
  await f.run(); await tick();
  assert.equal(f.res.statusCode, 206);
  assert.equal(f.res.headers['content-range'], 'bytes 2-4/10');
  assert.equal(Buffer.concat(f.res.chunks).toString(), 'cde');
  assert.equal(f.timers.size, 0);
});

test('closing a playing stream cancels upstream without treating cancellation as source failure', async () => {
  let cancelled = false;
  const f = proxyFixture({ fetchPublicUrl: async () => ({ response: new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancelled = true; }
  })) }) });
  await f.run(); await tick();
  f.res.destroy(); await tick();
  assert.equal(cancelled, true);
  assert.equal(f.errors.length, 0);
});

test('real upstream stream errors remain observable and close downstream', async () => {
  let controller;
  const f = proxyFixture({ fetchPublicUrl: async () => ({ response: new Response(new ReadableStream({ start(value) { controller = value; } })) }) });
  await f.run();
  controller.error(new Error('source disconnected'));
  await tick();
  assert.equal(f.res.destroyed, true);
  assert.equal(f.errors.length, 1);
});

test('HLS follows response lifetime, not the completed incoming GET request', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const killed = [];
  child.kill = signal => { killed.push(signal); child.signalCode = signal; queueMicrotask(() => child.emit('close', null)); };
  let args;
  const f = proxyFixture({ ffmpegPath: '/fake/ffmpeg', spawn: (_bin, value) => { args = value; return child; } });
  f.req.query.url = 'https://example.com/video.m3u8';
  await f.run();
  f.req.emit('close');
  assert.deepEqual(killed, []);
  assert.ok(args.includes('-rw_timeout'));
  f.res.destroy(); await tick();
  assert.deepEqual(killed, ['SIGTERM']);
  assert.equal(f.timers.size, 0);
});

test('HLS rejects an invalid source before spawning any process', async () => {
  const f = proxyFixture({ validatePublicUrl: async () => { throw Error('blocked'); }, spawn: () => assert.fail('must not spawn') });
  f.req.query.url = 'http://localhost/private.m3u8';
  await f.run(); await tick();
  assert.equal(f.res.statusCode, 502);
});

test('site extractor keeps referer, provider budget and cancellation without requiring optional impersonation', async () => {
  const calls = [];
  const f = fixture(section('async function resolveWithSiteExtractor(', "\napp.post('/api/resolve-video-url'"), {
    selectExtractorSource,
    runVideoExtractor: async (url, options, processOptions) => {
      calls.push({ url, options, processOptions });
      return { url: 'https://cdn.test/video.mp4', vcodec: 'h264', acodec: 'aac' };
    }
  });
  const signal = new AbortController().signal;
  const result = await f.scope.resolveWithSiteExtractor('https://vk.com/video_ext.php?oid=-1&id=2', {
    referer: 'https://site.test/watch', signal, timeoutMs: 45000
  });
  assert.equal(result.sourceUrl, 'https://cdn.test/video.mp4');
  assert.equal(calls.length, 1);
  for (const call of calls) {
    assert.equal(call.options.referer, 'https://site.test/watch');
    assert.equal(call.processOptions.signal, signal);
    assert.equal(call.processOptions.timeoutMs, 45000);
    assert.equal(call.options.impersonate, undefined);
    assert.equal(call.options.playlistEnd, 5);
  }
});

test('site extractor does not retry a denied source or run on a private URL', async () => {
  let calls = 0;
  const code = section('async function resolveWithSiteExtractor(', "\napp.post('/api/resolve-video-url'");
  const f = fixture(code, { selectExtractorSource, videoErrorDiagnostic, runVideoExtractor: async () => { calls++; throw Error('HTTP 403 forbidden'); } });
  await assert.rejects(f.scope.resolveWithSiteExtractor('https://site.test/watch'), /403/);
  assert.equal(calls, 1);
  const blocked = fixture(code, {
    validatePublicUrl: async () => { throw Error('private address'); },
    runVideoExtractor: () => assert.fail('must not start')
  });
  await assert.rejects(blocked.scope.resolveWithSiteExtractor('http://localhost/video'), /private address/);
});

test('configured source probe is opt-in, time-limited, validated and does not log its URL', async () => {
  const code = section('async function runConfiguredVideoProbe()', '\napp.listen(');
  for (const until of [undefined, '0', String(Date.now() - 1000), String(Date.now() + 3600000)]) {
    const process = { env: { VIDEO_RESOLUTION_PROBE_URL: 'https://site.test/video?list=private', VIDEO_RESOLUTION_PROBE_UNTIL: until } };
    const f = fixture(code, { process, resolvePublicVideoPage: () => assert.fail('disabled probe must not run') });
    await f.scope.runConfiguredVideoProbe();
    assert.equal(process.env.VIDEO_RESOLUTION_PROBE_URL, undefined);
  }
  const messages = [];
  let validations = 0, calls = 0;
  const process = { env: { VIDEO_RESOLUTION_PROBE_URL: 'https://site.test/video?list=private', VIDEO_RESOLUTION_PROBE_UNTIL: String(Date.now() + 60000) } };
  const f = fixture(code, {
    process, videoErrorDiagnostic,
    validatePublicUrl: async () => { validations++; },
    resolvePublicVideoPage: async () => { calls++; return { type: 'video' }; },
    console: { log: (...args) => messages.push(args), warn: (...args) => messages.push(args) }
  });
  await f.scope.runConfiguredVideoProbe();
  await f.scope.runConfiguredVideoProbe();
  assert.equal(validations, 1);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(messages), /private|https:|list=/);
});

test('redirect responses are cancelled and caller cancellation survives redirects', async () => {
  const abort = new AbortController();
  let cancelled = 0;
  let calls = 0;
  const f = fixture(section('async function fetchPublicUrl(', '\nasync function probeVideoCandidate('), {
    normalizeAmpUrl: value => value,
    fetch: async (_url, options) => {
      calls++;
      assert.equal(options.signal.aborted, false);
      return { status: 302, headers: new Headers({ location: '/next' }), body: { cancel: async () => { cancelled++; abort.abort(); } } };
    }
  });
  await assert.rejects(f.scope.fetchPublicUrl('https://example.com', { signal: abort.signal, timeoutMs: 0 }));
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

const chunkCode = section("app.post(\n  '/api/dialogue-upload/:uploadId/chunk'", '\nsetInterval(');
async function chunkFixture(t, fsOverride) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vq-stability-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'upload.part');
  await fs.promises.writeFile(filePath, '');
  const f = fixture(chunkCode, fsOverride ? { fs: { promises: { ...fs.promises, ...fsOverride } } } : {});
  const session = { filePath, receivedSize: 0, nextChunk: 0, totalSize: 6, updatedAt: 0 };
  f.scope.dialogueUploadSessions.set('upload', session);
  return { ...f, session, send: async (index, data = 'abc') => {
    const res = new ResponseStream();
    await f.routes.get('/api/dialogue-upload/:uploadId/chunk')({ params: { uploadId: 'upload' }, headers: { 'x-chunk-index': index }, body: Buffer.from(data) }, res);
    return res;
  } };
}

test('simultaneous retries write a chunk once; completed duplicates remain idempotent', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await chunkFixture(t, { appendFile: async (...args) => { await gate; return fs.promises.appendFile(...args); } });
  const first = f.send(0);
  const overlap = await f.send(0);
  assert.equal(overlap.statusCode, 409);
  assert.equal(overlap.jsonBody.reason, 'CHUNK_WRITE_IN_PROGRESS');
  release(); await first;
  const duplicate = await f.send(0);
  assert.equal(duplicate.jsonBody.duplicate, true);
  assert.equal(await fs.promises.readFile(f.session.filePath, 'utf8'), 'abc');
  assert.equal(f.session.receivedSize, 3);
});

test('failed append rolls back partially written bytes before a successful retry', async t => {
  let fail = true;
  const f = await chunkFixture(t, { appendFile: async (file, data) => {
    if (fail) { fail = false; await fs.promises.appendFile(file, data.subarray(0, 1)); throw Error('disk write interrupted'); }
    await fs.promises.appendFile(file, data);
  } });
  assert.equal((await f.send(0)).statusCode, 500);
  assert.equal((await fs.promises.stat(f.session.filePath)).size, 0);
  assert.equal(f.session.writing, false);
  assert.equal((await f.send(0)).statusCode, 200);
  assert.equal((await f.send(1, 'def')).jsonBody.complete, true);
  assert.equal(await fs.promises.readFile(f.session.filePath, 'utf8'), 'abcdef');
});

test('empty, out-of-order and oversized chunks never mutate upload state', async t => {
  const f = await chunkFixture(t);
  assert.equal((await f.send(0, '')).statusCode, 409);
  assert.equal((await f.send(2)).statusCode, 409);
  assert.equal((await f.send(0, '1234567')).statusCode, 400);
  assert.equal(f.session.nextChunk, 0);
  assert.equal((await fs.promises.stat(f.session.filePath)).size, 0);
});

test('request errors consistently return JSON with safe status codes', () => {
  const f = fixture(section('function handleRequestError(', '\napp.use(handleRequestError)'));
  for (const [error, status, reason] of [
    [{ code: 'LIMIT_FILE_SIZE' }, 413, 'UPLOAD_TOO_LARGE'],
    [{ type: 'entity.too.large' }, 413, 'UPLOAD_TOO_LARGE'],
    [{ type: 'entity.parse.failed' }, 400, 'INVALID_REQUEST'],
    [{ message: 'UNSUPPORTED_VIDEO_FORMAT' }, 415, 'UNSUPPORTED_VIDEO_FORMAT'],
    [new Error('secret-internal-path'), 500, 'INTERNAL_ERROR']
  ]) {
    const res = new ResponseStream();
    f.scope.handleRequestError(error, {}, res, () => assert.fail('should respond'));
    assert.equal(res.statusCode, status);
    assert.equal(res.jsonBody.reason, reason);
    assert.ok(!JSON.stringify(res.jsonBody).includes('secret-internal-path'));
  }
});

test('external analysis streams the temporary upload and removes it after success or failure', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vq-external-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  for (const fail of [false, true]) {
    const file = path.join(dir, `video-${fail}`);
    await fs.promises.writeFile(file, 'ordinary test content');
    const f = fixture(section("app.post('/api/external-analyze'", '// PUBLIC VIDEO URL RESOLVER'), {
      EXTERNAL_ANALYSIS_URL: 'https://example.com', readJsonSafe: response => response.json(),
      fetch: async (_url, { body }) => {
        assert.equal(await body.get('video').text(), 'ordinary test content');
        if (fail) throw Error('upstream unavailable');
        return new Response('{"available":true}');
      }
    });
    const res = new ResponseStream();
    await f.routes.get('/api/external-analyze')({ file: { path: file, mimetype: 'video/mp4', originalname: 'test.mp4' } }, res);
    assert.equal(res.statusCode, fail ? 503 : 200);
    assert.equal(fs.existsSync(file), false);
  }
});


test('chunked video upload accepts up to 2 GiB but rejects oversized audio and video before disk creation', async () => {
  const sessions = new Map();
  let writes = 0;
  const f = fixture(section("app.post('/api/dialogue-upload/start'", "app.post(\n  '/api/dialogue-upload/:uploadId/chunk'"), {
    dialogueUploadLimit, crypto: { randomUUID: () => 'large-video' }, dialogueUploadSessions: sessions,
    fs: { promises: { async mkdir() {}, async writeFile() { writes++; } } }
  });
  const handler = f.routes.get('/api/dialogue-upload/start');
  for (const size of [700 * 1024 * 1024, MAX_VIDEO_BYTES]) {
    const res = new ResponseStream();
    await handler({ body: { totalSize: size, mimeType: 'video/mp4', fileName: 'large.mp4' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(sessions.get('large-video').totalSize, size);
  }
  assert.equal(writes, 2);
  for (const [mimeType, totalSize] of [['video/mp4', MAX_VIDEO_BYTES + 1], ['audio/wav', 251 * 1024 * 1024], ['text/html', 20]]) {
    const res = new ResponseStream();
    await handler({ body: { mimeType, totalSize } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(writes, 2);
});

test('repeated provider annotation steps do not duplicate words or erase later real repetitions', () => {
  const f = fixture(section('function parseGeminiOffsetSeconds(', '\nasync function transcribeDialogueGemini35('));
  const annotation = { type: 'word_info', speaker: 'a', text: 'Hello', start_offset: '1s', end_offset: '1.4s' };
  const words = f.scope.extractTranscribeWordAnnotations({ steps: [
    { content: [{ annotations: [annotation] }] },
    { content: [{ annotations: [annotation, { ...annotation, speaker: 'b' },
      { ...annotation, start_offset: '2s', end_offset: '2.4s' }] }] }
  ] });
  assert.deepEqual(Array.from(words, word => [word.speakerId, word.startTime]), [['a', 1], ['b', 1], ['a', 2]]);
});

test('overlapping word annotations preserve separate sentences while consecutive turns stay separate', () => {
  const f = fixture(section('function groupTranscribeWords(', '\nasync function transcribeDialogueGemini35('));
  const words = [
    { speakerId: 'a', text: 'Merhaba', startTime: 0, endTime: 0.6 },
    { speakerId: 'b', text: 'İyi', startTime: 0.3, endTime: 0.9 },
    { speakerId: 'a', text: 'Elif.', startTime: 0.7, endTime: 1.2 },
    { speakerId: 'b', text: 'akşamlar.', startTime: 1, endTime: 1.5 }
  ];
  const groups = f.scope.groupTranscribeWords(words);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].originalText, 'Merhaba Elif.');
  assert.equal(groups[1].originalText, 'İyi akşamlar.');
  assert.equal(groups[0].endTime, 1.2);
  const turns = f.scope.groupTranscribeWords([
    { speakerId: 'a', text: 'Selam', startTime: 0, endTime: 0.2 },
    { speakerId: 'b', text: 'Merhaba', startTime: 0.3, endTime: 0.4 },
    { speakerId: 'a', text: 'Nasılsın?', startTime: 0.5, endTime: 0.7 }
  ]);
  assert.equal(turns.length, 3);
});
