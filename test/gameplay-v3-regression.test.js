import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, availableChoices, gameplayReducer, progression, nextPlayableClip } from '../public/gameplay-state.js';
import { observation, evidence, visual, analysis } from './fixtures/gameplay-v2.js';

function witnessed(state, choiceId) {
  state = gameplayReducer(state, { type: 'SELECT', choiceId });
  const selectionId = state.selection.id;
  state = gameplayReducer(state, { type: 'PLAYING', selectionId });
  let time = nextPlayableClip(state).startTime;
  for (let i = 0; i < 16; i++) {
    time += .25;
    state = gameplayReducer(state, { type: 'PLAYBACK', time, elapsed: .25, selectionId, playing: true });
  }
  return state;
}

test('v3: one verified core action never manufactures full Lust progress', () => {
  const graph = createGameplayGraph(analysis([observation('only', 0, { phase: 'CORE' })]));
  let state = createGameplayState(graph);
  state = witnessed(state, availableChoices(state)[0].id);
  assert.equal(progression(state).value, 50);
  assert.equal(progression(state).completed, true);
});

test('v3: position families remain choices under one core stage', () => {
  const graph = createGameplayGraph(analysis([
    observation('pose-a', 0, { phase: 'CORE', positionId: 'seated-facing', positionLabel: 'Oturma düzeni' }),
    observation('movement-a', 9, { phase: 'CORE', positionId: 'seated-facing', positionLabel: 'Oturma düzeni' }),
    observation('pose-b', 18, { phase: 'CORE', positionId: 'rear', positionLabel: 'Başka düzen' })
  ]));
  const stages = graph.stages.filter(stage => stage.phase === 'CORE');
  assert.equal(stages.length, 1);
  assert.equal(availableChoices(createGameplayState(graph)).length, 3);
  assert.deepEqual(graph.choices.map(c => c.positionId), ['seated-facing', 'seated-facing', 'rear']);
});

test('v3: preview stops early but does not claim unseen visual after-state', () => {
  const graph = createGameplayGraph(analysis([observation('long', 0, {
    duration: 38, gameplayEvidence: evidence('long', {
      before: visual({ clothing: 'coat' }), after: visual({ clothing: 'removed' })
    })
  })]));
  const clip = graph.clips[0];
  assert.equal(clip.endTime, 38);
  assert.equal(clip.previewEndTime, 14);
  let state = createGameplayState(graph);
  state = gameplayReducer(state, { type: 'SELECT', choiceId: graph.choices[0].id });
  const selectionId = state.selection.id;
  state = gameplayReducer(state, { type: 'PLAYING', selectionId });
  let time = 0;
  while (time < 14) {
    const next = Math.min(14, time + .25);
    state = gameplayReducer(state, { type: 'PLAYBACK', time: next, elapsed: next - time, selectionId, playing: true });
    time = next;
  }
  state = gameplayReducer(state, { type: 'CLIP_ENDED', time: 14, selectionId });
  assert.equal(progression(state).value, 50);
  assert.equal(state.visual.clothing, 'coat');
  assert.deepEqual(state.observedClipIds, []);
});

test('v3: skipping a stage reaches next observed stage without awarding credit', () => {
  const graph = createGameplayGraph(analysis([
    observation('approach', 0),
    observation('core', 12, { phase: 'CORE' })
  ]));
  let state = createGameplayState(graph);
  const firstId = state.stageId;
  state = gameplayReducer(state, { type: 'SKIP_STAGE' });
  assert.notEqual(state.stageId, firstId);
  assert.equal(state.cursor, 12);
  assert.equal(progression(state).value, 0);
  assert.equal(state.status, 'decision');
});

test('v3: next chapter updates cursor to the source chapter', () => {
  const graph = createGameplayGraph(analysis([
    observation('one', 0, { adultSceneId: 'one' }),
    observation('two', 50, { adultSceneId: 'two' })
  ]));
  assert.equal(graph.chapters.length, 2);
  let state = createGameplayState(graph);
  state = gameplayReducer(state, { type: 'NEXT_CHAPTER' });
  assert.equal(state.stageId, graph.chapters[1].stageIds[0]);
  assert.equal(state.cursor, 50);
  assert.equal(progression(state).value, 0);
});

test('v3: a genuine story decision needs fact-level intent evidence', () => {
  const actions = Array.from({ length: 3 }, (_, i) =>
    observation('narrative-' + i, i * 8, { phase: 'STORY',
      narrativeChoiceLabel: 'Gözlenen karar ' + i, storyEvidenceLevel: 'fact', storyConfidence: .95 }));
  const graph = createGameplayGraph(analysis(actions));
  assert.equal(availableChoices(createGameplayState(graph)).length, 3);
  const notVerified = actions.map(row => ({ ...row, storyEvidenceLevel: 'unknown', storyConfidence: 0 }));
  assert.equal(availableChoices(createGameplayState(createGameplayGraph(analysis(notVerified)))).length, 1);
});

test('v3: source encounter continues across dialogue, approach and core', () => {
  const graph = createGameplayGraph(analysis([
    observation('talk', 0, { phase: 'STORY', adultSceneId: 'single-encounter' }),
    observation('approach', 8, { phase: 'APPROACH', adultSceneId: 'single-encounter' }),
    observation('core', 16, { phase: 'CORE', adultSceneId: 'single-encounter' })
  ]));
  assert.equal(graph.chapters.length, 1);
  assert.deepEqual(graph.stages.map(stage => stage.phase), ['STORY', 'APPROACH', 'CORE']);
  let state = createGameplayState(graph);
  state = gameplayReducer(state, { type: 'SKIP_STAGE' });
  assert.equal(state.chapterId, graph.chapters[0].id);
  assert.equal(state.stageId, graph.stages[1].id);
});
