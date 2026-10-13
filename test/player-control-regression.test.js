import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer, availableChoices, progression, restoreGameplay, captureGameplay } from '../public/gameplay-state.js';
import { createGameplayPlayer } from '../public/gameplay-player.js';
import { normalizeStoryContext } from '../public/story-engine.js';
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
  const story = normalizeStoryContext(report.storyContext);
  assert.ok(story.facts.every(row => row.text !== '[object Object]'));
  assert.ok(story.facts.some(row => row.text === report.storyContext.facts[0].evidence));
  const stage = gameplayReducer(createGameplayState(graph), { type: 'SEEK', time: 134.373 }).stageId;
  assert.equal(stage, graph.clips.find(row => row.startTime === 134.373).stageId);
});

test('uploaded analysis: story, approach and core stay separate and opening progress reaches its verified boundary', { skip: !existsSync(realReport) }, () => {
  const report = JSON.parse(readFileSync(realReport));
  const graph = createGameplayGraph({ videoDuration: report.graph.duration,
    actions: report.actions.map(row => ({ ...row.input, actionId: row.actionId, label: row.label,
      startTime: row.startTime, endTime: row.endTime, sourceVerified: true, confidence: row.confidence })) });
  assert.deepEqual(graph.stages.filter(stage => stage.phase !== 'STORY').map(stage => stage.phase),
    ['APPROACH', 'APPROACH', 'CORE', 'APPROACH', 'CORE', 'AFTERMATH']);
  const firstCore = graph.stages.find(stage => stage.phase === 'CORE');
  assert.equal(graph.clips.filter(clip => clip.stageId === firstCore.id).length, 1);
  assert.equal(graph.choices.find(row => row.stageId === firstCore.id).movementLabel, 'ritmik hareket');
  let state = createGameplayState(graph);
  const earn = time => {
    state = gameplayReducer(state, { type: 'SEEK', time, rewind: true });
    const choice = availableChoices(state)[0];
    state = gameplayReducer(state, { type: 'SELECT', choiceId: choice.id });
    const selectionId = state.selection.id;
    state = gameplayReducer(state, { type: 'PLAYING', selectionId });
    for (let t = time + .5; t <= time + 3.5; t += .5) {
      state = gameplayReducer(state, { type: 'PLAYBACK', selectionId, time: t, elapsed: .5, playing: true });
    }
  };
  earn(134.373);
  assert.equal(progression(state).lust, 50);
  earn(211.158);
  assert.equal(progression(state).lust, 100);
});

const latestReport = new URL('../../upload/videoquest-sex-analysis-1791873375989.json', import.meta.url);
test('new saved-game report: local story, earned opening and automatic first-position reveal across an analysis gap', { skip: !existsSync(latestReport) }, () => {
  const report = JSON.parse(readFileSync(latestReport));
  const graph = createGameplayGraph({ videoDuration: report.graph.duration, actions: report.actions.map(row => ({
    ...row.input, actionId: row.actionId, label: row.label, startTime: row.startTime,
    endTime: row.endTime, sourceVerified: true, confidence: row.confidence })) });
  assert.equal(graph.choices.length, 12);
  assert.equal(graph.decisions.length, 0);
  assert.equal(graph.stages.filter(row => row.phase === 'STORY' && row.startTime < 211.158).length, 8);
  let state = createGameplayState(graph);
  assert.deepEqual(availableChoices(state).map(row => row.label), ['Mutfakta ayakta durup dinliyor']);
  const engage = start => {
    state = gameplayReducer(state, { type: 'SEEK', time: start, rewind: true });
    const choice = availableChoices(state).find(row => row.clipIds.some(id =>
      graph.clips.find(clip => clip.id === id)?.startTime === start));
    state = gameplayReducer(state, { type: 'SELECT', choiceId: choice.id });
    const id = state.selection.id, clip = graph.clips.find(row => row.id === choice.clipIds[0]);
    state = gameplayReducer(state, { type: 'PLAYING', selectionId: id });
    for (let t = start + .5; t <= start + 3.5; t += .5)
      state = gameplayReducer(state, { type: 'PLAYBACK', selectionId: id, time: t, elapsed: .5, playing: true });
    state = gameplayReducer(state, { type: 'CLIP_ENDED', selectionId: id, time: clip.endTime });
  };
  engage(211.158);
  assert.equal(progression(state).lust, 50);
  engage(227.955);
  assert.equal(progression(state).lust, 100);
  assert.equal(progression(state).phase, 'CORE');
  assert.equal(state.cursor, 232.754); // no silent seek across the unanalysed source gap
  assert.equal(availableChoices(state).length, 1);
  assert.equal(graph.clips.find(row => row.actionId === 'tl-011').classificationReview, 'needs_review');
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

test('old combined-story save distributes earned events into their chronological stages', () => {
  const graph = createGameplayGraph(analysis([
    observation('first', 0, { phase: 'STORY' }), observation('second', 8, { phase: 'STORY' })]));
  const prior = captureGameplay(createGameplayState(graph));
  const restored = restoreGameplay(graph, { ...prior, fingerprint: 'vq2-previous-layout',
    cursor: 8, stageProgress: { [graph.stages[0].id]: { score: 75,
      counts: { [graph.choices[0].id]: 1, [graph.choices[1].id]: 1 }, completed: true } } });
  assert.equal(restored.stageId, graph.stages[1].id);
  assert.equal(restored.stageProgress[graph.stages[0].id].counts[graph.choices[0].id], 1);
  assert.equal(restored.stageProgress[graph.stages[1].id].counts[graph.choices[1].id], 1);
  assert.equal(restored.stageProgress[graph.stages[0].id].score, 50);
});
