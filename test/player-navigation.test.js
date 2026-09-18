import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { hasRemainingVideo, sceneExitTime, seekMediaTo } from '../public/playback-logic.js';

// Exercise the actual application handlers with deterministic media events.
// These tests deliberately use ordinary chapter data and no model/API calls.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['finishAdultScene', 'renderChoices', 'showPlaybackRecovery', 'resumeSourceVideo', 'navigateTimelineTo', 'cancelTimelineNavigation'];
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
    gameCursorTime: 0, adultSelectionToken: 0, gameState: 'DECISION_PENDING'
  };
  const els = new Proxy({ video: new Media() }, { get(target, key) { return target[key] ||= new Element(); } });
  const scope = vm.createContext({ state, els, AbortController, DOMException,
    hasRemainingVideo, sceneExitTime, seekMediaTo,
    document: { createElement: () => new Element(), querySelector: () => new Element() },
    setGameState: value => { state.gameState = value; },
    setAdultMachinePhase() {}, logEngineEvent() {}, cancelAdultSeek() {}, persistRuntimeSnapshot() {}, renderDebug() {},
    orderedLockedAdultPositions: () => [], findAdultSceneAt: () => null,
    futureActions: () => [], selectDiverseStoryActions: list => list, findAdultSceneForTimeline: () => null,
    verifiedAdultPositionFamily: () => null
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
