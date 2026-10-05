import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFullscreen, revealFullscreenChoices } from '../public/fullscreen.js';

const statusNode = () => ({ hidden: true, textContent: '', classList: { remove() {} } });

test('unsupported fullscreen shows an explanation without touching playback or choices', async () => {
  const status = statusNode();
  assert.equal(await toggleFullscreen({ document: {}, stage: {}, status }), false);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Tam ekran açılamadı/);
});

test('a rejected fullscreen request can be retried and clears the old explanation on success', async () => {
  const status = statusNode(); let calls = 0;
  const stage = { async requestFullscreen() { calls++; if (calls === 1) throw Error('NotAllowedError'); } };
  assert.equal(await toggleFullscreen({ document: {}, stage, status }), false);
  assert.equal(status.hidden, false);
  assert.equal(await toggleFullscreen({ document: {}, stage, status }), true);
  assert.equal(status.hidden, true);
  assert.equal(status.textContent, '');
});

test('orientation lock failure does not make a successful fullscreen request look failed', async () => {
  const status = statusNode(); let requests = 0;
  assert.equal(await toggleFullscreen({ document: {}, stage: { requestFullscreen() { requests++; } },
    screen: { orientation: { lock() { throw Error('Unsupported'); } } }, status }), true);
  assert.equal(requests, 1);
  assert.equal(status.hidden, true);
});

test('standard fullscreen exits instead of requesting fullscreen again', async () => {
  let exits = 0;
  const document = { fullscreenElement: {}, exitFullscreen() { assert.equal(this, document); exits++; } };
  assert.equal(await toggleFullscreen({ document, stage: { requestFullscreen() { throw Error('unexpected enter'); } }, status: statusNode() }), true);
  assert.equal(exits, 1);
});

test('successful fullscreen exit releases the orientation lock, including the webkit path', async () => {
  for (const webkit of [false, true]) {
    let unlocks = 0;
    const document = webkit
      ? { webkitFullscreenElement: {}, webkitExitFullscreen() {} }
      : { fullscreenElement: {}, exitFullscreen() {} };
    assert.equal(await toggleFullscreen({ document, stage: {},
      screen: { orientation: { unlock() { unlocks++; } } }, status: statusNode() }), true);
    assert.equal(unlocks, 1);
  }
});

test('failed fullscreen exit retains the lock and an unsupported unlock does not fail a successful exit', async () => {
  let unlocks = 0;
  const document = { fullscreenElement: {}, exitFullscreen() { throw Error('blocked'); } };
  assert.equal(await toggleFullscreen({ document, stage: {},
    screen: { orientation: { unlock() { unlocks++; } } }, status: statusNode() }), false);
  assert.equal(unlocks, 0);
  document.exitFullscreen = () => {};
  assert.equal(await toggleFullscreen({ document, stage: {},
    screen: { orientation: { unlock() { throw Error('unsupported'); } } }, status: statusNode() }), true);
});

test('webkit fullscreen uses matching enter and exit APIs with the original receivers', async () => {
  let entered = 0, exited = 0;
  const stage = { webkitRequestFullscreen() { assert.equal(this, stage); entered++; } };
  const document = { webkitExitFullscreen() { assert.equal(this, document); exited++; } };
  assert.equal(await toggleFullscreen({ document, stage, status: statusNode() }), true);
  document.webkitFullscreenElement = stage;
  assert.equal(await toggleFullscreen({ document, stage, status: statusNode() }), true);
  assert.equal(entered, 1); assert.equal(exited, 1);
});

test('entering fullscreen reveals all choices, while dialogue and exit keep their current surface', () => {
  const stage = {};
  const panel = { classList: { contains: value => value === 'hidden' ? false : value === 'compact-collapsed' } };
  let expansions = 0;
  const options = { stage, panel, expand: () => { expansions++; } };
  assert.equal(revealFullscreenChoices({ ...options, document: { fullscreenElement: stage } }), true);
  assert.equal(revealFullscreenChoices({ ...options, document: { webkitFullscreenElement: stage } }), true);
  assert.equal(expansions, 2);
  assert.equal(revealFullscreenChoices({ ...options, document: { fullscreenElement: null } }), false);
  assert.equal(revealFullscreenChoices({ ...options, document: { fullscreenElement: stage },
    panel: { classList: { contains: () => true } } }), false);
  assert.equal(expansions, 2);
});
