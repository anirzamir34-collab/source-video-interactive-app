import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurkishMediaClient } from '../public/turkish-media-client.js';

class Media extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this.seekWrites = [];
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 4;
    this.duration = 60;
    this.playbackRate = 1;
    this.volume = 0.65;
    this.muted = false;
    this.src = '';
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.playResult = null;
  }
  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    this.seekWrites.push(value);
    this._currentTime = value;
  }
  sourceTime(value) { this._currentTime = value; }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return this.playResult ?? Promise.resolve();
  }
  pause() { this.pauseCalls += 1; this.paused = true; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  fire(name) { this.dispatchEvent(new Event(name)); }
}

class CaptionNode {
  constructor(children = []) {
    this.children = children;
    this.textContent = '';
    this.hidden = false;
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => {
        const next = enabled ?? !this.classes.has(name);
        if (next) this.classes.add(name); else this.classes.delete(name);
        return next;
      }
    };
  }
  set innerHTML(value) { throw new Error(`Caption nodes must stay mounted: ${value}`); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
}

const transcript = {
  language: 'en',
  duration: 60,
  speakers: [{ id: 'speaker-1', name: 'Kaynak konuşmacı', gender: 'male' }],
  segments: [{ id: 'speech-1', start: 1, end: 3, startTime: 1, endTime: 3,
    text: 'Source evidence', speakerId: 'speaker-1' }]
};

function manifest(jobId = 'job-a') {
  return {
    version: 1,
    jobId,
    duration: 60,
    sourceTranscript: structuredClone(transcript),
    subtitles: {
      source_tr: [
        { id: 'source-1', start: 0, end: 2, text: 'Birinci kaynak altyazı', speakerId: 'speaker-1', speakerName: 'Erkek' },
        { id: 'source-2', startTime: 1, endTime: 3, text: 'Çakışan kaynak altyazı', speakerId: 'speaker-2', speakerName: 'Kadın' }
      ],
      dub_tr: [{ id: 'dub-1', start: 0, end: 3, text: 'Türkçe dublaj altyazısı', speakerId: 'speaker-1', speakerName: 'Erkek' }]
    },
    assets: { mix: { url: `/api/turkish-media/jobs/${jobId}/assets/mix`, mimeType: 'audio/wav', duration: 60 } }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fixture(fetchHandler = () => new Response('final mix', { headers: { 'content-type': 'audio/wav' } }), options = {}) {
  const video = new Media();
  const speaker = new CaptionNode();
  const text = new CaptionNode();
  const overlay = new CaptionNode([speaker, text]);
  const audios = [];
  const requests = [];
  const statuses = [];
  class Audio extends Media {
    constructor(src) {
      super();
      if (src) this.src = src;
      audios.push(this);
    }
  }
  const client = createTurkishMediaClient({
    video,
    captionElements: { overlay, speaker, text },
    AudioClass: Audio,
    fetchImpl: async (url, init = {}) => {
      const request = { url: String(url), init };
      requests.push(request);
      return fetchHandler(request, requests.length);
    },
    onStatus: value => statuses.push(value),
    pollIntervalMs: 1,
    retryDelayMs: 1,
    requestTimeoutMs: 1000,
    chunkSize: 3,
    ...options
  });
  return { client, video, audios, overlay, speaker, text, requests, statuses };
}

function statusState(value) { return String(value?.state ?? value?.status ?? '').toUpperCase(); }

function sourceFile() {
  const file = new Blob(['123456789'], { type: 'audio/mpeg' });
  file.name = 'source.wav';
  return file;
}

test('resumable upload sends only missing chunks and reports source evidence before READY without browser credentials', async t => {
  let polls = 0;
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'upload-a', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/upload-a/status')) return json({ uploadId: 'upload-a', chunkSize: 3, totalChunks: 3, completedChunks: [0, 2] });
    if (url.endsWith('/uploads/upload-a/chunk/1')) return json({ uploadId: 'upload-a', chunkIndex: 1, complete: true });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'job-a', statusUrl: '/api/turkish-media/jobs/job-a' });
    if (url.endsWith('/jobs/job-a')) {
      polls += 1;
      return json(polls === 1
        ? { id: 'job-a', state: 'TRANSCRIBED', progress: 35, sourceTranscript: transcript }
        : { id: 'job-a', state: 'READY', progress: 100, result: manifest() });
    }
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
  });
  t.after(() => f.client.destroy());
  await f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true }, qualityMode: 'quality', sceneContext: [] });
  const chunks = f.requests.filter(request => /\/chunk\//.test(request.url));
  assert.deepEqual(chunks.map(request => request.url), ['/api/turkish-media/uploads/upload-a/chunk/1']);
  assert.equal(await chunks[0].init.body.text(), '456');
  for (const { url, init } of f.requests) {
    assert.match(url, /^\/api\/turkish-media\//);
    const headers = new Headers(init.headers);
    for (const key of headers.keys()) assert.doesNotMatch(key, /authorization|api[-_]?key|gemini|elevenlabs/i);
  }
  const sourceIndex = f.statuses.findIndex(value => value?.sourceTranscript?.segments?.length);
  const readyIndex = f.statuses.findIndex(value => statusState(value) === 'READY');
  assert.ok(sourceIndex >= 0, 'source transcript is emitted for gameplay evidence');
  assert.ok(readyIndex > sourceIndex, 'transcript arrives before final mix readiness');
  assert.ok(JSON.stringify(f.client.capture()).includes('Source evidence'));
});

test('browser provider keys are read dynamically only for capabilities, voices, job creation and retry headers', async t => {
  let elevenLabsKey = 'browser-elevenlabs-key-1234567890';
  let geminiKey = '';
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/capabilities')) return json({ configured: true });
    if (url.endsWith('/voices')) return json({ voices: [{ voiceId: 'catalogue-voice', name: 'Ses', gender: 'male' }] });
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'upload-keys', chunkSize: 3 });
    if (url.endsWith('/uploads/upload-keys/status')) return json({ receivedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'failed-key-job' });
    if (url.endsWith('/jobs/failed-key-job')) return json({ state: 'FAILED', error: { message: 'Retry required' } });
    if (url.endsWith('/jobs/failed-key-job/retry')) return json({ jobId: 'ready-key-job' });
    if (url.endsWith('/jobs/ready-key-job')) return json({ state: 'READY', result: manifest('ready-key-job') });
    if (url.endsWith('/assets/mix')) return new Response('final sound', { headers: { 'Content-Type': 'audio/wav' } });
    assert.fail(`Unexpected request ${url}`);
  }, { getElevenLabsApiKey: () => elevenLabsKey, getGeminiApiKey: () => geminiKey });
  t.after(() => f.client.destroy());
  await f.client.getCapabilities();
  await f.client.getVoices();
  await assert.rejects(f.client.start(sourceFile()), /Retry required/);
  geminiKey = 'browser-gemini-key-1234567890';
  await f.client.retry();
  await f.client.materializeAudio();
  for (const { url, init } of f.requests) {
    const headers = new Headers(init.headers);
    const providerRoute = url.endsWith('/capabilities') || url.endsWith('/voices') ||
      (init.method === 'POST' && (url.endsWith('/jobs') || url.endsWith('/retry')));
    assert.equal(headers.get('x-elevenlabs-api-key'), providerRoute ? elevenLabsKey : null, url);
    assert.equal(headers.get('x-gemini-api-key'), url.endsWith('/retry') ? geminiKey : null, url);
    if (typeof init.body === 'string') {
      assert.equal(init.body.includes(elevenLabsKey), false);
      assert.equal(init.body.includes(geminiKey), false);
    }
  }
  const serialized = JSON.stringify({ captured: f.client.capture(), statuses: f.statuses });
  assert.equal(serialized.includes(elevenLabsKey), false);
  assert.equal(serialized.includes(geminiKey), false);
});

test('empty browser key getters leave server credentials as the provider fallback', async t => {
  const f = fixture(() => json({ configured: true }), {
    getElevenLabsApiKey: () => ' ', getGeminiApiKey: () => ''
  });
  t.after(() => f.client.destroy());
  await f.client.getCapabilities();
  assert.equal(new Headers(f.requests[0].init.headers).has('x-elevenlabs-api-key'), false);
  assert.equal(new Headers(f.requests[0].init.headers).has('x-gemini-api-key'), false);
});

test('a failed backend job surfaces its failure and never pretends final media is ready', async t => {
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'failed-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/failed-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'failed-job' });
    if (url.endsWith('/jobs/failed-job')) return json({ id: 'failed-job', state: 'FAILED', progress: 50, error: 'Provider rejected the audio' });
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  await assert.rejects(f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true } }), /Provider rejected the audio/);
  assert.ok(f.statuses.some(value => ['FAILED', 'ERROR'].includes(statusState(value))));
  assert.equal(f.statuses.some(value => statusState(value) === 'READY'), false);
  assert.equal(f.audios.some(audio => audio.src), false);
});

test('reset ignores a READY job response that arrives after cancellation', async t => {
  const pendingJob = deferred();
  const jobRequested = deferred();
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'old-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/old-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'old-job' });
    if (url.endsWith('/jobs/old-job')) { jobRequested.resolve(); return pendingJob.promise; }
    if (url.endsWith('/cancel')) return json({ state: 'CANCELLED' });
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  const started = f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true } });
  const settled = Promise.resolve(started).catch(() => null);
  await jobRequested.promise;
  f.client.reset();
  const statusCount = f.statuses.length;
  pendingJob.resolve(json({ id: 'old-job', state: 'READY', result: manifest('old-job') }));
  await settled;
  await settle();
  assert.equal(f.statuses.slice(statusCount).some(value => statusState(value) === 'READY'), false);
  assert.equal(JSON.stringify(f.client.capture()).includes('old-job'), false);
  assert.equal(f.audios.some(audio => audio.src.includes('old-job')), false);
});

test('source switch keeps the new manifest when an old job finishes late', async t => {
  const pendingJob = deferred();
  const jobRequested = deferred();
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'old-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/old-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'old-job' });
    if (url.endsWith('/jobs/old-job')) { jobRequested.resolve(); return pendingJob.promise; }
    if (url.endsWith('/cancel')) return json({ state: 'CANCELLED' });
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  const started = f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true } });
  const settled = Promise.resolve(started).catch(() => null);
  await jobRequested.promise;
  await f.client.loadResult(manifest('new-job'));
  pendingJob.resolve(json({ id: 'old-job', state: 'READY', result: manifest('old-job') }));
  await settled;
  await settle();
  const saved = JSON.stringify(f.client.capture());
  assert.ok(saved.includes('new-job'));
  assert.equal(saved.includes('old-job'), false);
});

test('final mix follows the video clock and lifecycle without controlling video playback or seeking', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  f.video.sourceTime(5);
  await f.client.loadResult(manifest());
  f.client.setDubEnabled(true);
  f.video.paused = false;
  f.video.fire('playing');
  f.client.sync();
  await settle();
  const audio = f.audios.findLast(value => value.src);
  assert.ok(audio, 'one final mix audio element is loaded');
  assert.equal(audio.currentTime, 5);
  assert.equal(audio.paused, false);
  assert.equal(f.video.muted, true);
  f.video.playbackRate = 1.5;
  f.video.fire('ratechange');
  assert.equal(audio.playbackRate, 1.5);
  f.video.volume = 0.3;
  f.video.fire('volumechange');
  assert.equal(audio.volume, 0.3);
  f.video.paused = true;
  f.video.fire('pause');
  assert.equal(audio.paused, true);
  f.video.paused = false;
  f.video.seeking = true;
  f.video.sourceTime(12);
  f.video.fire('seeking');
  assert.equal(audio.paused, true);
  f.video.seeking = false;
  f.video.fire('seeked');
  await settle();
  assert.equal(audio.currentTime, 12);
  f.video.fire('waiting');
  assert.equal(audio.paused, true);
  f.video.fire('playing');
  await settle();
  assert.equal(audio.paused, false);
  f.client.setSyncOffset(0.25);
  f.client.sync();
  assert.equal(audio.currentTime, 12.25);
  f.video.ended = true;
  f.video.fire('ended');
  assert.equal(audio.paused, true);
  assert.deepEqual(f.video.seekWrites, [], 'client never writes video.currentTime');
  assert.equal(f.video.playCalls, 0, 'client never starts the source video');
  assert.equal(f.video.pauseCalls, 0, 'client never pauses the source video');
});

test('rapid scene skip waits for the dubbed MP3 seek to finish before playing the new dialogue', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest());
  f.client.setDubEnabled(true);
  f.video.paused = false;
  f.video.sourceTime(4);
  f.video.fire('playing');
  await settle();
  const audio = f.audios.findLast(value => value.src);
  assert.equal(audio.paused, false);

  // A real mobile MP3 decoder can still be seeking after the video seeked.
  f.video.seeking = true;
  f.video.sourceTime(45);
  f.video.fire('seeking');
  audio.seeking = true;
  const playedBefore = audio.playCalls;
  f.video.seeking = false;
  f.video.fire('seeked');
  f.client.sync();
  await settle();
  assert.equal(audio.paused, true);
  assert.equal(audio.playCalls, playedBefore, 'no stale audio is played while decoder is seeking');

  // Decoding the older target must not start it either.
  audio.seeking = false;
  audio.fire('seeked');
  audio.seeking = true;
  f.client.sync();
  assert.equal(audio.currentTime, 45);
  assert.equal(audio.paused, true);
  audio.seeking = false;
  audio.fire('seeked');
  await settle();
  assert.equal(audio.currentTime, 45);
  assert.equal(audio.paused, false);
  assert.deepEqual(f.video.seekWrites, [], 'never seek the source video from dub sync');
});

test('dub disable and reset restore the video original mute state', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest());
  f.client.setDubEnabled(true);
  assert.equal(f.video.muted, false, 'enabling while paused does not silence the source');
  f.video.paused = false;
  f.video.fire('playing');
  await settle();
  assert.equal(f.video.muted, true);
  f.client.setDubEnabled(false);
  assert.equal(f.video.muted, false);
  f.video.muted = true;
  f.client.setDubEnabled(true);
  f.client.setDubEnabled(false);
  assert.equal(f.video.muted, true, 'a source originally muted remains muted');
  f.video.muted = false;
  f.client.setDubEnabled(true);
  f.client.reset();
  assert.equal(f.video.muted, false);
});

test('dub rejection and decode failure restore source sound and a successful retry mutes it', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest());
  const audio = f.audios.findLast(value => value.src);
  audio.playResult = Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  f.client.setDubEnabled(true);
  f.video.paused = false;
  f.video.fire('playing');
  await settle();
  assert.equal(f.video.muted, false);
  audio.playResult = null;
  f.client.setDubEnabled(false);
  f.client.setDubEnabled(true);
  await settle();
  assert.equal(f.video.muted, true);
  audio.fire('error');
  assert.equal(f.video.muted, false);
});

test('dub switching preserves explicit caption choice and dub-only manifests hide old caption tracks', async t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const dubOnly = manifest(); dubOnly.outputs = { dub: true, subtitles: false };
  await f.client.loadResult(dubOnly, { subtitleTrack: 'off' });
  f.client.setDubEnabled(false); f.client.setDubEnabled(true);
  assert.equal(f.client.capture().subtitleTrack, 'off');
  assert.deepEqual(f.client.capture().manifest.subtitles, { source_tr: [], dub_tr: [] });
  f.client.setSubtitleTrack('dub_tr');
  assert.equal(f.client.capture().subtitleTrack, 'off', 'unrequested legacy tracks cannot become active');
  await f.client.loadResult(manifest(), { subtitleTrack: 'source_tr' });
  f.client.setDubEnabled(false); f.client.setDubEnabled(true);
  assert.equal(f.client.capture().subtitleTrack, 'source_tr');
  const audio = f.audios.findLast(value => value.src);
  f.video.sourceTime(1); audio.sourceTime(.9);
  const writes = audio.seekWrites.length;
  f.client.sync();
  assert.equal(audio.seekWrites.length, writes, 'minor clock jitter does not repeatedly seek the audio');
});

test('old saved muted mixes restore quiet original speech locally without reducing dub volume or new requests', async t => {
  const f = fixture(); t.after(() => f.client.destroy());
  const old = manifest(); old.qualityReport = { mix: { originalSpeechMuted: true } };
  old.dubSegments = [{ start: 1, end: 3, originalSpeechStart: 1, originalSpeechEnd: 3 }];
  await f.client.loadResult(old);
  f.video.sourceTime(1.5); f.video.paused = false; f.video.fire('playing'); await settle();
  const audio = f.audios.findLast(value => value.src);
  assert.equal(f.video.muted, false);
  assert.ok(Math.abs(f.video.volume - .65 * .18) < .00001);
  f.client.sync(); assert.equal(audio.volume, .65);
  f.video.sourceTime(4); f.client.sync();
  assert.equal(f.video.muted, true, 'the existing mix owns normal source audio outside speech');
  f.client.setDubEnabled(false);
  assert.equal(f.video.volume, .65); assert.equal(f.video.muted, false);
  assert.equal(f.requests.length, 0);
});

test('source and dub subtitle tracks render overlapping cues while retaining cached caption nodes', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  const mounted = [...f.overlay.children];
  await f.client.loadResult(manifest());
  f.video.sourceTime(1.5);
  f.client.setSubtitleTrack('source_tr');
  f.client.sync();
  assert.match(f.text.textContent, /Birinci kaynak altyazı/);
  assert.match(f.text.textContent, /Çakışan kaynak altyazı/);
  assert.deepEqual(f.overlay.children, mounted);
  f.client.setSubtitleTrack('dub_tr');
  f.client.sync();
  assert.match(f.text.textContent, /Türkçe dublaj altyazısı/);
  assert.doesNotMatch(f.text.textContent, /kaynak altyazı/);
  f.client.setSubtitleTrack('off');
  f.client.sync();
  assert.equal(f.text.textContent, '');
  assert.deepEqual(f.overlay.children, [f.speaker, f.text]);
  f.client.setSubtitleTrack('source_tr');
  f.video.sourceTime(4);
  f.video.fire('timeupdate');
  assert.equal(f.text.textContent, '', 'out of range cues are cleared');
});

test('late audio play rejection from the previous source does not overwrite new source status', async t => {
  const oldPlay = deferred();
  const f = fixture();
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest('old-job'));
  f.client.setDubEnabled(true);
  const oldAudio = f.audios.findLast(value => value.src);
  oldAudio.playResult = oldPlay.promise;
  f.video.paused = false;
  f.video.fire('playing');
  f.client.sync();
  await settle();
  oldAudio.playResult = null;
  await f.client.loadResult(manifest('new-job'));
  f.client.setDubEnabled(true);
  f.client.sync();
  await settle();
  const statusCount = f.statuses.length;
  oldPlay.reject(new Error('stale play denied'));
  await settle();
  assert.equal(f.statuses.slice(statusCount).some(value => /FAILED|ERROR|BLOCKED/.test(statusState(value))), false);
  assert.ok(JSON.stringify(f.client.capture()).includes('new-job'));
  assert.equal(f.audios.findLast(value => value.src).paused, false);
});

test('capture is synchronous stable metadata and materializeAudio fetches final bytes once', async t => {
  const f = fixture(({ url }) => {
    assert.equal(url, '/api/turkish-media/jobs/job-a/assets/mix');
    return new Response('complete final mix', { headers: { 'content-type': 'audio/wav' } });
  });
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest());
  f.client.setSubtitleTrack('dub_tr');
  f.client.setSyncOffset(0.4);
  f.client.setDubEnabled(true);
  const capture = f.client.capture();
  assert.equal(typeof capture?.then, 'undefined', 'saved-game metadata capture is synchronous');
  const serialized = JSON.stringify(capture);
  assert.ok(serialized.includes('dub_tr'));
  assert.ok(serialized.includes('0.4'));
  assert.ok(serialized.includes('Source evidence'));
  assert.doesNotMatch(serialized, /blob:|data:|authorization|apiKey|AbortController|AudioContext/i);
  const [first, concurrent] = await Promise.all([f.client.materializeAudio(), f.client.materializeAudio()]);
  const cached = await f.client.materializeAudio();
  assert.ok(first instanceof Blob);
  assert.equal(await first.text(), 'complete final mix');
  assert.equal(await concurrent.text(), 'complete final mix');
  assert.equal(await cached.text(), 'complete final mix');
  assert.equal(f.requests.filter(request => request.url.endsWith('/assets/mix')).length, 1);
  assert.ok(f.audios.findLast(value => value.src).src.startsWith('blob:'), 'saved audio plays locally instead of repeatedly requesting the server');
});

test('subtitle-only results require no audio element or mix download', async t => {
  const f = fixture(() => { throw new Error('Subtitle-only result should not fetch audio'); });
  t.after(() => f.client.destroy());
  const captionsOnly = manifest();
  captionsOnly.assets = {};
  await f.client.loadResult(captionsOnly);
  f.client.setSubtitleTrack('source_tr');
  f.video.sourceTime(0.5);
  f.client.sync();
  assert.match(f.text.textContent, /Birinci kaynak altyazı/);
  assert.equal(await f.client.materializeAudio(), null);
  assert.equal(f.audios.some(audio => audio.src), false);
  assert.equal(f.requests.length, 0);
});

test('a failed chunk response reconciles server completion before resending video bytes', async t => {
  let statusReads = 0;
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'resume-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/resume-upload/status')) {
      statusReads += 1;
      return json({ completedChunks: statusReads === 1 ? [0, 2] : [0, 1, 2] });
    }
    if (url.endsWith('/uploads/resume-upload/chunk/1')) return json({ error: 'Response lost after chunk receipt' }, 503);
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'job-a' });
    if (url.endsWith('/jobs/job-a')) return json({ id: 'job-a', state: 'READY', result: manifest() });
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  await f.client.start(sourceFile(), { outputs: { dub: true, subtitles: true } });
  assert.equal(statusReads, 2, 'retry checks whether the server already stored the failed chunk');
  assert.equal(f.requests.filter(request => /\/chunk\//.test(request.url)).length, 1, 'accepted bytes are not resent');
  assert.ok(JSON.stringify(f.client.capture()).includes('job-a'));
});

test('nonretryable upload rejection sends the chunk once and does not create a job', async t => {
  const f = fixture(({ url }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'bad-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/bad-upload/status')) return json({ completedChunks: [0, 2] });
    if (url.endsWith('/uploads/bad-upload/chunk/1')) return json({ error: 'Invalid source chunk' }, 400);
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  await assert.rejects(f.client.start(sourceFile()), /Invalid source chunk/);
  assert.equal(f.requests.filter(request => /\/chunk\//.test(request.url)).length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/status')).length, 1);
  assert.equal(f.requests.some(request => request.url.endsWith('/jobs')), false);
  assert.equal(f.client.capture(), null);
});

test('source upload keys hash middle bytes and remain stable for repeated identical Blob contents', async t => {
  assert.ok(globalThis.crypto?.subtle, 'this regression exercises the browser SHA digest branch');
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  const digestCalls = [];
  t.mock.method(subtle, 'digest', async (algorithm, bytes) => {
    digestCalls.push({ algorithm, length: bytes.byteLength });
    return digest(algorithm, bytes);
  });
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'hashed-upload', chunkSize: 1024 * 1024, totalChunks: 1 });
    if (url.endsWith('/uploads/hashed-upload/status')) return json({ completedChunks: [0] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'job-a' });
    if (url.endsWith('/jobs/job-a')) return json({ id: 'job-a', state: 'READY', result: manifest() });
    throw new Error(`Unexpected request ${url}`);
  }, { chunkSize: 1024 * 1024 });
  t.after(() => f.client.destroy());
  const bytes = new Uint8Array(256 * 1024).fill(7);
  const changedBytes = bytes.slice();
  changedBytes[128 * 1024] = 8;
  const sources = [new Blob([bytes], { type: 'audio/mpeg' }),
    new Blob([changedBytes], { type: 'audio/mpeg' }),
    new Blob([bytes], { type: 'audio/mpeg' })];
  for (const source of sources) {
    source.name = 'same-name.mp4';
    await f.client.start(source, { outputs: { dub: true, subtitles: true } });
  }
  const keys = f.requests.filter(request => request.url.endsWith('/uploads/start'))
    .map(request => JSON.parse(request.init.body).clientUploadKey);
  assert.equal(keys.length, 3);
  assert.notEqual(keys[0], keys[1], 'a different middle byte cannot reuse the original source upload');
  assert.equal(keys[0], keys[2], 'identical content in a new Blob has the same source identity');
  assert.ok(digestCalls.some(call => call.algorithm === 'SHA-256' && call.length === bytes.byteLength));
});

test('asset URLs outside the same-origin media API are rejected before audio or saved metadata exists', async t => {
  const f = fixture(() => { throw new Error('Invalid assets must never be fetched'); });
  t.after(() => f.client.destroy());
  for (const url of ['https://external.example/audio.wav', '/api/source-video/cache/audio.wav',
    '/api/turkish-media/jobs/job-a/assets/mix?apiKey=secret']) {
    const invalid = manifest();
    invalid.assets.mix.url = url;
    await assert.rejects(Promise.resolve().then(() => f.client.loadResult(invalid)), /adres|URL|address|origin|geçersiz/i);
    assert.equal(f.client.capture(), null);
  }
  assert.equal(f.audios.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.video.muted, false);
});

test('saved manifest strips provider credentials recursively while retaining source evidence', async t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  const result = manifest();
  result.apiKey = 'top-level-secret';
  result.metadata = { authorization: 'Bearer secret', GeminiApiKey: 'provider-secret',
    access_token: 'access-secret', refreshToken: 'refresh-secret', password: 'password-secret',
    useful: { sourceNote: 'verified from source', api_key: 'nested-secret' } };
  result.sourceTranscript.segments[0].apiKey = 'transcript-secret';
  await f.client.loadResult(result);
  const capture = f.client.capture();
  const serialized = JSON.stringify(capture);
  assert.doesNotMatch(serialized, /top-level-secret|Bearer secret|provider-secret|access-secret|refresh-secret|password-secret|nested-secret|transcript-secret/);
  assert.doesNotMatch(serialized, /api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password/i);
  assert.ok(serialized.includes('verified from source'));
  assert.ok(serialized.includes('Source evidence'));
  assert.equal(result.metadata.GeminiApiKey, 'provider-secret', 'loading does not mutate the caller manifest');
});

test('video error and emptied stop the finished mix without automatically restarting it', async t => {
  for (const event of ['error', 'emptied']) {
    await t.test(event, async child => {
      const f = fixture();
      child.after(() => f.client.destroy());
      f.video.sourceTime(1.5);
      await f.client.loadResult(manifest());
      f.client.setSubtitleTrack('source_tr');
      f.video.paused = false;
      f.video.fire('playing');
      await settle();
      const audio = f.audios.findLast(value => value.src);
      assert.equal(audio.paused, false);
      const plays = audio.playCalls;
      f.video.fire(event);
      await settle();
      assert.equal(audio.paused, true, `${event} stops the audio even before video.paused updates`);
      f.client.sync();
      f.video.fire('timeupdate');
      await settle();
      assert.equal(audio.playCalls, plays, 'clock updates cannot restart audio after source failure');
      assert.deepEqual(f.video.seekWrites, []);
      assert.equal(f.video.pauseCalls, 0);
      if (event === 'emptied') assert.equal(f.text.textContent, '', 'removed source clears captions');
    });
  }
});

test('retry restarts the failed server job without uploading the cached source again', async t => {
  const captionsOnly = manifest('retried-job');
  captionsOnly.assets = {};
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'cached-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/cached-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'failed-job' });
    if (url.endsWith('/jobs/failed-job')) return json({ id: 'failed-job', state: 'FAILED', error: 'Temporary job failure' });
    if (url.endsWith('/jobs/failed-job/retry') && init.method === 'POST') {
      return json({ jobId: 'retried-job', statusUrl: '/api/turkish-media/jobs/retried-job' });
    }
    if (url.endsWith('/jobs/retried-job')) return json({ id: 'retried-job', state: 'READY', result: captionsOnly });
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
  });
  t.after(() => f.client.destroy());
  const options = { outputs: { dub: false, subtitles: true }, qualityMode: 'quality',
    sceneContext: [{ id: 'occurrence-1', start: 0, end: 3, label: 'Source label' }] };
  await assert.rejects(f.client.start(sourceFile(), options), /Temporary job failure/);
  const uploadsBeforeRetry = f.requests.filter(request => request.url.includes('/uploads/')).length;
  await f.client.retry();
  assert.equal(f.requests.filter(request => request.url.includes('/uploads/')).length, uploadsBeforeRetry);
  assert.equal(f.requests.filter(request => request.url.endsWith('/jobs')).length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/failed-job/retry')).length, 1);
  const saved = f.client.capture();
  assert.equal(saved.manifest.jobId, 'retried-job');
  assert.equal(saved.dubEnabled, false);
  assert.equal(saved.subtitleTrack, 'source_tr');
  const created = JSON.parse(f.requests.find(request => request.url.endsWith('/jobs')).init.body);
  assert.deepEqual(created.outputs, options.outputs);
  assert.equal(created.qualityMode, options.qualityMode);
  assert.deepEqual(created.sceneContext, options.sceneContext);
});

test('a vanished server job fails without automatically spending credits on a new job', async t => {
  let jobs = 0;
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'upload-1', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/upload-1/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: `job-${++jobs}` });
    if (url.endsWith('/jobs/job-1')) return json({ error: 'Medya işlemi veya dosyası bulunamadı.' }, 404);
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
  });
  t.after(() => f.client.destroy());
  await assert.rejects(f.client.start(sourceFile()), error => error.code === 'MEDIA_JOB_LOST');
  assert.equal(jobs, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/uploads/start')).length, 1);
  assert.equal(f.statuses.at(-1).error.code, 'MEDIA_JOB_LOST');
});

test('retry uploads a fresh source when the old job has disappeared', async t => {
  let jobs = 0;
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: `upload-${jobs + 1}`, chunkSize: 3, totalChunks: 3 });
    if (/\/uploads\/upload-\d+\/status$/.test(url)) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: `job-${++jobs}` });
    if (url.endsWith('/jobs/job-1') && !init.method) {
      return jobs === 1 ? json({ id: 'job-1', state: 'FAILED', error: 'Provider unavailable' }) : json({}, 404);
    }
    if (url.endsWith('/jobs/job-1/retry')) return json({ error: 'Medya işlemi veya dosyası bulunamadı.' }, 404);
    if (url.endsWith('/jobs/job-2')) return json({ id: 'job-2', state: 'READY', result: manifest('job-2') });
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
  });
  t.after(() => f.client.destroy());
  await assert.rejects(f.client.start(sourceFile()), /Provider unavailable/);
  await f.client.retry();
  assert.equal(jobs, 2);
  assert.equal(f.requests.filter(request => request.url.endsWith('/uploads/start')).length, 2);
  assert.equal(f.client.capture().manifest.jobId, 'job-2');
});

test('transient job polling failures recover without creating a duplicate job or reuploading source', async t => {
  let polls = 0;
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'poll-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/poll-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'job-a' });
    if (url.endsWith('/jobs/job-a')) {
      polls += 1;
      if (polls === 1) throw new TypeError('Network request failed');
      if (polls === 2) return json({ error: 'Temporary gateway failure' }, 503);
      return json({ id: 'job-a', state: 'READY', result: manifest() });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  await f.client.start(sourceFile());
  assert.equal(polls, 3);
  assert.equal(f.requests.filter(request => request.url.endsWith('/uploads/start')).length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith('/jobs')).length, 1);
  assert.equal(f.client.capture().manifest.jobId, 'job-a');
});

test('request timeout aborts a stalled upload request and reports failure', async t => {
  const neverResponds = deferred();
  const f = fixture(({ url }) => {
    assert.equal(url, '/api/turkish-media/uploads/start');
    return neverResponds.promise;
  }, { requestTimeoutMs: 15, uploadRequestTimeoutMs: 15 });
  t.after(() => f.client.destroy());
  await assert.rejects(f.client.start(sourceFile()), /zaman aşımı|timed? ?out|timeout/i);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.signal.aborted, true);
  assert.ok(f.statuses.some(value => statusState(value) === 'FAILED'));
  assert.equal(f.client.capture(), null);
});

test('upload requests can outlive the normal browser request timeout', async t => {
  let stalled = true;
  let polls = 0;
  const f = fixture(({ url }) => {
    if (stalled && url.endsWith('/uploads/start')) {
      return new Promise(resolve => setTimeout(() => {
        stalled = false;
        resolve(json({ uploadId: 'slow-upload', chunkSize: 3, totalChunks: 3 }));
      }, 30));
    }
    if (url.endsWith('/uploads/slow-upload/status')) {
      polls += 1;
      return json({ completedChunks: [0, 1, 2] });
    }
    if (url.endsWith('/jobs') ) return json({ jobId: 'slow-job' });
    if (url.endsWith('/jobs/slow-job')) return json({ state: 'READY', result: manifest('slow-job') });
    throw new Error(`Unexpected request ${url}`);
  }, { requestTimeoutMs: 15, uploadRequestTimeoutMs: 80 });
  t.after(() => f.client.destroy());
  await assert.doesNotReject(
    f.client.start(sourceFile(), { outputs: { dub: false, subtitles: true } })
  );
  assert.equal(polls, 1);
  assert.ok(f.statuses.some(status => status.state === 'UPLOADING'));
  assert.equal(f.client.capture().manifest.jobId, 'slow-job');
});


test('explicit cancel aborts polling and sends one backend cancellation even if a READY response arrives late', async t => {
  const pendingJob = deferred();
  const jobRequested = deferred();
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'cancel-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/cancel-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'cancel-job' });
    if (url.endsWith('/jobs/cancel-job')) { jobRequested.resolve(); return pendingJob.promise; }
    if (url.endsWith('/jobs/cancel-job/cancel') && init.method === 'POST') return json({ state: 'CANCELLED' });
    throw new Error(`Unexpected request ${url}`);
  });
  t.after(() => f.client.destroy());
  const started = f.client.start(sourceFile());
  const rejected = assert.rejects(started, error => error.name === 'AbortError');
  await jobRequested.promise;
  await f.client.cancel();
  await rejected;
  const polling = f.requests.find(request => request.url.endsWith('/jobs/cancel-job'));
  assert.equal(polling.init.signal.aborted, true);
  assert.equal(f.requests.filter(request => request.url.endsWith('/cancel')).length, 1);
  const statusCount = f.statuses.length;
  pendingJob.resolve(json({ id: 'cancel-job', state: 'READY', result: manifest('cancel-job') }));
  await settle();
  assert.equal(f.client.capture(), null);
  assert.equal(f.statuses.slice(statusCount).some(value => statusState(value) === 'READY'), false);
});

test('stale audio download cannot populate the new source offline audio cache', async t => {
  const oldDownload = deferred();
  const f = fixture(({ url }) => {
    if (url.endsWith('/jobs/old-job/assets/mix')) return oldDownload.promise;
    if (url.endsWith('/jobs/new-job/assets/mix')) {
      return new Response('new source final mix', { headers: { 'content-type': 'audio/wav' } });
    }
    throw new Error(`Unexpected asset ${url}`);
  });
  t.after(() => f.client.destroy());
  await f.client.loadResult(manifest('old-job'));
  const previous = f.client.materializeAudio();
  const rejected = assert.rejects(previous, error => error.name === 'AbortError');
  await f.client.loadResult(manifest('new-job'));
  await rejected;
  oldDownload.resolve(new Response('stale old source mix', { headers: { 'content-type': 'audio/wav' } }));
  await settle();
  const fresh = await f.client.materializeAudio();
  assert.equal(await fresh.text(), 'new source final mix');
  assert.equal(await (await f.client.materializeAudio()).text(), 'new source final mix');
  assert.equal(f.requests.filter(request => request.url.endsWith('/jobs/new-job/assets/mix')).length, 1);
  assert.equal(f.client.capture().manifest.jobId, 'new-job');
});

test('transcript-only requests preserve the backend output flag and use no Turkish playback assets', async t => {
  const sourceOnly = manifest('source-only-job');
  sourceOnly.subtitles = { source_tr: [], dub_tr: [] };
  sourceOnly.assets = {};
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'transcript-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/transcript-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') return json({ jobId: 'source-only-job' });
    if (url.endsWith('/jobs/source-only-job')) {
      return json({ id: 'source-only-job', state: 'READY', sourceTranscript: transcript, result: sourceOnly });
    }
    throw new Error(`Unexpected transcript-only request ${url}`);
  });
  t.after(() => f.client.destroy());
  await f.client.start(sourceFile(), { outputs: { dub: false, subtitles: false, transcriptOnly: true }, qualityMode: 'quality' });
  const body = JSON.parse(f.requests.find(request => request.url.endsWith('/jobs')).init.body);
  assert.deepEqual(body.outputs, { dub: false, subtitles: false, transcriptOnly: true });
  assert.equal(f.audios.length, 0);
  assert.equal(await f.client.materializeAudio(), null);
  assert.equal(f.client.capture().dubEnabled, false);
  assert.equal(f.client.capture().subtitleTrack, 'off');
  assert.ok(f.statuses.some(value => value.sourceTranscript?.segments?.length));
});

test('a job descriptor arriving after reset is cancelled remotely without polling or installing stale media', async t => {
  const descriptor = deferred();
  const creationRequested = deferred();
  const f = fixture(({ url, init }) => {
    if (url.endsWith('/uploads/start')) return json({ uploadId: 'late-upload', chunkSize: 3, totalChunks: 3 });
    if (url.endsWith('/uploads/late-upload/status')) return json({ completedChunks: [0, 1, 2] });
    if (url.endsWith('/jobs') && init.method === 'POST') { creationRequested.resolve(); return descriptor.promise; }
    if (url.endsWith('/jobs/late-created-job/cancel') && init.method === 'POST') return json({ state: 'CANCELLED' });
    throw new Error(`Unexpected stale-job request ${init.method ?? 'GET'} ${url}`);
  });
  t.after(() => f.client.destroy());
  const started = f.client.start(sourceFile());
  const rejected = assert.rejects(started, error => error.name === 'AbortError');
  await creationRequested.promise;
  f.client.reset();
  await rejected;
  const statusCount = f.statuses.length;
  descriptor.resolve(json({ id: 'late-created-job', statusUrl: '/api/turkish-media/jobs/late-created-job' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(request => request.url.endsWith('/jobs/late-created-job/cancel')).length, 1);
  assert.equal(f.requests.some(request => request.url.endsWith('/jobs/late-created-job')), false);
  assert.equal(f.client.capture(), null);
  assert.equal(f.audios.length, 0);
  assert.equal(f.statuses.slice(statusCount).some(value => statusState(value) === 'READY'), false);
});


test('decision timing follows source speech without a media manifest or network request', t => {
  const f = fixture();
  t.after(() => f.client.destroy());
  assert.equal(f.client.conversationEndAt(2, [{ startTime: 1, endTime: 4 }], 10), 4.12);
  assert.equal(f.client.capture(), null);
  assert.equal(f.requests.length, 0);
});
