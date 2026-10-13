import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, availableChoices, gameplayReducer } from '../public/gameplay-state.js';
import { createGameplayPlayer } from '../public/gameplay-player.js';

const sourceEvent = (id, startTime, endTime, label, more = {}) => ({
  actionId: id, startTime, endTime, label, actionType: 'dialogue',
  subjectTrackId: 'character-1', partnerTrackId: 'character-2',
  sourceVerified: true, confidence: .95, ...more
});

const source = {
  videoDuration: 460.8,
  actions: [
    sourceEvent('event-1', 7.54, 86.38, 'Kapıda karşıla'),
    sourceEvent('event-2', 86.383, 100.8, 'Mutfakta konuş'),
    sourceEvent('event-3', 103.2, 110.4, 'Odadan ayrıl'),
    sourceEvent('event-4', 112.8, 134.4, 'Oturup sohbet et'),
    sourceEvent('event-5', 136.8, 170.4, 'Konuşmaya devam et')
  ]
};

class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.paused = true;
    this.seeking = false;
    this.readyState = 4;
    this.playbackRate = 1;
  }
  pause() { this.paused = true; }
}

const seek = async (media, time) => { media.currentTime = time; };
const play = async media => { media.paused = false; };

test('multiple evidenced labels survive as successive source events, not one decision', () => {
  const graph = createGameplayGraph(source);
  const state = createGameplayState(graph);
  assert.equal(graph.choices.length, 5);
  assert.equal(availableChoices(state).length, 1);
  assert.deepEqual(graph.stages.map(stage => graph.choices.find(row => row.stageId === stage.id).label),
    source.actions.map(row => row.label));
  assert.ok(graph.choices.every(choice => choice.intent === ''));
  assert.ok(graph.choices.every(choice => choice.clipIds.length === 1));
});

test('selecting a source-backed event never invents a second outcome', () => {
  const graph = createGameplayGraph(source);
  let state = createGameplayState(graph);
  state = gameplayReducer(state, { type: 'SEEK', time: 103.2 });
  state = gameplayReducer(state, { type: 'SELECT', choiceId: graph.choices[2].id });
  assert.equal(state.selection.choiceId, graph.choices[2].id);
  assert.deepEqual(state.selection.clipIds, [graph.choices[2].clipIds[0]]);
  assert.equal(graph.clips.find(x => x.id === state.selection.clipIds[0]).startTime, 103.2);
});

test('single source-event skip lands on the next available timestamp without earning a reward', async t => {
  const graph = createGameplayGraph(source);
  const video = new FakeMedia();
  const player = createGameplayPlayer({ graph, video, seek, play });
  t.after(() => player.destroy());
  await player.select(graph.choices[0].id);
  assert.equal(video.currentTime, 7.54);
  await player.skipCurrentClip();
  assert.equal(video.currentTime, 86.383);
  assert.equal(player.getState().selection, null);
  assert.equal(availableChoices(player.getState()).length, 1);
  assert.equal(Object.values(player.getState().stageProgress).reduce((sum, row) =>
    sum + Object.keys(row.counts).length, 0), 0);
});

test('unattributed source intervals never turn into fabricated narrative branches', () => {
  const graph = createGameplayGraph({
    videoDuration: 100,
    actions: [
      sourceEvent('a', 0, 10, '', { gameplayEvidence: { version: 2, action: { verified: false } } }),
      sourceEvent('b', 10, 20, '', { gameplayEvidence: { version: 2, action: { verified: false } } })
    ]
  });
  assert.equal(availableChoices(createGameplayState(graph)).length, 1);
});
