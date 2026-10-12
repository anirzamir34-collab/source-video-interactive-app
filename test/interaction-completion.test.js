import test from 'node:test';
import assert from 'node:assert/strict';
import { beginVerifiedClipPlayback, observeVerifiedClipPlayback,
  verifiedClipCompletionReady } from './fixtures/legacy-interaction-completion.js';

const selection = (overrides = {}) => ({ token: 4, kind: 'prelude',
  item: { id: 'intro-a', sourceVerified: true, startTime: 10, endTime: 20 }, ...overrides });
const observe = (pending, startTime, endTime, opts = {}) =>
  observeVerifiedClipPlayback(pending, { startTime, endTime, playing: true, ...opts });
const ready = (pending, mediaTime = 20, token = 4) =>
  verifiedClipCompletionReady(pending, { token, mediaTime });

test('successful play call never credits a clip until real source footage has been observed', () => {
  const started = beginVerifiedClipPlayback(selection(), 4);
  assert.equal(started.playStarted, true);
  assert.equal(ready(started), false);
  assert.equal(ready(observe(started, 10, 11)), false);
  const complete = observe(started, 10, 20);
  assert.equal(complete.observedSeconds, 10);
  assert.equal(ready(complete, 19.2), false);
  assert.equal(ready(complete), true);
});

test('seek, pause and stale token cannot mint selection completion credit', () => {
  const started = beginVerifiedClipPlayback(selection(), 4);
  assert.equal(observe(started, 10, 20, { seek: true }).observedSeconds, 0);
  assert.equal(observe(started, 10, 20, { playing: false }).observedSeconds, 0);
  assert.equal(ready(started), false);
  assert.equal(ready(observe(started, 10, 20), 20, 5), false);
  assert.equal(beginVerifiedClipPlayback(selection(), 5).playStarted, undefined);
});

test('real disjoint frame intervals earn only observed seconds of the verified source range', () => {
  let pending = beginVerifiedClipPlayback(selection(), 4);
  pending = observe(pending, 9, 13);
  pending = observe(pending, 13, 17);
  assert.equal(pending.observedSeconds, 7);
  assert.equal(ready(pending), true);
  pending = observe(pending, 17, 30);
  assert.equal(pending.observedSeconds, 10);
});

test('zero-duration, absent, unverified and mismatched clips never complete', () => {
  for (const item of [
    { sourceVerified: false, startTime: 10, endTime: 20 },
    { sourceVerified: true, startTime: null, endTime: 20 },
    { sourceVerified: true, startTime: 10, endTime: 10 },
    { sourceVerified: true, startTime: 12, endTime: undefined }
  ]) {
    const invalid = beginVerifiedClipPlayback(selection({ item }), 4);
    assert.equal(invalid.playStarted, undefined);
    assert.equal(ready(invalid), false);
  }
});

test('movement completion follows the movement loop, never its broader parent position', () => {
  const pending = { token: 9, kind: 'movement', position: { startTime: 0, endTime: 100 },
    movement: { id: 'clip-b', sourceVerified: true, loopStartTime: 35, loopEndTime: 40 } };
  const started = beginVerifiedClipPlayback(pending, 9);
  const partial = observe(started, 35, 36);
  assert.equal(ready(partial, 40, 9), false);
  assert.equal(ready(observe(started, 35, 40), 40, 9), true);
});
