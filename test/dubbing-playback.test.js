import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDubMixer, naturalDubRate, canFinishDubTail } from '../public/dubbing-audio.js';
import { dialogueSegmentAt, nextDialogueSegments, dialogueSegmentsForTarget,
  isDubStartTimely, mapVideoTimeToDubTime, dubSegmentKey } from '../public/playback-logic.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
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
function fixture(segments, { durations = {}, ensure, playGate } = {}) {
  const made = [];
  class Media extends EventTarget {
    paused = true; ended = false; seeking = false; volume = 1; muted = false;
    currentTime = 0; duration = 1; playbackRate = 1; readyState = 4; src = '';
    plays = 0; pauses = 0;
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
      if (playGate) await playGate(this);
      this.paused = false;
      this.ended = false;
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
    activeDubSegmentId: null, dubPlayedSegmentIds: new Set(), dubRequestController: new AbortController()
  };
  const els = { video, keepOriginalAudio: new Media() };
  const timers = new Map();
  let nextTimer = 0;
  const scope = vm.createContext({
    state, els, Audio, console, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id),
    createDubMixer: media => createDubMixer(media, frames), naturalDubRate, canFinishDubTail,
    dialogueSegmentAt, nextDialogueSegments, dialogueSegmentsForTarget, isDubStartTimely, mapVideoTimeToDubTime,
    dubTimeline: () => segments, getDubSegmentId: segment => segment ? dubSegmentKey(segment) : '',
    ensureDubSegment: ensure || (async segment => segment.segmentId), renderSubtitle() {}, logEngineEvent() {}
  });
  const helpers = source.slice(source.indexOf('const dubChannels = new Map();'), source.indexOf('function recordAiUsage('));
  const from = source.indexOf("els.video.addEventListener('timeupdate', () => void syncDubPlayback());");
  const events = source.slice(from, source.indexOf("els.subtitleToggleBtn?.addEventListener", from));
  vm.runInContext(helpers + functions('stopDubPlayback', 'prefetchDubSegmentsAround', 'primeLanguageTracksAt',
    'resyncLanguageTracks', 'playDubAudio', 'syncDubPlayback') + events + '\nupdateDubMix();', scope);
  return { scope, video, state, made, frames, timers, els,
    sync: () => scope.syncDubPlayback(),
    event: name => video.dispatchEvent(new Event(name)),
    active: () => vm.runInContext('dubChannels.get(state.activeDubSegmentId)', scope),
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
