import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sceneExitTime, seekMediaTo } from '../public/playback-logic.js';

// Exercise the real playback handlers with neutral chapter data and simulated
// media events. No model calls or content/progression rules are involved.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['cancelAdultSeek', 'beginAdultSelection', 'seekAdultLoop',
  'clearPanelPlaybackRecovery', 'showPanelPlaybackRecovery', 'resumePanelPlayback',
  'skipCurrentScene', 'finishAdultScene', 'updateAdultPlayback', 'handleSourceEnded'];
const handlers = names.map(name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}).join('\n');

class Element extends EventTarget {
  children = [];
  dataset = {};
  classes = new Set();
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name))
  };
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  appendChild(child) { this.append(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  querySelector(selector) { return selector === 'button' ? this.children.at(-1) : null; }
}

class Media extends Element {
  time = 10;
  duration = 150;
  readyState = 4;
  seeking = false;
  paused = true;
  mode = 'ready';
  playCalls = 0;
  get currentTime() { return this.time; }
  set currentTime(value) {
    if (this.mode === 'throw') throw new Error('Media assignment failed');
    this.seeking = true;
    if (this.mode === 'stalled') return;
    this.time = value;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event(this.mode === 'error' ? 'error' : 'seeked'));
    });
  }
  pause() { this.paused = true; }
  async play() {
    this.playCalls += 1;
    if (this.mode === 'blocked') throw new Error('NotAllowedError');
    if (this.mode === 'pending-play') return new Promise((_resolve, reject) => { this.rejectPlay = reject; });
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
}

function fixture() {
  const stage = new Element();
  const video = new Media();
  video.closest = () => stage;
  const state = {
    adultMode: true, adultScene: { id: 'chapter-1', startTime: 0, endTime: 100, positions: [] },
    adultSelectionToken: 0, adultSeekRequestId: 0, adultLoopSeeking: false,
    adultSeekController: null, adultOutcomePhase: 'idle', adultTimelineFloor: 0,
    adultUnlockedPositionIds: new Set(), adultVisitedPositionIds: new Set(),
    adultRevealedPositionIds: new Set(), completedAdultSceneIds: new Set(),
    consumedActionIds: new Set(), currentActionIndex: -1,
    analysis: { actions: [], videoDuration: 150 }, gameState: 'SEGMENT_PLAYING',
    events: [], resyncs: 0, navigationTargets: []
  };
  const els = new Proxy({ video, panelPlaybackRecovery: null }, {
    get(target, key) { return Object.hasOwn(target, key) ? target[key] : (target[key] = new Element()); }
  });
  const scope = vm.createContext({ state, els, AbortController, DOMException,
    performance, clearTimeout, sceneExitTime,
    // Only shorten the timer; the media readiness/abort implementation is real.
    seekMediaTo: (media, target, options) => seekMediaTo(media, target, { ...options, timeoutMs: 25 }),
    document: { createElement: () => new Element(), querySelector: () => new Element() },
    setGameState: value => { state.gameState = value; },
    logEngineEvent: (type, data) => state.events.push({ type, data }),
    primeLanguageTracksAt() {}, resyncLanguageTracks: () => { state.resyncs += 1; },
    setAdultMachinePhase() {}, persistRuntimeSnapshot() {}, renderChoices() {},
    orderedLockedAdultPositions: () => [], isWarmupPosition: () => false,
    selectAdultPosition: () => { throw Error('Exit must not route to another clip'); },
    navigateTimelineTo: async target => { state.navigationTargets.push(target); },
    currentAdultFlow: () => 0, renderAdultProgressiveUI() {}, findAdultSceneAt: () => null
  });
  vm.runInContext(handlers, scope);
  video.addEventListener('play', () => { if (state.gameState !== 'SEGMENT_PLAYING') video.pause(); });
  return Object.assign(scope, { stage });
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('stalled panel seek never starts playback or reports a successful transition', async () => {
  const f = fixture();
  f.els.video.mode = 'stalled';
  const pending = f.seekAdultLoop(80);
  assert.equal(f.state.adultLoopSeeking, true);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(await pending, false);
  assert.equal(f.els.video.currentTime, 10);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.resyncs, 0);
  assert.equal(f.state.adultLoopSeeking, false);
  assert.equal(f.state.adultSeekController, null);
  assert.equal(f.els.panelPlaybackRecovery.querySelector('button').dataset.playbackRecovery, 'retry');
});

for (const mode of ['throw', 'error']) {
  test(`panel seek ${mode} cleans up and can be retried through the visible button`, async () => {
    const f = fixture();
    f.els.video.mode = mode;
    assert.equal(await f.seekAdultLoop(80), false);
    assert.equal(f.state.adultLoopSeeking, false);
    assert.equal(f.state.adultSeekController, null);
    assert.equal(f.state.gameState, 'DECISION_PENDING');
    f.els.video.mode = 'ready';
    f.els.panelPlaybackRecovery.querySelector('button').dispatchEvent(new Event('click'));
    await flush();
    assert.equal(f.els.video.currentTime, 80);
    assert.equal(f.els.video.paused, false);
    assert.equal(f.state.resyncs, 1);
    assert.equal(f.els.panelPlaybackRecovery, null);
    assert.equal(f.stage.children.length, 0);
  });
}

test('blocked playback offers continue without losing the active clip or seeking again', async () => {
  const f = fixture();
  f.state.activeMovementId = 'clip-1';
  f.els.video.mode = 'blocked';
  assert.equal(await f.seekAdultLoop(40), false);
  assert.equal(f.state.gameState, 'DECISION_PENDING');
  const button = f.els.panelPlaybackRecovery.querySelector('button');
  assert.equal(button.dataset.playbackRecovery, 'continue');
  f.els.video.mode = 'ready';
  button.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(f.els.video.currentTime, 40);
  assert.equal(f.els.video.paused, false);
  assert.equal(f.state.activeMovementId, 'clip-1');
  assert.equal(f.state.resyncs, 1);
});

test('new panel selection cancels the old seek without clearing the new state', async () => {
  const f = fixture();
  f.els.video.mode = 'stalled';
  const previous = f.seekAdultLoop(20);
  const token = f.beginAdultSelection();
  f.els.video.mode = 'ready';
  const current = f.seekAdultLoop(60, token);
  assert.equal(await previous, false);
  assert.equal(await current, true);
  assert.equal(f.els.video.currentTime, 60);
  assert.equal(f.state.adultLoopSeeking, false);
  assert.equal(f.els.video.playCalls, 1);
  assert.equal(f.els.panelPlaybackRecovery, null);
});

test('old play rejection cannot cover a later selection with a recovery message', async () => {
  const f = fixture();
  f.els.video.mode = 'pending-play';
  const previous = f.seekAdultLoop(20);
  await flush();
  const reject = f.els.video.rejectPlay;
  f.els.video.mode = 'ready';
  const token = f.beginAdultSelection();
  assert.equal(await f.seekAdultLoop(60, token), true);
  reject(new Error('Playback superseded'));
  assert.equal(await previous, false);
  assert.equal(f.els.panelPlaybackRecovery, null);
  assert.equal(f.state.gameState, 'SEGMENT_PLAYING');
});

for (const phase of ['idle', 'outcome', 'aftermath', 'orgasm-decision']) {
  test(`scene skip exits during ${phase}, even with unplayed options`, () => {
    const f = fixture();
    f.state.adultOutcomePhase = phase;
    f.state.adultScene.positions = [{ id: 'clip-2', startTime: 30, endTime: 40 }];
    f.state.adultUnlockedPositionIds.add('clip-2');
    f.skipCurrentScene();
    assert.equal(f.state.adultMode, false);
    assert.equal(f.state.adultScene, null);
    assert.equal(f.state.completedAdultSceneIds.has('chapter-1'), true);
    assert.deepEqual(f.state.navigationTargets, [100]);
    assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), true);
  });
}

test('scene exit cancels a pending seek and removes its recovery state', async () => {
  const f = fixture();
  f.els.video.mode = 'stalled';
  const pending = f.seekAdultLoop(60);
  f.skipCurrentScene();
  assert.equal(await pending, false);
  assert.equal(f.state.adultLoopSeeking, false);
  assert.equal(f.state.adultSeekController, null);
  assert.equal(f.els.panelPlaybackRecovery, null);
  assert.equal(f.els.video.playCalls, 0);
});

for (const paused of [false, true]) {
  test(`passing the scene boundary clears the old panel without rewinding (paused=${paused})`, () => {
    const f = fixture();
    f.els.video.time = 130;
    f.els.video.paused = paused;
    f.updateAdultPlayback(1000, 130);
    assert.equal(f.state.adultMode, false);
    assert.equal(f.state.adultScene, null);
    assert.deepEqual(f.state.navigationTargets, [130]);
  });
}

test('end of source clears the scene even with an active clip and paused video', () => {
  const f = fixture();
  f.state.activeMovementId = 'clip-1';
  f.els.video.time = 150;
  f.handleSourceEnded();
  assert.equal(f.state.adultMode, false);
  assert.deepEqual(f.state.navigationTargets, [150]);
});

test('pending media seek does not accidentally trigger scene exit', () => {
  const f = fixture();
  f.els.video.time = 130;
  f.els.video.seeking = true;
  f.updateAdultPlayback(1000, 130);
  assert.equal(f.state.adultMode, true);
  assert.deepEqual(f.state.navigationTargets, []);
});
