import test from 'node:test';
import assert from 'node:assert/strict';
import { mountInteractionPanel, resetInteractionSelection,
  sceneSurfaceIsStale, syncInteractionSurfaces } from '../public/interaction-panel.js';

class Element {
  constructor(id = '') { this.id = id; }
  children = [];
  parentElement = null;
  classes = new Set();
  classList = { toggle: (name, enabled) => enabled
    ? this.classes.add(name) : this.classes.delete(name) };
  appendChild(node) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
  }
  remove() {
    if (this.parentElement) this.parentElement.children =
      this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  querySelectorAll() { return this.children.flatMap(node =>
    [...(node.id ? [node] : []), ...node.querySelectorAll()]); }
}

test('rewind and repeated rendering reuse one panel node and preserve listeners', () => {
  const stage = new Element('stage');
  const panel = new Element('interaction-panel');
  panel.listener = () => 'original-listener';
  assert.deepEqual(mountInteractionPanel(stage, panel),
    { mounted: true, removedDuplicates: 0 });
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(mountInteractionPanel(stage, panel),
      { mounted: false, removedDuplicates: 0 });
  }
  assert.equal(stage.children.length, 1);
  assert.equal(stage.children[0], panel);
  assert.equal(panel.listener(), 'original-listener');
});

test('mount removes only stale duplicates with the same panel id', () => {
  const stage = new Element('stage');
  const duplicate = new Element('interaction-panel');
  const unrelated = new Element('playback-recovery');
  const panel = new Element('interaction-panel');
  stage.appendChild(duplicate);
  stage.appendChild(unrelated);
  assert.deepEqual(mountInteractionPanel(stage, panel),
    { mounted: true, removedDuplicates: 1 });
  assert.deepEqual(stage.children, [unrelated, panel]);
});

test('fullscreen placement moves the original panel without cloning it', () => {
  const container = new Element('container');
  const stage = new Element('fullscreen-stage');
  const panel = new Element('interaction-panel');
  container.appendChild(panel);
  mountInteractionPanel(stage, panel);
  assert.equal(container.children.length, 0);
  assert.equal(stage.children.length, 1);
  assert.equal(stage.children[0], panel);
});

test('scene switch clears active group, occurrence, movement, card and pending selection', () => {
  const state = { activeGroupId: 'old-group', activeOccurrenceId: 'old-occurrence',
    activeMovementId: 'old-clip', activeMovementChoiceId: 'old-card',
    activeApproachId: 'old-intro', pendingSelection: { id: 'old-clip' },
    tapTimes: [100, 200], held: true, armed: true, awaitingInput: true,
    progressionValue: 42, source: { label: 'opaque source label' } };
  resetInteractionSelection(state);
  for (const key of ['activeGroupId', 'activeOccurrenceId', 'activeMovementId',
    'activeMovementChoiceId', 'activeApproachId', 'pendingSelection']) {
    assert.equal(state[key], null, key);
  }
  assert.deepEqual(state.tapTimes, []);
  assert.equal(state.held, false);
  assert.equal(state.armed, false);
  assert.equal(state.awaitingInput, false);
  assert.equal(state.progressionValue, 42);
  assert.equal(state.source.label, 'opaque source label');
});

test('adapter can clear existing engine state keys and creates independent rhythm arrays', () => {
  const options = { selectionKeys: ['currentGroup', 'currentCard', 'pending'],
    rhythmDefaults: { inputTimes: [], inputHeld: false, inputArmed: false } };
  const first = { currentGroup: 'a', currentCard: 'card-a', pending: { id: 'a' },
    inputTimes: [1], inputHeld: true, inputArmed: true };
  const second = { currentGroup: 'b', currentCard: 'card-b', pending: { id: 'b' } };
  resetInteractionSelection(first, options);
  first.inputTimes.push(7);
  resetInteractionSelection(second, options);
  assert.equal(first.currentGroup, null);
  assert.equal(first.currentCard, null);
  assert.equal(first.pending, null);
  assert.equal(first.inputHeld, false);
  assert.equal(first.inputArmed, false);
  assert.deepEqual(second.inputTimes, []);
  assert.deepEqual(options.rhythmDefaults.inputTimes, []);
});

test('panel remains the sole surface through selection, seek, pause, resume and clip completion', () => {
  const panel = new Element('interaction-panel');
  const overlay = new Element('ordinary-choices');
  const approach = new Element('approach-choices');
  for (const event of ['selection', 'seeking', 'seeked', 'pause', 'resume', 'complete']) {
    const visible = syncInteractionSurfaces({ panel, overlay, approach, surface: 'panel' });
    assert.equal(panel.classes.has('hidden'), false, event);
    assert.equal(overlay.classes.has('hidden'), true, event);
    assert.equal(approach.classes.has('hidden'), true, event);
    assert.equal(visible.surface, 'panel');
    assert.equal(visible.overlayCount, 1, event);
  }
});

test('a single named surface exclusively owns approach, story, core and none', () => {
  const panel = new Element('core-panel');
  const overlay = new Element('story-overlay');
  const approach = new Element('approach-overlay');
  for (const surface of ['approach', 'story', 'panel', 'none', 'story', 'approach', 'panel']) {
    const visible = syncInteractionSurfaces({ panel, overlay, approach, surface });
    const active = [panel, overlay, approach].filter(node => !node.classes.has('hidden'));
    assert.equal(active.length, surface === 'none' ? 0 : 1, surface);
    assert.equal(visible.overlayCount, active.length, surface);
    assert.equal(visible.surface, surface);
    assert.equal(visible.panelVisible, surface === 'panel');
    assert.equal(visible.overlayVisible, surface === 'story');
    assert.equal(visible.approachVisible, surface === 'approach');
  }
});

test('missing target never leaves an old panel visible and invalid states fail loudly', () => {
  const panel = new Element('panel');
  const overlay = new Element('story');
  const first = syncInteractionSurfaces({ panel, overlay, surface: 'panel' });
  assert.equal(first.surface, 'panel');
  const second = syncInteractionSurfaces({ panel, overlay, surface: 'approach' });
  assert.equal(second.surface, 'none');
  assert.equal(panel.classes.has('hidden'), true);
  assert.equal(overlay.classes.has('hidden'), true);
  assert.throws(() => syncInteractionSurfaces({ panel, overlay, surface: 'typo' }),
    /UNKNOWN_INTERACTION_SURFACE/);
});

test('an interaction surface releases ownership on the first unrelated source scene', () => {
  const scene = { startTime: 138.212, endTime: 239.5 };
  assert.equal(sceneSurfaceIsStale(scene, 160), false);
  assert.equal(sceneSurfaceIsStale(scene, 239.5), false);
  assert.equal(sceneSurfaceIsStale(scene, 240), true);
  assert.equal(sceneSurfaceIsStale(scene, 276.423), true);
  assert.equal(sceneSurfaceIsStale(scene, 100), true);
  assert.equal(sceneSurfaceIsStale(scene, NaN), false);
  assert.equal(sceneSurfaceIsStale(null, 100), false);
});
