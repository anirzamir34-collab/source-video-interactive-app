import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// A separate browser realm checks native receivers without replacing Node's
// test-runner globals. Samsung/Android Window methods may reject a plain object.
const clientSource = fs.readFileSync(new URL('../public/turkish-media-client.js', import.meta.url), 'utf8');
const nativeNames = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame',
  'fetch', 'createObjectURL', 'revokeObjectURL', 'digest', 'randomUUID'];

class Media extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  duration = 8;
  volume = .6;
  playbackRate = 1;
  muted = false;
  src = '';
  playCalls = 0;
  pauseCalls = 0;
  play() { this.paused = false; this.playCalls++; return Promise.resolve(); }
  pause() { this.paused = true; this.pauseCalls++; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  fire(name) { this.dispatchEvent(new Event(name)); }
}

function caption() {
  const classes = new Set();
  return { textContent: '', classes, classList: {
    add: name => classes.add(name), remove: name => classes.delete(name),
  } };
}

function result() {
  return { version: 1, jobId: 'native-job', sourceTranscript: {
    version: 1, source: { duration: 8 }, language: 'en',
    speakers: [{ speakerId: 'speaker_0' }],
    utterances: [{ segmentId: 'source-1', speakerId: 'speaker_0', sourceText: 'Hello.',
      sourceStart: 1, sourceEnd: 3, words: [] }],
  }, subtitles: {
    source_tr: [{ id: 'source-1', speakerId: 'speaker_0', start: 1, end: 3, text: 'Merhaba.' }],
    dub_tr: [{ id: 'dub-1', speakerId: 'speaker_0', start: 1, end: 3, text: 'Merhaba.' }],
  }, assets: { mix: { url: '/api/turkish-media/jobs/native-job/artifacts/mix.wav',
    mimeType: 'audio/wav', duration: 8 } } };
}

function installBrowserNatives() {
  'use strict';
  globalThis.nativeCalls = {};
  globalThis.receiverErrors = [];
  const required = new Set(bridge.strict);
  const check = (name, actual, expected) => {
    nativeCalls[name] = (nativeCalls[name] || 0) + 1;
    if (required.has(name) && actual !== expected) {
      const error = new TypeError('Illegal invocation: ' + name);
      receiverErrors.push(error.stack);
      throw error;
    }
  };
  globalThis.setTimeout = function nativeSetTimeout(...args) {
    check('setTimeout', this, globalThis);
    return bridge.setTimeout(...args);
  };
  globalThis.clearTimeout = function nativeClearTimeout(...args) {
    check('clearTimeout', this, globalThis);
    return bridge.clearTimeout(...args);
  };
  globalThis.frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = function nativeRequestAnimationFrame(callback) {
    check('requestAnimationFrame', this, globalThis);
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = function nativeCancelAnimationFrame(id) {
    check('cancelAnimationFrame', this, globalThis);
    frames.delete(id);
  };
  globalThis.fetch = function nativeFetch(...args) {
    check('fetch', this, globalThis);
    return bridge.fetch(...args);
  };
  globalThis.URL = class BrowserURL extends bridge.URL {
    static createObjectURL(blob) {
      check('createObjectURL', this, globalThis.URL);
      return bridge.createObjectURL(blob);
    }
    static revokeObjectURL(url) {
      check('revokeObjectURL', this, globalThis.URL);
      return bridge.revokeObjectURL(url);
    }
  };
  globalThis.crypto = {
    randomUUID() { check('randomUUID', this, globalThis.crypto); return bridge.randomUUID(); },
    ...(bridge.noSubtle ? {} : { subtle: {
      digest(...args) { check('digest', this, globalThis.crypto.subtle); return bridge.digest(...args); },
    } }),
  };
  globalThis.clock = {
    setTimeout(...args) { checkClock(this); nativeCalls.clockSet = (nativeCalls.clockSet || 0) + 1; return bridge.setTimeout(...args); },
    clearTimeout(...args) { checkClock(this); nativeCalls.clockClear = (nativeCalls.clockClear || 0) + 1; return bridge.clearTimeout(...args); },
    now() { checkClock(this); nativeCalls.clockNow = (nativeCalls.clockNow || 0) + 1; return bridge.now(); },
    requestAnimationFrame(callback) {
      checkClock(this); nativeCalls.clockFrame = (nativeCalls.clockFrame || 0) + 1;
      frames.set(++nextFrame, callback); return nextFrame;
    },
    cancelAnimationFrame(id) { checkClock(this); nativeCalls.clockCancel = (nativeCalls.clockCancel || 0) + 1; frames.delete(id); },
  };
  function checkClock(actual) {
    if (actual !== globalThis.clock) throw new TypeError('Injected clock receiver was changed');
  }
}

function fixture(t, { strict = nativeNames, customClock = false, explicitNativeFetch = false,
  customFetch = false, running = false, noSubtle = false, noFrames = false } = {}) {
  const requests = [], statuses = [], audios = [], timers = new Set(), objectUrls = new Set();
  let polls = 0, resolvePolled;
  const polled = new Promise(resolve => { resolvePolled = resolve; });
  const response = value => Response.json(value);
  const handleFetch = async (address, options = {}) => {
    const url = String(address);
    requests.push({ url, options });
    if (url.endsWith('/capabilities')) return response({ configured: true,
      transcriptionConfigured: true, translationConfigured: true, translationProvider: 'gemini', openAIRequired: false });
    if (url.endsWith('/uploads/start')) return response({ uploadId: 'native-upload', chunkSize: 3 });
    if (url.endsWith('/uploads/native-upload/status')) return response({ receivedChunks: [] });
    if (url.includes('/uploads/native-upload/chunk/')) return response({ complete: true });
    if (url.endsWith('/jobs') && options.method === 'POST') return response({ jobId: 'native-job' });
    if (url.endsWith('/jobs/native-job/cancel')) return response({ state: 'CANCELLED' });
    if (url.endsWith('/jobs/native-job')) {
      polls++;
      resolvePolled();
      return response(running || polls === 1 ? { state: 'TRANSCRIBING', progress: 20 }
        : { state: 'READY', result: result() });
    }
    if (url.endsWith('/artifacts/mix.wav')) return new Response('actual final mix bytes',
      { headers: { 'Content-Type': 'audio/wav' } });
    throw new Error('Unexpected native-browser request: ' + url);
  };
  const bridge = {
    strict, URL, noSubtle,
    setTimeout(callback, ms) {
      const id = setTimeout(() => { timers.delete(id); callback(); }, ms);
      timers.add(id); return id;
    },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    now: () => Date.now(),
    fetch: handleFetch,
    createObjectURL(blob) { const url = URL.createObjectURL(blob); objectUrls.add(url); return url; },
    revokeObjectURL(url) { objectUrls.delete(url); URL.revokeObjectURL(url); },
    digest: (...args) => webcrypto.subtle.digest(...args),
    randomUUID: () => webcrypto.randomUUID(),
  };
  const realm = vm.createContext({ bridge, Blob, Response, Headers, AbortController, AbortSignal,
    DOMException, Uint8Array, console });
  vm.runInContext('(' + installBrowserNatives.toString() + ')()', realm, { filename: 'test/native-browser-receivers.js' });
  if (noFrames) vm.runInContext('delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;', realm);
  vm.runInContext('"use strict";\n' + clientSource.replace('export function createTurkishMediaClient', 'function createTurkishMediaClient')
    + '\nglobalThis.createClient = createTurkishMediaClient;', realm, { filename: 'public/turkish-media-client.js' });
  const video = new Media(), overlay = caption(), speaker = caption(), text = caption();
  class Audio extends Media { constructor() { super(); audios.push(this); } }
  const options = { video, captionElements: { overlay, speaker, text }, AudioClass: Audio,
    onStatus: value => statuses.push(value), getElevenLabsApiKey: () => 'browser-eleven-key-test-only-123456',
    getGeminiApiKey: () => '', pollIntervalMs: 1, requestTimeoutMs: 2000, chunkSize: 3 };
  if (customClock) options.clock = realm.clock;
  if (explicitNativeFetch) options.fetchImpl = realm.fetch;
  if (customFetch) options.fetchImpl = function injectedFetch(...args) {
    assert.equal(this, undefined, 'injected fetch retains its ordinary function calling contract');
    return handleFetch(...args);
  };
  const client = realm.createClient(options);
  t.after(() => {
    for (const id of timers) clearTimeout(id);
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });
  return { client, realm, video, overlay, speaker, text, audios, requests, statuses, polled };
}

function sourceFile() {
  const file = new Blob(['123456789'], { type: 'video/mp4' });
  file.name = 'source.mp4';
  return file;
}

test('Android native timeout receiver allows start to upload and reach READY without Illegal invocation', async t => {
  const f = fixture(t, { strict: ['setTimeout'] });
  const value = await f.client.start(sourceFile());
  assert.equal(value.jobId, 'native-job');
  assert.ok(f.realm.nativeCalls.setTimeout > 0);
  assert.ok(f.statuses.some(row => row.state === 'READY'));
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('Android native clearTimeout keeps its global receiver during request cleanup', async t => {
  const f = fixture(t, { strict: ['clearTimeout'] });
  assert.equal((await f.client.getCapabilities()).configured, true);
  assert.ok(f.realm.nativeCalls.clearTimeout > 0);
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('Android native RAF keeps its global receiver during source-clock audio playback', async t => {
  const f = fixture(t, { strict: ['requestAnimationFrame'] });
  f.client.loadResult(result());
  f.video.paused = false;
  f.client.sync();
  assert.ok(f.realm.nativeCalls.requestAnimationFrame > 0);
  assert.equal(f.realm.frames.size, 1);
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('Android native cancelAnimationFrame keeps its global receiver during reset', async t => {
  const f = fixture(t, { strict: ['cancelAnimationFrame'] });
  f.client.loadResult(result());
  f.video.paused = false;
  f.client.sync();
  await f.client.reset({ cancelJob: false });
  assert.ok(f.realm.nativeCalls.cancelAnimationFrame > 0);
  assert.equal(f.realm.frames.size, 0);
  assert.equal(f.realm.receiverErrors.length, 0);
});

for (const explicitNativeFetch of [false, true]) {
  test('Android native fetch keeps Window receiver with ' + (explicitNativeFetch ? 'explicit native injection' : 'default transport'), async t => {
    const f = fixture(t, { strict: ['fetch'], customClock: true, explicitNativeFetch });
    assert.equal((await f.client.getCapabilities()).configured, true);
    assert.equal(f.realm.nativeCalls.fetch, 1);
    assert.equal(f.realm.receiverErrors.length, 0);
  });
}

test('Android native fetch reaches backend cancellation instead of being swallowed by cancelRemoteJob', async t => {
  const f = fixture(t, { strict: ['fetch'], customClock: true, running: true });
  const operation = f.client.start(sourceFile()).then(value => ({ value }), error => ({ error }));
  await Promise.race([f.polled, operation.then(row => { throw row.error || new Error('Job ended before cancellation'); })]);
  await f.client.cancel();
  const finished = await operation;
  assert.equal(finished.error?.name, 'AbortError');
  assert.equal(f.requests.filter(row => row.url.endsWith('/cancel')).length, 1);
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('strict browser natives preserve start, keys, digest, seek, pause/resume, offline audio and reset', async t => {
  const f = fixture(t);
  await f.client.getCapabilities();
  const value = await f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true }, qualityMode: 'quality' });
  assert.equal(value.jobId, 'native-job');
  assert.ok(f.statuses.some(row => row.state === 'READY'));
  assert.ok(f.realm.nativeCalls.digest >= 2);
  const blob = await f.client.materializeAudio();
  assert.equal(await blob.text(), 'actual final mix bytes');
  f.client.loadResult(value, { audioBlob: blob, dubEnabled: true, subtitleTrack: 'dub_tr' });
  assert.match(f.audios.at(-1).src, /^blob:/);
  f.video.currentTime = 1.5;
  f.video.paused = false;
  f.client.sync();
  assert.equal(f.text.textContent, 'Merhaba.');
  const [id, callback] = [...f.realm.frames][0];
  f.realm.frames.delete(id); callback();
  f.video.paused = true; f.video.fire('pause');
  assert.equal(f.realm.frames.size, 0);
  f.video.currentTime = 4;
  f.video.fire('seeking'); f.video.fire('seeked');
  assert.equal(f.overlay.classes.has('hidden'), true);
  f.video.currentTime = 1.5; f.video.paused = false; f.video.fire('play');
  assert.equal(f.text.textContent, 'Merhaba.');
  await f.client.reset({ cancelJob: false });
  assert.equal(f.realm.frames.size, 0);
  assert.equal(f.client.capture(), null);
  for (const name of nativeNames.filter(name => name !== 'randomUUID')) assert.ok(f.realm.nativeCalls[name] > 0, name);
  for (const row of f.requests) {
    const headers = new Headers(row.options.headers);
    const provider = row.url.endsWith('/capabilities') || (row.url.endsWith('/jobs') && row.options.method === 'POST');
    assert.equal(headers.get('x-elevenlabs-api-key'), provider ? 'browser-eleven-key-test-only-123456' : null);
    assert.equal(headers.get('x-gemini-api-key'), null, 'server Gemini fallback remains selected');
    if (typeof row.options.body === 'string') assert.equal(row.options.body.includes('browser-eleven-key-test-only-123456'), false);
  }
  assert.equal(JSON.stringify(f.client.capture()).includes('browser-eleven-key-test-only-123456'), false);
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('injected clock and fetch retain their receivers without browser globals being substituted', async t => {
  const f = fixture(t, { customClock: true, customFetch: true });
  await f.client.start(sourceFile());
  f.video.paused = false; f.client.sync();
  await f.client.reset({ cancelJob: false });
  for (const name of ['clockSet', 'clockClear', 'clockNow', 'clockFrame', 'clockCancel']) assert.ok(f.realm.nativeCalls[name] > 0, name);
  assert.equal(f.realm.nativeCalls.fetch || 0, 0);
  assert.equal(f.realm.nativeCalls.setTimeout || 0, 0);
  assert.equal(f.realm.receiverErrors.length, 0);
});

test('browsers without RAF or subtle crypto keep randomUUID receiver and can finish a media job', async t => {
  const f = fixture(t, { noSubtle: true, noFrames: true });
  await f.client.start(sourceFile());
  f.video.paused = false; f.client.sync();
  await f.client.reset({ cancelJob: false });
  assert.ok(f.realm.nativeCalls.randomUUID > 0);
  assert.equal(f.realm.receiverErrors.length, 0);
});
