import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer, availableChoices, progression, restoreGameplay, captureGameplay } from '../public/gameplay-state.js';
import { createGameplayPlayer } from '../public/gameplay-player.js';
import { observation, analysis } from './fixtures/gameplay-v2.js';

const realReport = new URL('../../upload/videoquest-sex-analysis-1791867671268.json', import.meta.url);
test('uploaded analysis: overlapping source event remains independently reachable and identity conflicts require review', { skip: !existsSync(realReport) }, () => {
  const report = JSON.parse(readFileSync(realReport));
  const source = { videoDuration: report.graph.duration, actions: report.actions.map(row => ({ ...row.input,
    actionId: row.actionId, label: row.label, startTime: row.startTime, endTime: row.endTime,
    sourceVerified: true, confidence: row.confidence })) };
  const graph = createGameplayGraph(source);
  assert.equal(graph.clips.length, 10);
  assert.equal(graph.sourceEvents.length, 10);
  assert.equal(graph.decisions.length, 0);
  assert.ok(graph.clips.some(row => row.startTime === 134.373 && row.endTime === 136.773));
  assert.ok(graph.chapters.some(row => row.endTime === 285.544));
  assert.ok(graph.chapters.some(row => row.startTime === 374.326));
  assert.ok(graph.clips.every(row => row.classificationReview === 'needs_review'));
  const stage = gameplayReducer(createGameplayState(graph), { type: 'SEEK', time: 134.373 }).stageId;
  assert.equal(stage, graph.clips.find(row => row.startTime === 134.373).stageId);
});

test('new selection interrupts seeking and stale completion cannot award progress', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0, { duration: 30 }), observation('b', 31)]));
  let state = createGameplayState(graph);
  const [a, b] = availableChoices(state);
  state = gameplayReducer(state, { type: 'SELECT', choiceId: a.id });
  const previousId = state.selection.id;
  state = gameplayReducer(state, { type: 'SELECT', choiceId: b.id });
  assert.equal(state.selection.choiceId, b.id);
  assert.notEqual(state.selection.id, previousId);
  state = gameplayReducer(state, { type: 'PLAYING', selectionId: previousId });
  state = gameplayReducer(state, { type: 'CLIP_ENDED', selectionId: previousId, time: 30 });
  assert.equal(state.status, 'seeking');
  assert.equal(progression(state).value, 0);
});

test('media controller aborts prior async seek on rapid selection', async () => {
  const graph = createGameplayGraph(analysis([observation('a', 0, { duration: 30 }), observation('b', 31)]));
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0, playbackRate: 1, paused: true, seeking: false,
    pause() { this.paused = true; } });
  const pending = [];
  const player = createGameplayPlayer({ graph, video, seek: (_video, time, { signal }) => new Promise(resolve => {
    pending.push({ time, signal, resolve });
  }), play: async () => { video.paused = false; } });
  const [a, b] = availableChoices(player.getState());
  const first = player.select(a.id);
  const second = player.select(b.id);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(); await first;
  assert.equal(player.getState().selection.choiceId, b.id);
  pending[1].resolve(); await second;
  assert.equal(player.getState().status, 'playing');
  player.destroy();
});

test('compatible v2 save migrates stable source IDs without resetting score', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0)]));
  let state = createGameplayState(graph);
  const choice = availableChoices(state)[0];
  state = gameplayReducer(state, { type: 'SELECT', choiceId: choice.id });
  const saved = captureGameplay(state);
  const restored = restoreGameplay(graph, { ...saved, fingerprint: 'vq2-previous-graph' });
  assert.equal(restored.stageId, saved.stageId);
  assert.equal(restoreGameplay(graph, { ...saved, fingerprint: 'other' }).fingerprint, graph.fingerprint);
});
