import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
    els: elements(), state: {}, updateDubMix() {}, ...overrides
  });
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
  for (const busy of ['analysisInProgress', 'urlResolutionInProgress']) {
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
    state, createDubRequestQueue, dubTimeline: () => state.dialogue.segments,
    getDubSegmentId: segment => segment.id, stableDubGender: () => 'female',
    activeElevenLabsApiKey: () => 'test-key', elevenLabsHeaders: value => value,
    logEngineEvent() {}, stopDubPlayback() {}, stopDubClock() {}, clearPreparedDubAudio() {}, checkAiUsageStatus() {},
    fetch: (_url, options) => { const item = { ...deferred(), signal: options.signal }; pending.push(item); return item.promise; }
  });
  return { ...f, state, pending };
}
function voiceResponse(audio = 'new-audio') { return { ok: true, json: async () => ({ available: true, audioBase64: audio, voiceId: 'new-voice' }) }; }

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
    RUNTIME_SAVE_KEY: 'runtime', releaseVideoObjectUrl() {}, resetDubState() {}, setGameState(value) { state.gameState = value; }
  });
  f.scope.clearPreviousGameResidue();
  els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(staleCallbacks, 0);
  assert.equal(state.analysis, null);
  assert.equal(state.dialogue, null);
  assert.equal(state.stopListener, null);
  assert.equal(state.gameState, 'IDLE');
});

function urlFixture(fetch) {
  const state = { selectedFile: { name: 'existing.mp4' }, analysis: { actions: [{}] }, analysisSession: { saved: true } };
  let handlerCode = source.slice(source.indexOf('async function resolveVideoUrl()'));
  handlerCode = handlerCode.slice(0, handlerCode.indexOf('\nresolveUrlBtn?.addEventListener'));
  return fixture(handlerCode, {
    state, fetch, videoUrlInput: { value: 'https://example.com/new' }, resolveUrlBtn: {},
    setUrlStatus() {}, updateAnalyzeAvailability() {}, renderDebug() {},
    clearPreviousGameResidue: () => assert.fail('failed resolution must keep previous source')
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
      return { ok: true, headers: new Headers({ 'content-length': String(601 * 1024 * 1024) }), body: { getReader() { reads++; } } };
    }
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy'), /600 MB/);
  assert.equal(signal.aborted, true);
  assert.equal(reads, 0);
});

test('download without content length is still bounded and its reader released', async () => {
  let cancelled = false;
  let released = false;
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {}, fetch: async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ done: false, value: { length: 601 * 1024 * 1024 } }),
      cancel: async () => { cancelled = true; }, releaseLock() { released = true; }
    }) } })
  });
  await assert.rejects(f.scope.downloadUrlVideo('/proxy'), /600 MB/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('normal download returns exact bytes and releases its reader', async () => {
  const f = fixture(functions('downloadUrlVideo'), {
    setUrlStatus() {}, fetch: async () => new Response('test-video-bytes', { headers: { 'content-type': 'video/mp4' } })
  });
  const blob = await f.scope.downloadUrlVideo('/proxy');
  assert.equal(await blob.text(), 'test-video-bytes');
  assert.equal(blob.type, 'video/mp4');
});
