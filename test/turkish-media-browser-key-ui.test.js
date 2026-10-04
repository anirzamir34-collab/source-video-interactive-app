import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTurkishMediaClient } from '../public/turkish-media-client.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const slice = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const credentials = slice('const GEMINI_SESSION_KEY', '\nfunction selectedAnalysisModes(');
const badge = slice('function renderQuotaBadge(', '\nconst GEMINI_SESSION_KEY');
const availability = slice('function selectedAnalysisModes(', '\n[\n  els.qualityMode');
const listeners = slice("els.elevenLabsApiKeyInput?.addEventListener('input'", '\nrenderGeminiApiKeyState();');
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
});

class Element extends EventTarget {
  value = ''; checked = false; textContent = ''; disabled = false;
  classes = new Set();
  classList = { add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  replaceChildren() { this.children = []; }
  querySelectorAll() { return []; }
}
class Video extends Element {
  currentTime = 42; paused = true; muted = false; volume = 1; playbackRate = 1;
  pause() { this.paused = true; }
}

function fixture({ capability, geminiStatus } = {}) {
  const els = new Proxy({}, { get(target, id) { return target[id] ||= new Element(); } });
  els.video = new Video(); els.motionMode.checked = true; els.dubMode.checked = true;
  const file = new Blob(['complete source video'], { type: 'audio/mpeg' });
  const storyboard = { frames: ['verified original frame'] };
  const transcript = { version: 1, speakers: [], utterances: [], audioEvents: [] };
  const state = { selectedFile: file, analysisInProgress: false, savedGameBusy: false,
    analysisSession: { file, storyboard, mediaManifest: { version: 1 }, mediaModeKey: 'previous-account' },
    sourceTranscript: transcript, sourceContext: { segments: [] },
    analysis: { actions: [{ startTime: 42, endTime: 45, sourceVerified: true }] },
    activePositionId: 'current-position', activeMovementId: 'current-movement',
    gameCursorTime: 42, maleSceneProgress: 70, consumedActionIds: new Set(['observed-action']),
    voiceCatalog: [{ voiceId: 'previous-account-voice' }], mediaCredentialGeneration: 0, voiceMappingGeneration: 0,
    turkishMediaStatus: { state: 'FAILED' } };
  const requests = [], writes = [], storage = new Map(), timers = new Map();
  let timerId = 0;
  const scope = vm.createContext({ els, state, savedGames: null, $: () => new Element(),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => { writes.push([key, value]); storage.set(key, value); },
      removeItem: key => { storage.delete(key); } },
    fetch: async (url, init = {}) => {
      const request = { url, init }; requests.push(request);
      if (String(url).endsWith('/api/gemini-key-status')) {
        if (geminiStatus) return geminiStatus(request);
        return json({ ok: true, state: 'available', source: new Headers(init.headers).has('x-gemini-api-key') ? 'browser' : 'server',
          message: 'Gemini hazır.' });
      }
      assert.fail(`Unexpected app fetch ${url}`);
    },
    setTimeout: (work, delay) => { const id = ++timerId; timers.set(id, { work, delay }); return id; },
    clearTimeout: id => timers.delete(id), renderMediaControls() {}, renderVoiceMappingPanel() {} });
  vm.runInContext(`${badge}\n${credentials}\n${availability}\n${listeners}`, scope);
  const client = createTurkishMediaClient({ video: els.video,
    getElevenLabsApiKey: scope.activeElevenLabsApiKey, getGeminiApiKey: scope.activeGeminiApiKey,
    fetchImpl: async (url, init = {}) => {
      const request = { url, init }; requests.push(request);
      if (url.endsWith('/capabilities')) {
        if (capability) return capability(request);
        const configured = Boolean(new Headers(init.headers).get('x-elevenlabs-api-key'));
        return json({ configured, transcriptionConfigured: configured, translationConfigured: true });
      }
      if (url.endsWith('/voices')) return json({ voices: [] });
      if (url.endsWith('/uploads/start')) return json({ uploadId: 'same-video', chunkSize: 1024 });
      if (url.endsWith('/uploads/same-video/status')) return json({ receivedChunks: [0] });
      if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'browser-key-job' });
      if (url.endsWith('/jobs/browser-key-job')) return json({ state: 'READY', result: {
        version: 1, sourceTranscript: transcript, subtitles: {}, assets: {} } });
      assert.fail(`Unexpected ${url}`);
    } });
  scope.mediaClient = client;
  return { scope, state, els, client, requests, writes, storage, timers, file, storyboard, transcript,
    async flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.work()); await tick(); } };
}

test('typing an ElevenLabs password alone enables effective capabilities and forwards that key to the real job client with server Gemini fallback', async t => {
  assert.match(html, /ELEVENLABS DOĞAL DUBLAJ/);
  assert.match(html, /id="elevenLabsApiKeyInput" type="password"/);
  assert.match(html, /KENDİ GEMINI API ANAHTARIN/);
  const f = fixture(); t.after(() => f.client.destroy());
  await f.scope.checkTurkishMediaCapabilities();
  assert.match(f.els.dubQuotaStatus.title, /ElevenLabs anahtarını gir/);
  const key = 'typed-elevenlabs-secret-123456789';
  f.els.elevenLabsApiKeyInput.value = key;
  f.els.elevenLabsApiKeyInput.dispatchEvent(new Event('input'));
  assert.equal(f.scope.activeElevenLabsApiKey(), key, 'the Kullan button is not required');
  assert.equal(f.els.analyzeBtn.disabled, false);
  assert.equal(f.els.dubQuotaStatus.textContent, 'Kontrol ediliyor');
  assert.equal([...f.timers.values()][0].delay, 300);
  await f.flush();
  assert.equal(f.els.dubQuotaStatus.textContent, 'Servis hazır');
  await f.client.start(f.file, { outputs: { dub: true, subtitles: true } });
  const job = f.requests.find(request => request.url.endsWith('/jobs') && request.init.method === 'POST');
  assert.equal(new Headers(job.init.headers).get('x-elevenlabs-api-key'), key);
  assert.equal(new Headers(job.init.headers).has('x-gemini-api-key'), false, 'the configured server Gemini key remains the fallback');
  assert.equal(job.init.body.includes(key), false);
  assert.equal(JSON.stringify(f.client.capture()).includes(key), false);
  assert.deepEqual(f.writes, [], 'typing ElevenLabs never writes browser storage');
});

test('typed ElevenLabs assignments and opaque punctuation are normalized before request headers', async t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const key = 'sk_live.v4/+opaque:=credential~1234567890';
  f.els.elevenLabsApiKeyInput.value = `ELEVENLABS_API_KEY="${key}"`;
  f.els.elevenLabsApiKeyInput.dispatchEvent(new Event('input'));
  assert.equal(f.scope.activeElevenLabsApiKey(), key);
  await f.flush();
  await f.client.start(f.file, { outputs: { dub: true, subtitles: true } });
  const job = f.requests.find(request => request.url.endsWith('/jobs') && request.init.method === 'POST');
  assert.equal(new Headers(job.init.headers).get('x-elevenlabs-api-key'), key);
});

test('changing credentials immediately invalidates account media and voices while preserving source evidence, upload bytes, frames and gameplay', t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const analysis = f.state.analysis;
  f.els.voiceMappingRows.children = ['old-account-draft']; f.els.voiceMappingPanel.open = true;
  f.els.elevenLabsApiKeyInput.value = 'new-account-secret-123456789';
  f.els.elevenLabsApiKeyInput.dispatchEvent(new Event('input'));
  assert.equal(f.state.analysisSession.mediaManifest, null);
  assert.equal(f.state.analysisSession.mediaModeKey, '');
  assert.equal(f.state.voiceCatalog, null); assert.equal(f.state.voiceCatalogPromise, null);
  assert.equal(f.state.turkishMediaStatus, null); assert.deepEqual(f.els.voiceMappingRows.children, []);
  assert.equal(f.els.voiceMappingPanel.open, false);
  assert.equal(f.state.analysisSession.file, f.file); assert.equal(f.state.analysisSession.storyboard, f.storyboard);
  assert.equal(f.state.sourceTranscript, f.transcript); assert.equal(f.state.analysis, analysis);
  assert.equal(f.els.video.currentTime, 42); assert.equal(f.state.gameCursorTime, 42);
  assert.equal(f.state.activePositionId, 'current-position'); assert.equal(f.state.activeMovementId, 'current-movement');
  assert.equal(f.state.maleSceneProgress, 70); assert.deepEqual([...f.state.consumedActionIds], ['observed-action']);
});

test('late unconfigured capability responses cannot overwrite the newly typed account availability', async t => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const f = fixture({ capability: request => new Headers(request.init.headers).has('x-elevenlabs-api-key')
    ? json({ configured: true, translationConfigured: true, transcriptionConfigured: true }) : old });
  t.after(() => f.client.destroy());
  const pending = f.scope.checkTurkishMediaCapabilities();
  await tick();
  f.els.elevenLabsApiKeyInput.value = 'fresh-account-key-123456789';
  f.els.elevenLabsApiKeyInput.dispatchEvent(new Event('input'));
  await f.flush();
  resolveOld(json({ configured: false, transcriptionConfigured: false, translationConfigured: true }));
  await pending; await tick();
  assert.equal(f.els.dubQuotaStatus.textContent, 'Servis hazır');
});

test('depleted server Gemini credit is detected before analysis and blocks Turkish media until another key is used', async t => {
  const f = fixture({ geminiStatus: () => json({
    ok: false, state: 'no_credits', source: 'server',
    message: 'Sunucu Gemini kredisi tükendi. Kendi Gemini API anahtarını gir.'
  }, { status: 402 }) });
  t.after(() => f.client.destroy());

  f.els.elevenLabsApiKeyInput.value = 'typed-elevenlabs-secret-123456789';
  f.els.elevenLabsApiKeyInput.dispatchEvent(new Event('input'));
  await f.flush();

  assert.equal(f.scope.activeElevenLabsApiKey(), 'typed-elevenlabs-secret-123456789');
  assert.equal(f.state.geminiProviderStatus.state, 'no_credits');
  assert.equal(f.state.geminiProviderStatus.source, 'server');
  assert.equal(f.els.dubQuotaStatus.textContent, 'Gemini kredisi yok');
  assert.match(f.els.dubQuotaStatus.title, /Sunucu Gemini kredisi tükendi/);
  assert.equal(f.els.apiKeyStatus.textContent, 'Sunucu Gemini kredisi tükendi');
  assert.equal(f.els.analyzeBtn.disabled, true);
});

test('ElevenLabs Kullan and Sil retain a key only in memory and never share Gemini session storage', t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const key = 'memory-elevenlabs-secret-123456789';
  f.els.elevenLabsApiKeyInput.value = key; f.scope.saveElevenLabsApiKey();
  assert.equal(f.els.elevenLabsApiKeyInput.value, ''); assert.equal(f.scope.activeElevenLabsApiKey(), key);
  assert.deepEqual(f.writes, []); assert.equal(JSON.stringify(f.state).includes(key), false);
  f.scope.clearElevenLabsApiKey();
  assert.equal(f.scope.activeElevenLabsApiKey(), ''); assert.deepEqual(f.writes, []);
});

test('an optional saved Gemini browser key takes priority in media headers and clearing it restores the server fallback', async t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const key = 'optional-gemini-secret-123456789';
  f.els.geminiApiKeyInput.value = key; f.scope.saveGeminiApiKey();
  await f.client.getCapabilities();
  const own = f.requests.filter(request => request.url.endsWith('/capabilities')).at(-1);
  assert.equal(new Headers(own.init.headers).get('x-gemini-api-key'), key);
  assert.equal(f.storage.get('videoquest_gemini_api_key'), key, 'existing Gemini session behavior is preserved');
  f.scope.clearGeminiApiKey(); await f.client.getCapabilities();
  const fallback = f.requests.filter(request => request.url.endsWith('/capabilities')).at(-1);
  assert.equal(new Headers(fallback.init.headers).has('x-gemini-api-key'), false);
  assert.equal(JSON.stringify(f.state).includes(key), false);
});
