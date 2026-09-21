import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { selectExtractorSource } from '../lib/video-url.js';

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
    fs, Readable, pipeline, resolvedVideoSessions: new Map(), dialogueUploadSessions: new Map(),
    dialogueChunkParser() {}, upload: { single: () => () => {} },
    multer: { MulterError: class extends Error {} },
    app: { get: (url, ...handlers) => routes.set(url, handlers.at(-1)), post: (url, ...handlers) => routes.set(url, handlers.at(-1)) },
    setTimeout: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    console: { error: (...args) => errors.push(args) },
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
    return { response: new Response('cde', { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3' } }) };
  } });
  f.req.headers.range = 'bytes=2-4';
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
  const f = fixture(code, { selectExtractorSource, runVideoExtractor: async () => { calls++; throw Error('HTTP 403 forbidden'); } });
  await assert.rejects(f.scope.resolveWithSiteExtractor('https://site.test/watch'), /403/);
  assert.equal(calls, 1);
  const blocked = fixture(code, {
    validatePublicUrl: async () => { throw Error('private address'); },
    runVideoExtractor: () => assert.fail('must not start')
  });
  await assert.rejects(blocked.scope.resolveWithSiteExtractor('http://localhost/video'), /private address/);
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
