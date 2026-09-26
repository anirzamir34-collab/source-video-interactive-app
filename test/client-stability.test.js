import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { dubSpeakerKey } from '../public/dub-speakers.js';
import { createVideoDownloader } from '../public/video-download.js';
import { canDecodeDialogueLocally } from '../public/media-limits.js';
import { createDubRequestQueue } from '../public/dubbing-queue.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
function functions(...names) {
  return names.map(name => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const tail = source.slice(start);
    return tail.slice(0, tail.slice(1).search(/\n(?:async )?function /) + 1);
  }).join('\n');
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Element extends EventTarget {
  classList = { add() {}, remove() {}, toggle() {} };
  dataset = {};
  pause() { this.paused = true; }
  removeAttribute(name) { delete this[name]; }
  load() {}
}
function elements() { return new Proxy({}, { get(target, name) { return target[name] ||= new Element(); } }); }
function fixture(code, overrides = {}) {
  const errors = [];
  const scope = vm.createContext({
    AbortController, AbortSignal, URL, Blob, File, FormData, performance, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args), warn() {} },
    els: elements(), state: {}, savedGames: null, $: () => new Element(), updateDubMix() {}, ...overrides
  });
  scope.videoDownloads ||= createVideoDownloader({ fetch: (...args) => scope.fetch(...args), storage: null, locks: null });
  scope.canDecodeDialogueLocally = canDecodeDialogueLocally;
  vm.runInContext(code, scope);
  return { scope, errors };
}

test('blocked storage property and removeItem failures do not stop startup cleanup', () => {
  const f = fixture(functions('removeStoredValue'));
  Object.defineProperty(f.scope, 'localStorage', { get() { throw Error('SecurityError'); } });
  f.scope.sessionStorage = { removeItem() { throw Error('denied'); } };
  assert.doesNotThrow(() => f.scope.removeStoredValue('localStorage', 'runtime'));
  assert.doesNotThrow(() => f.scope.removeStoredValue('sessionStorage', 'runtime'));
});

test('availability refreshes cannot reenable analysis during analysis or URL import', () => {
  const f = fixture(section('function updateAnalyzeAvailability()', '\n[\n  els.qualityMode'), { updateAnalysisModesUI: () => true });
  f.scope.state.selectedFile = { name: 'clip.mp4' };
  for (const busy of ['analysisInProgress', 'urlResolutionInProgress', 'savedGameBusy']) {
    f.scope.state[busy] = true;
    f.scope.updateAnalyzeAvailability();
    assert.equal(f.scope.els.analyzeBtn.disabled, true);
    f.scope.state[busy] = false;
  }
  f.scope.updateAnalyzeAvailability();
  assert.equal(f.scope.els.analyzeBtn.disabled, false);
});

test('analysis ignores duplicate starts and releases controls even if initial setup throws', async () => {
  let handler;
  let setupCalls = 0;
  const els = elements();
  els.analyzeBtn.addEventListener = (_event, callback) => { handler = callback; };
  const state = { selectedFile: { name: 'clip.mp4' }, analysisInProgress: true };
  const code = section("els.analyzeBtn.addEventListener('click', async () => {", '\nfunction assignPositionOccurrenceIds(');
  const f = fixture(code, {
    els, state, videoUrlInput: new Element(), resolveUrlBtn: new Element(),
    setGameState() {}, renderDebug() {}, updateAnalyzeAvailability() { els.analyzeBtn.disabled = state.analysisInProgress; },
    selectedAnalysisModes() { setupCalls++; throw Error('setup failed'); }
  });
  await handler();
  assert.equal(setupCalls, 0);
  state.analysisInProgress = false;
  await handler();
  assert.equal(setupCalls, 1);
  assert.equal(state.analysisInProgress, false);
  assert.equal(els.videoInput.disabled, false);
  assert.equal(els.analysisState.textContent, 'ANALYSIS_ERROR');
  assert.equal(f.errors.length, 1);
});

test('missing dubbing credentials fail before expensive analysis and unlock controls', async () => {
  let handler;
  const els = elements();
  els.analyzeBtn.addEventListener = (_event, callback) => { handler = callback; };
  const state = { selectedFile: { name: 'clip.mp4' } };
  fixture(section("els.analyzeBtn.addEventListener('click', async () => {", '\nfunction assignPositionOccurrenceIds('), {
    els, state, videoUrlInput: {}, resolveUrlBtn: {}, setGameState() {}, renderDebug() {}, updateAnalyzeAvailability() {},
    selectedAnalysisModes: () => ({ dubbing: true }), activeElevenLabsApiKey: () => '',
    extractStoryboard: () => assert.fail('must not spend analysis work without required credentials')
  });
  await handler();
  assert.match(els.analysisOutput.textContent, /ElevenLabs anahtarı gerekli/);
  assert.equal(state.analysisInProgress, false);
  assert.equal(els.videoInput.disabled, false);
});

class UploadRequest extends EventTarget {
  upload = new EventTarget();
  status = 0;
  response = null;
  open() {}
  setRequestHeader() {}
  send(chunk) { this.chunk = chunk; }
  abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
}

test('completed mobile upload is not aborted while waiting for the server response', async () => {
  const timers = new Map();
  let nextTimer = 0;
  let request;
  const f = fixture(functions('sendDialogueChunk'), {
    XMLHttpRequest: class extends UploadRequest { constructor() { super(); request = this; } },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const result = f.scope.sendDialogueChunk({ uploadId: 'one', chunk: new Blob(['speech']), chunkIndex: 0,
    completedBytes: 0, totalBytes: 6, startedAt: performance.now(), onProgress() {} });
  request.upload.dispatchEvent(new Event('progress'));
  request.upload.dispatchEvent(new Event('load'));
  for (const callback of [...timers.values()]) callback();
  assert.equal(request.aborted, undefined);
  request.status = 200;
  request.response = { available: true, nextChunk: 1 };
  request.dispatchEvent(new Event('load'));
  assert.equal((await result).nextChunk, 1);
});

test('fast links use four parallel dialogue upload streams while constrained links stay serial', () => {
  const uploadSection = section('async function uploadDialogueWithProgress(', '\nasync function prepareDialoguePayload(');
  assert.match(uploadSection, /4 \* 1024 \* 1024/);
  assert.match(uploadSection, /maxConnections = constrained \? 1/);
  assert.match(uploadSection, /effectiveType === '3g' \? 2 : 4/);
  assert.match(uploadSection, /Promise\.all\(workers\)/);
});

test('HTTP upload errors expose status and do not retry permanent authorization failures', async () => {
  let request;
  const f = fixture(functions('sendDialogueChunk'), {
    XMLHttpRequest: class extends UploadRequest { constructor() { super(); request = this; } }
  });
  const result = f.scope.sendDialogueChunk({ uploadId: 'one', chunk: new Blob(['speech']), chunkIndex: 0,
    completedBytes: 0, totalBytes: 6, startedAt: performance.now(), onProgress() {} });
  request.upload.dispatchEvent(new Event('load'));
  request.status = 401;
  request.response = { reason: 'AUTH_REQUIRED', message: 'Oturum süresi doldu.' };
  request.dispatchEvent(new Event('load'));
  await assert.rejects(result, error => error.status === 401 && error.retryable === false && /Oturum/.test(error.message));
});

test('quota status does not advertise an unused provider as ready for dubbing', async () => {
  const badges = [];
  const f = fixture(functions('checkAiUsageStatus'), {
    fetch: async () => ({ json: async () => ({ subtitles: { state: 'available' }, dubbing: { state: 'available' } }) }),
    geminiRequestHeaders: () => ({}), activeElevenLabsApiKey: () => '',
    renderQuotaBadge: (_el, status) => badges.push(status)
  });
  await f.scope.checkAiUsageStatus();
  assert.equal(badges.at(-1).state, 'unconfigured');
  assert.match(badges.at(-1).message, /ElevenLabs/);
});

function dubbingFixture() {
  const pending = [];
  const state = {
    dialogue: { segments: [] }, dubRequestController: new AbortController(),
    dubUnavailableUntil: 0, dubCache: new Map(), dubRequests: new Map(), dubSyncGeneration: 0,
    dubQueue: createDubRequestQueue(), dubVoiceIds: {}, dubStableSpeakerGenders: new Map(), dubPlayedSegmentIds: new Set()
  };
  const f = fixture(functions('ensureDubSegment', 'resetDubState', 'prepareCompleteDubTimeline'), {
    state, createDubRequestQueue, dubSpeakerKey,
    ensureDubVoicePlan: async () => new Map([['speaker-unknown', { speakerId: 'speaker-unknown', voiceId: 'new-voice', gender: 'female' }]]),
    dubTimeline: () => state.dialogue.segments,
    getDubSegmentId: segment => segment.id, stableDubGender: () => 'female',
    activeElevenLabsApiKey: () => 'test-key', elevenLabsHeaders: value => value,
    logEngineEvent() {}, stopDubPlayback() {}, stopDubClock() {}, clearPreparedDubAudio() {}, checkAiUsageStatus() {},
    fetch: (_url, options) => { const item = { ...deferred(), signal: options.signal }; pending.push(item); return item.promise; }
  });
  return { ...f, state, pending };
}
function voiceResponse(audio = 'new-audio') { return { ok: true, json: async () => ({ available: true, audioBase64: audio, voiceId: 'new-voice' }) }; }

test('mismatched provider voice is neither cached nor retried as a transient error', async () => {
  const f = dubbingFixture();
  const segment = { id: 'line-1', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [segment];
  const request = f.scope.ensureDubSegment(segment);
  await tick();
  f.pending[0].resolve({ ok: true, json: async () => ({ available: true, audioBase64: 'wrong-audio', voiceId: 'someone-else' }) });
  assert.equal(await request, null);
  assert.equal(f.pending.length, 1);
  assert.equal(f.state.dubCache.size, 0);
  assert.equal(f.state.dubFailureReason, 'DUB_VOICE_MISMATCH');
});

test('late audio from an old source cannot replace new audio or delete a new pending request with the same id', async () => {
  const f = dubbingFixture();
  const old = { id: 'line-1', turkishText: 'Önceki konuşma' };
  f.state.dialogue.segments = [old];
  const oldRequest = f.scope.ensureDubSegment(old);
  await tick();
  f.scope.resetDubState();
  assert.equal(f.pending[0].signal.aborted, true);
  const current = { id: 'line-1', turkishText: 'Yeni konuşma' };
  f.state.dialogue.segments = [current];
  const newRequest = f.scope.ensureDubSegment(current);
  await tick();
  f.pending[0].resolve(voiceResponse('old-audio'));
  assert.equal(await oldRequest, null);
  assert.equal(f.state.dubCache.size, 0);
  assert.equal(f.state.dubRequests.size, 1);
  f.pending[1].resolve(voiceResponse());
  assert.match(await newRequest, /new-audio$/);
  assert.equal(f.state.dubRequests.size, 0);
  assert.equal(f.errors.length, 0);
});

test('late quota errors cannot disable dubbing in the new source', async () => {
  const f = dubbingFixture();
  const segment = { id: 'line-1', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [segment];
  const request = f.scope.ensureDubSegment(segment);
  await tick();
  f.scope.resetDubState();
  f.state.dubbingEnabled = true;
  f.pending[0].resolve({ ok: false, json: async () => ({ reason: 'ELEVENLABS_QUOTA_LIMIT' }) });
  await request;
  assert.equal(f.state.dubbingEnabled, true);
  assert.equal(f.state.dubUnavailableUntil, 0);
});

test('reset cancels queued work before any request for the previous source starts', async () => {
  const f = dubbingFixture();
  const old = { id: 'line-1', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [old];
  const request = f.scope.ensureDubSegment(old);
  f.scope.resetDubState();
  f.state.dialogue.segments = [];
  assert.equal(await request, null);
  assert.equal(await f.scope.ensureDubSegment(old), null);
  assert.equal(f.pending.length, 0);
});

test('a long provider rate limit is surfaced without retrying before its deadline', async () => {
  const f = dubbingFixture();
  const segment = { id: 'line-1', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [segment];
  const request = f.scope.ensureDubSegment(segment);
  await tick();
  f.pending[0].resolve({ ok: false, json: async () => ({ reason: 'ELEVENLABS_RATE_LIMIT', retryAfterSeconds: 120 }) });
  assert.equal(await request, null);
  assert.equal(f.pending.length, 1);
  assert.equal(f.state.dubFailureReason, 'ELEVENLABS_RATE_LIMIT');
  assert.ok(f.state.dubUnavailableUntil > Date.now());
  assert.equal(await f.scope.ensureDubSegment(segment), null);
  assert.equal(f.pending.length, 1);
});

test('preparation workers stop when their source changes', async () => {
  const f = dubbingFixture();
  const old = [{ id: 'one', turkishText: 'Merhaba' }, { id: 'two', turkishText: 'Nasılsın' }];
  f.state.dialogue.segments = old;
  f.state.dubbingEnabled = true;
  const preparation = f.scope.prepareCompleteDubTimeline(old);
  await tick();
  f.scope.resetDubState();
  f.pending[0].resolve(voiceResponse());
  assert.equal(await preparation, 0);
  assert.equal(f.pending.length, 1);
});

test('complete preparation reports every translated line ready before playback', async () => {
  const f = dubbingFixture();
  const segments = ['one', 'two', 'three'].map(id => ({ id, turkishText: `Türkçe ${id}` }));
  const progress = [];
  f.state.dialogue.segments = segments;
  f.state.dubbingEnabled = true;
  const preparation = f.scope.prepareCompleteDubTimeline(
    segments,
    1,
    (ready, total) => progress.push([ready, total])
  );
  for (let index = 0; index < segments.length; index += 1) {
    await tick();
    f.pending[index].resolve(voiceResponse(`audio-${index}`));
  }
  assert.equal(await preparation, segments.length);
  assert.deepEqual(progress.at(-1), [segments.length, segments.length]);
  assert.deepEqual([...f.state.dubCache.keys()], ['one', 'two', 'three']);
});

test('cached speech remains playable during a provider cooldown', async () => {
  const f = dubbingFixture();
  const segment = { id: 'cached', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [segment];
  f.state.dubCache.set('cached', 'cached-audio');
  f.state.dubUnavailableUntil = Date.now() + 120000;
  assert.equal(await f.scope.ensureDubSegment(segment, 100), 'cached-audio');
  assert.equal(f.pending.length, 0);
});

test('saved-game replay uses stored audio and never synthesizes missing audio', async () => {
  const f = dubbingFixture();
  const cached = { id: 'saved', turkishText: 'Merhaba' };
  const missing = { id: 'missing', turkishText: 'Görüşürüz' };
  f.state.dialogue.segments = [cached, missing];
  f.state.savedPlaybackOnly = true;
  f.state.dubCache.set('saved', 'saved-audio');
  assert.equal(await f.scope.ensureDubSegment(cached), 'saved-audio');
  assert.equal(await f.scope.ensureDubSegment(missing), null);
  assert.equal(f.pending.length, 0);
});

test('the selected line overtakes queued preload work without duplicate synthesis', async () => {
  const f = dubbingFixture();
  const segments = ['running', 'preload', 'selected'].map(id => ({ id, turkishText: id }));
  f.state.dialogue.segments = segments;
  const running = f.scope.ensureDubSegment(segments[0]);
  await tick();
  const preload = f.scope.ensureDubSegment(segments[1]);
  const selected = f.scope.ensureDubSegment(segments[2]);
  const promoted = f.scope.ensureDubSegment(segments[2], 100);
  f.pending[0].resolve(voiceResponse('running'));
  await running;
  await tick();
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(voiceResponse('selected'));
  assert.match(await selected, /selected$/);
  assert.equal(await promoted, await selected);
  await tick();
  f.pending[2].resolve(voiceResponse('preload'));
  assert.match(await preload, /preload$/);
  assert.equal(f.pending.length, 3);
});

test('queued requests respect a cooldown imposed after they were queued', async () => {
  const f = dubbingFixture();
  const segments = ['a', 'b'].map(id => ({ id, turkishText: 'Merhaba' }));
  f.state.dialogue.segments = segments;
  const first = f.scope.ensureDubSegment(segments[0]);
  await tick();
  const queued = f.scope.ensureDubSegment(segments[1]);
  f.pending[0].resolve({ ok: false, json: async () => ({ reason: 'ELEVENLABS_RATE_LIMIT', retryAfterSeconds: 120 }) });
  assert.equal(await first, null);
  assert.equal(await queued, null);
  assert.equal(f.pending.length, 1);
});

test('quota exhaustion does not silently change the chosen audio mode', async () => {
  const f = dubbingFixture();
  const segment = { id: 'a', turkishText: 'Merhaba' };
  f.state.dialogue.segments = [segment];
  f.state.dubbingEnabled = true;
  const request = f.scope.ensureDubSegment(segment);
  await tick();
  f.pending[0].resolve({ ok: false, json: async () => ({ reason: 'ELEVENLABS_QUOTA_LIMIT' }) });
  assert.equal(await request, null);
  assert.equal(f.state.dubbingEnabled, true);
  assert.equal(f.state.dubFailureReason, 'ELEVENLABS_QUOTA_LIMIT');
  assert.ok(f.state.dubUnavailableUntil > Date.now());
});

test('changing source removes the previous time boundary listener and clears old analysis', () => {
  const els = elements();
  let staleCallbacks = 0;
  const listener = () => staleCallbacks++;
  els.video.addEventListener('timeupdate', listener);
  const state = { stopListener: listener, analysis: { actions: [{}] }, dialogue: { segments: [{}] } };
  const f = fixture(section('function clearPreviousGameResidue()', '\nclearPreviousGameResidue();'), {
    state, els, cancelTimelineNavigation() {}, cancelAdultSeek() {}, removeStoredValue() {},
    RUNTIME_SAVE_KEY: 'runtime', releaseVideoObjectUrl() {}, resetDubState() {}, updateLanguageSyncControls() {}, setGameState(value) { state.gameState = value; }
  });
  f.scope.clearPreviousGameResidue();
  els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(staleCallbacks, 0);
  assert.equal(state.analysis, null);
  assert.equal(state.dialogue, null);
  assert.equal(state.stopListener, null);
  assert.equal(state.gameState, 'IDLE');
});

function urlFixture(fetch, overrides = {}) {
  const state = { selectedFile: { name: 'existing.mp4' }, analysis: { actions: [{}] }, analysisSession: { saved: true } };
  let handlerCode = source.slice(source.indexOf('async function resolveVideoUrl()'));
  handlerCode = handlerCode.slice(0, handlerCode.indexOf('\nresolveUrlBtn?.addEventListener'));
  return fixture(handlerCode, {
    state, fetch, videoUrlInput: { value: 'https://example.com/new' }, resolveUrlBtn: {},
    setUrlStatus() {}, updateAnalyzeAvailability() {}, renderDebug() {},
    hideBrowserDownloadHelp() {}, showBrowserDownloadHelp() {},
    urlVideoCache: { get: async () => null, put: async () => null, update: async () => true, removeExpired: async () => {} },
    clearPreviousGameResidue: () => assert.fail('failed resolution must keep previous source'), ...overrides
  });
}

test('failed URL import preserves previous source and completed analysis', async () => {
  const f = urlFixture(async () => ({ ok: false, json: async () => ({ message: 'unavailable' }) }));
  const oldFile = f.scope.state.selectedFile;
  const oldAnalysis = f.scope.state.analysis;
  const oldSession = f.scope.state.analysisSession;
  await f.scope.resolveVideoUrl();
  assert.equal(f.scope.state.selectedFile, oldFile);
  assert.equal(f.scope.state.analysis, oldAnalysis);
  assert.equal(f.scope.state.analysisSession, oldSession);
  assert.equal(f.scope.state.urlResolutionInProgress, false);
  assert.equal(f.scope.els.videoInput.disabled, false);
});

test('Enter and button presses during URL resolution cannot launch duplicate imports', async () => {
  const gate = deferred();
  let calls = 0;
  const f = urlFixture(() => { calls++; return gate.promise; });
  const first = f.scope.resolveVideoUrl();
  await f.scope.resolveVideoUrl();
  assert.equal(calls, 1);
  assert.equal(f.scope.els.videoInput.disabled, true);
  gate.resolve({ ok: false, json: async () => ({}) });
  await first;
  assert.equal(f.scope.resolveUrlBtn.disabled, false);
});

test('URL import downloads the complete source directly before enabling a local player; no proxy preview or probe', async () => {
  const gate = deferred();
  const requests = [];
  const sourceUrl = 'https://cdn.example.com/original.mp4';
  let cleared = 0;
  const f = urlFixture(async (url, options) => {
    requests.push(url);
    if (url === '/api/resolve-video-url') return { ok: true, json: async () => ({ ok: true,
      type: 'video', sourceUrl, proxyUrl: '/api/video-proxy?token=never', remoteToken: 'never', directDownload: true }) };
    assert.equal(url, sourceUrl);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Range, 'bytes=0-0');
    return gate.promise;
  }, { clearPreviousGameResidue() { cleared++; } });
  vm.runInContext(functions('downloadUrlVideo', 'remoteVideoFileName'), f.scope);
  const oldFile = f.scope.state.selectedFile;
  const pending = f.scope.resolveVideoUrl();
  await tick();
  assert.deepEqual(requests, ['/api/resolve-video-url', sourceUrl]);
  assert.equal(f.scope.state.urlResolutionInProgress, true);
  assert.equal(f.scope.els.videoInput.disabled, true);
  assert.equal(f.scope.state.selectedFile, oldFile);
  assert.equal(cleared, 0);
  assert.equal(f.scope.els.video.src, undefined);
  gate.resolve(new Response('exact original video', { headers: { 'content-type': 'video/mp4' } }));
  await pending;
  try {
    assert.equal(cleared, 1);
    assert.equal(await f.scope.state.selectedFile.text(), 'exact original video');
    assert.equal(f.scope.state.selectedRemoteVideo, null);
    assert.equal(f.scope.state.selectedRemoteToken, 'never');
    assert.match(f.scope.els.video.src, /^blob:/);
    assert.equal(f.scope.state.urlResolutionInProgress, false);
    assert.equal(f.scope.els.videoInput.disabled, false);
    assert.equal(requests.length, 2);
  } finally { URL.revokeObjectURL(f.scope.state.videoObjectUrl); }
});

test('blocked browser downloads and manifests automatically download via Render before local playback', async () => {
  for (const type of ['video', 'hls', 'dash']) {
    const sourceUrl = 'https://cdn.example.com/video.' + (type === 'video' ? 'mp4' : type === 'hls' ? 'm3u8' : 'mpd');
    const pageUrl = 'https://example.com/watch';
    const requests = [];
    const help = [];
    const f = urlFixture(async url => {
      requests.push(url);
      if (url === '/api/resolve-video-url') return { ok: true, json: async () => ({ ok: true,
        type, sourceUrl, pageUrl, proxyUrl: '/api/video-proxy?token=never',
        directDownload: type === 'video' }) };
      if (url === sourceUrl) throw new TypeError('CORS denied');
      assert.equal(url, '/api/video-proxy?token=never');
      return new Response('original video bytes', { headers: { 'content-type': 'video/mp4' } });
    }, { clearPreviousGameResidue() {}, showBrowserDownloadHelp: (...args) => help.push(args) });
    vm.runInContext(functions('downloadUrlVideo', 'remoteVideoFileName'), f.scope);
    const oldFile = f.scope.state.selectedFile;
    await f.scope.resolveVideoUrl();
    assert.deepEqual(requests, ['/api/resolve-video-url', ...(type === 'video' ? [sourceUrl] : []), '/api/video-proxy?token=never']);
    assert.deepEqual(help, []);
    assert.notEqual(f.scope.state.selectedFile, oldFile);
    assert.equal(await f.scope.state.selectedFile.text(), 'original video bytes');
    assert.match(f.scope.els.video.src, /^blob:/);
    assert.equal(f.scope.els.videoInput.disabled, false);
    URL.revokeObjectURL(f.scope.state.videoObjectUrl);
  }
});

test('failure of both download routes offers manual import and preserves the previous video', async () => {
  const requests = [];
  const help = [];
  const f = urlFixture(async url => {
    requests.push(url);
    if (url === '/api/resolve-video-url') return { ok: true, json: async () => ({ ok: true,
      type: 'video', sourceUrl: 'https://cdn.example.com/a.mp4', pageUrl: 'https://example.com/watch',
      proxyUrl: '/proxy', directDownload: true }) };
    if (url === '/proxy') return new Response(JSON.stringify({ message: 'source unavailable' }), { status: 502 });
    throw new TypeError('CORS denied');
  }, { showBrowserDownloadHelp: (...args) => help.push(args) });
  vm.runInContext(functions('downloadUrlVideo', 'remoteVideoFileName'), f.scope);
  const oldFile = f.scope.state.selectedFile;
  await f.scope.resolveVideoUrl();
  assert.deepEqual(requests, ['/api/resolve-video-url', 'https://cdn.example.com/a.mp4', '/proxy']);
  assert.equal(f.scope.state.selectedFile, oldFile);
  assert.deepEqual(help, [['https://cdn.example.com/a.mp4', 'https://example.com/watch']]);
});

test('manual download links reject executable URLs and discard stale source links', () => {
  const nodes = new Map(['browserDownloadHelp', 'browserVideoLink', 'browserPageLink'].map(id => [id, new Element()]));
  const f = fixture(functions('showBrowserDownloadHelp', 'hideBrowserDownloadHelp'), {
    document: { getElementById: id => nodes.get(id) }
  });
  f.scope.showBrowserDownloadHelp('https://cdn.example.com/video.mp4', 'https://example.com/watch');
  assert.equal(nodes.get('browserVideoLink').href, 'https://cdn.example.com/video.mp4');
  f.scope.showBrowserDownloadHelp('javascript:alert(1)', 'https://user:secret@example.com/private');
  assert.equal(nodes.get('browserVideoLink').href, undefined);
  assert.equal(nodes.get('browserPageLink').href, undefined);
  f.scope.showBrowserDownloadHelp('https://cdn.example.com/new.mp4', 'https://example.com/watch');
  f.scope.hideBrowserDownloadHelp();
  assert.equal(nodes.get('browserVideoLink').href, undefined);
  assert.equal(nodes.get('browserPageLink').href, undefined);
});

test('malformed escape sequences in remote filenames do not block a valid media URL', () => {
  const f = fixture(functions('remoteVideoFileName'));
  assert.equal(f.scope.remoteVideoFileName('https://example.com/clip%broken.mp4'), 'clip%broken.mp4');
});

test('oversized downloads are cancelled before consuming their response body', async () => {
  let signal;
  let reads = 0;
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {}, fetch: async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, headers: new Headers({ 'content-length': String(601 * 1024 * 1024) }), body: { getReader() { reads++; } } };
    }
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4'), /600 MB/);
  assert.equal(signal.aborted, true);
  assert.equal(reads, 0);
});

test('download without content length is still bounded and its reader released', async () => {
  let cancelled = false;
  let released = false;
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {}, fetch: async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ done: false, value: { length: 601 * 1024 * 1024 } }),
      cancel: async () => { cancelled = true; }, releaseLock() { released = true; }
    }) } })
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4'), /600 MB/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('proxy downloads stay parallel even when direct browser download is disabled', async () => {
  const calls = [];
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {},
    videoDownloads: {
      download: async (proxy, options) => {
        calls.push({ proxy, options });
        return new Blob(['video'], { type: 'video/mp4' });
      }
    }
  });
  await f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4', { allowDirect: false });
  assert.equal(calls[0].proxy, '/proxy');
  assert.equal(calls[0].options.parallel, true);
  assert.equal(calls[0].options.directUrl, '');
});

test('normal download returns exact bytes and releases its reader', async () => {
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {}, fetch: async () => new Response('test-video-bytes', { headers: { 'content-type': 'video/mp4' } })
  });
  const blob = await f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4');
  assert.equal(await blob.text(), 'test-video-bytes');
  assert.equal(blob.type, 'video/mp4');
});

test('storyboard transfer enforces its smaller limit and reports bytes without changing URL status', async () => {
  const progress = [];
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() { assert.fail('storyboard owns transfer progress'); },
    fetch: async () => new Response('exact-video-bytes', { headers: { 'content-type': 'video/mp4', 'content-length': '17' } })
  });
  const blob = await f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4', { maxBytes: 128, onProgress: detail => progress.push(detail) });
  assert.equal(await blob.text(), 'exact-video-bytes');
  assert.equal(progress.at(-1).loaded, 17);
  await assert.rejects(f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4', { maxBytes: 8 }), /indirme sınırını/);
});

test('storyboard transfer has an overall deadline even when waiting for response headers', async () => {
  let signal;
  const f = fixture(functions('downloadUrlVideo'), {
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4', { maxDurationMs: 5 }), /aktarımı durdu/);
  assert.equal(signal.aborted, true);
});

test('cancelling storyboard transfer aborts and releases its active reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let released = false;
  const f = fixture(functions('downloadUrlVideo'), {
    fetch: async (_url, { signal }) => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      read: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort();
      }),
      cancel: async () => { cancelled = true; }, releaseLock() { released = true; }
    }) } })
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy', 'https://cdn.example.com/video.mp4', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

function remoteFileFixture(download) {
  const state = { selectedFile: null, selectedRemoteVideo: {
    sourceUrl: 'https://example.com/video.mp4', proxyUrl: '/proxy?token=one', fileName: 'video.mp4', size: 0
  }, videoObjectUrl: '' };
  return fixture(functions('analysisSourceKey', 'prepareStoryboardSource', 'ensureSelectedRemoteFile'), {
    state, setUrlStatus() {}, downloadUrlVideo: download
  });
}

test('one complete remote download is shared and reused without losing the analysis identity', async () => {
  const gate = deferred();
  let downloads = 0;
  const f = remoteFileFixture(async () => { downloads++; return gate.promise; });
  const { state } = f.scope;
  const beforeKey = f.scope.analysisSourceKey(null, state.selectedRemoteVideo);
  const first = f.scope.ensureSelectedRemoteFile();
  const second = f.scope.ensureSelectedRemoteFile();
  assert.equal(downloads, 1);
  gate.resolve(new Blob(['source-video'], { type: 'video/mp4' }));
  const [firstFile, secondFile] = await Promise.all([first, second]);
  assert.equal(firstFile, secondFile);
  assert.equal(await firstFile.text(), 'source-video');
  assert.equal(f.scope.analysisSourceKey(firstFile, state.selectedRemoteVideo), beforeKey);
  assert.equal(await f.scope.ensureSelectedRemoteFile(), firstFile);
  assert.equal(downloads, 1);
  assert.equal(state.remoteFileDownload, null);
});

test('frame preparation waits for the complete download, then uses the same local bytes for playback and retry', async () => {
  const gate = deferred();
  const progress = [];
  const f = remoteFileFixture(async (_url, _source, options) => {
    progress.push(options);
    return gate.promise;
  });
  const session = {};
  f.scope.els.video.src = '/proxy?token=one';
  let prepared = false;
  const pending = f.scope.prepareStoryboardSource(session, null).then(file => { prepared = true; return file; });
  await tick();
  assert.equal(prepared, false);
  assert.equal(f.scope.els.video.src, undefined);
  assert.equal(f.scope.els.analysisState.textContent, 'DOWNLOADING_VIDEO');
  progress[0].onProgress({ loaded: 6, total: 12 });
  assert.match(f.scope.els.analysisTitle.textContent, /%50/);
  gate.resolve(new Blob(['source-video'], { type: 'video/mp4' }));
  try {
    const file = await pending;
    assert.equal(await file.text(), 'source-video');
    assert.equal(session.file, file);
    assert.match(f.scope.els.video.src, /^blob:/);
    const localUrl = f.scope.els.video.src;
    assert.equal(await f.scope.prepareStoryboardSource(session, null), file);
    assert.equal(progress.length, 1);
    assert.equal(f.scope.els.video.src, localUrl);
  } finally { URL.revokeObjectURL(f.scope.state.videoObjectUrl); }
});

test('large and unknown-size remote sources go directly to download without adaptive seek probes', async () => {
  for (const size of [0, 200 * 1024 * 1024]) {
    const f = remoteFileFixture(() => assert.fail('using the complete-file helper'));
    f.scope.state.selectedRemoteVideo.size = size;
    let downloads = 0;
    const expectedFile = new Blob(['video']);
    f.scope.ensureSelectedRemoteFile = async () => { downloads++; return expectedFile; };
    try {
      assert.equal(await f.scope.prepareStoryboardSource({}, null), expectedFile);
      assert.equal(downloads, 1);
    } finally { URL.revokeObjectURL(f.scope.state.videoObjectUrl); }
  }
});

test('an already uploaded local file needs no download or source replacement', async () => {
  const f = remoteFileFixture(() => assert.fail('local file must never be fetched'));
  f.scope.state.selectedRemoteVideo = null;
  const file = new File(['video'], 'local.mp4', { type: 'video/mp4' });
  const session = {};
  f.scope.els.video.src = 'blob:existing';
  assert.equal(await f.scope.prepareStoryboardSource(session, file), file);
  assert.equal(session.file, file);
  assert.equal(f.scope.els.video.src, 'blob:existing');
});

test('failed download leaves the player unloaded and can be retried without starting a proxy preview', async () => {
  let attempts = 0;
  const f = remoteFileFixture(async () => {
    if (++attempts === 1) throw Error('network stalled');
    return new Blob(['video']);
  });
  const session = {};
  await assert.rejects(f.scope.prepareStoryboardSource(session, null), /network stalled/);
  assert.equal(f.scope.els.video.src, undefined);
  assert.equal(f.scope.state.selectedFile, null);
  assert.equal(session.file, undefined);
  assert.equal(f.scope.state.remoteFileDownload, null);
  try {
    assert.equal(await (await f.scope.prepareStoryboardSource(session, null)).text(), 'video');
    assert.equal(attempts, 2);
  } finally { URL.revokeObjectURL(f.scope.state.videoObjectUrl); }
});

test('a stale transfer or incomplete file cannot replace the current source', async () => {
  const gate = deferred();
  const f = remoteFileFixture(async () => gate.promise);
  const pending = f.scope.ensureSelectedRemoteFile();
  f.scope.state.selectedRemoteVideo = { proxyUrl: '/other-source' };
  gate.resolve(new Blob(['old-video']));
  await assert.rejects(pending, /kaynağı değişti/);
  assert.equal(f.scope.state.selectedFile, null);
  const incomplete = remoteFileFixture(async () => new Blob(['short']));
  incomplete.scope.state.selectedRemoteVideo.size = 100;
  await assert.rejects(incomplete.scope.ensureSelectedRemoteFile(), /aktarım.*eksik/);
  assert.equal(incomplete.scope.state.selectedFile, null);
});


test('large or long videos skip full browser decoding before chunked upload', async () => {
  const f = fixture(functions('prepareDialoguePayload'), {
    setInterval, clearInterval,
    extractMp4Audio: async () => null,
    extractDialogueAudio() { assert.fail('large source must not be read into an ArrayBuffer'); }
  });
  for (const [size, duration] of [[700 * 1024 * 1024, 300], [10 * 1024 * 1024, 1800]]) {
    const file = { size };
    f.scope.els.video.duration = duration;
    assert.equal(await f.scope.prepareDialoguePayload(file), file);
  }
});
