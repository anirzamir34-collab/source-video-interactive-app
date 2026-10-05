import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sceneExitTime, seekMediaTo } from '../public/playback-logic.js';
import * as gameplay from '../public/adult-gameplay.js';
import { advanceAdultPhase, canPlayAction } from '../public/engine-hardening.js';
import { forwardVerifiedClips } from '../public/panel-feedback.js';
import { sourcePositionAtTime } from '../public/scene-entry.js';
import * as interaction from '../public/interaction-engine.js';
import * as timeline from '../public/interaction-timeline.js';
import * as panel from '../public/interaction-panel.js';
import * as compat from '../public/interaction-compat.js';

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
    contains: name => this.classes.has(name),
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
  };
  style = {};
  set innerHTML(value) { this.html = value; this.children = []; }
  get parentElement() { return this.parent || null; }
  append(...children) { children.forEach(child => { child.remove(); child.parent = this; this.children.push(child); }); }
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
    orderedLockedAdultPositions: () => (state.adultScene?.positions || [])
      .filter(position => !state.adultUnlockedPositionIds.has(position.id)),
    isWarmupPosition: () => false,
    selectAdultPosition: id => { state.selectedPositionId = id; },
    navigateTimelineTo: async target => { state.navigationTargets.push(target); },
    currentAdultFlow: () => 0, renderAdultProgressiveUI() {}, findAdultSceneAt: () => null,
    clearInteractionSelection() {}, reconcileInteractionSource() {},
    settleInteractionClipBoundary: () => false, observeInteractionProgress() {}
  });
  vm.runInContext(handlers, scope);
  video.addEventListener('play', () => { if (state.gameState !== 'SEGMENT_PLAYING') video.pause(); });
  return Object.assign(scope, { stage });
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('selecting the current frame resumes without another seek request', async () => {
  const f = fixture();
  f.els.video.mode = 'stalled';
  assert.equal(await f.seekAdultLoop(10), true);
  assert.equal(f.els.video.seeking, false);
  assert.equal(f.els.video.paused, false);
  assert.equal(f.els.video.playCalls, 1);
});

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
  test(`scene skip advances an unplayed chapter during ${phase}`, () => {
    const f = fixture();
    f.state.adultOutcomePhase = phase;
    f.state.adultScene.positions = [{ id: 'clip-2', startTime: 30, endTime: 40 }];
    f.state.adultUnlockedPositionIds.add('clip-2');
    f.skipCurrentScene();
    assert.equal(f.state.adultMode, true);
    assert.equal(f.state.selectedPositionId, 'clip-2');
    assert.equal(f.state.completedAdultSceneIds.has('chapter-1'), false);
    assert.deepEqual(f.state.navigationTargets, []);
  });
}

test('scene skip reveals the next locked chapter before leaving', () => {
  const f = fixture();
  f.state.adultScene.positions = [{ id: 'next', startTime: 50, endTime: 60 }];
  f.skipCurrentScene();
  assert.equal(f.state.adultUnlockedPositionIds.has('next'), true);
  assert.equal(f.state.selectedPositionId, 'next');
  assert.equal(f.state.adultMode, true);
});

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
  'genericInteractionScene', 'genericInteractionSnapshot', 'genericInteractionTrace',
  'clearInteractionSelection', 'reconcileInteractionSource', 'reconcileInteractionSeek',
  'settleInteractionClipBoundary',
  'observeInteractionProgress',
  'guardPlayable', 'setAdultMachinePhase', 'isWarmupPosition', 'isBonusPosition',
  'adultTimeLabel', 'currentAdultFlow', 'currentWarmupLustScale', 'tempoLabel', 'orderedLockedAdultPositions',
  'unlockNextAdultPositionFromLust', 'addFemaleLust', 'unlockedAdultPositions',
  'unlockedAdultOutcomes', 'renderAdultFlowStatus', 'renderAdultProgress',
  'renderAdultApproachChoices', 'renderAdultProgressiveUI', 'selectAdultCategory',
  'renderInteractionInterludeChoices',
  'selectAdultPosition', 'selectAdultMovement', 'refreshAdultCompactDock',
  'playAdultPrelude', 'applyAdultPreludeProgress', 'applyAdultSelectionProgress',
  'resetAdultTapRhythm', 'updateVariantButton', 'updateRhythmControl',
  'nextEnergeticPositionMovement', 'remainingPositionControlClips', 'selectMovementTempoVariant',
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
    id, sourceVerified: true, familyId: family, progressionRole: role, label: `Chapter ${id}`,
    partnerTrackId: 'track-a', startTime: start, endTime: start + 30,
    sourceRanges: [{ id: `source-${id}`, startTime: start, endTime: start + 30 }],
    controlClipIds: [`${id}-1`, `${id}-2`],
    movements: [0, 1, 2].map(index => ({
      id: `${id}-${index}`, sourcePositionId: `source-${id}`, sourceVerified: true,
      label: `Action ${index}`, startTime: start + index * 10, endTime: start + (index + 1) * 10,
      loopStartTime: start + index * 10, loopEndTime: start + (index + 1) * 10
    }))
  };
}

function runtimeFixture() {
  const f = fixture();
  Object.assign(f, gameplay, interaction, timeline, panel, compat, {
    canPlayAction, advanceAdultPhase, queueMicrotask, forwardVerifiedClips, sourcePositionAtTime,
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

test('a grouped introduction card selects another existing clip on each click and keeps its own time bounds', async () => {
  const f = runtimeFixture();
  const intro = chapter('opening', 0, 'opening', 'foreplay');
  intro.movements.forEach(item => { item.actionType = 'movement'; item.label = 'Patikada yürü'; });
  f.state.adultScene.foreplay = [];
  f.state.adultScene.positions = [intro, chapter('main', 60)];
  f.els.video.time = 0;
  f.renderAdultApproachChoices(f.state.adultScene);
  const card = f.els.foreplayChoices.children[0];
  assert.equal(card.dataset.variantIds, 'opening-0,opening-1,opening-2');
  assert.equal(f.state.adultApproachChoices[0].startTime, 0);
  assert.equal(f.state.adultApproachChoices[0].endTime, 30);
  card.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.activeMovementId, 'opening-0');
  card.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.activeMovementId, 'opening-1');
});

test('an empty introduction menu leaves a visible source playback control', () => {
  const f = runtimeFixture();
  f.state.adultScene.foreplay = [];
  f.state.adultScene.positions = [chapter('main', 60)];
  f.state.adultTimelineFloor = 0;
  f.els.video.time = 0;
  f.els.video.paused = true;
  f.renderAdultApproachChoices(f.state.adultScene);
  assert.equal(f.els.foreplayChoices.children.at(-1).textContent, 'Videoya devam et');
  assert.equal(f.els.video.paused, true);
});

test('forward control moves past a finished clip when its active id was cleared', () => {
  const f = runtimeFixture();
  const position = chapter('navigation', 30);
  f.isEnergeticSexMoment = () => true;
  f.state.activeAdultOccurrenceId = 'source-navigation';
  f.state.adultTimelineFloor = 40;
  f.els.video.time = 40;
  assert.equal(f.nextEnergeticPositionMovement(position, null)?.id, 'navigation-1');
  assert.deepEqual(Array.from(f.remainingPositionControlClips(position), clip => clip.id),
    ['navigation-1', 'navigation-2']);
  f.els.video.time = 60;
  assert.equal(f.nextEnergeticPositionMovement(position, null), null);
});

test('forward control never includes a disjoint return from another occurrence', () => {
  const f = runtimeFixture();
  const position = chapter('navigation', 30);
  const later = chapter('return', 90);
  position.sourceRanges.push(...later.sourceRanges);
  position.movements.push(...later.movements);
  f.isEnergeticSexMoment = () => true;
  f.state.activeAdultOccurrenceId = 'source-navigation';
  f.els.video.time = 45;
  assert.deepEqual(Array.from(f.remainingPositionControlClips(position), clip => clip.id), ['navigation-2']);
  f.els.video.time = 60;
  assert.equal(f.nextEnergeticPositionMovement(position, null), null);
});

test('the scene control occupies space only while an existing clip is available', () => {
  const f = runtimeFixture();
  const position = chapter('navigation', 30);
  f.isEnergeticSexMoment = () => true;
  f.state.activeAdultOccurrenceId = 'source-navigation';
  f.state.activePositionId = position.id;
  f.state.activeMovementId = 'navigation-1';
  f.els.video.time = 40;
  f.updateRhythmControl(position);
  assert.equal(f.els.rhythmControl.classes.has('hidden'), false);
  assert.equal(f.els.rhythmTapBtn.disabled, false);
  assert.equal(f.els.rhythmTapStatus.textContent, 'Hazır');
  f.state.activeMovementId = null;
  f.updateRhythmControl(position);
  assert.equal(f.els.rhythmControl.classes.has('hidden'), true);
  f.state.activeMovementId = 'navigation-1';
  f.els.video.time = 60;
  f.updateRhythmControl(position);
  assert.equal(f.els.rhythmControl.classes.has('hidden'), true);
  assert.equal(f.els.rhythmTapBtn.disabled, true);
  f.updateRhythmControl(null);
  assert.equal(f.els.rhythmControl.classes.has('hidden'), true);
  assert.equal(f.els.video.currentTime, 60);
  assert.equal(f.els.video.playCalls, 0);
});

async function startFirstChapter(f) {
  f.els.video.time = 20;
  f.addFemaleLust(35);
  f.renderAdultProgressiveUI(true);
  assert.equal(f.els.video.playCalls, 0, 'unlocking never starts playback');
  f.selectAdultPosition('one', true);
  await flush();
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.els.video.paused, false);
}

test('first unlock reveals a clickable chapter; only explicit selection plays its verified entry', async () => {
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
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.video.playCalls, 0);
  f.renderAdultProgressiveUI(true);
  const tab = f.els.positionTabs.querySelectorAll('.position-tab').find(button => button.dataset.positionId === 'one');
  assert.ok(tab);
  assert.equal(tab.disabled, false);
  tab.dispatchEvent(new Event('click'));
  await flush();
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

test('natural playback reaching a verified chapter opens its panel despite a short introduction without seeking', () => {
  const f = runtimeFixture();
  f.state.femaleSceneProgress = 5;
  f.els.video.time = 25;
  f.els.video.paused = false;
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.adultSexUnlocked, true);
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.state.activeAdultOccurrenceId, 'source-one');
  assert.equal(f.els.video.currentTime, 25);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one']);
});

test('entry during a disjoint return binds that occurrence and a parent gap never opens the panel', () => {
  for (const time of [75, 125]) {
    const f = runtimeFixture();
    const position = chapter('one', 20);
    const later = chapter('return', 120);
    position.sourceRanges.push(...later.sourceRanges);
    position.movements.push(...later.movements);
    f.state.adultScene.positions = [position];
    f.els.video.time = time;
    f.renderAdultProgressiveUI(true);
    assert.equal(f.state.adultSexUnlocked, time === 125);
    assert.equal(f.els.video.currentTime, time);
    assert.equal(f.els.video.playCalls, 0);
    if (time === 125) assert.equal(f.state.activeAdultOccurrenceId, 'source-return');
  }
});

test('each completed gate reveals exactly one next verified chapter without moving the source clock', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.state.femaleSceneProgress = 0;
  assert.equal(f.unlockNextAdultPositionFromLust(), null);
  const plays = f.els.video.playCalls;
  f.addFemaleLust(35);
  f.renderAdultProgressiveUI(true);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one', 'two']);
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.els.video.playCalls, plays);
  assert.equal(f.state.femaleSceneProgress, 0);
  const tab = f.els.positionTabs.querySelectorAll('.position-tab').find(button => button.dataset.positionId === 'two');
  assert.ok(tab);
  assert.equal(tab.disabled, false, 'an unlocked destination is clickable outside passive lookahead');
  f.addFemaleLust(35);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one', 'two', 'three']);
  assert.equal(f.state.activePositionId, 'one');
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.els.video.playCalls, plays);
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

test('failed chapter playback earns no visit or progress; revealing destinations never starts media', async () => {
  const f = runtimeFixture();
  f.els.video.mode = 'error';
  f.els.video.time = 19.8;
  f.addFemaleLust(35);
  f.selectAdultPosition('one', true);
  await flush();
  assert.equal(f.state.adultVisitedPositionIds.size, 0);
  assert.equal(f.state.femaleSceneProgress, 0);
  f.addFemaleLust(35);
  assert.equal(f.state.adultUnlockedPositionIds.has('two'), true);
  assert.equal(f.state.adultVisitedPositionIds.size, 0);
  assert.equal(f.els.video.paused, true);
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

test('one canonical position tab keeps each distant return occurrence local and never jumps backward', async () => {
  const f = runtimeFixture();
  const first = f.state.adultScene.positions[0];
  const later = chapter('return', 120, 'one');
  first.sourceRanges.push(...later.sourceRanges);
  first.movements.push(...later.movements);
  first.endTime = 150;
  await startFirstChapter(f);

  assert.equal(first.activeMovementChoices.some(choice =>
    choice.variants.some(item => item.id === 'return-0')), false,
  'the first occurrence does not expose movement cards from a distant return');
  assert.ok(first.activeMovementChoices.every(choice =>
    choice.variants.every(item => item.sourcePositionId === 'source-one')));

  f.state.activeMovementId = null;
  f.state.adultTimelineFloor = 119.8;
  f.els.video.time = 119.8;
  f.selectAdultPosition('one', false);
  assert.deepEqual(
    new Set(first.activeMovementChoices.flatMap(item => item.variants).map(item => item.id)),
    new Set(['return-0', 'return-1', 'return-2'])
  );

  const tabPlayCalls = f.els.video.playCalls;
  f.selectAdultPosition('one', true);
  await flush();
  assert.equal(f.els.video.playCalls, tabPlayCalls + 1);
  assert.equal(f.els.video.currentTime, 120,
    'an explicit tab near a later return enters that forward verified occurrence instead of rewinding');
  assert.equal(f.state.activeAdultOccurrenceId, 'source-return');
  assert.equal(f.state.activePositionId, 'one');
});

test('explicitly replaying a chapter seeks only to its verified entry', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.state.activeMovementId = null;
  f.state.adultTimelineFloor = 120;
  f.els.video.time = 120;
  const plays = f.els.video.playCalls;
  f.selectAdultPosition('one', true);
  f.selectAdultMovement('one-0', true);
  await flush();
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.els.video.playCalls, plays + 1);
  assert.equal(f.state.activeAdultOccurrenceId, 'source-one');
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
  assert.deepEqual(first.activeMovementChoices.flatMap(c => c.variants).map(m => m.id), ['one-0'],
    'the valid entry remains replayable; the gap and exclusive controls remain absent');
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
  f.finishAdultScene({ force: true });
  await flush();
  assert.equal(f.state.adultMode, false);
  assert.equal(f.els.video.playCalls, 0);
});

test('repeated panel rendering after rewind mounts one panel and replaces introductory choices', () => {
  const f = runtimeFixture();
  const scene = f.state.adultScene;
  f.els.video.time = 0;
  f.renderAdultPanel(scene);
  const initialChoices = f.els.foreplayChoices.children.length;
  assert.ok(initialChoices > 0);
  f.els.video.time = 12;
  f.renderAdultPanel(scene);
  f.els.video.time = 0;
  f.renderAdultPanel(scene);
  assert.equal(f.stage.children.filter(node => node === f.els.adultInteractionPanel).length, 1);
  assert.equal(f.els.foreplayChoices.children.length, initialChoices);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
});

test('a verified explicit chapter selection retains the panel and never finishes the encounter', async () => {
  const f = runtimeFixture();
  f.state.adultUnlockedPositionIds.add('one');
  f.state.adultSexUnlocked = true;
  f.renderAdultPanel(f.state.adultScene);
  f.selectAdultPosition('one', true);
  await flush();
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
  assert.equal(f.state.adultMode, true);
  f.els.video.time = 30;
  f.updateAdultPlayback(1000, 30);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
  assert.equal(f.state.adultMode, true);
});

test('explicit future chapter click plays its verified entry beyond passive lookahead', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  assert.equal(f.state.adultMovementPlayCounts.has('one-1'), false);
  assert.equal(f.state.adultMovementPlayCounts.has('one-2'), false);
  f.addFemaleLust(35);
  f.renderAdultProgressiveUI(true);
  const tab = f.els.positionTabs.querySelectorAll('.position-tab').find(button => button.dataset.positionId === 'two');
  assert.equal(tab.disabled, false);
  tab.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(f.els.video.currentTime, 60);
  assert.equal(f.state.activeMovementId, 'two-0');
  assert.equal(f.state.activeAdultOccurrenceId, 'source-two');
  assert.equal(f.state.adultMovementPlayCounts.has('two-1'), false);
  f.els.video.time = 70;
  f.updateAdultPlayback(1000, 70);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
});

test('paused manual rewind reconciles source approach phase and clears stale selection without seeking', async () => {
  const f = runtimeFixture();
  f.renderAdultPanel(f.state.adultScene);
  await startFirstChapter(f);
  f.els.video.time = 25;
  f.updateAdultPlayback(1000, 25);
  f.state.activeMovementChoiceId = 'old-card';
  const plays = f.els.video.playCalls;
  f.els.video.time = 5;
  f.els.video.paused = true;
  f.reconcileInteractionSource(5, { manual: true });
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.state.activeMovementChoiceId, null);
  assert.equal(f.state.activePositionId, null);
  assert.equal(f.state.adultPendingSelectionProgress, null);
  assert.equal(f.state.adultTimelineFloor, 5);
  assert.equal(f.genericInteractionTrace().currentPhase, 'APPROACH');
  assert.equal(f.genericInteractionTrace().overlayCount, 1);
  assert.equal(f.els.choices.classes.has('hidden'), true);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.video.currentTime, 5);
  assert.equal(f.els.video.playCalls, plays);
  f.renderAdultPanel(f.state.adultScene);
  f.renderAdultPanel(f.state.adultScene);
  assert.equal(f.stage.children.filter(node => node === f.els.adultInteractionPanel).length, 1);
});

test('paused source boundary reveals the actual verified chapter before playback resumes', () => {
  const f = runtimeFixture();
  f.els.video.time = 65;
  f.els.video.paused = true;
  f.updateAdultPlayback(1000, 65);
  assert.equal(f.state.adultUnlockedPositionIds.has('two'), true);
  assert.equal(f.state.activePositionId, 'two');
  assert.equal(f.state.activeAdultOccurrenceId, 'source-two');
  assert.equal(f.genericInteractionTrace().currentPhase, 'CORE');
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.els.video.currentTime, 65);
});

test('same-scene rendering preserves a collapsed panel and a new scene opens its controls', () => {
  const f = runtimeFixture();
  const scene = f.state.adultScene;
  f.renderAdultPanel(scene);
  f.setAdultPanelExpanded(false);
  f.renderAdultPanel(scene);
  assert.equal(f.els.adultInteractionPanel.classes.has('compact-collapsed'), true);
  assert.equal(f.els.adultInteractionPanel.classes.has('compact-expanded'), false);
  f.renderAdultPanel({ id: 'new-panel-scene', startTime: 0, endTime: 30,
    positions: [chapter('new-panel', 0)], foreplay: [] });
  assert.equal(f.els.adultInteractionPanel.classes.has('compact-expanded'), true);
  assert.equal(f.els.adultInteractionPanel.classes.has('compact-collapsed'), false);
});

test('unchanged UI signature repairs panel visibility after seek or pause', () => {
  const f = runtimeFixture();
  f.state.adultUnlockedPositionIds.add('one');
  f.state.adultSexUnlocked = true;
  f.renderAdultProgressiveUI(true);
  f.renderAdultProgressiveUI(false);
  const signature = f.state.adultUiSignature;
  f.els.adultInteractionPanel.classList.add('hidden');
  f.els.choices.classList.remove('hidden');
  f.renderAdultProgressiveUI(false);
  assert.equal(f.state.adultUiSignature, signature);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.choices.classes.has('hidden'), true);
});

test('scene switch drops previous card, pending selection and held input state', () => {
  const f = runtimeFixture();
  let resets = 0;
  f.state.interactionHoldControl = { reset() { resets += 1; } };
  f.state.activePositionId = 'one';
  f.state.activeAdultOccurrenceId = 'source-one';
  f.state.activeMovementId = 'one-1';
  f.state.activeMovementChoiceId = 'previous-card';
  f.state.adultPendingSelectionProgress = { token: 12 };
  f.state.adultTapTimes = [10, 20];
  f.state.adultRhythmHeld = true;
  f.renderAdultPanel({ id: 'new-set', startTime: 0, endTime: 30, positions: [chapter('new', 0)], foreplay: [] });
  assert.equal(f.state.activePositionId, 'new');
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.state.activeMovementChoiceId, null);
  assert.equal(f.state.adultPendingSelectionProgress, null);
  assert.equal(f.state.activeAdultOccurrenceId, 'source-new');
  assert.deepEqual(Array.from(f.state.adultTapTimes), []);
  assert.equal(f.state.adultRhythmHeld, false);
  assert.ok(resets > 0);
  assert.equal(f.els.video.playCalls, 0);
});

test('verified range fallback entry seeks one source start and does not autoplay internal movements', async () => {
  const f = runtimeFixture();
  const group = chapter('range-only', 60);
  group.movements = [];
  f.state.adultScene.positions = [group];
  f.state.adultUnlockedPositionIds.add(group.id);
  f.state.adultSexUnlocked = true;
  f.renderAdultProgressiveUI(true);
  const tab = f.els.positionTabs.querySelectorAll('.position-tab')[0];
  assert.equal(tab.disabled, false);
  tab.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(f.els.video.currentTime, 60);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
});

test('active introduction prepares upcoming choices without dropping the current choice or exposing distant data', () => {
  const f = runtimeFixture();
  f.state.adultScene.foreplay = [
    { id: 'opening-a', label: 'Step A', sourceVerified: true, startTime: 0, endTime: 40 },
    { id: 'opening-b', label: 'Step B', sourceVerified: true, startTime: 40, endTime: 50 },
    { id: 'distant', label: 'Distant', sourceVerified: true, startTime: 400, endTime: 410 },
    { id: 'unverified', label: 'Unverified', sourceVerified: false, startTime: 15, endTime: 25 }
  ];
  f.state.adultScene.positions = [chapter('main', 500)];
  f.state.activeAdultPreludeId = 'opening-a';
  f.els.video.time = 10;
  f.renderAdultApproachChoices(f.state.adultScene);
  assert.deepEqual(Array.from(f.state.adultApproachChoices, choice => choice.id), ['opening-a', 'opening-b']);
  assert.equal(f.els.video.currentTime, 10);
  assert.equal(f.els.video.playCalls, 0);
});

test('unverified groups and clips cannot be revealed or explicitly selected', async () => {
  const f = runtimeFixture();
  f.state.adultScene.positions[1].sourceVerified = false;
  f.state.adultUnlockedPositionIds.add('two');
  f.state.adultSexUnlocked = true;
  f.renderAdultProgressiveUI(true);
  assert.equal(f.els.positionTabs.querySelectorAll('.position-tab').some(button => button.dataset.positionId === 'two'), false);
  f.selectAdultPosition('two', true);
  await flush();
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.els.video.currentTime, 10);
  assert.equal(f.genericInteractionTrace().blockedSeekReason, 'unverified-group');
});

test('a delayed source tick settles the selected card before discovering a terminal phase', async () => {
  const f = runtimeFixture();
  await startFirstChapter(f);
  f.state.adultScene.outcomes = [{ id: 'next-ending', sourceVerified: true, startTime: 30, endTime: 40 }];
  f.els.video.time = 30.8;
  f.updateAdultPlayback(1000, 30.8);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.state.adultOutcomePhase, 'idle');
  assert.equal(f.state.activeAdultOutcomeId, undefined);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.state.adultMovementPlayCounts.has('one-1'), false);
});

test('a delayed final card tick pauses without completing the scene envelope', async () => {
  const f = runtimeFixture();
  f.state.adultScene.positions = [chapter('last', 20)];
  f.state.adultScene.endTime = 50;
  f.state.adultScene.outcomes = [];
  f.state.adultUnlockedPositionIds.add('last');
  f.state.adultSexUnlocked = true;
  f.state.activePositionId = 'last';
  f.state.activeAdultOccurrenceId = 'source-last';
  f.selectAdultMovement('last-2', true);
  await flush();
  f.els.video.time = 50.8;
  f.updateAdultPlayback(1000, 50.8);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.state.adultMode, true);
  assert.equal(f.state.completedAdultSceneIds.size, 0);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
});

test('a full meter clears the opening override when every verified group is already unlocked without seeking', () => {
  const f = runtimeFixture();
  f.els.video.time = 5;
  f.state.adultSexUnlocked = true;
  f.state.interactionPhaseOverride = 'APPROACH';
  f.state.femaleSceneProgress = 35;
  f.state.adultScene.positions.forEach(group => f.state.adultUnlockedPositionIds.add(group.id));
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.interactionPhaseOverride, null);
  assert.equal(f.els.adultInteractionPanel.dataset.phase, 'positions');
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.choices.classes.has('hidden'), true);
  assert.equal(f.els.video.currentTime, 5);
  assert.equal(f.els.video.playCalls, 0);
  assert.equal(f.state.adultSeekRequestId, 0);
  assert.equal(f.state.adultUnlockedPositionIds.size, 3);
  f.renderAdultProgressiveUI(false);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.video.currentTime, 5);
});

test('an inactive scene trace excludes retained group unlocks and source ranges', () => {
  const f = runtimeFixture();
  f.state.adultUnlockedPositionIds.add('one');
  f.state.adultRevealedPositionIds.add('one');
  f.state.activePositionId = 'one';
  f.state.activeAdultOccurrenceId = 'source-one';
  f.genericInteractionSnapshot();
  f.state.adultMode = false;
  f.state.adultScene = null;
  const trace = f.genericInteractionTrace();
  assert.equal(trace.sceneId, null);
  assert.equal(trace.sceneActive, false);
  assert.equal(trace.currentPhase, null);
  assert.deepEqual(Array.from(trace.unlockedGroupIds), []);
  assert.deepEqual(Array.from(trace.revealedGroupIds), []);
  assert.deepEqual(Array.from(trace.sourceRanges), []);
  assert.equal(trace.activeGroupId, null);
  assert.equal(trace.activeOccurrenceId, null);
});

test('verified normal dialogue has its own choices and earns no progress before the opening choices appear', async () => {
  const f = runtimeFixture();
  f.state.adultScene.foreplay = [
    { id: 'source-dialogue', label: 'Existing line', sourceVerified: true, nonIntimate: true, startTime: 0, endTime: 10 },
    { id: 'source-opening', label: 'Existing opening', sourceVerified: true, startTime: 10, endTime: 20 }
  ];
  f.els.video.time = 0;
  f.renderAdultPanel(f.state.adultScene);
  assert.equal(f.els.choices.dataset.interactionPhase, 'DIALOGUE');
  assert.deepEqual(Array.from(f.state.adultApproachChoices, item => item.id), ['source-dialogue']);
  assert.equal(f.els.choices.children[0].html, '<strong>DİYALOG</strong>');
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), true);
  f.playAdultPrelude('source-dialogue');
  await flush();
  assert.equal(f.state.activeAdultPreludeId, 'source-dialogue');
  assert.equal(f.state.femaleSceneProgress, 0);
  f.state.lastAdultFrameNow = 1000;
  f.els.video.time = 5;
  f.updateAdultPlayback(1250, 5);
  assert.equal(f.state.femaleSceneProgress, 0);
  assert.equal(f.els.choices.dataset.interactionPhase, 'DIALOGUE');
  f.els.video.time = 10;
  f.updateAdultPlayback(1500, 10);
  assert.equal(f.els.choices.dataset.interactionPhase, 'APPROACH');
  assert.deepEqual(Array.from(f.state.adultApproachChoices, item => item.id), ['source-opening']);
  assert.equal(f.els.adultInteractionPanel.classes.has('hidden'), false);
  assert.equal(f.els.choices.classes.has('hidden'), true);
  assert.equal(f.els.foreplayChoices.children.length > 0, true);
  assert.equal(f.state.femaleSceneProgress, 0);
  assert.equal(f.els.video.currentTime, 10);
  assert.equal(f.els.video.playCalls, 1);
});

test('unique opening clips fill the budget and open the core panel without repeat farming', async () => {
  const f = runtimeFixture();
  f.state.adultScene.positions = [chapter('main', 60)];
  f.state.adultScene.foreplay = Array.from({ length: 6 }, (_, index) => ({
    id: `step-${index}`, label: `Source step ${index}`, startTime: index * 10,
    endTime: (index + 1) * 10, sourceVerified: true, castIds: ['track-a', 'track-b']
  }));
  f.els.video.time = 0;
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.adultApproachChoices.length, 5);
  for (let index = 0; index < 6; index += 1) {
    f.playAdultPrelude(`step-${index}`);
    await flush();
    f.els.video.time = (index + 1) * 10;
    f.updateAdultPlayback((index + 1) * 1000, f.els.video.time);
    if (index < 5) {
      assert.ok(f.currentAdultFlow() < 100);
      assert.ok(f.state.adultApproachChoices.some(choice => choice.id === `step-${index + 1}`));
    }
  }
  assert.equal(f.currentAdultFlow(), 100);
  assert.equal(f.state.interactionRuntime.currentPhase, 'CORE');
  assert.equal(f.els.adultInteractionPanel.classList.contains('hidden'), false);
  assert.equal(f.els.choices.classList.contains('hidden'), true);
  assert.equal(f.state.adultPreludePlayCounts.size, 6);
  assert.ok([...f.state.adultPreludePlayCounts.values()].every(count => count === 1));
  assert.equal(f.els.video.time, 60);
});

test('natural opening playback advances the budget without button clicks and never double-unlocks', () => {
  const f = runtimeFixture();
  f.els.video.time = 0;
  f.els.video.paused = false;
  f.renderAdultProgressiveUI(true);
  f.updateAdultPlayback(0, 0);
  f.els.video.time = 10;
  f.updateAdultPlayback(10000, 10);
  assert.ok(f.currentAdultFlow() > 0 && f.currentAdultFlow() < 100);
  f.els.video.time = 20;
  f.updateAdultPlayback(20000, 20);
  assert.equal(f.currentAdultFlow(), 100);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one']);
  f.els.video.time = 21;
  f.updateAdultPlayback(21000, 21);
  assert.deepEqual([...f.state.adultUnlockedPositionIds], ['one']);
  assert.equal(f.state.interactionRuntime.currentPhase, 'CORE');
  assert.equal(f.els.adultInteractionPanel.classList.contains('hidden'), false);
});

test('a separate verified entry plays only its transition and keeps every core movement card', async () => {
  const f = runtimeFixture();
  const group = f.state.adultScene.positions[0];
  group.subjectTrackId = 'track-b';
  group.controlClipIds = [];
  group.movements = group.movements.slice(0, 2);
  group.movements.forEach((movement, index) => { movement.sourceActionId = `observed-${index}`; });
  group.entryRange = { id: 'source-entry', startTime: 18, endTime: 20, sourceVerified: true,
    subjectTrackId: 'track-b', partnerTrackId: 'track-a', coreOccurrenceId: 'source-one', entryForGroupId: 'one' };
  group.entryClip = { id: 'entry-clip', startTime: 18, endTime: 20, loopStartTime: 18, loopEndTime: 20,
    sourceVerified: true, sourcePositionId: 'source-entry', sourceOccurrenceId: 'source-entry',
    subjectTrackId: 'track-b', partnerTrackId: 'track-a' };
  f.addFemaleLust(35);
  f.renderAdultProgressiveUI(true);
  f.selectAdultPosition('one', true);
  await flush();
  assert.equal(f.els.video.currentTime, 18);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.state.activeAdultEntryClip.id, 'entry-clip');
  assert.deepEqual(group.activeMovementChoices.flatMap(card => card.variants).map(movement => movement.id), ['one-0', 'one-1']);
  const playCalls = f.els.video.playCalls;
  f.els.video.time = 20;
  f.updateAdultPlayback(1000, 20);
  assert.equal(f.state.activeAdultEntryClip, null);
  assert.equal(f.state.activeMovementId, null);
  assert.equal(f.els.video.paused, true);
  assert.equal(f.els.video.playCalls, playCalls);
  assert.equal(f.els.adultInteractionPanel.classList.contains('hidden'), false);
  f.selectAdultMovement('one-0', true);
  await flush();
  assert.equal(f.els.video.currentTime, 20);
  assert.equal(f.state.activeAdultOccurrenceId, 'source-one');
});

test('tab text retains the full verified provider display label', () => {
  const f = runtimeFixture();
  const position = f.state.adultScene.positions[0];
  position.label = 'Source Chapter · Anal';
  f.addFemaleLust(35);
  f.renderAdultProgressiveUI(true);
  const button = f.els.positionTabs.children.find(child => child.dataset.positionId === position.id);
  assert.equal(button.textContent, position.label);
});

test('verified interlude choices remain selectable without resetting the core phase or mounting another overlay', async () => {
  const f = runtimeFixture();
  f.addFemaleLust(35);
  f.state.adultScene.foreplay.push({ id: 'interlude', label: 'Existing source transition',
    startTime: 50, endTime: 60, sourceVerified: true });
  f.els.video.time = 50;
  f.reconcileInteractionSource(50);
  f.renderAdultProgressiveUI(true);
  assert.equal(f.state.interactionRuntime.currentPhase, 'CORE');
  assert.equal(f.els.adultInteractionPanel.classList.contains('hidden'), false);
  assert.equal(f.els.choices.classList.contains('hidden'), true);
  const button = f.els.foreplayChoices.children.find(child => child.dataset.clipId === 'interlude');
  assert.ok(button);
  button.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(f.state.activeAdultPreludeId, 'interlude');
  assert.equal(f.els.video.currentTime, 50);
  assert.equal(f.state.interactionRuntime.currentPhase, 'CORE');
  assert.equal(f.els.adultInteractionPanel.classList.contains('hidden'), false);
});


test('context-control clips stay visible as ordinary movement choices', () => {
  const f = runtimeFixture();
  f.state.adultUnlockedPositionIds.add('one');
  f.state.adultSexUnlocked = true;
  f.selectAdultPosition('one', false);
  assert.deepEqual(
    new Set(f.state.adultScene.positions[0].activeMovementChoices.flatMap(card =>
      card.variants.map(item => item.id))),
    new Set(['one-0', 'one-1', 'one-2'])
  );
});
