import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sceneExitTime, seekMediaTo } from '../public/playback-logic.js';
import * as gameplay from '../public/adult-gameplay.js';
import { advanceAdultPhase, canPlayAction } from '../public/engine-hardening.js';

// Exercise the real playback handlers with neutral chapter data and simulated
// media events. No model calls or content/progression rules are involved.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['cancelAdultSeek', 'beginAdultSelection', 'seekAdultLoop',
  'clearPanelPlaybackRecovery', 'showPanelPlaybackRecovery', 'resumePanelPlayback',
  'commitAdultSelectionProgress',
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
  textContent = '';
  dataset = {};
  classes = new Set();
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
  };
  style = {};
  set innerHTML(value) { this.html = value; this.children = []; }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  appendChild(child) { this.append(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  removeAttribute() {}
  querySelector(selector) { return selector === 'button' ? this.children.at(-1) : new Element(); }
  querySelectorAll(selector) {
    const matches = node => selector === 'button' || node.className?.split(' ').includes(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
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

// Integration coverage: real panel handlers, guards, progress and DOM click
// handlers together. Fixtures are neutral timed chapters; no external media.
const runtimeNames = [
  'guardPlayable', 'setAdultMachinePhase', 'isWarmupPosition', 'isBonusPosition',
  'adultTimeLabel', 'currentAdultFlow', 'orderedLockedAdultPositions',
  'unlockNextAdultPositionFromLust', 'addFemaleLust', 'unlockedAdultPositions',
  'unlockedAdultOutcomes', 'renderAdultFlowStatus', 'renderAdultProgress',
  'renderAdultApproachChoices', 'renderAdultProgressiveUI', 'selectAdultCategory',
  'selectAdultPosition', 'selectAdultMovement', 'refreshAdultCompactDock',
  'playAdultPrelude', 'applyAdultPreludeProgress', 'applyAdultSelectionProgress',
  'resetAdultTapRhythm', 'updateVariantButton', 'updateRhythmControl',
  'nextEnergeticPositionMovement', 'selectMovementTempoVariant',
  'triggerAdultOrgasmDecision', 'openAdultOrgasmDecision', 'continueAfterAdultOrgasm',
  'playAdultOutcome', 'resetAdultSceneGameplay', 'renderAdultPanel',
  'syncAdultPanelPlacement', 'setAdultPanelExpanded'
];
const runtimeHandlers = runtimeNames.map(name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}).join('\n');

function chapter(id, start, family = id, role = 'core') {
  return {
    id, familyId: family, progressionRole: role, label: `Chapter ${id}`,
    partnerTrackId: 'track-a', startTime: start, endTime: start + 30,
    sourceRanges: [{ id: `source-${id}`, startTime: start, endTime: start + 30 }],
    movements: [0, 1, 2].map(index => ({
      id: `${id}-${index}`, sourcePositionId: `source-${id}`, sourceVerified: true,
      label: `Action ${index}`, startTime: start + index * 10, endTime: start + (index + 1) * 10,
      loopStartTime: start + index * 10, loopEndTime: start + (index + 1) * 10
    }))
  };
}

function runtimeFixture() {
  const f = fixture();
  Object.assign(f, gameplay, {
    canPlayAction, advanceAdultPhase, queueMicrotask,
    primeAdultPositionLanguage() {}, escapeHtml: String,
    normalizeAdultLabel: value => String(value || '').toLowerCase()
  });
  Object.assign(f.state, {
    adultPhaseMachine: 'foreplay', adultLastUiPhase: 'foreplay',
    adultUiSignature: '', adultSexUnlocked: false, activePositionId: null,
    activeMovementId: null, activeAdultPreludeId: null, activeAdultOccurrenceId: null,
    femaleSceneProgress: 0, adultMaleOrgasmProgress: 0, adultFemaleOrgasmProgress: 0,
    adultMaleOrgasmCount: 0, adultFemaleOrgasmCount: 0,
    adultMovementPlayCounts: new Map(), adultPreludePlayCounts: new Map(),
    adultPlayedOutcomeIds: new Set(), adultUnlockedOutcomeIds: new Set(),
    adultComboCount: 0, adultClimaxProgress: 0, adultCorePlaySeconds: 0,
    adultOrgasmDecision: null, adultPendingSelectionProgress: null,
    adultScene: {
      id: 'chapter-set', startTime: 0, endTime: 210,
      positions: [chapter('one', 20), chapter('two', 60), chapter('three', 120, 'one')],
      foreplay: [{ id: 'intro', label: 'Introduction', startTime: 0, endTime: 15, sourceVerified: true }],
      outcomes: [{ id: 'ending', label: 'Ending', startTime: 200, endTime: 210,
        sourceVerified: true, partnerTrackId: 'track-a' }]
    }
  });
  f.els.video.duration = 210;
  f.state.analysis.videoDuration = 210;
  vm.runInContext(runtimeHandlers, f);
  return f;
}

async function startFirstChapter(f) {
  f.addFemaleLust(35);
  await flush();
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.els.video.paused, false);
}

test('first full threshold opens the panel and plays the first local clip automatically', async () => {
  const f = runtimeFixture();
  f.renderAdultProgressiveUI(true);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.state.activeMovementId, null);
  f.addFemaleLust(34);
  await flush();
  assert.equal(f.state.adultSexUnlocked, false);
  f.addFemaleLust(1);
  await flush();
  assert.equal(f.state.adultSexUnlocked, true);
  assert.equal(f.state.activeMovementId, 'one-0');
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.els.video.paused, false);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one']);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.ok(f.state.femaleSceneProgress < 35);
  const token = f.state.adultSelectionToken;
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.adultSelectionToken, token);
  assert.equal(f.state.activeMovementId, 'one-0');
  assert.equal(f.els.video.playCalls, 1);
});

test('an introduction without warmup-position metadata still keeps the gate closed', () => {
  const f = runtimeFixture();
  f.renderAdultPanel(f.state.adultScene);
  assert.equal(f.state.adultSexUnlocked, false);
  assert.equal(f.state.adultUnlockedPositionIds.size, 0);
});

test('later thresholds unlock exactly one next chapter without switching playback', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.state.femaleSceneProgress = 0;
  assert.equal(f.unlockNextAdultPositionFromLust(), null);
  f.addFemaleLust(35);
  await flush();
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one', 'two']);
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.state.femaleSceneProgress, 0);
  f.addFemaleLust(35);
  assert.equal(f.state.adultUnlockedPositionIds.has('three'), false);
  assert.equal(f.state.femaleSceneProgress, 35);
  f.state.femaleSceneProgress = 0;
  f.selectAdultPosition('two', true);
  await flush();
  f.addFemaleLust(35);
  assert.equal(f.state.adultUnlockedPositionIds.has('three'), true);
});

test('direct calls cannot play a locked chapter or movement', async () => {
  const f = runtimeFixture();
  f.selectAdultPosition('two', true);
  assert.equal(f.els.video.playCalls, 0);
  f.state.activePositionId = 'two';
  f.state.activeAdultOccurrenceId = 'source-two';
  f.selectAdultMovement('two-0', true);
  await flush();
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.state.adultVisitedPositionIds.size, 0);
});

for (const mode of ['error', 'blocked']) {
  test(`a ${mode} selection earns nothing until recovery actually starts playback`, async () => {
    const f = runtimeFixture();
    f.els.video.mode = mode;
    f.playAdultPrelude('intro');
    await flush();
    assert.equal(f.state.femaleSceneProgress, 0);
    assert.equal(f.state.adultPreludePlayCounts.size, 0);
    f.els.video.mode = 'ready';
    f.els.panelPlaybackRecovery.querySelector('button').dispatchEvent(new Event('click'));
    await flush();
    assert.equal(f.state.adultPreludePlayCounts.get('intro'), 1);
    assert.ok(f.state.femaleSceneProgress > 0);
    const progress = f.state.femaleSceneProgress;
    f.commitAdultSelectionProgress(f.state.adultSelectionToken);
    assert.equal(f.state.femaleSceneProgress, progress);
    assert.equal(f.state.adultPreludePlayCounts.get('intro'), 1);
  });
}

test('failed chapter playback cannot count as a visit or open the following chapter', async () => {
  const f = runtimeFixture();
  f.els.video.mode = 'error';
  f.addFemaleLust(35);
  await flush();
  assert.equal(f.state.adultVisitedPositionIds.size, 0);
  assert.equal(f.state.femaleSceneProgress, 0);
  f.addFemaleLust(35);
  assert.equal(f.state.adultUnlockedPositionIds.has('two'), false);
});

test('obsolete introduction selections cannot earn progress after a newer selection', async () => {
  const f = runtimeFixture();
  f.els.video.mode = 'stalled';
  f.playAdultPrelude('intro');
  const oldToken = f.state.adultSelectionToken;
  f.beginAdultSelection();
  f.commitAdultSelectionProgress(oldToken);
  await flush();
  assert.equal(f.state.femaleSceneProgress, 0);
  assert.equal(f.state.adultPreludePlayCounts.size, 0);
});

test('one position tab exposes later verified returns and switches occurrence only when selected', async () => {
  const f = runtimeFixture();
  const first = f.state.adultScene.positions[0];
  const later = chapter('return', 120, 'one');
  first.sourceRanges.push(...later.sourceRanges);
  first.movements.push(...later.movements);
  first.endTime = 150;
  await startFirstChapter(f);
  assert.deepEqual(
    new Set(first.activeMovementChoices.flatMap(item => item.variants).map(item => item.id)),
    new Set(['one-1', 'one-2', 'return-0', 'return-1', 'return-2'])
  );
  f.selectAdultMovement('return-0', true);
  await flush();
  assert.equal(f.state.activeAdultOccurrenceId, 'source-return');
  assert.equal(f.els.video.currentTime, 120);
  assert.equal(f.state.activePositionId, 'one');
});

test('a rejected later selection does not mutate the current occurrence or playback token', async () => {
  const f = runtimeFixture();
  const first = f.state.adultScene.positions[0];
  const later = chapter('return', 120, 'one');
  first.sourceRanges.push(...later.sourceRanges);
  first.movements.push(...later.movements);
  first.endTime = 150;
  await startFirstChapter(f);
  const token = f.state.adultSelectionToken;
  const currentOccurrence = f.state.activeAdultOccurrenceId;
  const playCalls = f.els.video.playCalls;
  f.state.adultUnlockedPositionIds.delete(first.id);
  f.selectAdultMovement('return-0', true);
  await flush();
  assert.equal(f.state.activeAdultOccurrenceId, currentOccurrence);
  assert.equal(f.state.adultSelectionToken, token);
  assert.equal(f.state.activeMovementId, 'one-0');
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.els.video.playCalls, playCalls);
});

test('render-only selection leaves the active occurrence unchanged', async () => {
  const f = runtimeFixture();
  const first = f.state.adultScene.positions[0];
  const later = chapter('return', 120, 'one');
  first.sourceRanges.push(...later.sourceRanges);
  first.movements.push(...later.movements);
  first.endTime = 150;
  await startFirstChapter(f);
  const occurrence = f.state.activeAdultOccurrenceId;
  f.selectAdultMovement('return-0', false);
  assert.equal(f.state.activeAdultOccurrenceId, occurrence);
  assert.equal(f.state.activeMovementId, 'one-0');
  assert.equal(f.els.video.currentTime, 20);
});

test('invalid child clips are neither shown nor allowed to bridge disjoint source ranges', async () => {
  const f = runtimeFixture();
  const first = f.state.adultScene.positions[0];
  first.sourceRanges = [
    { id: 'source-one', startTime: 20, endTime: 30 },
    { id: 'source-one', startTime: 40, endTime: 50 }
  ];
  await startFirstChapter(f);
  assert.deepEqual(first.activeMovementChoices.flatMap(c => c.variants).map(m => m.id), ['one-2']);
  const currentOccurrence = f.state.activeAdultOccurrenceId;
  f.selectAdultMovement('one-1', true);
  await flush();
  assert.equal(f.state.activeAdultOccurrenceId, currentOccurrence);
  assert.equal(f.state.activeMovementId, 'one-0');
  assert.equal(f.els.video.currentTime, 20);
});

test('finishing a short clip pauses and clears it without arming another clip during render', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.els.video.time = 30;
  f.updateAdultPlayback(1000, 30);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.activeMovementId, null);
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.video.playCalls, 1);
});

test('full ending meter plays a verified ending then continues at the exact saved time', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.selectAdultMovement('one-1', true);
  await flush();
  f.els.video.time = 34.375;
  const progress = f.state.femaleSceneProgress;
  const playCount = f.state.adultMovementPlayCounts.get('one-1');
  f.state.adultMaleOrgasmProgress = 100;
  assert.equal(f.triggerAdultOrgasmDecision(), true);
  assert.equal(f.state.adultOrgasmDecision.mediaTime, 34.375);
  await flush();
  assert.equal(f.els.video.currentTime, 200);
  assert.equal(f.state.adultOutcomePhase, 'outcome');
  assert.equal(f.state.adultPlayedOutcomeIds.has('ending'), true);
  // End-of-file must retain the decision and saved branch, not close the scene.
  f.els.video.time = 210;
  f.handleSourceEnded();
  assert.equal(f.state.adultMode, true);
  assert.equal(f.state.adultOutcomePhase, 'orgasm-decision');
  f.continueAfterAdultOrgasm();
  await flush();
  assert.equal(f.els.video.currentTime, 34.375);
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.state.activeMovementId, 'one-1');
  assert.equal(f.state.adultPhaseMachine, 'positions');
  assert.equal(f.state.adultOutcomePhase, 'idle');
  assert.equal(f.state.activeAdultOutcomeId, null);
  assert.equal(f.state.adultMaleOrgasmProgress, 0);
  assert.equal(f.state.adultMaleOrgasmCount, 1);
  assert.equal(f.state.femaleSceneProgress, progress);
  assert.equal(f.state.adultMovementPlayCounts.get('one-1'), playCount);
  assert.equal(f.els.video.paused, false);
});

test('ending completion at a scene boundary opens the decision instead of auto-exiting', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.els.video.time = 24;
  f.state.adultMaleOrgasmProgress = 100;
  f.triggerAdultOrgasmDecision();
  await flush();
  f.els.video.time = 210.2;
  f.updateAdultPlayback(1000, 210.2);
  assert.equal(f.state.adultOutcomePhase, 'orgasm-decision');
  assert.equal(f.state.adultMode, true);
  f.finishAdultScene({ force: true });
  assert.equal(f.state.adultMode, false);
  assert.equal(f.state.adultOrgasmDecision, null);
});

test('missing, unverified or other-partner endings never fabricate or play an ending', async () => {
  for (const endings of [[], [{ sourceVerified: false }], [{ sourceVerified: true, partnerTrackId: 'track-b' }]]) {
    const f = runtimeFixture();
    await startFirstChapter(f);
    f.els.video.time = 24;
    f.state.adultScene.outcomes = endings.map(item => ({ id: 'invalid', startTime: 200, endTime: 210, ...item }));
    f.state.adultMaleOrgasmProgress = 100;
    f.triggerAdultOrgasmDecision();
    await flush();
    assert.equal(f.state.adultOutcomePhase, 'orgasm-decision');
    assert.equal(f.state.adultOrgasmDecision.hasVerifiedOutcome, false);
    assert.match(f.els.orgasmDecisionTitle.textContent, /bulunamadı/);
    assert.equal(f.els.video.currentTime, 24);
    assert.equal(f.state.adultPlayedOutcomeIds.size, 0);
    f.continueAfterAdultOrgasm();
    await flush();
    assert.equal(f.els.video.currentTime, 24);
    assert.equal(f.els.video.paused, false);
  }
});

test('leaving the scene cancels a queued automatic first entry', async () => {
  const f = runtimeFixture();
  f.addFemaleLust(35);
  f.skipCurrentScene();
  await flush();
  assert.equal(f.state.adultMode, false);
  assert.equal(f.els.video.playCalls, 0);
});
