import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer, availableChoices,
  nextPlayableClip, progression, captureGameplay, restoreGameplay } from '../public/gameplay-state.js';
import { phaseVisibleChoices, renderGameplay } from '../public/gameplay-view.js';
import { observation, evidence, analysis } from './fixtures/gameplay-v2.js';

test('one evidenced story decision spans source times without absorbing later dialogue', () => {
  const actions = [observation('ask', 0, { phase: 'STORY', duration: 2,
    gameplayEvidence: evidence('ask', { decisionId: 'fork-1', intent: 'ask' }) }),
  observation('listen', 5, { phase: 'STORY', duration: 2,
    gameplayEvidence: evidence('listen', { decisionId: 'fork-1', intent: 'listen' }) }),
  observation('later-talk', 12, { phase: 'STORY', duration: 2 })];
  const graph = createGameplayGraph(analysis(actions));
  assert.equal(graph.decisions.length, 1);
  assert.equal(graph.stages.length, 3);
  let state = createGameplayState(graph);
  assert.deepEqual(availableChoices(state).map(row => row.sourceActionId), ['ask', 'listen']);
  assert.deepEqual(phaseVisibleChoices(state), availableChoices(state));
  state = gameplayReducer(state, { type: 'SELECT', choiceId: graph.choices[1].id });
  assert.equal(state.stageId, graph.stages[1].id);
  assert.equal(nextPlayableClip(state).startTime, 5);
  assert.equal(availableChoices(state).length, 2, 'alternatives remain present during playback');
  const selectionId = state.selection.id;
  state = gameplayReducer(state, { type: 'PLAYING', selectionId });
  for (let time = 5.25; time <= 7; time += .25)
    state = gameplayReducer(state, { type: 'PLAYBACK', selectionId, time, elapsed: .25, playing: true });
  assert.equal(availableChoices(state).length, 2);
  state = gameplayReducer(state, { type: 'CLIP_ENDED', selectionId, time: 7 });
  assert.equal(availableChoices(state).length, 0, 'one chosen branch completes the decision');
  assert.equal(progression(state).nextStageId, graph.stages[2].id);
  state = gameplayReducer(state, { type: 'ADVANCE_STAGE' });
  assert.equal(state.stageId, graph.stages[2].id);
  state = gameplayReducer(state, { type: 'SEEK', time: 12.1, rewind: true });
  assert.deepEqual(availableChoices(state).map(row => row.sourceActionId), ['later-talk']);
});

test('scene ownership gathers approach and core alternatives around an intervening story event', () => {
  const owned = (id, time, extra = {}) => observation(id, time,
    { adultScene: true, adultSceneId: 'scene-one', duration: 2, ...extra });
  const graph = createGameplayGraph(analysis([
    owned('touch', 0), owned('dialogue', 3, { phase: 'STORY' }),
    owned('kiss', 6), owned('rear', 9, { phase: 'CORE', positionId: 'rear', positionLabel: 'Rear' }),
    owned('breather', 12), owned('front', 15, { phase: 'CORE', positionId: 'missionary', positionLabel: 'Missionary' }),
    owned('new-scene', 80, { adultSceneId: 'scene-two', phase: 'CORE', positionId: 'oral' })]));
  let state = createGameplayState(graph);
  assert.deepEqual(availableChoices(state).map(row => row.sourceActionId), ['touch', 'kiss', 'breather']);
  state = gameplayReducer(state, { type: 'SELECT', choiceId: graph.choices[2].id });
  assert.equal(nextPlayableClip(state).startTime, 6);
  assert.equal(availableChoices(state).length, 3);
  state = gameplayReducer(state, { type: 'SEEK', time: 9.1, rewind: true });
  assert.deepEqual(availableChoices(state).map(row => row.positionId), ['rear', 'missionary']);
  const front = availableChoices(state)[1];
  state = gameplayReducer(state, { type: 'SELECT', choiceId: front.id });
  assert.equal(state.focusedPositionId, 'missionary');
  assert.equal(nextPlayableClip(state).startTime, 15);
  assert.equal(availableChoices(state).length, 2);
  state = gameplayReducer(state, { type: 'SEEK', time: 80.1, rewind: true });
  assert.deepEqual(availableChoices(state).map(row => row.positionId), ['oral']);
});

test('a continuous opening with missing scene id joins its next core without merging conflicted cast', () => {
  const graph = createGameplayGraph(analysis([
    observation('opening-a', 0, { duration: 3, adultScene: false, adultSceneId: '',
      subjectTrackId: 'speaker-a', partnerTrackId: 'voice-b',
      participantTrackIds: ['speaker-a', 'voice-b'] }),
    observation('dialogue', 3, { phase: 'STORY', duration: 3 }),
    observation('opening-b', 6, { adultScene: true, adultSceneId: 'scene-1', duration: 3,
      subjectTrackId: 'speaker-a', partnerTrackId: 'visual-b',
      participantTrackIds: ['speaker-a', 'visual-b'] }),
    observation('position', 9, { phase: 'CORE', adultScene: true, adultSceneId: 'scene-1',
      positionId: 'seated-facing', duration: 3, subjectTrackId: 'speaker-a',
      partnerTrackId: 'visual-b', participantTrackIds: ['speaker-a', 'visual-b'] })]));
  const first = createGameplayState(graph);
  assert.deepEqual(availableChoices(first).map(row => row.sourceActionId), ['opening-a', 'opening-b']);
  assert.notDeepEqual(graph.choices[0].cast, graph.choices[2].cast);
  assert.deepEqual(availableChoices(gameplayReducer(first, { type: 'SEEK', time: 3.1, rewind: true }))
    .map(row => row.sourceActionId), ['dialogue']);
});

test('core tabs retain all positions while movement cards follow the selected position', () => {
  const graph = createGameplayGraph(analysis([
    observation('rear', 0, { phase: 'CORE', positionId: 'rear', positionLabel: 'Rear' }),
    observation('front', 8, { phase: 'CORE', positionId: 'missionary', positionLabel: 'Missionary' })]));
  const element = () => ({ children: [], dataset: {}, style: {}, handlers: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.parentElement = this; },
    replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
  const document = { createElement: element, querySelectorAll: () => [] };
  const stage = element(); stage.ownerDocument = document;
  const els = { video: { closest: () => stage }, choices: element(), approachChoices: element(),
    adultInteractionPanel: element(), movementChoices: element(), positionTabs: element() };
  let state = createGameplayState(graph);
  let selectedId;
  const player = { select(id) { selectedId = id; } };
  renderGameplay({ state, player, els, document });
  assert.equal(els.positionTabs.children.length, 2);
  assert.equal(els.movementChoices.children.filter(row => row.dataset.choiceId).length, 1);
  els.positionTabs.children[1].handlers.click();
  assert.equal(selectedId, graph.choices[1].id, 'a hidden movement still has a playable position tab');
  state = gameplayReducer(state, { type: 'SELECT', choiceId: graph.choices[1].id });
  renderGameplay({ state, player, els, document });
  assert.equal(els.positionTabs.children.length, 2);
  assert.deepEqual(els.movementChoices.children.filter(row => row.dataset.choiceId).map(row => row.dataset.choiceId),
    [graph.choices[1].id]);
  assert.equal(restoreGameplay(graph, captureGameplay(state)).focusedPositionId, 'missionary');
});
