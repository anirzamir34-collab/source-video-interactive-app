import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeploymentGuard } from '../public/deployment-guard.js';

test('an open player detects a new deployment before starting another analysis', async () => {
  let commit = 'release-one';
  const calls = [];
  const guard = createDeploymentGuard({ fetch: async (url, options) => {
    calls.push([url, options.cache]);
    return { ok: true, json: async () => ({ deploymentCommit: commit }) };
  } });
  assert.equal(await guard.loadedCommit(), 'release-one');
  assert.equal(await guard.hasChanged(), false);
  commit = 'release-two';
  assert.equal(await guard.hasChanged(), true);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['/health', 'no-store']));
});

test('a health request failure does not block an offline player', async () => {
  let count = 0;
  const guard = createDeploymentGuard({ fetch: async () => {
    if (count++ > 0) throw new Error('offline');
    return { ok: true, json: async () => ({ deploymentCommit: 'release-one' }) };
  } });
  assert.equal(await guard.hasChanged(), false);
});
