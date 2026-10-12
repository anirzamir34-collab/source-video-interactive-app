import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameplayGraph, normalizeGameplayEvidence } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer as reduce, availableChoices, activeSurface,
  nextPlayableClip, progression, captureGameplay, restoreGameplay } from '../public/gameplay-state.js';
import { observation, evidence, visual, analysis } from './fixtures/gameplay-v2.js';

function engage(state, id = availableChoices(state)[0]?.id, { finish = true, seconds = Infinity } = {}) {
  state = reduce(state, { type: 'SELECT', choiceId: id });
  const selectionId = state.selection?.id;
  state = reduce(state, { type: 'PLAYING', selectionId });
  const clip = nextPlayableClip(state);
  if (!clip) return state;
  const end = Math.min(clip.endTime, clip.startTime + seconds);
  let time = clip.startTime;
  while (time < end) {
    const next = Math.min(end, time + .25);
    state = reduce(state, { type: 'PLAYBACK', selectionId, time: next, elapsed: next - time, playing: true }); time = next;
  }
  return finish ? reduce(state, { type: 'CLIP_ENDED', selectionId, time: end }) : state;
}

test('A: seven verified narrative observations survive encounter references as meaningful story decisions', () => {
  const actions = Array.from({ length: 7 }, (_, i) => observation(`story-${i}`, i * 5, {
    phase: 'STORY', duration: 4, storyEvidenceLevel: 'fact', storyConfidence: .95,
    narrativeChoiceLabel: `Doğrulanmış niyet ${i}` }));
  const graph = createGameplayGraph(analysis(actions));
  const state = createGameplayState(graph);
  assert.equal(graph.choices.length, 7);
  assert.equal(activeSurface(state), 'story');
  assert.equal(availableChoices(state).length, 7);
  assert.ok(availableChoices(state).every(choice => choice.label !== 'Videoya devam et'));
  assert.ok(Object.isFrozen(graph.clips[0]));
});

test('A: labelled dialogue source events remain selectable without claiming unseen branches', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0, { phase: 'STORY' }), observation('b', 8, { phase: 'STORY' })]));
  assert.equal(availableChoices(createGameplayState(graph)).length, 2);
});

test('B: two 7.2 second choices cannot exhaust a stage from one choice or wall-clock coverage', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0), observation('b', 7.2)]));
  let state = createGameplayState(graph);
  const [a, b] = availableChoices(state);
  const untouched = reduce(state, { type: 'PLAYBACK', time: 14.4, elapsed: 14.4, playing: true });
  assert.equal(progression(untouched).value, 0);
  state = engage(state, a.id);
  assert.equal(progression(state).value, 50);
  state = engage(state, a.id);
  assert.equal(progression(state).value, 75);
  state = engage(state, a.id);
  assert.equal(progression(state).value, 75);
  assert.equal(progression(state).completed, false);
  state = engage(state, b.id);
  assert.equal(progression(state).completed, true);
});

test('B: actual engagement can earn credit before a long clip ends, without double reward', () => {
  let state = createGameplayState(createGameplayGraph(analysis([observation('a', 0, { duration: 30 }), observation('b', 31)])));
  const id = availableChoices(state)[0].id;
  state = engage(state, id, { finish: false, seconds: 3.5 });
  assert.equal(progression(state).value, 50);
  const first = state;
  state = reduce(state, { type: 'PLAYBACK', selectionId: state.selection.id, time: 4, elapsed: .5, playing: true });
  assert.deepEqual(progression(state), progression(first));
});

test('C: eight choices reveal progressively and verified visual changes retire incompatible earlier clips', () => {
  const actions = Array.from({ length: 8 }, (_, i) => observation(`a${i}`, i * 8, {
    gameplayEvidence: evidence(`a${i}`, { before: visual({ clothing: i < 2 ? 'coat' : 'shirt' }),
      after: visual({ clothing: i < 1 ? 'coat' : 'shirt' }) }) }));
  let state = createGameplayState(createGameplayGraph(analysis(actions)));
  assert.equal(availableChoices(state).length, 3);
  const first = availableChoices(state)[0].id;
  state = engage(state, availableChoices(state)[1].id);
  assert.equal(state.visual.clothing, 'shirt');
  assert.ok(!availableChoices(state).some(row => row.id === first));
  const blocked = reduce(state, { type: 'SELECT', choiceId: first });
  assert.equal(blocked, state);
  const rewound = reduce(state, { type: 'SEEK', time: 0, rewind: true });
  assert.ok(availableChoices(rewound).some(row => row.id === first));
  assert.deepEqual(rewound.stageProgress, state.stageProgress);
});

test('D: five source actions remain distinct; exact same action across cuts becomes an ordered sequence', () => {
  const actions = Array.from({ length: 5 }, (_, i) => observation(`source-${i}`, i * 9, {
    movementTempo: 'fast', gameplayEvidence: evidence(`source-${i}`) }));
  actions.push(observation('source-0-cut', 48, { gameplayEvidence: evidence('source-0') }));
  const graph = createGameplayGraph(analysis(actions));
  assert.equal(graph.choices.length, 5);
  assert.equal(graph.choices[0].clipIds.length, 2);
  assert.deepEqual(graph.choices[0].clipIds.map(id => graph.clips.find(row => row.id === id).startTime), [0, 48]);
});

test('D: changed cast, occurrence or observed semantics forbids cut merging', () => {
  for (const change of [{ occurrenceId: 'other' }, { action: { ...evidence('a').action, key: 'different' } }]) {
    const graph = createGameplayGraph(analysis([observation('a', 0, { gameplayEvidence: evidence('a') }),
      observation('b', 9, { gameplayEvidence: evidence('a', change) })]));
    assert.equal(graph.choices.length, 2);
  }
});

test('E: verified observed action overrides a mismatching headline and generic tempo abstains', () => {
  const observed = evidence('a', { action: { ...evidence('a').action, label: 'Kapıyı aç' } });
  const graph = createGameplayGraph(analysis([observation('a', 0, { label: 'Pencereyi aç', gameplayEvidence: observed }),
    observation('b', 9, { label: 'HIZLI' })]));
  assert.equal(graph.choices[0].label, 'Kapıyı aç');
  assert.equal(graph.choices[1].abstained, true);
  assert.match(graph.choices[1].label, /9\.0–16\.2/);
});

test('F: same-chapter next stage unlocks at a choice boundary without seeking or entering another chapter', () => {
  const actions = [observation('a', 0), observation('b', 8),
    observation('out', 16, { phase: 'OUTCOME' }),
    observation('other', 28, { adultSceneId: 'another-chapter' })];
  let state = createGameplayState(createGameplayGraph(analysis(actions)));
  const chapterId = state.chapterId;
  state = engage(state);
  state = engage(state, availableChoices(state)[1].id);
  assert.ok(progression(state).nextStageId);
  const cursor = state.cursor;
  state = reduce(state, { type: 'ADVANCE_STAGE' });
  assert.equal(state.cursor, cursor);
  assert.equal(state.chapterId, chapterId);
  assert.equal(activeSurface(state), 'panel');
  assert.ok(availableChoices(state).every(row => row.chapterId === chapterId));
});

test('G: rejected playback, seek jumps, pauses and stale events cannot mint engagement', () => {
  let state = createGameplayState(createGameplayGraph(analysis([observation('a', 0)])));
  state = reduce(state, { type: 'SELECT', choiceId: availableChoices(state)[0].id });
  const selectionId = state.selection.id;
  state = reduce(state, { type: 'PLAYING', selectionId });
  state = reduce(state, { type: 'PLAYBACK', selectionId, time: 7.2, elapsed: .01, playing: true });
  assert.equal(progression(state).value, 0);
  state = reduce(state, { type: 'PAUSE' });
  state = reduce(state, { type: 'PLAYBACK', selectionId, time: 7.2, elapsed: 10, playing: true });
  assert.equal(progression(state).value, 0);
  state = reduce(state, { type: 'FAIL', selectionId, message: 'blocked' });
  assert.equal(state.status, 'error');
  assert.equal(progression(state).value, 0);
  assert.equal(reduce(state, { type: 'PLAYING', selectionId: selectionId + 1 }), state);
});

test('G/H: save restoration is paused, graph bound and preserves rewards without replaying them', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0), observation('b', 8)]));
  let state = engage(createGameplayState(graph));
  const snapshot = JSON.parse(JSON.stringify(captureGameplay(state)));
  const restored = restoreGameplay(graph, snapshot);
  assert.equal(restored.status, 'decision');
  assert.equal(restored.selection, null);
  assert.deepEqual(restored.stageProgress, state.stageProgress);
  assert.deepEqual(restored.characters, state.characters);
  assert.equal(progression(restoreGameplay(graph, { ...snapshot, fingerprint: 'other' })).value, 0);
  assert.equal(progression(restoreGameplay(graph, null)).value, 0);
});

test('source normalization rejects unverified visual changes and invalid intervals', () => {
  assert.equal(normalizeGameplayEvidence({ version: 2, before: { verified: false, facts: { clothing: 'invented' } } }).before, null);
  const graph = createGameplayGraph(analysis([observation('a', 0, { sourceVerified: false }), observation('b', 2, { endTime: 1 })]));
  assert.equal(graph.choices.length, 0);
  assert.equal(graph.rejected.length, 2);
});

test('restore retains diminished engagement in its recorded order and verified mid-clip visual state', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0, { gameplayEvidence: evidence('a', {
    before: visual({ 'appearance:performer-a': 'hat' }) }) }), observation('b', 8)]));
  let state = createGameplayState(graph);
  const [a, b] = availableChoices(state);
  state = engage(state, b.id);
  state = engage(state, a.id, { finish: false, seconds: 3.5 });
  const restored = restoreGameplay(graph, captureGameplay(state));
  assert.deepEqual(restored.stageProgress, state.stageProgress);
  assert.deepEqual(restored.visual, state.visual);
  assert.deepEqual(restored.characters, state.characters);
});

test('missing or nonfinite boundary events and malformed snapshots do not create progress', () => {
  const graph = createGameplayGraph(analysis([observation('a', 0)]));
  let state = createGameplayState(graph);
  state = reduce(state, { type: 'SELECT', choiceId: availableChoices(state)[0].id });
  state = reduce(state, { type: 'PLAYING', selectionId: state.selection.id });
  assert.equal(reduce(state, { type: 'CLIP_ENDED', selectionId: state.selection.id }), state);
  const restored = restoreGameplay(graph, { version: 2, fingerprint: graph.fingerprint, stageProgress: {
    [state.stageId]: { score: 100, counts: { invented: 9999 }, completed: true } } });
  assert.equal(progression(restored).value, 0);
  assert.equal(progression(restored).completed, false);
});

test('out-of-order video frame callbacks cannot replay already observed seconds', () => {
  let state = createGameplayState(createGameplayGraph(analysis([observation('a', 0), observation('b', 8)])));
  state = engage(state, undefined, { finish: false, seconds: 1 });
  const selectionId = state.selection.id;
  const stale = reduce(state, { type: 'PLAYBACK', selectionId, time: .5, elapsed: 1, playing: true });
  assert.equal(stale, state);
  state = reduce(stale, { type: 'PLAYBACK', selectionId, time: 1.5, elapsed: .5, playing: true });
  assert.equal(state.selection.observed, 1.5);
  assert.equal(progression(state).value, 0);
});

test('a source range referenced on another surface cannot consume its narrative observation', () => {
  const shared = evidence('same', { action: { ...evidence('same').action, label: 'Doğrulanmış kaynak kesiti' } });
  const graph = createGameplayGraph(analysis([observation('story-reference', 0, { phase: 'STORY', gameplayEvidence: shared }),
    observation('panel-reference', 0, { phase: 'CORE', gameplayEvidence: shared })]));
  assert.equal(graph.choices.length, 2);
  assert.deepEqual(new Set(graph.choices.map(row => row.surface)), new Set(['story', 'panel']));
  assert.ok(graph.stages.every(stage => stage.choiceIds.length > 0));
});
