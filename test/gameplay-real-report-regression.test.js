import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer, availableChoices, activeSurface,
  nextPlayableClip, progression, restoreGameplay } from '../public/gameplay-state.js';
import { phaseVisibleChoices } from '../public/gameplay-view.js';

// Supply the user's actual diagnostic through VIDEOQUEST_REAL_REPORT. Its
// transcript, cast and private source labels never enter the repository.
const path = process.env.VIDEOQUEST_REAL_REPORT;
const report = path ? JSON.parse(readFileSync(path, 'utf8')) : null;
const graph = report && createGameplayGraph({ videoDuration: report.graph.duration,
  actions: report.actions.map(row => ({ ...row.input, actionId: row.actionId,
    label: row.label, startTime: row.startTime, endTime: row.endTime,
    sourceVerified: row.sourceVerified, confidence: row.confidence })) });
const at = time => gameplayReducer(createGameplayState(graph), { type: 'SEEK', time, rewind: true });

test('real report: every accepted action retains its exact source range and panel owner', { skip: !report }, () => {
  assert.equal(report.sourceActionCount, 13);
  assert.equal(graph.clips.length, 13);
  assert.equal(graph.choices.length, 13);
  assert.equal(graph.decisions.length, 0, 'chronological dialogue is not a decision fork');
  for (const action of report.actions) {
    const clip = graph.clips.find(row => row.actionId === action.actionId);
    assert.ok(clip, action.actionId);
    assert.equal(clip.startTime, action.startTime);
    assert.equal(clip.endTime, action.endTime);
  }
  assert.deepEqual(phaseVisibleChoices(at(.1)).map(row => row.sourceActionId),
    [graph.choices[0].sourceActionId]);
  assert.deepEqual(availableChoices(at(134.5)).map(row => row.label), ['Kadının bacağına dokun']);
  assert.equal(activeSurface(at(134.5)), 'approach');
  assert.deepEqual(availableChoices(at(211.3)).map(row => row.positionId), ['oral', 'rear']);
  assert.deepEqual(availableChoices(at(391.2)).map(row => row.positionId), ['rear', 'missionary']);
  assert.equal(activeSurface(at(325.5)), 'panel', 'body transition never belongs to STORY');
  assert.deepEqual(availableChoices(at(391.2)).map(row => row.label),
    ['Arkadan pozisyonu sürdür', 'Misyoner pozisyonunu sürdür']);
});

test('real report: selected position targets its own observed interval and a later scene has no stale choices',
  { skip: !report }, () => {
    let state = at(391.2);
    const other = availableChoices(state).find(row => row.positionId === 'missionary');
    state = gameplayReducer(state, { type: 'SELECT', choiceId: other.id });
    assert.equal(state.focusedPositionId, 'missionary');
    assert.equal(nextPlayableClip(state).startTime, 441.513);
    assert.equal(nextPlayableClip(state).endTime, 451.111);
    state = gameplayReducer(state, { type: 'SEEK', time: 172.8, rewind: true });
    assert.equal(activeSurface(state), 'story');
    assert.ok(availableChoices(state).every(row => row.phase === 'STORY'));
    assert.ok(availableChoices(state).every(row => row.chapterId === state.chapterId));
  });

test('real report: repeated opening playback does not mint extra Lust; old graph save migrates',
  { skip: !report }, () => {
    let state = at(374.4);
    const choice = availableChoices(state)[0];
    const owner = state.stageId;
    state = { ...state, stageProgress: { [owner]: { counts: { [choice.id]: 1 }, score: 50, completed: true } } };
    assert.equal(progression(state).lust, 100);
    state = { ...state, stageProgress: { [owner]: { counts: { [choice.id]: 100 }, score: 100, completed: true } } };
    assert.equal(progression(state).lust, 100);
    const old = { version: 2, fingerprint: report.graph.fingerprint,
      chapterId: report.graph.stages.at(-2).chapterId,
      stageId: report.graph.stages.at(-2).id, cursor: 375,
      stageProgress: { [owner]: { counts: { [choice.id]: 1 }, score: 50, completed: true } } };
    const restored = restoreGameplay(graph, old);
    assert.equal(restored.stageId, owner);
    assert.equal(restored.stageProgress[owner].counts[choice.id], 1);
    assert.equal(progression(restored).lust, 100);
  });
