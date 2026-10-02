import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { MAX_VIDEO_BYTES } from '../public/media-limits.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { selectExtractorSource, videoErrorDiagnostic } from '../lib/video-url.js';
import { createMediaUploads } from '../lib/turkish-media/uploads.js';
import { installTurkishMediaRoutes } from '../lib/turkish-media/routes.js';
import { MediaError } from '../lib/turkish-media/errors.js';

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
    Buffer, URL, AbortController, AbortSignal, FormData, Blob, Date,
    fs, Readable, pipeline, resolvedVideoSessions: new Map(),
    upload: { single: () => () => {} },
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
const proxyCode = section("app.get('/api/video-proxy'", '\n\n// TURKISH MEDIA JOBS');
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

async function uploadFixture(t, options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vq-new-uploads-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return { directory, uploads: createMediaUploads({ directory, ...options }),
    input: { totalSize: 6, chunkSize: 3, fileName: 'source.mp4', mimeType: 'video/mp4', clientUploadKey: 'device-source' } };
}

test('concurrent upload starts share one disk session and restart resumes acknowledged chunks', async t => {
  const f = await uploadFixture(t);
  const starts = await Promise.all([f.uploads.start(f.input), f.uploads.start(f.input)]);
  assert.equal(starts[0].uploadId, starts[1].uploadId);
  assert.equal(starts[1].reused, true);
  await f.uploads.writeChunk(starts[0].uploadId, 0, Buffer.from('abc'));
  const restarted = createMediaUploads({ directory: f.directory });
  const resumed = await restarted.start(f.input);
  assert.equal(resumed.uploadId, starts[0].uploadId);
  assert.deepEqual(resumed.receivedChunks, [0]);
  assert.equal(resumed.complete, false);
  await restarted.writeChunk(resumed.uploadId, 1, Buffer.from('def'));
  const source = await restarted.source(resumed.uploadId);
  assert.equal(await fs.promises.readFile(source.path, 'utf8'), 'abcdef');
  assert.equal(source.hash, crypto.createHash('sha256').update('abcdef').digest('hex'));
  assert.deepEqual((await createMediaUploads({ directory: f.directory }).status(resumed.uploadId)).receivedChunks, [0, 1]);
});

test('simultaneous chunk retries publish once and conflicting duplicate bytes are rejected', async t => {
  const f = await uploadFixture(t);
  const { uploadId } = await f.uploads.start(f.input);
  const results = await Promise.all([f.uploads.writeChunk(uploadId, 0, Buffer.from('abc')),
    f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'))]);
  assert.equal(results.filter(row => row.duplicate).length, 1);
  assert.equal(results[1].receivedSize, 3);
  await assert.rejects(f.uploads.writeChunk(uploadId, 0, Buffer.from('xyz')), { code: 'CHUNK_ID_CONFLICT', status: 409 });
  await f.uploads.writeChunk(uploadId, 1, Buffer.from('def'));
  assert.equal((await f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'))).complete, true);
  await assert.rejects(f.uploads.writeChunk(uploadId, 1, Buffer.from('bad')), { code: 'CHUNK_ID_CONFLICT' });
});

test('out-of-order delivery writes deterministic source offsets without holes or overlapping ranges', async t => {
  const f = await uploadFixture(t);
  const { uploadId } = await f.uploads.start(f.input);
  assert.equal((await f.uploads.writeChunk(uploadId, 1, Buffer.from('def'))).complete, false);
  await assert.rejects(f.uploads.source(uploadId), { code: 'UPLOAD_INCOMPLETE' });
  assert.equal((await f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'))).complete, true);
  assert.equal(await fs.promises.readFile((await f.uploads.source(uploadId)).path, 'utf8'), 'abcdef');
});

test('short writes are completed; zero-byte failure cleans partial data before retry', async t => {
  let fail = true;
  const fsImpl = { ...fs.promises, async open(filename, ...options) {
    const handle = await fs.promises.open(filename, ...options);
    if (!path.basename(filename).startsWith('chunk-')) return handle;
    return { sync: () => handle.sync(), close: () => handle.close(), write: async (buffer, offset, length, position) => {
      if (fail && position > 0) { fail = false; return { bytesWritten: 0 }; }
      return handle.write(buffer, offset, Math.min(1, length), position);
    } };
  } };
  const f = await uploadFixture(t, { fsImpl });
  const { uploadId } = await f.uploads.start(f.input);
  await assert.rejects(f.uploads.writeChunk(uploadId, 0, Buffer.from('abc')), { code: 'CHUNK_SHORT_WRITE' });
  assert.deepEqual((await f.uploads.status(uploadId)).receivedChunks, []);
  assert.deepEqual(await fs.promises.readdir(path.join(f.directory, uploadId)), ['upload.json']);
  await f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'));
  await f.uploads.writeChunk(uploadId, 1, Buffer.from('def'));
  assert.equal(await fs.promises.readFile((await f.uploads.source(uploadId)).path, 'utf8'), 'abcdef');
});

test('aborted chunks and failed metadata publication never acknowledge partial source bytes', async t => {
  const f = await uploadFixture(t);
  const { uploadId } = await f.uploads.start(f.input);
  await assert.rejects(f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'), { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  let fail = true;
  const store = createMediaUploads({ directory: f.directory, fsImpl: { ...fs.promises, async rename(from, to) {
    if (to.endsWith('upload.json') && fail) { fail = false; throw new Error('publication failed'); }
    return fs.promises.rename(from, to);
  } } });
  await assert.rejects(store.writeChunk(uploadId, 0, Buffer.from('abc')), /publication failed/);
  assert.deepEqual((await store.status(uploadId)).receivedChunks, []);
  assert.deepEqual(await fs.promises.readdir(path.join(f.directory, uploadId)), ['upload.json']);
  assert.equal((await store.writeChunk(uploadId, 0, Buffer.from('abc'))).receivedSize, 3);
});

test('failed initialization releases the device key reservation for a fresh retry', async t => {
  let fail = true;
  const f = await uploadFixture(t, { fsImpl: { ...fs.promises, async rename(...args) {
    if (fail) { fail = false; throw new Error('disk initialization failed'); }
    return fs.promises.rename(...args);
  } } });
  await assert.rejects(f.uploads.start(f.input), /disk initialization failed/);
  assert.deepEqual(await fs.promises.readdir(f.directory), ['keys']);
  assert.equal((await f.uploads.start(f.input)).reused, false);
});

test('uploads enforce the shared 2 GiB limit and fixed chunk ranges before publishing data', async t => {
  const f = await uploadFixture(t);
  assert.equal((await f.uploads.start({ ...f.input, totalSize: MAX_VIDEO_BYTES })).totalSize, MAX_VIDEO_BYTES);
  await assert.rejects(f.uploads.start({ ...f.input, totalSize: MAX_VIDEO_BYTES + 1 }), { code: 'INVALID_SOURCE_SIZE' });
  await assert.rejects(f.uploads.start({ ...f.input, totalSize: 1.5 }), { code: 'INVALID_SOURCE_SIZE' });
  await assert.rejects(f.uploads.start({ ...f.input, mimeType: 'text/html' }), { code: 'UNSUPPORTED_VIDEO_FORMAT' });
  const { uploadId } = await f.uploads.start({ ...f.input, clientUploadKey: 'small' });
  for (const [index, bytes] of [[0, ''], [2, 'abc'], [0, 'ab'], [0, 'abcd']]) {
    await assert.rejects(f.uploads.writeChunk(uploadId, index, Buffer.from(bytes)));
  }
  assert.deepEqual((await f.uploads.status(uploadId)).receivedChunks, []);
  await assert.rejects(f.uploads.start({ ...f.input, clientUploadKey: 'small', chunkSize: 2 }), { code: 'UPLOAD_KEY_CONFLICT' });
  const files = await fs.promises.readdir(path.join(f.directory, 'keys'));
  assert.ok(files.every(name => /^[a-f0-9]{64}\.json$/.test(name)), 'raw client keys are never filenames');
});

test('active source leases prevent 24-hour eviction and release refreshes its retry lifetime', async t => {
  let now = 1000;
  const f = await uploadFixture(t, { clock: () => now });
  const { uploadId } = await f.uploads.start(f.input);
  await f.uploads.writeChunk(uploadId, 0, Buffer.from('abc'));
  await f.uploads.writeChunk(uploadId, 1, Buffer.from('def'));
  const source = await f.uploads.source(uploadId);
  const release = await f.uploads.acquireLeaseByPath(source.path);
  now += 86400001;
  await f.uploads.removeExpired();
  assert.equal((await f.uploads.status(uploadId)).complete, true);
  await release(); await release();
  now += 86399000;
  await f.uploads.removeExpired();
  assert.equal((await f.uploads.status(uploadId)).complete, true);
  now += 2000;
  await f.uploads.removeExpired();
  assert.equal(await f.uploads.status(uploadId), null);
  assert.equal(fs.existsSync(source.path), false);
});

function mediaRouteFixture(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const credentialCalls = [];
  const jobs = { capabilities: () => ({ configured: true, fastAvailable: false }),
    voices: async () => [{ voiceId: 'voice-1', name: 'Türkçe ses', gender: 'female', language: 'tr' }],
    create: async (input, credentials) => { calls.push(input); credentialCalls.push(credentials); return { id: 'job', state: 'PREPARING_AUDIO' }; },
    get: async () => ({ id: 'job', state: 'READY', result: { subtitles: {} } }),
    retry: async () => ({ id: 'job', state: 'PREPARING_AUDIO' }), cancel: async () => ({ id: 'job', state: 'CANCELLED' }),
    artifact: async () => null, ...overrides.jobs };
  const app = { get: (url, ...handlers) => routes.set(`GET ${url}`, handlers.at(-1)), post: (url, ...handlers) => routes.set(`POST ${url}`, handlers.at(-1)) };
  installTurkishMediaRoutes(app, { uploads: { start: async value => value, status: async () => null,
    source: async () => ({ path: '/private/source.bin', hash: 'verified-hash' }), ...overrides.uploads },
    jobs, rawParser() {}, secrets: ['provider-secret'] });
  return { calls, credentialCalls, async request(method, url, body = {}, params = {}, res = new ResponseStream(), headers = {}, query = {}, rawHeaders) {
    const req = Object.assign(new EventEmitter(), { body, params, headers, query, rawHeaders });
    await routes.get(`${method} /api/turkish-media${url}`)(req, res, error => { throw error; });
    return res;
  } };
}

test('job routes use server source bytes, preserve output modes and return the create/retry DTO', async () => {
  const f = mediaRouteFixture();
  const created = await f.request('POST', '/jobs', { uploadId: 'upload', source: { path: '/untrusted' }, duration: 9999,
    outputs: { dub: true, subtitles: true } });
  assert.equal(created.statusCode, 202); assert.equal(created.jsonBody.jobId, 'job');
  assert.deepEqual(f.calls[0].source, { path: '/private/source.bin', hash: 'verified-hash' });
  assert.equal(f.calls[0].source.duration, undefined);
  await f.request('POST', '/jobs', { uploadId: 'upload', outputs: { transcriptOnly: true } });
  assert.deepEqual(f.calls[1].outputs, { dub: false, subtitles: false, transcriptOnly: true });
  const retry = await f.request('POST', '/jobs/:id/retry', {}, { id: 'job' });
  assert.equal(retry.statusCode, 202); assert.equal(retry.jsonBody.jobId, 'job');
  const result = await f.request('GET', '/jobs/:id/result', {}, { id: 'job' });
  assert.deepEqual(result.jsonBody, { subtitles: {} });
});

test('provider headers travel separately from persisted job input and body/query keys are ignored', async () => {
  const elevenKey = 'browser-eleven-route-test-123456';
  const geminiKey = 'browser-gemini-route-test-123456';
  const headers = { 'x-elevenlabs-api-key': elevenKey, 'x-gemini-api-key': geminiKey };
  const seen = [];
  const f = mediaRouteFixture({ jobs: {
    capabilities: credentials => { seen.push(['capabilities', credentials]); return { configured: true }; },
    voices: async credentials => { seen.push(['voices', credentials]); return []; },
    retry: async (id, credentials) => { seen.push([id, credentials]); return { id, state: 'PREPARING_AUDIO' }; },
  } });
  await f.request('POST', '/jobs', { uploadId: 'upload', apiKey: elevenKey, elevenLabsApiKey: elevenKey,
    geminiApiKey: geminiKey, credentials: headers }, {}, new ResponseStream(), headers);
  assert.deepEqual(f.credentialCalls[0], { elevenLabsApiKey: elevenKey, geminiApiKey: geminiKey });
  assert.doesNotMatch(JSON.stringify(f.calls[0]), /browser-eleven|browser-gemini|apiKey|credentials/);
  await f.request('GET', '/capabilities', {}, {}, new ResponseStream(), headers);
  await f.request('GET', '/voices', {}, {}, new ResponseStream(), headers);
  await f.request('POST', '/jobs/:id/retry', {}, { id: 'job' }, new ResponseStream(), headers);
  assert.deepEqual(seen.map(row => row[1]), Array(3).fill({ elevenLabsApiKey: elevenKey, geminiApiKey: geminiKey }));
  await f.request('POST', '/jobs', { uploadId: 'upload', elevenLabsApiKey: elevenKey }, {}, new ResponseStream(), {}, { 'x-elevenlabs-api-key': elevenKey });
  assert.deepEqual(f.credentialCalls[1], {});
});

test('invalid supplied provider headers fail before source access and never fall back silently', async () => {
  let sourceCalls = 0;
  const f = mediaRouteFixture({ uploads: { source: async () => { sourceCalls++; return { path: '/private/source.bin' }; } } });
  for (const key of ['short', ' ', 'x'.repeat(1025), 'valid-looking-key-123456 with-space', ['valid-looking-key-123456']]) {
    const response = await f.request('POST', '/jobs', { uploadId: 'upload' }, {}, new ResponseStream(), { 'x-elevenlabs-api-key': key });
    assert.equal(response.statusCode, 400); assert.equal(response.jsonBody.reason, 'MEDIA_CREDENTIAL_INVALID');
    assert.doesNotMatch(JSON.stringify(response.jsonBody), /valid-looking-key|\/private/);
  }
  const duplicated = await f.request('GET', '/capabilities', {}, {}, new ResponseStream(),
    { 'x-gemini-api-key': 'valid-gemini-key-123456' }, {}, ['x-gemini-api-key', 'valid-gemini-key-123456', 'X-Gemini-Api-Key', 'second-gemini-key-123456']);
  assert.equal(duplicated.statusCode, 400);
  assert.equal(sourceCalls, 0);
});

test('provider errors redact dynamic browser credentials and owned read endpoints need no provider headers', async () => {
  const elevenKey = 'dynamic-eleven-secret-test-123456';
  const geminiKey = 'dynamic-gemini-secret-test-123456';
  const f = mediaRouteFixture({ jobs: { voices: async () => {
    throw new MediaError(`FAIL_${elevenKey}`, `Provider ${elevenKey} and ${geminiKey} rejected`, { status: 401, segmentIds: [geminiKey] });
  } } });
  const error = await f.request('GET', '/voices', {}, {}, new ResponseStream(),
    { 'x-elevenlabs-api-key': elevenKey, 'x-gemini-api-key': geminiKey });
  assert.equal(error.statusCode, 401);
  assert.equal(JSON.stringify(error.jsonBody).includes(elevenKey), false);
  assert.equal(JSON.stringify(error.jsonBody).includes(geminiKey), false);
  for (const route of ['/jobs/:id', '/jobs/:id/result']) {
    const result = await f.request('GET', route, {}, { id: 'job' }, new ResponseStream(), { 'x-elevenlabs-api-key': 'invalid' });
    assert.equal(result.statusCode, 200);
  }
});

test('media route errors and capabilities never expose provider secrets or internal source paths', async () => {
  const f = mediaRouteFixture({ jobs: { create: async () => { throw new MediaError('PROVIDER_ERROR', 'apiKey=provider-secret failure provider-secret'); } } });
  const error = await f.request('POST', '/jobs', { uploadId: 'upload' });
  assert.equal(error.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(error.jsonBody), /provider-secret|\/private/);
  const capabilities = await f.request('GET', '/capabilities');
  assert.doesNotMatch(JSON.stringify(capabilities.jsonBody), /provider-secret|apiKey|authorization/);
  const broken = mediaRouteFixture({ jobs: { create: async () => { throw new Error('provider-secret /private/source.bin'); } } });
  assert.doesNotMatch(JSON.stringify((await broken.request('POST', '/jobs', { uploadId: 'upload' })).jsonBody), /provider-secret|\/private/);
});

test('voice catalog routes return safe backend metadata and normal redacted provider errors', async () => {
  const f = mediaRouteFixture();
  const result = await f.request('GET', '/voices');
  assert.deepEqual(result.jsonBody, { voices: [{ voiceId: 'voice-1', name: 'Türkçe ses', gender: 'female', language: 'tr' }] });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(result.jsonBody), /apiKey|provider-secret|authorization/i);
  const failed = mediaRouteFixture({ jobs: { voices: async () => { throw new MediaError('VOICE_CATALOG_UNAVAILABLE', 'provider-secret unavailable', { status: 503 }); } } });
  const error = await failed.request('GET', '/voices');
  assert.equal(error.statusCode, 503); assert.equal(error.jsonBody.reason, 'VOICE_CATALOG_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(error.jsonBody), /provider-secret/);
});

test('job routes accept bounded manual voice IDs and refuse malformed mappings before source access', async () => {
  let sourceCalls = 0;
  const f = mediaRouteFixture({ uploads: { source: async () => { sourceCalls++; return { path: '/private/source.bin' }; } } });
  await f.request('POST', '/jobs', { uploadId: 'upload', voiceMapping: { 'speaker-source-001': 'voice-1' }, previousVoiceMapping: { 'speaker-source-002': 'voice-2' } });
  assert.deepEqual(f.calls[0].voiceMapping, { 'speaker-source-001': 'voice-1' });
  assert.deepEqual(f.calls[0].previousVoiceMapping, { 'speaker-source-002': 'voice-2' });
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`speaker-${index}`, `voice-${index}`]));
  for (const mapping of [null, [], 'voice-1', { 'speaker-1': 42 }, { 'speaker-1': {} },
    { 'speaker-1': 'x'.repeat(129) }, { 'speaker-1': '../secret' }, JSON.parse('{"__proto__":"voice-1"}'), tooMany]) {
    for (const field of ['voiceMapping', 'previousVoiceMapping']) {
      const result = await f.request('POST', '/jobs', { uploadId: 'upload', [field]: mapping });
      assert.equal(result.statusCode, 400); assert.equal(result.jsonBody.reason, 'VOICE_MAPPING_INVALID');
    }
  }
  assert.equal(sourceCalls, 1);
});

test('browser scene context requires valid source intervals and cannot certify source evidence', async () => {
  const f = mediaRouteFixture();
  const result = await f.request('POST', '/jobs', { uploadId: 'upload', sceneContext: [
    { id: 'scene-1', start: 1.25, end: 3, label: 'Kaynak açıklaması', evidence: 'Sahne notu', sourceVerified: true, confidence: 1,
      apiKey: 'provider-secret', arbitrary: { proof: true } }
  ] });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(f.calls[0].sceneContext, [{ startTime: 1.25, endTime: 3, id: 'scene-1', label: 'Kaynak açıklaması', evidence: 'Sahne notu' }]);
  for (const context of [null, {}, [{ start: null, end: 2 }], [{ start: 0, end: '2' }], [{ start: -1, end: 2 }],
    [{ start: 3, end: 2 }], [{ start: 0, end: 2, title: 1 }], [{ start: 0, end: 2, title: 'x'.repeat(2001) }],
    Array.from({ length: 65 }, () => ({ start: 0, end: 1 }))]) {
    const invalid = await f.request('POST', '/jobs', { uploadId: 'upload', sceneContext: context });
    assert.equal(invalid.statusCode, 400); assert.equal(invalid.jsonBody.reason, 'SCENE_CONTEXT_INVALID');
  }
  assert.equal(f.calls.length, 1);
});

test('artifact routes delegate actual bytes/Range to sendFile and release cache leases once', async () => {
  let releases = 0;
  const f = mediaRouteFixture({ jobs: { artifact: async () => ({ path: '/safe/cache/mix.wav', release: () => { releases++; } }) } });
  const res = new ResponseStream();
  res.type = type => { res.mimeType = type; return res; };
  res.sendFile = (filename, options) => { res.filePath = filename; res.fileOptions = options; };
  await f.request('GET', '/jobs/:id/artifacts/:name', {}, { id: 'job', name: 'mix.wav' }, res);
  assert.equal(res.filePath, '/safe/cache/mix.wav'); assert.equal(res.fileOptions.acceptRanges, true);
  assert.equal(releases, 0);
  res.emit('finish'); res.emit('close'); assert.equal(releases, 1);
  const denied = await f.request('GET', '/jobs/:id/artifacts/:name', {}, { id: 'job', name: '../source.bin' });
  assert.equal(denied.statusCode, 404);
});

test('artifact range errors and disconnected responses release the lease without leaking a file path', async () => {
  let releases = 0;
  const f = mediaRouteFixture({ jobs: { artifact: async () => ({ path: '/safe/cache/mix.wav', release: () => { releases++; } }) } });
  const res = new ResponseStream(); res.type = () => res;
  res.sendFile = (_filename, _options, callback) => callback(Object.assign(new Error('/safe/cache/mix.wav'), { statusCode: 416 }));
  await f.request('GET', '/jobs/:id/artifacts/:name', {}, { id: 'job', name: 'mix.wav' }, res);
  assert.equal(res.statusCode, 416); assert.equal(releases, 1);
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /\/safe/);
});
