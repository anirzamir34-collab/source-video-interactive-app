import test from 'node:test';
import assert from 'node:assert/strict';
import { mountInteractionPanel, resetInteractionSelection,
  syncInteractionSurfaces } from '../public/interaction-panel.js';

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

test('panel remains visible through selection, seek, pause, resume and clip completion', () => {
  const panel = new Element('interaction-panel');
  const overlay = new Element('ordinary-choices');
  for (const event of ['selection', 'seeking', 'seeked', 'pause', 'resume', 'complete']) {
    const snapshot = syncInteractionSurfaces({ panel, overlay,
      panelVisible: true, overlayVisible: true });
    assert.equal(panel.classes.has('hidden'), false, event);
    assert.equal(overlay.classes.has('hidden'), true, event);
    assert.equal(snapshot.overlayCount, 1, event);
  }
});

test('approach and core rendering share one visible interaction surface', () => {
  const panel = new Element('interaction-panel');
  const overlay = new Element('ordinary-choices');
  assert.deepEqual(syncInteractionSurfaces({ panel, overlay, overlayVisible: true }),
    { panelVisible: false, overlayVisible: true, overlayCount: 1 });
  assert.deepEqual(syncInteractionSurfaces({ panel, overlay, panelVisible: true }),
    { panelVisible: true, overlayVisible: false, overlayCount: 1 });
  assert.deepEqual(syncInteractionSurfaces({ panel, overlay }),
    { panelVisible: false, overlayVisible: false, overlayCount: 0 });
});
