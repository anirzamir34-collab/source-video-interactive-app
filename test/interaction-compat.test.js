import test from 'node:test';
import assert from 'node:assert/strict';
import { bindInteractionRuntimeViews } from '../public/interaction-compat.js';

function fixture() {
  const host = { progress: 0, unlocked: new Set(), revealed: new Set(), active: null,
    runtime: { scene: { groups: [{ id: 'chapter', phase: 'CORE', sourceVerified: true }] },
      progressionValue: 0, unlockedGroupIds: [], revealedGroupIds: [], activeGroupId: null } };
  bindInteractionRuntimeViews(host, { runtimeKey: 'runtime', progressKey: 'progress', progressTarget: 35,
    unlockedKey: 'unlocked', revealedKey: 'revealed', activeKeys: { active: 'activeGroupId' }, unlockedFlagKey: 'coreOpen' });
  return host;
}

test('legacy units and identifiers are views of the authoritative runtime', () => {
  const host = fixture();
  host.progress = 17.5;
  host.unlocked.add('chapter');
  host.revealed.add('chapter');
  host.active = 'chapter';
  assert.equal(host.runtime.progressionValue, 50);
  assert.equal(host.coreOpen, true);
  assert.deepEqual(host.runtime.unlockedGroupIds, ['chapter']);
  assert.equal(host.runtime.activeGroupId, 'chapter');
  host.runtime = { ...host.runtime, progressionValue: 100, activeGroupId: null };
  assert.equal(host.progress, 35);
  assert.equal(host.active, null);
  host.progress = -100;
  assert.equal(host.runtime.progressionValue, 0);
  host.progress = 1000;
  assert.equal(host.runtime.progressionValue, 100);
});

test('a retained legacy set view cannot erase an unlock from a newer runtime', () => {
  const host = fixture();
  const view = host.unlocked;
  host.runtime = { ...host.runtime, unlockedGroupIds: ['newer'] };
  view.add('chapter');
  assert.deepEqual(host.runtime.unlockedGroupIds, ['newer', 'chapter']);
  host.unlocked.delete('newer');
  assert.deepEqual(host.runtime.unlockedGroupIds, ['chapter']);
  host.unlocked.clear();
  assert.deepEqual(host.runtime.unlockedGroupIds, []);
  assert.equal(host.coreOpen, false);
});

test('bindings remain safe across source replacement and reset without creating a second runtime', () => {
  const host = fixture();
  host.runtime = null;
  host.progress = 0;
  host.unlocked = new Set();
  host.active = null;
  host.runtime = { scene: { groups: [] }, progressionValue: 10,
    unlockedGroupIds: [], revealedGroupIds: [], activeGroupId: null };
  assert.equal(host.progress, 3.5);
  assert.deepEqual([...host.unlocked], []);
  assert.equal(host.active, null);
  assert.equal(host.coreOpen, false);
});

test('a retained collection view cannot mutate another scene runtime', () => {
  const host = { interactionRuntime: { scene: { id: 'old' }, unlockedGroupIds: ['a'], revealedGroupIds: [] } };
  bindInteractionRuntimeViews(host, { unlockedKey: 'unlocked', revealedKey: 'revealed' });
  const old = host.unlocked;
  host.interactionRuntime = { scene: { id: 'new' }, unlockedGroupIds: ['b'], revealedGroupIds: [] };
  old.add('a');
  old.clear();
  assert.deepEqual(host.interactionRuntime.unlockedGroupIds, ['b']);
});
