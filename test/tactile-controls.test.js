import test from 'node:test';
import assert from 'node:assert/strict';
import { attachHoldReleaseControl, createTactileEngine, TACTILE_PATTERNS } from '../public/tactile-controls.js';

test('tactile engine persists its enabled state and emits named patterns', () => {
  const writes = new Map();
  const calls = [];
  const engine = createTactileEngine({
    navigatorRef: { vibrate: pattern => { calls.push(pattern); return true; } },
    storage: { getItem: key => writes.get(key), setItem: (key, value) => writes.set(key, value) },
    matchMediaRef: () => ({ matches: false })
  });
  assert.equal(engine.enabled, true);
  assert.equal(engine.pulse('confirm'), true);
  assert.deepEqual(calls[0], TACTILE_PATTERNS.confirm);
  assert.equal(engine.toggle(), false);
  assert.equal(engine.pulse('press'), false);
  assert.equal(calls.length, 1);
});

test('reduced motion shortens patterned vibration to one restrained pulse', () => {
  const calls = [];
  const engine = createTactileEngine({
    navigatorRef: { vibrate: pattern => { calls.push(pattern); return true; } },
    storage: null,
    matchMediaRef: () => ({ matches: true })
  });
  engine.pulse('charged');
  assert.equal(calls[0], TACTILE_PATTERNS.charged[0]);
});

test('unsupported vibration keeps visual fallback available without throwing', () => {
  const engine = createTactileEngine({ navigatorRef: {}, storage: null, matchMediaRef: null });
  assert.equal(engine.supported, false);
  assert.equal(engine.pulse('confirm'), false);
});

class HoldButton extends EventTarget {
  dataset = {};
  disabled = false;
  classes = new Set();
  captures = new Set();
  released = [];
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
  };
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    this.captures.delete(id);
    this.released.push(id);
    this.emit('lostpointercapture', { pointerId: id });
  }
  emit(type, properties = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, properties);
    this.dispatchEvent(event);
  }
}

function holdFixture() {
  const button = new HoldButton();
  const activations = [];
  const pulses = [];
  const detach = attachHoldReleaseControl({ button,
    engine: { pulse: kind => pulses.push(kind) },
    onActivate: value => activations.push(value), holdMs: 460 });
  return { button, activations, pulses, detach };
}

test('hold reset cancels pending charge and rejects a stale pointer release without detaching', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = holdFixture();
  f.button.emit('pointerdown', { pointerId: 0, pointerType: 'touch' });
  f.detach.reset();
  t.mock.timers.tick(1000);
  f.button.emit('pointerup', { pointerId: 0 });
  assert.deepEqual(f.activations, []);
  assert.deepEqual(f.pulses, ['press']);
  assert.deepEqual(f.button.released, [0]);
  assert.equal(f.button.classes.has('is-pressed'), false);
  assert.equal(f.button.classes.has('is-charged'), false);
  assert.equal(f.button.dataset.tactileManaged, 'true');
  // The same bound control remains usable in the next interaction scope.
  f.button.emit('pointerdown', { pointerId: 1, pointerType: 'touch' });
  f.button.emit('pointerup', { pointerId: 1 });
  assert.equal(f.activations.length, 1);
  assert.equal(f.activations[0].charged, false);
  assert.equal(f.button.classes.has('tap-confirmed'), true);
  f.detach();
});

test('reset clears a charged hold and confirmed CSS then preserves normal charged activation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = holdFixture();
  f.button.classes.add('tap-confirmed');
  f.button.emit('pointerdown', { pointerId: 2, pointerType: 'touch' });
  t.mock.timers.tick(460);
  assert.equal(f.button.classes.has('is-charged'), true);
  f.detach.reset();
  assert.equal(f.button.classes.has('is-charged'), false);
  assert.equal(f.button.classes.has('tap-confirmed'), false);
  f.button.emit('pointerup', { pointerId: 2 });
  assert.equal(f.activations.length, 0);
  f.button.emit('pointerdown', { pointerId: 3, pointerType: 'touch' });
  t.mock.timers.tick(460);
  f.button.emit('pointerup', { pointerId: 3 });
  assert.equal(f.activations.length, 1);
  assert.equal(f.activations[0].charged, true);
  assert.deepEqual(f.pulses, ['press', 'charged', 'press', 'charged', 'charged']);
  assert.equal(f.button.classes.has('tap-confirmed'), true);
  f.detach();
});

test('reset tolerates missing or failed capture and detach still removes listeners', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = holdFixture();
  f.button.setPointerCapture = () => { throw Error('capture unavailable'); };
  f.button.hasPointerCapture = undefined;
  f.button.releasePointerCapture = () => { throw Error('capture already released'); };
  f.button.emit('pointerdown', { pointerId: 4, pointerType: 'touch' });
  assert.doesNotThrow(() => f.detach.reset());
  f.button.emit('pointerup', { pointerId: 4 });
  assert.equal(f.activations.length, 0);
  f.detach();
  f.button.emit('pointerdown', { pointerId: 5, pointerType: 'touch' });
  f.button.emit('pointerup', { pointerId: 5 });
  t.mock.timers.tick(1000);
  assert.equal(f.activations.length, 0);
  assert.equal(f.button.dataset.tactileManaged, undefined);
});

test('scope reset inside activation callback prevents stale confirmation on the next scope', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const button = new HoldButton();
  const pulses = [];
  let activations = 0;
  const detach = attachHoldReleaseControl({ button,
    engine: { pulse: kind => pulses.push(kind) },
    onActivate: () => { activations += 1; detach.reset(); } });
  button.emit('pointerdown', { pointerId: 6, pointerType: 'touch' });
  button.emit('pointerup', { pointerId: 6 });
  assert.equal(activations, 1);
  assert.deepEqual(pulses, ['press']);
  assert.equal(button.classes.has('tap-confirmed'), false);
  detach();
});

test('a control disabled during a hold never activates on release', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = holdFixture();
  f.button.emit('pointerdown', { pointerId: 7, pointerType: 'touch' });
  f.button.disabled = true;
  t.mock.timers.tick(460);
  f.button.emit('pointerup', { pointerId: 7 });
  assert.equal(f.activations.length, 0);
  assert.equal(f.button.classes.has('is-pressed'), false);
  assert.equal(f.button.classes.has('is-charged'), false);
  f.detach();
});
