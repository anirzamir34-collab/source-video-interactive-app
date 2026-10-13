import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGameplayGraph } from '../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer, availableChoices, activeSurface,
  nextPlayableClip, progression } from '../public/gameplay-state.js';
import { renderGameplay } from '../public/gameplay-view.js';

// Run with VIDEOQUEST_NEW_REPORT=/path/to/videoquest-sex-analysis-1791893002020.json.
// The user's video analysis is deliberately not checked into the repository.
test('new user report keeps dialogue, opening, and positions in their source panels',
  { skip: !process.env.VIDEOQUEST_NEW_REPORT }, () => {
    const report = JSON.parse(readFileSync(process.env.VIDEOQUEST_NEW_REPORT, 'utf8'));
    assert.equal(report.analysisFingerprint, 'vq-7cf6c2aa-13', 'the attached report must actually be loaded');
    assert.equal(report.sourceActionCount, 13);
    const graph = createGameplayGraph({ videoDuration: report.graph.duration,
      actions: report.actions.map(row => ({ ...row.input, actionId: row.actionId,
        label: row.label, startTime: row.startTime, endTime: row.endTime,
        sourceVerified: row.sourceVerified, confidence: row.confidence })) });
    assert.equal(graph.clips.length, 13);
    assert.equal(graph.choices.length, 13);
    assert.equal(graph.decisions.length, 0, 'consecutive dialogue is not a verified decision fork');
    for (const row of report.actions) {
      const clip = graph.clips.find(item => item.actionId === row.actionId);
      assert.deepEqual([clip?.startTime, clip?.endTime], [row.startTime, row.endTime]);
    }
    const at = time => gameplayReducer(createGameplayState(graph), { type: 'SEEK', time, rewind: true });
    for (const time of [154.2, 157.5, 202.6]) {
      const state = at(time);
      assert.equal(activeSurface(state), 'story');
      assert.ok(availableChoices(state).every(choice => choice.phase === 'STORY'));
    }
    for (const time of [127.95, 172.6]) {
      const state = at(time);
      assert.equal(activeSurface(state), 'approach');
      assert.deepEqual(availableChoices(state).map(choice => choice.sourceActionId), ['tl-002', 'tl-006']);
      assert.equal(progression(state).lust, 0);
    }
    for (const time of [213.3, 272.3]) {
      const state = at(time);
      assert.equal(activeSurface(state), 'panel');
      assert.deepEqual(availableChoices(state).map(choice => choice.sourceActionId),
        ['tl-008', 'tl-009', 'tl-010', 'tl-011']);
      assert.deepEqual(availableChoices(state).filter(choice => choice.positionId).map(choice => choice.positionId),
        ['oral', 'missionary']);
      assert.ok(availableChoices(state).filter(choice => !choice.positionId)
        .every(choice => choice.phase === 'CORE'), 'unlinked movements are not turned into story events');
    }
    let state = at(213.3);
    const other = availableChoices(state).find(choice => choice.positionId === 'missionary');
    state = gameplayReducer(state, { type: 'SELECT', choiceId: other.id });
    assert.equal(state.focusedPositionId, 'missionary');
    assert.deepEqual([nextPlayableClip(state).startTime, nextPlayableClip(state).endTime], [262.406, 272.246]);
    assert.equal(availableChoices(state).length, 4, 'positions remain accessible during playback');
    state = at(472.4);
    assert.deepEqual(availableChoices(state).filter(choice => choice.positionId).map(choice => choice.positionId),
      ['rear', 'cowgirl']);
    assert.ok(availableChoices(state).every(choice => choice.chapterId === state.chapterId));
    assert.notEqual(graph.choices.find(choice => choice.sourceActionId === 'tl-002').cast.join(),
      graph.choices.find(choice => choice.sourceActionId === 'tl-006').cast.join(),
      'a shared opening never equates conflicted character identities');

    const element = () => ({ children: [], dataset: {}, style: {}, classList: {
      add() {}, remove() {}, toggle() {} }, handlers: {},
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    const document = { createElement: element, fullscreenElement: null };
    const stage = element(); stage.ownerDocument = document;
    const els = { video: { closest: () => stage }, choices: element(), approachChoices: element(),
      adultInteractionPanel: element(), movementChoices: element(), positionTabs: element() };
    const player = { select(id) { player.selected = id; } };
    renderGameplay({ state: at(213.3), player, els, document });
    assert.equal(els.positionTabs.children.length, 2);
    assert.deepEqual(els.movementChoices.children.filter(row => row.dataset.choiceId)
      .map(row => row.dataset.choiceId), graph.choices.filter(row => ['tl-008', 'tl-010', 'tl-011']
      .includes(row.sourceActionId)).map(row => row.id), 'unlinked events are separate from selected position');
    els.positionTabs.children[1].handlers.click();
    assert.equal(player.selected, other.id);
    renderGameplay({ state: gameplayReducer(at(213.3), { type: 'SELECT', choiceId: other.id }),
      player, els, document: { ...document, fullscreenElement: stage } });
    assert.equal(els.positionTabs.children.length, 2, 'all tabs remain in landscape fullscreen');
    assert.equal(els.movementChoices.children.filter(row => row.dataset.choiceId).length, 3);
  });
