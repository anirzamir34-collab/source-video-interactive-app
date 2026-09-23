import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analysisGapBridgeTarget, decisionBoundaryAfterDialogue, hasRemainingVideo, sceneExitTime, seekMediaTo } from '../public/playback-logic.js';

// Exercise the actual application handlers with deterministic media events.
// These tests deliberately use ordinary chapter data and no model/API calls.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['isUnownedTimelineChoice', 'finishAdultScene', 'nextVerifiedRouteTime', 'resumeAnalysisGap', 'renderChoices', 'showPlaybackRecovery', 'resumeSourceVideo', 'navigateTimelineTo', 'cancelTimelineNavigation', 'playAction', 'resumeActionPlayback', 'finishActionAfterDub', 'waitForDubEnd'];
const handlers = names.map(name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is present`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}).join('\n');

class Element extends EventTarget {
  children = [];
  dataset = {};
  classes = new Set();
  classList = { add: (...names) => names.forEach(n => this.classes.add(n)), remove: (...names) => names.forEach(n => this.classes.delete(n)) };
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  set innerHTML(value) { this.children = []; this.html = value; }
  querySelector(selector) {
    return this.children.find(child => selector === 'button' || selector.includes(`"${child.dataset.playbackRecovery}"`)) || null;
  }
}

class Media extends Element {
  time = 0;
  duration = 100;
  readyState = 4;
  seeking = false;
  paused = true;
  mode = 'ready';
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value;
    this.seeking = true;
    if (this.mode === 'stalled') return;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event(this.mode === 'error' ? 'error' : 'seeked'));
    });
  }
  pause() { this.paused = true; }
  async play() {
    if (this.mode === 'blocked') throw Error('NotAllowedError');
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
}

function fixture() {
  const state = {
    analysis: { actions: [], videoDuration: 100 }, adultMode: false, adultScenes: [],
    completedAdultSceneIds: new Set(), consumedActionIds: new Set(), currentActionIndex: -1,
    gameCursorTime: 0, adultSelectionToken: 0, gameState: 'DECISION_PENDING', stopListener: null
  };
  const els = new Proxy({ video: new Media() }, { get(target, key) { return target[key] ||= new Element(); } });
  const scope = vm.createContext({ state, els, AbortController, DOMException,
    analysisGapBridgeTarget, hasRemainingVideo, sceneExitTime, seekMediaTo, decisionBoundaryAfterDialogue,
    setTimeout, clearTimeout, dubChannels: new Map(),
    guardPlayable: () => ({ allowed: true }),
    finishAction: action => { state.finishedAction = action; },
    document: { createElement: () => new Element(), querySelector: () => new Element() },
    setGameState: value => { state.gameState = value; },
    setAdultMachinePhase() {}, logEngineEvent() {}, cancelAdultSeek() {}, persistRuntimeSnapshot() {}, renderDebug() {},
    orderedLockedAdultPositions: () => [], findAdultSceneAt: () => null,
    futureActions: () => [], selectDiverseStoryActions: list => list, findAdultSceneForTimeline: () => null,
    verifiedAdultPositionFamily: () => null, storyChoiceLabelForAction: action => action.label,
    playableAdultPanelFamily: () => '',
    escapeHtml: value => String(value)
  });
  vm.runInContext(handlers, scope);
  // Mirror the application's play guard: an incorrect state silently pauses.
  els.video.addEventListener('play', () => { if (state.gameState !== 'SEGMENT_PLAYING') els.video.pause(); });
  return scope;
}

test('scene exit resumes adjacent source footage when no choices remain', async () => {
  const f = fixture();
  f.state.adultScene = { id: 'chapter-1', startTime: 0, endTime: 24, postSceneTime: 90, positions: [] };
  f.state.adultMode = true;
  f.finishAdultScene({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 24);
  assert.equal(f.els.video.paused, false);
  assert.equal(f.state.gameState, 'SEGMENT_PLAYING');
  assert.equal(f.state.navigationSeeking, false);
});

test('partial analysis plays through a failed range and restores the next verified choice', async () => {
  const f = fixture();
  f.state.analysis = {
    partial: true, videoDuration: 100,
    analysisGaps: [{ startTime: 10, endTime: 20 }],
    actions: [{ actionId: 'verified-next', label: 'Kapıyı aç', startTime: 30, endTime: 35, sourceVerified: true }]
  };
  f.state.gameCursorTime = 10;
  f.renderChoices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.gameState, 'SEGMENT_PLAYING');
  assert.equal(f.els.video.paused, false);
  assert.equal(f.els.choices.classes.has('hidden'), true);
  f.els.video.time = 30;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.gameCursorTime, 30);
  assert.equal(f.state.gameState, 'DECISION_PENDING');
  assert.equal(f.els.choices.children.length, 1);
});

test('a final failed range continues to the real media end instead of waiting forever', async () => {
  const f = fixture();
  f.state.analysis = {
    partial: true, videoDuration: 100,
    analysisGaps: [{ startTime: 10, endTime: 100 }],
    actions: [{ actionId: 'completed', label: 'Tamamlandı', startTime: 0, endTime: 10, sourceVerified: true }]
  };
  f.state.currentActionIndex = 0;
  f.state.consumedActionIds.add('completed');
  f.state.gameCursorTime = 10;
  f.renderChoices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.paused, false);
  f.els.video.time = 100;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameState, 'ENDED');
  assert.equal(f.els.video.paused, true);
});

test('blocked gap playback exposes a usable continue control', async () => {
  const f = fixture();
  f.els.video.mode = 'blocked';
  f.state.analysis = {
    partial: true, videoDuration: 100,
    analysisGaps: [{ startTime: 10, endTime: 20 }],
    actions: [{ actionId: 'verified-next', label: 'Devam', startTime: 30, endTime: 35, sourceVerified: true }]
  };
  f.state.gameCursorTime = 10;
  f.renderChoices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.gameState, 'DECISION_PENDING');
  assert.equal(f.els.choices.children[1].dataset.playbackRecovery, 'continue');
});

test('failed navigation exposes retry; new seek cancels pending navigation', async () => {
  const f = fixture();
  f.els.video.mode = 'error';
  await f.navigateTimelineTo(45);
  assert.equal(f.state.navigationSeeking, false);
  assert.equal(f.els.choices.children[1].dataset.playbackRecovery, 'retry');
  f.els.video.mode = 'stalled';
  const previous = f.navigateTimelineTo(20);
  f.els.video.mode = 'ready';
  await f.navigateTimelineTo(60);
  await previous;
  assert.equal(f.state.gameCursorTime, 60);
  assert.equal(f.state.navigationSeeking, false);
  assert.equal(f.state.navigationSeekController, null);
});

test('blocked play has a continue action; only the source end is terminal', async () => {
  const f = fixture();
  f.els.video.mode = 'blocked';
  await f.navigateTimelineTo(70, { resumeWhenEmpty: true });
  assert.equal(f.state.gameState, 'DECISION_PENDING');
  assert.equal(f.els.choices.children[1].dataset.playbackRecovery, 'continue');
  f.els.video.mode = 'ready';
  await f.resumeSourceVideo();
  assert.equal(f.els.video.paused, false);
  await f.navigateTimelineTo(100);
  assert.equal(f.state.gameState, 'ENDED');
});

test('ordinary choice seek errors expose retry without starting playback', async () => {
  const f = fixture();
  const action = { actionId: 'door', startTime: 20, endTime: 30 };
  f.els.video.mode = 'error';
  await f.playAction(action);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.navigationSeeking, false);
  assert.equal(f.els.choices.children[1].dataset.playbackRecovery, 'retry');
  f.els.video.mode = 'ready';
  await f.playAction(action);
  assert.equal(f.els.video.paused, false);
  assert.equal(f.state.activeAction, action);
});

test('blocked ordinary choice resumes with its original end boundary intact', async () => {
  const f = fixture();
  const action = { actionId: 'walk', startTime: 20, endTime: 30 };
  f.els.video.mode = 'blocked';
  await f.playAction(action);
  assert.equal(f.els.choices.children[1].dataset.playbackRecovery, 'continue');
  f.els.video.mode = 'ready';
  await f.resumeActionPlayback(action);
  assert.equal(f.state.activeAction, action);
  f.els.video.time = 30;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.finishedAction, action);
});

test('a new navigation cancels an ordinary choice still seeking', async () => {
  const f = fixture();
  const action = { actionId: 'walk', startTime: 20, endTime: 30 };
  f.els.video.mode = 'stalled';
  const pending = f.playAction(action);
  f.els.video.mode = 'ready';
  await f.navigateTimelineTo(60);
  await pending;
  assert.equal(f.state.gameCursorTime, 60);
  assert.equal(f.state.activeAction, null);
  assert.equal(f.state.stopListener, null);
  assert.equal(f.els.video.paused, true);
});

test('old dubbing completion cannot finish a choice after navigation', async () => {
  const f = fixture();
  const action = { actionId: 'talk', startTime: 20, endTime: 30 };
  await f.playAction(action);
  f.state.dubbingEnabled = true;
  const audio = new Media();
  audio.paused = false;
  f.dubChannels.set('line', audio);
  const pending = f.finishActionAfterDub(action, 30);
  assert.equal(f.state.decisionDubHold, true);
  await f.navigateTimelineTo(60);
  audio.dispatchEvent(new Event('ended'));
  await pending;
  assert.equal(f.state.finishedAction, undefined);
  assert.equal(f.state.gameCursorTime, 60);
  assert.equal(f.state.decisionDubHold, false);
});

test('a decision boundary budgets the remaining voice duration at the chosen playback speed', async () => {
  const f = fixture();
  const audio = new Media();
  audio.duration = 12;
  audio.time = 2;
  audio.playbackRate = .5;
  let deadline;
  f.setTimeout = (_callback, delay) => { deadline = delay; return 1; };
  f.clearTimeout = () => {};
  const pending = f.waitForDubEnd([audio]);
  assert.ok(deadline > 20000, 'twenty seconds of remaining speech must not be cut by the former eight-second timer');
  audio.dispatchEvent(new Event('ended'));
  await pending;
});
