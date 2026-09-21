import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { activeDubSegments, dubSpeechEnd, sourceSpeechOverlaps } from '../public/dub-overlap.js';
import { dubSpeakerKey } from '../public/dub-speakers.js';
import { createDubMixer, naturalDubRate, canFinishDubTail, correctDubClock } from '../public/dubbing-audio.js';
import { dialogueSegmentAt, nextDialogueSegments, dialogueSegmentsForTarget,
  isDubStartTimely, mapVideoTimeToDubTime, dubSegmentKey } from '../public/playback-logic.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const line = (id, startTime, endTime) => ({ segmentId: id, startTime, endTime, turkishText: 'Merhaba.' });
function functions(...names) {
  return names.map(name => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
}
function clock() {
  let time = 0;
  let counter = 0;
  const jobs = new Map();
  return {
    now: () => time,
    schedule: callback => { jobs.set(++counter, callback); return counter; },
    cancel: id => jobs.delete(id),
    advance(ms) { time += ms; const work = [...jobs.values()]; jobs.clear(); work.forEach(fn => fn()); }
  };
}
function fixture(segments, { durations = {}, ensure, playGate, browserEvents = false } = {}) {
  const made = [];
  class Media extends EventTarget {
    paused = true; ended = false; seeking = false; volume = 1; muted = false;
    currentTime = 0; duration = 1; playbackRate = 1; readyState = 4; src = '';
    plays = 0; pauses = 0;
    classList = { toggle() {} };
    removeAttribute(name) { this[name] = ''; }
    load() {
      if (this.src) {
        this.duration = durations[this.src] || 1;
        this.readyState = 4;
        queueMicrotask(() => this.dispatchEvent(new Event('canplay')));
      } else {
        this.readyState = 0;
        this.dispatchEvent(new Event('emptied'));
      }
    }
    async play() {
      this.plays++;
      if (playGate && made.includes(this)) await playGate(this);
      this.paused = false;
      this.ended = false;
      if (browserEvents && this === video) {
        this.dispatchEvent(new Event('play'));
        await new Promise(resolve => setImmediate(resolve));
        if (!this.paused) this.dispatchEvent(new Event('playing'));
        if (this.paused) { const error = new Error('play interrupted by pause'); error.name = 'AbortError'; throw error; }
      }
    }
    pause() { this.pauses++; this.paused = true; }
    end() { this.ended = true; this.paused = true; this.currentTime = this.duration; this.dispatchEvent(new Event('ended')); }
  }
  class Audio extends Media { constructor() { super(); made.push(this); } }
  const video = new Media();
  video.currentTime = segments[0]?.startTime || 0;
  video.paused = false;
  const frames = clock();
  const state = {
    dubbingEnabled: true, keepOriginalAudioEnabled: true, dubSyncGeneration: 0,
    dubStartingToken: null, dubResumeTime: null, dubVideoWaiting: false, dubPlaybackBlocked: false,
    activeDubSegmentId: null, dubBuffer: null, dubPlayedSegmentIds: new Set(), dubRequestController: new AbortController()
  };
  const els = { video, keepOriginalAudio: new Media(), dubBufferStatus: new Media(),
    dubBufferMessage: new Media(), dubRetryBtn: new Media(), dubContinueOriginalBtn: new Media() };
  const timers = new Map();
  let nextTimer = 0;
  const scope = vm.createContext({
    state, els, Audio, console, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id),
    createDubMixer: media => createDubMixer(media, frames), naturalDubRate, canFinishDubTail, correctDubClock,
    dialogueSegmentAt, nextDialogueSegments, dialogueSegmentsForTarget, isDubStartTimely, mapVideoTimeToDubTime,
    activeDubSegments, dubSpeechEnd, sourceSpeechOverlaps, dubSpeakerKey,
    dubTimeline: () => segments, getDubSegmentId: segment => segment ? dubSegmentKey(segment) : '',
    ensureDubSegment: ensure || (async segment => segment.segmentId), renderSubtitle() {}, logEngineEvent() {}
  });
  const helpers = source.slice(source.indexOf('const dubChannels = new Map();'), source.indexOf('function recordAiUsage('));
  const from = source.indexOf("els.video.addEventListener('timeupdate', () => { renderSubtitle();");
  const events = source.slice(from, source.indexOf("els.subtitleToggleBtn?.addEventListener", from));
  vm.runInContext(helpers + functions('stopDubPlayback', 'prefetchDubSegmentsAround', 'primeLanguageTracksAt',
    'resyncLanguageTracks', 'playDubAudio', 'syncDubPlayback') + events + '\nupdateDubMix();', scope);
  return { scope, video, state, made, frames, timers, els,
    sync: () => scope.syncDubPlayback(),
    event: name => {
      if (name === 'play' || name === 'playing') video.paused = false;
      video.dispatchEvent(new Event(name));
      if (name === 'play') video.dispatchEvent(new Event('playing'));
    },
    active: () => vm.runInContext('dubChannels.get(state.activeDubSegmentId)', scope),
    channels: () => vm.runInContext('[...dubChannels]', scope),
    close: () => { state.dubbingEnabled = false; scope.stopDubPlayback(); scope.clearPreparedDubAudio(); }
  };
}

test('source stays below the voice; levels ramp smoothly and restore the user volume/mute', () => {
  const video = { volume: 0.8, muted: false };
  const frames = clock();
  const mix = createDubMixer(video, frames);
  mix.update({ enabled: true });
  assert.ok(Math.abs(video.volume - 0.176) < 1e-8);
  assert.ok(Math.abs(mix.voiceVolume() - 0.416) < 1e-8);
  mix.update({ enabled: true, speaking: true });
  frames.advance(40);
  assert.ok(video.volume > 0.08 && video.volume < 0.176);
  frames.advance(40);
  assert.ok(Math.abs(video.volume - 0.08) < 1e-8);
  mix.update({ enabled: true, speaking: false });
  frames.advance(100);
  assert.ok(video.volume < 0.176);
  mix.update({ enabled: false });
  frames.advance(500);
  assert.equal(video.volume, 0.8);
  assert.equal(video.muted, false);
  video.muted = true;
  mix.update({ enabled: true, keepOriginal: false });
  mix.update({ enabled: false });
  assert.equal(video.muted, true);
});

test('voice fitting leaves short speech natural and bounds longer speech', () => {
  assert.equal(naturalDubRate(2, 4), 1);
  assert.equal(naturalDubRate(4.4, 4), 1.1);
  assert.equal(naturalDubRate(10, 4), 1.3);
  assert.equal(naturalDubRate(4, 4, 0.5), 0.5);
});

test('continuous clock correction never rewinds heard words and resumes after the video catches up', async () => {
  const f = fixture([line('a', 1, 7)], { durations: { a: 6 } });
  try {
    await f.sync();
    const audio = f.active();
    audio.currentTime = 1;
    f.video.currentTime = 1.3;
    await f.sync();
    assert.equal(audio.currentTime, 1);
    assert.equal(audio.paused, true);
    assert.equal(audio.plays, 1);
    f.video.currentTime = 1.95;
    await f.sync();
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 1);
    assert.equal(audio.plays, 2);
  } finally { f.close(); }
});

test('an audio decoder stall resynchronizes to the video and follows playback speed', async () => {
  const f = fixture([line('a', 1, 7)], { durations: { a: 6 } });
  try {
    await f.sync();
    const audio = f.active();
    audio.currentTime = .2;
    f.video.currentTime = 2;
    f.video.playbackRate = 1.5;
    await f.sync();
    assert.equal(audio.currentTime, 1);
    assert.equal(audio.playbackRate, 1.5);
    assert.equal(audio.plays, 1);
  } finally { f.close(); }
});

test('seeking into a short sentence preserves the heard offset even below the normal startup grace', async () => {
  const f = fixture([line('a', 1, 3)], { durations: { a: 2 } });
  try {
    f.video.currentTime = 1.4;
    f.event('seeking');
    f.event('seeked');
    await tick();
    assert.ok(Math.abs(f.active().currentTime - .4) < 1e-6);
  } finally { f.close(); }
});

test('the final voice cannot spill into unrelated footage without a following caption', async () => {
  const f = fixture([line('a', 1, 2)], { durations: { a: 4 } });
  try {
    await f.sync();
    const audio = f.active();
    audio.currentTime = 1;
    f.video.currentTime = 2.7;
    await f.sync();
    assert.equal(f.channels().length, 0);
    assert.equal(audio.paused, true);
    assert.equal(f.state.dubPlayedSegmentIds.has('a'), true);
  } finally { f.close(); }
});

test('real timeupdate and seeked handlers update subtitles even when dubbing is disabled', () => {
  const f = fixture([line('a', 1, 2), line('b', 3, 4)]);
  try {
    f.state.dubbingEnabled = false;
    f.state.subtitlesEnabled = true;
    f.state.dialogue = { segments: [line('a', 1, 2), { ...line('b', 3, 4), turkishText: 'İkinci cümle.' }] };
    vm.runInContext(functions('renderSubtitle'), f.scope);
    const element = () => ({ textContent: '', classList: { add() {}, remove() {} } });
    f.els.subtitleOverlay = element(); f.els.subtitleText = element(); f.els.subtitleSpeaker = element();
    f.video.currentTime = 1.5;
    f.event('timeupdate');
    assert.equal(f.els.subtitleText.textContent, 'Merhaba.');
    f.video.currentTime = 3.5;
    f.event('timeupdate');
    assert.equal(f.els.subtitleText.textContent, 'İkinci cümle.');
    f.video.currentTime = 1.5;
    f.event('seeked');
    assert.equal(f.els.subtitleText.textContent, 'Merhaba.');
  } finally { f.close(); }
});

test('estimated end time does not cut the final word in the following silence', async () => {
  const f = fixture([line('a', 1, 2)], { durations: { a: 1.2 } });
  try {
    await f.sync();
    const audio = f.active();
    audio.currentTime = 1.05;
    f.video.currentTime = 2.12;
    await f.sync();
    assert.equal(f.active(), audio);
    assert.equal(audio.paused, false);
    audio.end();
    assert.equal(f.state.activeDubSegmentId, null);
  } finally { f.close(); }
});

test('overlapping timestamps for the same person never double their voice', async () => {
  const f = fixture([{ ...line('a', 0, 2), speakerId: 'person' }, { ...line('b', 1.9, 4), speakerId: 'person' }],
    { durations: { a: 2.1, b: 2 } });
  try {
    await f.sync();
    const first = f.active();
    first.currentTime = 1.95;
    f.video.currentTime = 2.01;
    await f.sync();
    assert.equal(f.channels().length, 1);
    assert.equal(f.active(), first);
    first.end();
    await tick();
    assert.equal(f.channels().length, 1);
    assert.equal(f.state.activeDubSegmentId, 'b');
  } finally { f.close(); }
});

test('next speaker waits for a short tail and starts from its first syllable', async () => {
  const f = fixture([line('a', 1, 2), line('b', 2, 3)], { durations: { a: 1.2, b: 1 } });
  try {
    await f.sync();
    await tick();
    const first = f.active();
    first.currentTime = 1;
    f.video.currentTime = 1.95;
    await f.sync();
    assert.equal(f.active(), first);
    f.video.currentTime = 2.02;
    await f.sync();
    assert.equal(first.paused, false);
    assert.equal(f.state.activeDubSegmentId, 'a');
    f.video.currentTime = 2.18;
    first.end();
    await tick();
    assert.equal(f.state.activeDubSegmentId, 'b');
    assert.equal(f.active().currentTime, 0);
    assert.equal(f.made.length, 2, 'the prefetched media element is reused');
  } finally { f.close(); }
});

test('slow synthesis is not started after the source has left the sentence', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 2)], { ensure: () => request.promise });
  try {
    const pending = f.sync();
    f.video.currentTime = 3;
    request.resolve('a');
    await pending;
    assert.equal(f.state.activeDubSegmentId, null);
    assert.equal(f.state.dubPlayedSegmentIds.size, 0);
  } finally { f.close(); }
});

test('overlapping sync callbacks start one audio instance once', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 2)], { ensure: () => request.promise });
  try {
    const one = f.sync();
    const two = f.sync();
    request.resolve('a');
    await Promise.all([one, two]);
    assert.equal(f.made.length, 1);
    assert.equal(f.active().plays, 1);
  } finally { f.close(); }
});

test('paused seek and resync do not consume a line; resume maps to the middle of the sentence', async () => {
  const f = fixture([line('a', 1, 11)], { durations: { a: 10 } });
  try {
    f.video.paused = true;
    f.video.currentTime = 5;
    f.event('seeking');
    f.event('seeked');
    f.scope.resyncLanguageTracks();
    await tick();
    assert.equal(f.state.dubPlayedSegmentIds.size, 0);
    assert.equal(f.state.activeDubSegmentId, null);
    f.video.paused = false;
    f.event('play');
    await tick();
    assert.equal(f.state.activeDubSegmentId, 'a');
    assert.equal(f.active().currentTime, 4);
    assert.equal(f.active().paused, false);
    f.scope.resyncLanguageTracks();
    await tick();
    assert.equal(f.active().plays, 1);
  } finally { f.close(); }
});

test('buffering pauses the voice and playing resumes the same audio without resetting it', async () => {
  const f = fixture([line('a', 1, 3)], { durations: { a: 2 } });
  try {
    await f.sync();
    const audio = f.active();
    audio.currentTime = 0.6;
    f.video.currentTime = 1.6;
    f.event('waiting');
    assert.equal(audio.paused, true);
    await f.sync();
    assert.equal(audio.plays, 1);
    f.event('playing');
    await tick();
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 0.6);
    assert.equal(audio.plays, 2);
  } finally { f.close(); }
});

test('blocked play is not marked heard and can retry on a user play gesture', async () => {
  let blocked = true;
  const f = fixture([line('a', 1, 3)], { playGate: () => {
    if (blocked) { const error = new Error('gesture required'); error.name = 'NotAllowedError'; throw error; }
  } });
  try {
    await f.sync();
    assert.equal(f.state.dubPlayedSegmentIds.size, 0);
    assert.equal(f.state.dubPlaybackBlocked, true);
    blocked = false;
    f.event('play');
    await tick();
    assert.equal(f.state.dubPlayedSegmentIds.has('a'), true);
  } finally { f.close(); }
});

test('seek while synthesis is pending cannot start audio from the old timestamp', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 2), line('b', 5, 6)], { ensure: segment => segment.segmentId === 'a' ? request.promise : Promise.resolve('b') });
  try {
    const old = f.sync();
    f.video.currentTime = 5;
    f.event('seeking');
    f.event('seeked');
    f.event('play');
    await tick();
    request.resolve('a');
    await old;
    assert.equal(f.state.activeDubSegmentId, 'b');
    assert.equal(f.made.find(audio => audio.src === 'a').plays, 0);
  } finally { f.close(); }
});

test('an old play promise cannot pause the same pooled audio reused after a seek', async () => {
  const firstPlay = deferred();
  let count = 0;
  const f = fixture([line('a', 1, 6)], { durations: { a: 5 }, playGate: () => ++count === 1 ? firstPlay.promise : undefined });
  try {
    const old = f.sync();
    await tick();
    f.video.currentTime = 3;
    f.event('seeking');
    f.event('seeked');
    await tick();
    firstPlay.resolve();
    await old;
    assert.equal(f.state.activeDubSegmentId, 'a');
    assert.equal(f.active().paused, false);
    assert.equal(f.active().currentTime, 2);
  } finally { f.close(); }
});

test('original audio checkbox and disabling dub restore independent source state', async () => {
  const f = fixture([line('a', 1, 2)]);
  try {
    await f.sync();
    f.els.keepOriginalAudio.checked = false;
    f.els.keepOriginalAudio.dispatchEvent(new Event('change'));
    assert.equal(f.video.muted, true);
    assert.equal(f.active().paused, false);
    f.state.dubbingEnabled = false;
    f.scope.stopDubPlayback();
    f.frames.advance(1000);
    assert.equal(f.video.muted, false);
    assert.equal(f.video.volume, 1);
    assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test('decision hold lets the current voice finish while the video is paused', async () => {
  const f = fixture([line('a', 1, 2)]);
  try {
    await f.sync();
    const audio = f.active();
    f.state.decisionDubHold = true;
    f.video.paused = true;
    f.event('pause');
    await f.sync();
    assert.equal(audio.paused, false);
    audio.end();
    assert.equal(f.state.activeDubSegmentId, null);
  } finally { f.close(); }
});

test('a slow current line holds the source and then starts from its first syllable', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 4)], { ensure: () => request.promise, durations: { a: 3 } });
  try {
    const pending = f.sync();
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.video.currentTime, 1);
    assert.equal(f.state.dubBuffer.loading, true);
    assert.equal(f.els.dubRetryBtn.disabled, true);
    request.resolve('a');
    await pending;
    assert.equal(f.video.paused, false);
    assert.equal(f.active().currentTime, 0);
    assert.equal(f.active().paused, false);
    assert.equal(f.state.dubBuffer, null);
  } finally { f.close(); }
});

test('callbacks delayed beyond the former 650ms cutoff still dub the current line', async () => {
  const f = fixture([line('a', 1, 5)], { durations: { a: 4 } });
  try {
    f.video.currentTime = 2;
    await f.sync();
    assert.equal(f.state.activeDubSegmentId, 'a');
    assert.equal(f.active().currentTime, 1);
    assert.equal(f.active().paused, false);
  } finally { f.close(); }
});

test('ready prefetched lines do not stop the video', async () => {
  const segment = line('a', 1, 4);
  const f = fixture([segment]);
  try {
    await f.scope.prepareDubAudio(segment);
    const pauses = f.video.pauses;
    await f.sync();
    assert.equal(f.video.pauses, pauses);
    assert.equal(f.state.dubBuffer, null);
    assert.equal(f.active().plays, 1);
  } finally { f.close(); }
});

test('a provider failure pauses visibly and a retry plays without consuming the line early', async () => {
  let available = false;
  const f = fixture([line('a', 1, 4)], { ensure: async () => available ? 'a' : null });
  try {
    await f.sync();
    assert.equal(f.video.paused, true);
    assert.equal(f.state.dubBuffer.loading, false);
    assert.match(f.els.dubBufferMessage.textContent, /hazırlanamadı/);
    assert.equal(f.state.dubPlayedSegmentIds.size, 0);
    available = true;
    await f.scope.retryDubBuffer();
    await tick();
    assert.equal(f.state.activeDubSegmentId, 'a');
    assert.equal(f.state.dubBuffer, null);
  } finally { f.close(); }
});

test('a provider cooldown cannot be bypassed by retrying the buffer', async () => {
  const f = fixture([line('a', 1, 4)], { ensure: async () => null });
  try {
    await f.sync();
    f.state.dubUnavailableUntil = Date.now() + 120000;
    const plays = f.video.plays;
    await f.scope.retryDubBuffer();
    assert.equal(f.video.plays, plays);
    assert.equal(f.video.paused, true);
    assert.match(f.els.dubBufferMessage.textContent, /saniye sonra/);
  } finally { f.close(); }
});

test('the user can continue without dubbing while generation is still pending', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 4)], { ensure: () => request.promise });
  try {
    const pending = f.sync();
    await f.scope.retryDubBuffer(true);
    assert.equal(f.state.dubbingEnabled, false);
    assert.equal(f.state.dubBuffer, null);
    assert.equal(f.video.paused, false);
    request.resolve('a');
    await pending;
    assert.equal(f.state.activeDubSegmentId, null);
    assert.ok(f.made.every(audio => audio.plays === 0));
  } finally { f.close(); }
});

test('an obsolete selection cannot auto-resume after its voice finishes preparing', async () => {
  for (const changed of ['adultSelectionToken', 'playbackGeneration', 'gameState']) {
    const request = deferred();
    const f = fixture([line('a', 1, 4)], { ensure: () => request.promise });
    try {
      const pending = f.sync();
      f.state[changed] = 'changed';
      request.resolve('a');
      await pending;
      assert.equal(f.video.plays, 0, changed);
      assert.equal(f.video.paused, true);
      assert.equal(f.state.dubBuffer, null);
    } finally { f.close(); }
  }
});

test('a source change while buffered cannot start a stale voice or source playback', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 4)], { ensure: () => request.promise });
  try {
    const pending = f.sync();
    f.state.dubRequestController.abort();
    f.state.dubRequestController = new AbortController();
    f.scope.stopDubPlayback();
    request.resolve('a');
    await pending;
    assert.equal(f.video.plays, 0);
    assert.equal(f.state.activeDubSegmentId, null);
    assert.equal(f.state.dubBuffer, null);
  } finally { f.close(); }
});

test('an audio decode failure exposes recovery instead of leaving a heard-but-silent line', async () => {
  const f = fixture([line('a', 1, 4)]);
  try {
    await f.sync();
    const old = f.active();
    old.error = { code: 3 };
    old.dispatchEvent(new Event('error'));
    assert.equal(f.video.paused, true);
    assert.equal(f.state.dubPlayedSegmentIds.has('a'), false);
    assert.equal(f.state.dubBuffer.loading, false);
    await f.scope.retryDubBuffer();
    await tick();
    assert.notEqual(f.active(), old);
    assert.equal(f.active().paused, false);
  } finally { f.close(); }
});

test('buffering waits for the caller play promise to settle before pausing the source', async () => {
  const request = deferred();
  const f = fixture([line('a', 1, 4)], { ensure: () => request.promise, browserEvents: true });
  try {
    f.video.paused = true;
    await assert.doesNotReject(f.video.play(), 'navigation must not receive AbortError from a dubbing hold');
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.state.dubBuffer.loading, true);
    request.resolve('a');
    await tick();
    assert.equal(f.video.paused, false);
    assert.equal(f.state.dubBuffer, null);
    assert.equal(f.active().paused, false);
    assert.equal(f.active().plays, 1);
  } finally { f.close(); }
});

test('four overlapping speakers play once on four channels with bounded combined volume', async () => {
  const segments = ['a', 'b', 'c', 'd'].map(id => ({ ...line(id, 1, 5), speakerId: id }));
  const f = fixture(segments, { durations: { a: 4, b: 4, c: 4, d: 4 } });
  try {
    await f.sync();
    assert.equal(f.channels().length, 4);
    assert.ok(f.made.every(audio => audio.plays === 1 && !audio.paused));
    assert.ok(f.channels().reduce((sum, [, audio]) => sum + audio.volume, 0) <= 0.82001);
    const first = f.channels()[0][1];
    first.end();
    await tick();
    assert.equal(f.channels().length, 3);
    assert.ok(f.channels().every(([, audio]) => !audio.paused && audio.plays === 1));
    f.video.currentTime = 2;
    f.event('seeking');
    f.event('seeked');
    await tick();
    assert.equal(f.channels().length, 4);
    assert.ok(f.channels().every(([, audio]) => audio.currentTime === 1));
  } finally { f.close(); }
});

test('an overlapping second speaker does not accelerate or stop the first', async () => {
  const a = { ...line('a', 1, 5), speakerId: 'alice' };
  const b = { ...line('b', 2, 4), speakerId: 'bob' };
  const f = fixture([a, b], { durations: { a: 4, b: 2 } });
  try {
    await f.sync();
    const first = f.active();
    assert.equal(first.playbackRate, 1);
    f.video.currentTime = 2;
    first.currentTime = 1;
    await f.sync();
    assert.equal(f.channels().length, 2);
    assert.equal(first.paused, false);
    assert.equal(first.currentTime, 1);
    assert.equal(first.playbackRate, 1);
    assert.equal(f.made.find(audio => audio.src === 'b').currentTime, 0);
  } finally { f.close(); }
});

test('a shared buffer waits for all simultaneous voices before resuming the source', async () => {
  const a = deferred();
  const b = deferred();
  const segments = ['a', 'b'].map(id => ({ ...line(id, 1, 5), speakerId: id }));
  const f = fixture(segments, { ensure: row => row.speakerId === 'a' ? a.promise : b.promise });
  try {
    const pending = f.sync();
    a.resolve('a');
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.channels().length, 0);
    b.resolve('b');
    await pending;
    assert.equal(f.video.paused, false);
    assert.equal(f.channels().length, 2);
    assert.equal(f.video.plays, 1);
  } finally { f.close(); }
});
