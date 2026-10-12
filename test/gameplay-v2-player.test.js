import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayPlayer } from '../public/gameplay-player.js';
import { availableChoices, progression } from '../public/gameplay-state.js';
import { conversationEnd } from '../public/conversation-timing.js';
import { observation, evidence, analysis } from './fixtures/gameplay-v2.js';

class Media extends EventTarget {
  time = 0; paused = true; seeking = false; readyState = 4; duration = 120; playbackRate = 1;
  mode = 'ready'; seeks = []; playCalls = 0;
  get currentTime() { return this.time; }
  set currentTime(value) {
    if (this.mode === 'seek-error') throw new Error('seek failed');
    this.seeks.push(value); this.seeking = true; this.dispatchEvent(new Event('seeking'));
    this.time = value;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  async play() {
    this.playCalls++;
    if (this.mode === 'blocked') throw new Error('NotAllowedError');
    this.paused = false; this.dispatchEvent(new Event('play'));
  }
}
function fixture(actions, options = {}) {
  const video = new Media(), graph = createGameplayGraph(analysis(actions));
  let clock = 0;
  const player = createGameplayPlayer({ graph, video, now: () => clock, ...options });
  return { player, video, graph, async tick(seconds) {
    clock += seconds * 1000; video.time += seconds; await player.sample();
  } };
}
const choices = f => availableChoices(f.player.getState());

test('G: real media adapter handles blocked play with retry, no rewards and no stale seek completion', async t => {
  const f = fixture([observation('a', 0), observation('b', 8)]); t.after(() => f.player.destroy());
  f.video.mode = 'blocked';
  await f.player.select(choices(f)[0].id);
  assert.equal(f.player.getState().status, 'error');
  assert.equal(progression(f.player.getState()).value, 0);
  f.video.mode = 'ready'; await f.player.retry();
  assert.equal(f.video.paused, false);
  await f.tick(3);
  assert.equal(progression(f.player.getState()).value, 50);
  await f.tick(4.2);
  assert.equal(f.player.getState().selection, null);
  assert.equal(f.video.paused, true);
});

test('D: a multi-cut selection seeks only to verified cuts and awards once per engagement', async t => {
  const f = fixture([observation('a', 0, { duration: 4, gameplayEvidence: evidence('same') }),
    observation('b', 12, { duration: 4, gameplayEvidence: evidence('same') })]);
  t.after(() => f.player.destroy());
  await f.player.select(choices(f)[0].id);
  await f.tick(4);
  assert.equal(f.video.currentTime, 12);
  assert.equal(f.player.getState().selection.index, 1);
  await f.tick(4);
  assert.equal(f.player.getState().selection, null);
  assert.equal(Object.values(f.player.getState().stageProgress)[0].counts[f.graph.choices[0].id], 1);
  assert.ok(f.video.seeks.every(time => [0, 12].includes(time)));
});

test('G: pause/resume and duplicate samples cannot double count source playback', async t => {
  const f = fixture([observation('a', 0), observation('b', 8)]); t.after(() => f.player.destroy());
  await f.player.select(choices(f)[0].id);
  await f.tick(1); f.video.pause();
  await f.tick(2);
  assert.equal(progression(f.player.getState()).value, 0);
  await f.player.resume();
  await f.tick(.2); await f.tick(2);
  const earned = progression(f.player.getState()).value;
  await f.player.sample(); await f.player.sample();
  assert.equal(progression(f.player.getState()).value, earned);
  assert.equal(earned, 50);
});

test('G: source change destroys pending effects and prevents their state writes', async () => {
  let release;
  const f = fixture([observation('a', 0)], { seek: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.player.select(choices(f)[0].id);
  f.player.destroy(); release(); await pending;
  assert.equal(f.video.playCalls, 0);
  assert.equal(progression(f.player.getState()).value, 0);
});

test('H: story boundary preserves audible Turkish sentence timing before returning to choices', async t => {
  const f = fixture([observation('a', 0, { phase: 'STORY', duration: 2 })], {
    conversationEndAt: time => conversationEnd(time, [{ startTime: 1, endTime: 3 }],
      [{ start: 1, end: 4 }], { dubEnabled: true, duration: 120 }) });
  t.after(() => f.player.destroy());
  await f.player.select(choices(f)[0].id);
  await f.tick(2);
  assert.equal(f.video.paused, false);
  await f.tick(2.2);
  assert.equal(f.video.paused, true);
  assert.equal(f.player.getState().selection, null);
});

test('G: restore preserves stage boundary and does not replay already earned credit', async t => {
  const f = fixture([observation('a', 0), observation('b', 8), observation('end', 16, { phase: 'OUTCOME' })]);
  t.after(() => f.player.destroy());
  await f.player.select(choices(f)[0].id); await f.tick(7.2);
  await f.player.select(choices(f)[1].id); await f.tick(7.2);
  const snapshot = f.player.capture();
  const other = fixture([observation('a', 0), observation('b', 8), observation('end', 16, { phase: 'OUTCOME' })], { snapshot });
  t.after(() => other.player.destroy());
  await other.player.navigate(snapshot.cursor, { preserveState: true });
  assert.equal(other.player.getState().stageId, snapshot.stageId);
  assert.deepEqual(other.player.getState().stageProgress, snapshot.stageProgress);
  assert.equal(other.video.paused, true);
});


test('story speech continuation cannot swallow the next observed source event', async t => {
  const f = fixture([
    observation('first', 0, { phase: 'STORY', duration: 2 }),
    observation('second', 2, { phase: 'STORY', duration: 4 })
  ], { conversationEndAt: time => time + 20 });
  t.after(() => f.player.destroy());
  const first = choices(f)[0];
  await f.player.select(first.id);
  await f.tick(2);
  assert.notEqual(f.player.getState().selection?.choiceId, first.id,
    'first story action must stop at the next verified source boundary');
  assert.ok(f.video.currentTime >= 2);
});
