import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTurkishMediaClient } from '../public/turkish-media-client.js';
import { sourceContextAdapter } from '../public/source-transcript.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return app.slice(from, to);
}

class ClockMedia extends EventTarget {
  _currentTime = 12.25;
  seekWrites = [];
  duration = 40;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  volume = 0.6;
  muted = false;
  src = '';
  pauseCalls = 0;
  get currentTime() { return this._currentTime; }
  set currentTime(value) { this.seekWrites.push(value); this._currentTime = value; }
  pause() { this.paused = true; this.pauseCalls += 1; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function manifest(jobId = 'job-1', voiceMapping = {}) {
  return {
    version: 1, jobId, voiceMapping,
    sourceTranscript: { version: 1, language: 'en', source: { hash: 'same-complete-source', duration: 40 },
      speakers: [{ speakerId: 'source-a', providerId: 'voice-0', gender: null },
        { speakerId: 'source-b', providerId: 'voice-1', gender: 'female' }],
      utterances: [{ segmentId: 'speech-a', speakerId: 'source-a', sourceStart: 12, sourceEnd: 14,
        sourceText: 'Actual source speech.', gender: null }], audioEvents: [] },
    subtitles: { source_tr: [{ start: 12, end: 14, text: 'Kaynak TR' }],
      dub_tr: [{ start: 12, end: 14, text: 'Dublaj TR' }] },
    assets: { mix: { url: `/api/turkish-media/jobs/${jobId}/assets/mix`, mimeType: 'audio/wav', duration: 40 } }
  };
}

const sourceFile = () => {
  const file = new Blob(['123456789'], { type: 'video/mp4' });
  file.name = 'same-source.mp4';
  return file;
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

function clientFixture(handler) {
  const requests = [];
  const audios = [];
  const video = new ClockMedia();
  const client = createTurkishMediaClient({ video,
    AudioClass: class extends ClockMedia { constructor() { super(); audios.push(this); } },
    fetchImpl: async (url, init = {}) => {
      assert.match(String(url), /^\/api\/turkish-media\//, 'only the same-origin backend is contacted');
      for (const name of new Headers(init.headers).keys()) {
        assert.doesNotMatch(name, /authorization|api[-_]?key|gemini|elevenlabs/i);
      }
      const request = { url: String(url), init };
      requests.push(request);
      return handler(request);
    },
    urlImpl: { createObjectURL: () => 'blob:preserved-final-audio', revokeObjectURL() {} },
    chunkSize: 3, pollIntervalMs: 1, retryDelayMs: 1, requestTimeoutMs: 1000
  });
  return { client, requests, video, audios };
}

test('voice catalogue requests use the backend and return only public voice fields', async t => {
  const f = clientFixture(({ url }) => {
    assert.equal(url, '/api/turkish-media/voices');
    return json({ voices: [
      { voiceId: 'catalogue-custom-a', name: 'Katalog Ses A', gender: 'male', language: 'tr',
        apiKey: 'secret', authorization: 'Bearer private', settings: { providerCredential: 'secret' } },
      { voiceId: 'catalogue-custom-b', gender: 'unknown', language: 42, extra: 'private' },
      { voiceId: '', name: 'Invalid empty ID' }, { voiceId: 123, name: 'Invalid numeric ID' }
    ] });
  });
  t.after(() => f.client.destroy());
  assert.deepEqual(await f.client.getVoices(), [
    { voiceId: 'catalogue-custom-a', name: 'Katalog Ses A', gender: 'male', language: 'tr' },
    { voiceId: 'catalogue-custom-b', name: 'catalogue-custom-b', gender: 'uncertain', language: '' }
  ]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.credentials, 'same-origin');
  assert.equal(f.audios.length, 0);
});

test('manual mapping job options preserve outputs and resume the same source upload instead of resending its chunks', async t => {
  const completed = new Set();
  const plans = [];
  let jobCount = 0;
  const f = clientFixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'same-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/same-upload/status')) return json({ completedChunks: [...completed] });
    if (/\/uploads\/same-upload\/chunk\/\d$/.test(url)) {
      completed.add(Number(url.split('/').at(-1)));
      return json({ complete: true });
    }
    if (url.endsWith('/jobs') && init.method === 'POST') {
      plans.push(JSON.parse(init.body));
      jobCount += 1;
      return json({ jobId: `job-${jobCount}` });
    }
    const match = url.match(/\/jobs\/(job-\d)$/);
    if (match) return json({ id: match[1], state: 'READY', result: manifest(match[1], plans.at(-1).voiceMapping) });
    throw new Error(`Unexpected mapping request ${url}`);
  });
  t.after(() => f.client.destroy());
  const file = sourceFile();
  const outputs = { dub: true, subtitles: false };
  await f.client.start(file, { outputs, voiceMapping: { 'source-a': 'catalogue-custom-a' } });
  const chunksAfterFirstJob = f.requests.filter(request => /\/chunk\//.test(request.url)).length;
  await f.client.start(file, { outputs, qualityMode: 'quality',
    voiceMapping: { 'source-a': 'catalogue-custom-b', apiKey: 'never-send-this' },
    previousVoiceMapping: { 'source-a': 'catalogue-custom-a', authorization: 'never-send-this' },
    sceneContext: [{ startTime: 12, endTime: 14, description: 'Observed in source' }] });
  assert.equal(chunksAfterFirstJob, 3);
  assert.equal(f.requests.filter(request => /\/chunk\//.test(request.url)).length, chunksAfterFirstJob);
  const uploads = f.requests.filter(request => request.url.endsWith('/uploads/start')).map(request => JSON.parse(request.init.body));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].clientUploadKey, uploads[1].clientUploadKey);
  assert.deepEqual(plans[1].outputs, outputs);
  assert.equal(plans[1].qualityMode, 'quality');
  assert.deepEqual(plans[1].voiceMapping, { 'source-a': 'catalogue-custom-b' });
  assert.deepEqual(plans[1].previousVoiceMapping, { 'source-a': 'catalogue-custom-a' });
  assert.deepEqual(plans[1].sceneContext, [{ startTime: 12, endTime: 14, description: 'Observed in source' }]);
  assert.deepEqual(f.video.seekWrites, []);
});

test('restoring the previous final audio preserves a failed regeneration job for backend retry', async t => {
  const previous = manifest('previous-job', { 'source-a': 'old-voice' });
  const oldAudio = new Blob(['previous final soundtrack'], { type: 'audio/wav' });
  const f = clientFixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'regenerate-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/regenerate-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'failed-regeneration' });
    if (url.endsWith('/jobs/failed-regeneration')) return json({ id: 'failed-regeneration', state: 'FAILED', error: 'Voice generation failed' });
    if (url.endsWith('/jobs/failed-regeneration/retry') && init.method === 'POST') return json({ jobId: 'retried-regeneration' });
    if (url.endsWith('/jobs/retried-regeneration')) {
      return json({ id: 'retried-regeneration', state: 'READY', result: manifest('retried-regeneration', { 'source-a': 'new-voice' }) });
    }
    throw new Error(`Unexpected restore request ${url}`);
  });
  t.after(() => f.client.destroy());
  f.client.loadResult(previous, { audioBlob: oldAudio, dubEnabled: false, subtitleTrack: 'source_tr', syncOffset: -0.25 });
  await assert.rejects(f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true },
    voiceMapping: { 'source-a': 'new-voice' }, previousVoiceMapping: previous.voiceMapping }), /Voice generation failed/);
  f.client.loadResult(previous, { audioBlob: oldAudio, preserveJob: true,
    dubEnabled: false, subtitleTrack: 'source_tr', syncOffset: -0.25 });
  assert.equal(await f.client.materializeAudio(), oldAudio);
  assert.equal(f.client.capture().manifest.jobId, 'previous-job');
  assert.equal(f.client.capture().dubEnabled, false);
  assert.equal(f.client.capture().subtitleTrack, 'source_tr');
  assert.equal(f.client.capture().syncOffset, -0.25);
  await f.client.retry();
  assert.equal(f.requests.filter(request => request.url.endsWith('/failed-regeneration/retry')).length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/jobs')).length, 1, 'retry keeps the failed job descriptor');
  assert.equal(f.requests.filter(request => request.url.endsWith('/uploads/start')).length, 1);
  assert.equal(f.client.capture().manifest.jobId, 'retried-regeneration');
  assert.deepEqual(f.video.seekWrites, []);
});

class Element {
  constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); }
  children = [];
  dataset = {};
  listeners = new Map();
  classes = new Set();
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  open = true;
  clickCalls = 0;
  classList = {
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
  };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  click() { this.clickCalls += 1; return this.listeners.get('click')?.(); }
  querySelectorAll(tag) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(node => tag === '*' || node.tagName === tag.toUpperCase());
  }
}

const catalogue = [
  { voiceId: 'catalogue-custom-a', name: 'Katalog Ses A', gender: 'male', language: 'tr' },
  { voiceId: 'catalogue-custom-b', name: 'Katalog Ses B', gender: 'female', language: 'tr' }
];

function uiFixture({ start, retry, manual = true } = {}) {
  const previous = { manifest: manifest('previous-job', { 'source-a': 'catalogue-custom-a', 'source-b': 'catalogue-custom-b' }),
    dubEnabled: false, subtitleTrack: 'source_tr', syncOffset: -0.25 };
  let captured = previous;
  const oldAudio = new Blob(['previous soundtrack'], { type: 'audio/wav' });
  const source = sourceFile();
  const choices = new Element();
  choices.append(new Element('button'), new Element('button'));
  const els = new Proxy({ video: new ClockMedia(), choices }, {
    get(target, key) { return target[key] ||= new Element(); }
  });
  els.motionMode.checked = true;
  els.subtitleMode.checked = true;
  els.dubMode.checked = true;
  const session = { file: source, mediaManifest: previous.manifest };
  const state = { selectedFile: source, analysisSession: session, sourceTranscript: previous.manifest.sourceTranscript,
    voiceCatalog: catalogue, voiceMappingManualRequested: manual, voiceMappingGeneration: 0, analysisInProgress: false, savedGameBusy: false,
    savedGameReady: true, gameState: 'DECISION_PENDING', mediaRevoice: null,
    activePositionId: 'position-2', activeAdultOccurrenceId: 'occurrence-2', activeMovementId: 'movement-2',
    gameCursorTime: 12.25, adultProgress: 61, adultMovementPlayCounts: new Map([['movement-2', 2]]),
    activeAction: { id: 'selected-source-action', startTime: 12, endTime: 14 },
    analysis: { actions: [
      { startTime: 12, endTime: 14, sourceVerified: true, sourceEvidence: 'Original observed scene' },
      { startTime: 90, endTime: 92, sourceVerified: false, label: 'Invented scene must be excluded' },
      { startTime: 4, endTime: 3, sourceVerified: true, label: 'Invalid source range' }
    ] } };
  const calls = { start: [], retry: 0, load: [], materialize: 0, toggles: [], save: [], statuses: [], availability: [] };
  const mediaClient = {
    capture: () => captured,
    reset: () => { captured = null; },
    getVoices: async () => catalogue,
    materializeAudio: async () => { calls.materialize += 1; return oldAudio; },
    start: async (file, options) => {
      calls.start.push({ file, options: copy(options) });
      captured = null;
      const result = start ? await start(file, options) : manifest('regenerated-job', options.voiceMapping);
      captured = { manifest: result, dubEnabled: true, subtitleTrack: 'dub_tr', syncOffset: 0 };
      return result;
    },
    retry: async () => {
      calls.retry += 1;
      const result = retry ? await retry() : manifest('retried-job');
      captured = { manifest: result, dubEnabled: true, subtitleTrack: 'dub_tr', syncOffset: 0 };
      return result;
    },
    loadResult: (result, settings) => {
      calls.load.push({ manifest: result, settings });
      captured = { manifest: result, dubEnabled: settings.dubEnabled, subtitleTrack: settings.subtitleTrack, syncOffset: settings.syncOffset };
      return result;
    },
    setDubEnabled: value => { calls.toggles.push(['dubEnabled', value]); captured.dubEnabled = value; },
    setSubtitleTrack: value => { calls.toggles.push(['subtitleTrack', value]); captured.subtitleTrack = value; },
    setSyncOffset: value => { calls.toggles.push(['syncOffset', value]); captured.syncOffset = value; }
  };
  const scope = vm.createContext({ state, els, Blob, DOMException, mediaClient, sourceContextAdapter,
    document: { createElement: tag => new Element(tag) },
    savedGames: { saveCurrent: async forced => { calls.save.push(forced); }, resetCurrent() {} },
    updateAnalyzeAvailability: () => calls.availability.push(state.analysisInProgress),
    renderMediaControls: () => {},
    onTurkishMediaStatus: value => calls.statuses.push(copy(value))
  });
  const code = [
    section('function selectedAnalysisModes(', '\nfunction updateAnalysisModesUI('),
    section('function updateSourceTranscript(', '\nfunction onTurkishMediaStatus('),
    section('function renderVoiceMappingPanel(', '\nels.voiceMappingPanel?.addEventListener('),
    section('function verifiedSpeakerVoiceHints(', '\nfunction restorePreviousVoices('),
    section("els.voiceMappingApplyBtn?.addEventListener('click'", '\nfunction analysisSourceKey('),
    section('async function captureSavedGame(', '\nasync function openSavedGame(')
  ].join('\n');
  vm.runInContext(code, scope);
  return { scope, els, state, session, previous, source, oldAudio, calls, mediaClient };
}

test('verified visual character matches turn four raw speaker IDs into two automatic voice profiles', () => {
  const f = uiFixture({ manual: false });
  f.state.analysis = { storyContext: {
    emotionalTone: 'intense',
    characters: [
      { id: 'MAIN', participantTrackId: 'MAIN_MALE', sourceRole: 'erkek', gender: 'male',
        voiceTone: 'energetic', voiceEmotion: 'excited', evidenceLevel: 'fact',
        speakerIds: ['raw-1', 'raw-3'], voiceMatchEvidence: 'Kaynakta aynı erkek konuşuyor.' },
      { id: 'WOMAN', participantTrackId: 'PARTNER_A', sourceRole: 'kadın', gender: 'female',
        voiceTone: 'warm', voiceEmotion: 'calm', evidenceLevel: 'fact',
        speakerIds: ['raw-2', 'raw-4'], voiceMatchEvidence: 'Kaynakta aynı kadın konuşuyor.' },
    ]
  } };
  const hints = f.scope.verifiedSpeakerVoiceHints();
  assert.deepEqual(Object.keys(hints).sort(), ['raw-1', 'raw-2', 'raw-3', 'raw-4']);
  assert.deepEqual(copy(hints['raw-1']), { characterId: 'MAIN', gender: 'male', emotion: 'excited', tone: 'energetic' });
  assert.deepEqual(copy(hints['raw-4']), { characterId: 'WOMAN', gender: 'female', emotion: 'calm', tone: 'warm' });
});

test('ambiguous raw speaker IDs matched to two visible people are not forced into one character voice', () => {
  const f = uiFixture({ manual: false });
  f.state.analysis = { storyContext: { characters: [
    { id: 'A', participantTrackId: 'MAIN_MALE', evidenceLevel: 'fact', gender: 'male',
      speakerIds: ['raw-conflict'], voiceMatchEvidence: 'İlk aralıkta erkek konuşuyor.' },
    { id: 'B', participantTrackId: 'PARTNER_A', evidenceLevel: 'fact', gender: 'female',
      speakerIds: ['raw-conflict'], voiceMatchEvidence: 'Başka aralıkta kadın konuşuyor.' },
  ] } };
  assert.deepEqual(copy(f.scope.verifiedSpeakerVoiceHints()), {});
});

test('normal VideoQuest flow keeps manual speaker voice selection hidden', () => {
  const f = uiFixture({ manual: false });
  f.els.voiceMappingPanel.open = true;
  f.scope.renderVoiceMappingPanel();
  assert.equal(f.els.voiceMappingPanel.open, false);
  assert.equal(f.els.voiceMappingRows.children.length, 0);
  assert.equal(f.els.voiceMappingPanel.classes.has('hidden'), true);
});

test('manual voice UI labels uncertain source gender and displays catalogue names and IDs without invented defaults', () => {
  const f = uiFixture();
  f.scope.renderVoiceMappingPanel();
  const rows = f.els.voiceMappingRows.children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, 'Konuşmacı 1 · Belirsiz');
  assert.equal(rows[1].children[0].textContent, 'Konuşmacı 2 · Kadın');
  const selects = f.els.voiceMappingRows.querySelectorAll('select');
  assert.deepEqual(selects[0].options.map(option => option.value), ['', ...catalogue.map(voice => voice.voiceId)]);
  assert.deepEqual(selects[0].options.map(option => option.textContent), [
    'Otomatik ses seçimi', 'Katalog Ses A · Erkek · tr', 'Katalog Ses B · Kadın · tr'
  ]);
  assert.equal(selects[0].dataset.speakerId, 'source-a');
  assert.equal(selects[0].value, 'catalogue-custom-a');
  assert.equal(selects[1].value, 'catalogue-custom-b');
  assert.equal(f.els.voiceMappingApplyBtn.disabled, false);
});

test('applying catalogue voice IDs preserves original video range, gameplay state, output flags and prior playback settings', async () => {
  const f = uiFixture();
  f.scope.renderVoiceMappingPanel();
  const selects = f.els.voiceMappingRows.querySelectorAll('select');
  selects[0].value = 'catalogue-custom-b';
  selects[1].value = 'catalogue-custom-a';
  const choices = [...f.els.choices.children];
  const action = f.state.activeAction;
  const counts = f.state.adultMovementPlayCounts;
  await f.els.voiceMappingApplyBtn.click();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.start[0].file, f.source);
  assert.deepEqual(f.calls.start[0].options, {
    outputs: { dub: true, subtitles: true }, qualityMode: 'quality',
    voiceMapping: { 'source-a': 'catalogue-custom-b', 'source-b': 'catalogue-custom-a' },
    previousVoiceMapping: f.previous.manifest.voiceMapping,
    sceneContext: [{ startTime: 12, endTime: 14, description: 'Original observed scene' }]
  });
  assert.equal(f.els.video.currentTime, 12.25);
  assert.deepEqual(f.els.video.seekWrites, []);
  assert.equal(f.els.video.pauseCalls, 1);
  assert.deepEqual(f.els.choices.children, choices);
  assert.equal(f.state.activePositionId, 'position-2');
  assert.equal(f.state.activeAdultOccurrenceId, 'occurrence-2');
  assert.equal(f.state.activeMovementId, 'movement-2');
  assert.equal(f.state.activeAction, action);
  assert.equal(f.state.adultMovementPlayCounts, counts);
  assert.equal(f.state.adultMovementPlayCounts.get('movement-2'), 2);
  assert.equal(f.state.adultProgress, 61);
  assert.equal(f.state.gameCursorTime, 12.25);
  assert.equal(f.state.gameState, 'DECISION_PENDING');
  assert.deepEqual(f.calls.toggles, [['dubEnabled', false], ['subtitleTrack', 'source_tr'], ['syncOffset', -0.25]]);
  assert.equal(f.mediaClient.capture().dubEnabled, false);
  assert.equal(f.mediaClient.capture().subtitleTrack, 'source_tr');
  assert.equal(f.mediaClient.capture().syncOffset, -0.25);
  assert.equal(f.session.mediaManifest.jobId, 'regenerated-job');
  assert.equal(f.state.mediaRevoice, null);
  assert.equal(f.state.analysisInProgress, false);
  assert.deepEqual(f.calls.save, [true]);
});

test('duplicate explicitly selected voices are rejected before spending regeneration work', async () => {
  const f = uiFixture();
  f.scope.renderVoiceMappingPanel();
  for (const select of f.els.voiceMappingRows.querySelectorAll('select')) select.value = 'catalogue-custom-a';
  await f.els.voiceMappingApplyBtn.click();
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.materialize, 0);
  assert.match(f.els.voiceMappingMessage.textContent, /Her konuşmacı için ayrı bir ses/);
  assert.deepEqual(f.els.video.seekWrites, []);
});

test('failed voice regeneration restores previous final audio and keeps the failed plan available for retry', async () => {
  const f = uiFixture({ start: async () => { throw new Error('New voices failed'); } });
  const plan = { source: f.source, previous: f.previous, session: f.session, started: false,
    options: { outputs: { dub: true, subtitles: true }, qualityMode: 'quality',
      voiceMapping: { 'source-a': 'catalogue-custom-b' }, previousVoiceMapping: f.previous.manifest.voiceMapping, sceneContext: [] } };
  await f.scope.regenerateTurkishVoices(plan);
  assert.equal(f.calls.load.length, 1);
  assert.equal(f.calls.load[0].manifest, f.previous.manifest);
  assert.equal(f.calls.load[0].settings.audioBlob, f.oldAudio);
  assert.equal(f.calls.load[0].settings.preserveJob, true);
  assert.equal(f.calls.load[0].settings.dubEnabled, false);
  assert.equal(f.calls.load[0].settings.subtitleTrack, 'source_tr');
  assert.equal(f.calls.load[0].settings.syncOffset, -0.25);
  assert.equal(f.state.mediaRevoice, plan);
  assert.equal(f.state.analysisInProgress, false);
  assert.match(f.els.voiceMappingMessage.textContent, /New voices failed.*Önceki Türkçe ses korundu/);
  assert.equal(f.calls.statuses.at(-1).state, 'FAILED');
  await f.scope.regenerateTurkishVoices(plan, true);
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.retry, 1);
  assert.equal(f.calls.materialize, 1, 'retry reuses the preserved previous mix Blob');
  assert.equal(f.state.mediaRevoice, null);
  assert.deepEqual(f.els.video.seekWrites, []);
});

test('saved-game capture declines an in-progress voice replacement before reading an incomplete mix', async () => {
  const f = uiFixture();
  f.state.mediaRevoice = { started: true };
  f.state.analysisInProgress = true;
  f.mediaClient.capture = () => assert.fail('regeneration cannot save unfinished soundtrack metadata');
  assert.equal(await f.scope.captureSavedGame(), null);
  assert.equal(f.calls.materialize, 0);
});

test('source cleanup removes old voice drafts before rendering another saved mapping for the same speaker IDs', () => {
  const f = uiFixture();
  f.scope.renderVoiceMappingPanel();
  f.els.voiceMappingRows.querySelectorAll('select')[0].value = 'catalogue-custom-b';
  Object.assign(f.scope, {
    RUNTIME_SAVE_KEY: 'runtime', videoDownloads: { release: async () => {} },
    cancelTimelineNavigation() {}, cancelAdultSeek() {}, clearInteractionSelection() {}, removeStoredValue() {},
    releaseVideoObjectUrl() {}, updateLanguageSyncControls() {}, setGameState(value) { f.state.gameState = value; }
  });
  vm.runInContext(section('function clearPreviousGameResidue()', '\nclearPreviousGameResidue();'), f.scope);
  f.scope.clearPreviousGameResidue();
  assert.equal(f.els.voiceMappingRows.children.length, 0);
  assert.equal(f.els.voiceMappingPanel.open, false);
  assert.equal(f.state.voiceMappingGeneration, 1);
  f.state.sourceTranscript = f.previous.manifest.sourceTranscript;
  f.mediaClient.loadResult(f.previous.manifest, f.previous);
  f.els.voiceMappingPanel.open = true;
  f.scope.renderVoiceMappingPanel();
  assert.equal(f.els.voiceMappingRows.querySelectorAll('select')[0].value, 'catalogue-custom-a', 'previous source draft cannot override a newly loaded mapping');
});

test('late completion of a previous voice regeneration cannot unlock a newer analysis', async () => {
  const pending = deferred();
  const f = uiFixture({ start: () => pending.promise });
  const plan = { source: f.source, previous: f.previous, session: f.session, started: false,
    options: { outputs: { dub: true, subtitles: true }, qualityMode: 'quality',
      voiceMapping: { 'source-a': 'catalogue-custom-b' }, sceneContext: [] } };
  const running = f.scope.regenerateTurkishVoices(plan);
  await tick();
  assert.equal(f.calls.start.length, 1);
  const newerPlan = { newer: true };
  f.state.voiceMappingGeneration += 1;
  f.state.mediaRevoice = newerPlan;
  f.state.analysisInProgress = true;
  pending.resolve(manifest('stale-job'));
  await running;
  assert.equal(f.state.analysisInProgress, true);
  assert.equal(f.state.mediaRevoice, newerPlan);
  assert.equal(f.calls.availability.includes(false), false, 'stale finally cannot reenable controls');
  assert.equal(f.session.mediaManifest.jobId, 'previous-job');
  assert.equal(f.state.sourceTranscript, f.previous.manifest.sourceTranscript);
  assert.equal(f.els.analyzeBtn.clickCalls, 0);
  assert.deepEqual(f.els.video.seekWrites, []);
});
