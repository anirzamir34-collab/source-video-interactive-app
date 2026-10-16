import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as choiceRouting from '../public/choice-routing.js';
import { selectDiverseStoryActions, selectSameMomentStoryActions } from '../public/story-engine.js';
import { conversationEnd } from '../public/conversation-timing.js';
import { analysisGapBridgeTarget, hasRemainingVideo, sceneExitTime, nextVerifiedActionBoundary, seekMediaTo, playMedia } from '../public/playback-logic.js';

// Exercise the actual application handlers with deterministic media events.
// These tests deliberately use ordinary chapter data and no model/API calls.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['futureActions', 'genericConversationEnd', 'isUnownedTimelineChoice', 'finishAdultScene', 'nextVerifiedRouteTime', 'resumeAnalysisGap', 'renderChoices', 'showPlaybackRecovery', 'resumeSourceVideo', 'navigateTimelineTo', 'cancelTimelineNavigation', 'playAction', 'resumeActionPlayback'];
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
  const scope = vm.createContext({ ...choiceRouting, state, els, AbortController, DOMException,
    analysisGapBridgeTarget, hasRemainingVideo, sceneExitTime, nextVerifiedActionBoundary, seekMediaTo, playMedia,
    mediaClient: { conversationEndAt: (time, rows, duration) => conversationEnd(time, rows, [], { duration }) },
    setTimeout, clearTimeout,
    guardPlayable: () => ({ allowed: true }),
    finishAction: (action, boundary) => { state.finishedAction = action; state.finishedBoundary = boundary; els.video.pause(); },
    document: { createElement: () => new Element(), querySelector: () => new Element() },
    setGameState: value => { state.gameState = value; },
    setAdultMachinePhase() {}, logEngineEvent() {}, cancelAdultSeek() {}, clearInteractionSelection() {}, persistRuntimeSnapshot() {}, renderDebug() {},
    orderedLockedAdultPositions: () => [], findAdultSceneAt: () => null,
    selectDiverseStoryActions, selectSameMomentStoryActions, findAdultSceneForTimeline: () => null,
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

test('an unowned story action inside a wide scene envelope retains its ordinary choice surface', () => {
  const f = fixture();
  const scene = { id: 'wide-envelope', startTime: 0, endTime: 90, dialogue: [], positions: [] };
  f.state.adultScenes = [scene];
  f.state.gameCursorTime = 10;
  f.state.analysis.actions = [{ actionId: 'ordinary-line', sourceVerified: true, actionType: 'dialogue',
    label: 'Existing source line', startTime: 10, endTime: 20 }];
  f.findAdultSceneAt = () => scene;
  f.enterAdultScene = () => { throw Error('A scene envelope must not consume this source action'); };
  f.renderChoices();
  assert.equal(f.els.choices.children.length, 1);
  assert.match(f.els.choices.children[0].html, /Existing source line/);
});

test('leaving a chapter plays an unanalyzed gap before the next chapter', async () => {
  const f = fixture();
  f.els.video.duration = 400;
  f.state.analysis = {
    partial: true, videoDuration: 400,
    analysisGaps: [{ startTime: 236.3, endTime: 315.1 }],
    actions: [{ actionId: 'next', label: 'Yeni bölüm', startTime: 315.1,
      endTime: 327.5, sourceVerified: true }]
  };
  f.state.adultScene = { id: 'chapter-1', startTime: 145, endTime: 236.3, positions: [] };
  f.state.adultMode = true;
  f.finishAdultScene({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 236.3);
  assert.equal(f.els.video.paused, false);
  f.els.video.time = 315.1;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 315.1);
  assert.equal(f.els.choices.children.length, 1);
});

test('leaving a chapter also bridges an unlabeled gap without partial metadata', async () => {
  const f = fixture();
  f.els.video.duration = 400;
  f.state.analysis = { videoDuration: 400, actions: [
    { actionId: 'next', label: 'Yeni bölüm', startTime: 315.1,
      endTime: 327.5, sourceVerified: true }
  ] };
  f.state.adultScene = { id: 'chapter-1', startTime: 145, endTime: 236.3, positions: [] };
  f.state.adultMode = true;
  f.finishAdultScene({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 236.3);
  assert.equal(f.els.video.paused, false);
  f.els.video.time = 315.1;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 315.1);
  assert.equal(f.els.choices.children.length, 1);
});

test('an immediate verified choice remains available at the chapter boundary', async () => {
  const f = fixture();
  f.state.analysis = { videoDuration: 100, actions: [
    { actionId: 'adjacent', label: 'Kapıyı aç', startTime: 24,
      endTime: 30, sourceVerified: true }
  ] };
  f.state.adultScene = { id: 'chapter-1', startTime: 0, endTime: 24, positions: [] };
  f.state.adultMode = true;
  f.finishAdultScene({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 24);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.els.choices.children.length, 1);
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

test('unowned chapters offer a watch or skip decision at each source boundary', async () => {
  const f = fixture();
  f.state.analysis = {
    videoDuration: 100,
    actions: [{ actionId: 'later', label: 'Kapıyı aç', startTime: 80, endTime: 85, sourceVerified: true }],
    unownedSourceIntervals: [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }]
  };
  f.renderChoices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.paused, false);
  f.els.video.time = 10;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.choices.children[1].textContent, 'Bölümü izle');
  assert.equal(f.els.choices.children[2].textContent, 'Sahneyi geç');
  f.els.choices.children[1].dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  f.els.video.time = 20;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.paused, false, 'watching continues in source order to the next chapter');
  f.els.video.time = 40;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.choices.children[1].textContent, 'Bölümü izle');
  f.els.choices.children[2].dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.gameCursorTime, 50);
  assert.equal(f.els.video.currentTime, 50);
  assert.equal(f.els.video.paused, false, 'skipping a chapter keeps intervening source footage');
  f.els.video.time = 80;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 80);
  assert.equal(f.els.choices.children.length, 1);
});

test('skipping the last unowned chapter resumes remaining footage instead of seeking to the media end', async () => {
  const f = fixture();
  f.state.analysis = {
    videoDuration: 100, actions: [],
    unownedSourceIntervals: [{ startTime: 10, endTime: 25 }]
  };
  f.state.gameCursorTime = 10;
  f.els.video.time = 10;
  f.renderChoices();
  f.els.choices.children[2].dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 25);
  assert.equal(f.state.gameCursorTime, 25);
  assert.equal(f.els.video.paused, false);
  assert.equal(f.state.gameState, 'SEGMENT_PLAYING');
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

test('partly elapsed ordinary choices are hidden and cannot rewind playback', async () => {
  const f = fixture();
  f.state.gameCursorTime = 12;
  const earlier = { actionId: 'earlier', label: 'Earlier source moment', actionType: 'dialogue',
    startTime: 10, endTime: 20, sourceVerified: true };
  const next = { actionId: 'next', label: 'Next source moment', actionType: 'dialogue',
    startTime: 22, endTime: 27, sourceVerified: true };
  f.state.analysis.actions = [earlier, next];
  assert.deepEqual(Array.from(f.futureActions(), action => action.actionId), ['next']);
  await f.playAction(earlier);
  assert.equal(f.els.video.currentTime, 0);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.activeAction, undefined);
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

test('a stale source stop callback cannot finish a choice after navigation', async () => {
  const f = fixture();
  const action = { actionId: 'talk', startTime: 20, endTime: 30 };
  await f.playAction(action);
  const previousStop = f.state.stopListener;
  await f.navigateTimelineTo(60);
  previousStop();
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.finishedAction, undefined);
  assert.equal(f.state.gameCursorTime, 60);
  assert.equal(f.state.activeAction, null);
  assert.equal(f.state.stopListener, null);
});

test('the general clip listener delegates its source boundary to the speech-aware completion handler', async () => {
  const f = fixture();
  const action = { actionId: 'talk', startTime: 20, endTime: 30 };
  f.state.dubbingEnabled = true;
  f.state.sourceContext = { segments: [{ startTime: 25, endTime: 42, text: 'Original source speech' }] };
  await f.playAction(action);
  assert.equal(f.els.video.currentTime, 20);
  f.els.video.time = 29.95;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.finishedAction, undefined);
  f.els.video.time = 30;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.finishedAction, action);
  assert.equal(f.state.finishedBoundary, 30);
  assert.equal(f.els.video.currentTime, 30);
  assert.equal(f.els.video.paused, true);
});


test('a general gap boundary keeps playing through speech and records the actual played time', async () => {
  const f = fixture();
  f.state.sourceContext = { segments: [{ startTime: 9, endTime: 12 }] };
  f.state.analysis.actions = [{ actionId: 'next', label: 'Kapıyı aç', startTime: 15, endTime: 18, sourceVerified: true }];
  await f.resumeAnalysisGap(10);
  f.els.video.time = 10;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.video.paused, false);
  assert.equal(f.els.choices.classes.has('hidden'), true);
  f.els.video.time = 12.2;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.gameCursorTime, 12.2);
  assert.equal(f.els.choices.children.length, 1);
});

test('a replaced gap callback cannot pause a newer general playback', async () => {
  const f = fixture();
  await f.resumeAnalysisGap(10);
  const old = f.state.stopListener;
  await f.resumeAnalysisGap(20);
  f.els.video.time = 15;
  old();
  assert.equal(f.els.video.paused, false);
  assert.equal(f.state.gameCursorTime, 0);
  assert.notEqual(f.state.stopListener, old);
});

test('manual seeking during a general choice removes its old boundary and preserves the real cursor', () => {
  const f = fixture();
  const begin = source.indexOf("els.video.addEventListener('seeking',");
  const end = source.indexOf("els.video.addEventListener('play',", begin);
  vm.runInContext(source.slice(begin, end), f);
  f.state.activeAction = { actionId: 'old' };
  f.state.stopListener = () => { throw Error('stale callback'); };
  f.els.video.addEventListener('timeupdate', f.state.stopListener);
  f.state.analysis.actions = [
    { actionId: 'first', startTime: 1, endTime: 5, sourceVerified: true },
    { actionId: 'next', label: 'Kapıyı aç', startTime: 20, endTime: 25, sourceVerified: true }
  ];
  f.els.video.time = 10;
  f.els.video.dispatchEvent(new Event('seeking'));
  assert.equal(f.state.activeAction, null);
  assert.equal(f.state.stopListener, null);
  f.els.video.dispatchEvent(new Event('seeked'));
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 10);
  assert.equal(f.state.consumedActionIds.has('first'), true);
  assert.equal(f.state.consumedActionIds.has('next'), false);
  assert.equal(f.els.choices.children.length, 1);
  f.els.video.time = 100;
  f.els.video.dispatchEvent(new Event('seeking'));
  f.els.video.dispatchEvent(new Event('seeked'));
  assert.equal(f.state.gameState, 'ENDED');
});

function useRealCompletion(f) {
  const start = source.indexOf('function finishAction(');
  const end = source.indexOf('\nfunction resetGameAtAction', start);
  vm.runInContext(source.slice(start, end), f);
}

test('next verified source boundary interrupts long speech without rewinding or losing the next choice', async () => {
  const f = fixture(); useRealCompletion(f);
  const selected = { actionId: 'door', label: 'Kapıyı aç', startTime: 1, endTime: 2, sourceVerified: true };
  const next = { actionId: 'walk', label: 'Masaya yürü', startTime: 3, endTime: 5, sourceVerified: true };
  f.state.analysis.actions = [selected, next];
  f.state.sourceContext = { segments: [{ startTime: 1, endTime: 4 }] };
  await f.playAction(selected);
  f.els.video.time = 2;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.video.paused, false);
  // Speech lasts to 4s, but the next source-verified decision starts at 3s.
  // We must not play across that 3s boundary and erase the next event.
  f.els.video.time = 3.02;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.activeAction, null);
  assert.equal(f.state.gameCursorTime, 3.02);
  assert.equal(f.state.consumedActionIds.has('walk'), false);
  assert.equal(f.els.choices.children.length, 1);
  assert.equal(f.futureActions()[0].actionId, 'walk');
  await f.playAction(next);
  assert.equal(f.els.video.currentTime, 3.02);
  assert.equal(f.els.video.paused, false);
});

test('a distant general choice is reached automatically without exposing a stale distant button', async () => {
  const f = fixture();
  const later = { actionId: 'book', label: 'Kitabı al', startTime: 90, endTime: 95, sourceVerified: true };
  f.state.analysis.actions = [later];
  f.renderChoices();
  assert.equal(f.futureActions().length, 0);
  assert.equal(f.els.choices.children.length, 0);
  await f.playAction(later);
  assert.equal(f.els.video.currentTime, 0, 'a stale distant choice never seeks');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.els.video.currentTime, 0);
  assert.equal(f.els.video.paused, false);
  f.els.video.time = 90;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 90);
  assert.equal(f.els.choices.children.length, 1);
  assert.equal(f.futureActions()[0].actionId, 'book');
});

test('source ended completes an active general choice without needing one last timeupdate', async () => {
  const f = fixture(); useRealCompletion(f);
  const start = source.indexOf('function handleSourceEnded('), end = source.indexOf('\nfunction skipCurrentScene', start);
  vm.runInContext(source.slice(start, end), f);
  f.els.video.duration = 10;
  f.state.analysis.videoDuration = 10;
  const last = { actionId: 'last', label: 'Kitabı kapat', startTime: 5, endTime: 10.2, sourceVerified: true };
  f.state.analysis.actions = [last];
  await f.playAction(last);
  f.els.video.time = 10;
  f.els.video.ended = true;
  f.handleSourceEnded();
  assert.equal(f.state.activeAction, null);
  assert.equal(f.state.stopListener, null);
  assert.equal(f.state.gameCursorTime, 10);
  assert.equal(f.state.gameState, 'ENDED');
  assert.equal(f.state.consumedActionIds.has('last'), true);
});


test('gap playback stops at the earliest verified story choice even when speech continues past it', async () => {
  const f = fixture();
  f.els.video.duration = 630;
  f.state.analysis = { videoDuration: 630, partial: true,
    analysisGaps: [{ startTime: 0, endTime: 78.722 }],
    actions: [
      { actionId: 'first-dialogue', label: 'Teklifi konuş', sourceVerified: true,
        actionType: 'dialogue', startTime: 157.443, endTime: 172.08 },
      { actionId: 'next-dialogue', label: 'Sonraki kararı konuş', sourceVerified: true,
        actionType: 'dialogue', startTime: 200.08, endTime: 209.93 }
    ] };
  f.state.sourceContext = { segments: [{ startTime: 150, endTime: 190 }] };
  await f.resumeAnalysisGap(157.443);
  f.els.video.time = 157.45;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.els.video.paused, true);
  assert.ok(f.state.gameCursorTime >= 157.443 && f.state.gameCursorTime < 158);
  assert.equal(f.state.consumedActionIds.has('first-dialogue'), false);
  assert.equal(f.futureActions()[0].actionId, 'first-dialogue');
  assert.equal(f.els.choices.children.length, 1);
});


test('delayed gap playback tick preserves the exact first verified decision boundary', async () => {
  const f = fixture();
  f.els.video.duration = 200;
  f.state.analysis = { videoDuration: 200, partial: false, actions: [
    { actionId: 'first', label: 'İlk soruyu sor', sourceVerified: true,
      actionType: 'dialogue', startTime: 78.722, endTime: 90 },
    { actionId: 'second', label: 'Sonraki soruyu sor', sourceVerified: true,
      actionType: 'dialogue', startTime: 112.778, endTime: 124.775 }
  ] };
  await f.resumeAnalysisGap(78.722);
  f.els.video.time = 92;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 78.722);
  assert.equal(f.state.consumedActionIds.has('first'), false);
  assert.equal(f.futureActions()[0].actionId, 'first');
  await f.playAction(f.futureActions()[0]);
  assert.equal(f.els.video.currentTime, 78.722);
});

test('distinct simultaneous story questions show together without exposing later source events', () => {
  const f = fixture();
  f.state.analysis = { videoDuration: 200, actions: [
    { actionId: 'question-a', label: 'Ayrılık nedenini sor', sourceVerified: true,
      actionType: 'dialogue', startTime: 10, endTime: 16 },
    { actionId: 'question-b', label: 'Ayrılık zamanını sor', sourceVerified: true,
      actionType: 'dialogue', startTime: 10.2, endTime: 16 },
    { actionId: 'later', label: 'Başka bir konuyu konuş', sourceVerified: true,
      actionType: 'dialogue', startTime: 20, endTime: 25 }
  ] };
  f.renderChoices();
  assert.deepEqual(Array.from(f.futureActions(), action => action.actionId), ['question-a', 'question-b']);
  assert.equal(f.els.choices.children.length, 2);
});

test('one location offers up to four verified actions and retires them when the next scene begins', async () => {
  const f = fixture(); useRealCompletion(f);
  const actions = [
    { actionId: 'room-a-1', sceneId: 'scene-a1', locationId: 'room-a', label: 'Kapıyı aç', startTime: 10, endTime: 15 },
    { actionId: 'room-a-2', sceneId: 'scene-a1', locationId: 'room-a', label: 'Masaya yürü', startTime: 15, endTime: 20 },
    { actionId: 'room-a-3', sceneId: 'scene-a2', locationId: 'room-a', label: 'Bardağı al', startTime: 20, endTime: 25 },
    { actionId: 'room-a-4', sceneId: 'scene-a2', locationId: 'room-a', label: 'Pencereye bak', startTime: 25, endTime: 30 },
    { actionId: 'room-b-1', sceneId: 'scene-b1', locationId: 'room-b', label: 'Koridora gir', startTime: 30, endTime: 36 },
    { actionId: 'room-b-2', sceneId: 'scene-b1', locationId: 'room-b', label: 'Işığı aç', startTime: 36, endTime: 41 }
  ].map(action => ({ ...action, sourceVerified: true, actionType: 'other' }));
  f.state.analysis.actions = actions;
  f.state.gameCursorTime = 10;
  assert.deepEqual(Array.from(f.futureActions(), action => action.actionId),
    ['room-a-1', 'room-a-2', 'room-a-3', 'room-a-4']);
  await f.playAction(actions[2]);
  assert.equal(f.state.activeAction?.actionId, 'room-a-3');
  assert.equal(f.els.video.currentTime, 20);
  f.els.video.time = 25;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 25);
  assert.deepEqual(Array.from(f.futureActions(), action => action.actionId), ['room-a-4']);
  await f.playAction(actions[3]);
  f.els.video.time = 30;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(Array.from(f.futureActions(), action => action.actionId), ['room-b-1', 'room-b-2']);
});

test('late source frame does not consume a following normal decision', async () => {
  const f = fixture(); useRealCompletion(f);
  const first = { actionId: 'first', label: 'İlk konuşma', actionType: 'dialogue',
    startTime: 10, endTime: 15, sourceVerified: true };
  const second = { actionId: 'second', label: 'İkinci konuşma', actionType: 'dialogue',
    startTime: 15, endTime: 23, sourceVerified: true };
  f.state.analysis.actions = [first, second];
  await f.playAction(first);
  f.els.video.time = 25;
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.state.gameCursorTime, 15);
  assert.equal(f.state.consumedActionIds.has('first'), true);
  assert.equal(f.state.consumedActionIds.has('second'), false);
  assert.equal(f.futureActions()[0].actionId, 'second');
  await f.playAction(second);
  assert.equal(f.els.video.currentTime, 15);
});
