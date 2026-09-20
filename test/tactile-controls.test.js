import test from 'node:test';
import assert from 'node:assert/strict';
import { createTactileEngine, TACTILE_PATTERNS } from '../public/tactile-controls.js';

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
