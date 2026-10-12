import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as routing from '../../public/choice-routing.js';
import { selectDiverseStoryActions } from '../../public/story-engine.js';
import { pickNextVariant } from '../../public/adult-gameplay.js';
import { groupSourceChoiceCards } from '../../public/choice-groups.js';
import { createGameplayGraph } from '../../public/gameplay-evidence.js';
import { createGameplayState, gameplayReducer as reduce, availableChoices, progression } from '../../public/gameplay-state.js';
import { createInteractionState, transitionInteraction } from '../fixtures/legacy-interaction-engine.js';
import { observation, evidence, visual, analysis } from '../fixtures/gameplay-v2.js';

const legacy = fs.readFileSync(new URL('../fixtures/legacy-gameplay-reference.txt', import.meta.url), 'utf8');
const extract = name => {
  const start = legacy.indexOf(`function ${name}(`), tail = legacy.slice(start);
  return tail.slice(0, tail.slice(1).search(/\n(?:async )?function /) + 1);
};
const narrative = Array.from({ length: 7 }, (_, i) => observation(`story-${i}`, i * 4, {
  duration: 3, phase: 'STORY', storyEvidenceLevel: 'fact', storyConfidence: .95,
  narrativeChoiceLabel: `Niyet ${i}` }));
const context = vm.createContext({ ...routing, selectDiverseStoryActions, playableAdultPanelFamily: () => '',
  state: { analysis: analysis(narrative), gameCursorTime: 0, consumedActionIds: new Set(),
    completedAdultSceneIds: new Set(), adultScenes: [{ id: 'ref', dialogue: narrative.map(row => ({
      id: row.actionId, sourceVerified: true })) }] } });
vm.runInContext(extract('isUnownedTimelineChoice') + '\n' + extract('futureActions'), context);
const narrativeBefore = context.futureActions().length;
const storyGraph = createGameplayGraph(analysis(narrative));
const narrativeAfter = availableChoices(createGameplayState(storyGraph)).length;
assert.equal(narrativeBefore, 0); assert.equal(narrativeAfter, 7);

const actions = Array.from({ length: 5 }, (_, i) => observation(`action-${i}`, i * 8, {
  phase: 'CORE', duration: 6, gameplayEvidence: evidence(`action-${i}`) }));
actions.push(observation('cut-2', 42, { phase: 'CORE', duration: 6, gameplayEvidence: evidence('action-0') }));
const oldClips = actions.map(row => ({ ...row, id: row.actionId, loopStartTime: row.startTime,
  loopEndTime: row.endTime, sourceActionId: row.gameplayEvidence.sourceActionId,
  movementType: 'position', movementTempo: 'fast', sourcePositionId: 'same', sourceOccurrenceId: 'occurrence-1' }));
const oldCards = groupSourceChoiceCards(oldClips, { contextFor: () => 'same-occurrence', mergeWithinContext: true,
  bandFor: () => ({ key: 'fast', energyFlavor: 'fast', tempo: 'fast', intensityBand: 'intense' }) });
const newGraph = createGameplayGraph(analysis(actions));
const falseOld = oldCards.filter(card => new Set(card.variants.map(row => row.sourceActionId)).size > 1).length;
const falseNew = newGraph.choices.filter(card => new Set(card.clipIds.map(id => newGraph.clips.find(row => row.id === id).sourceActionId)).size > 1).length;
assert.equal(newGraph.choices.length, 5); assert.equal(falseNew, 0);

const opening = [observation('a', 0), observation('b', 7.2)];
let modern = createGameplayState(createGameplayGraph(analysis(opening)));
let old = createInteractionState({ id: 'opening', groups: [], choices: opening.map(row => ({
  id: row.actionId, phase: 'APPROACH', sourceVerified: true,
  sourceRanges: [{ id: row.actionId, occurrenceId: row.actionId, startTime: row.startTime, endTime: row.endTime }] })) }, { progressBudget: true });
const beforeProgress = [], afterProgress = [];
for (const name of ['a', 'a', 'a', 'b']) {
  const row = opening.find(row => row.actionId === name);
  old = transitionInteraction(old, { type: 'playback', startTime: row.startTime, endTime: row.endTime, playing: true });
  old = transitionInteraction(old, { type: 'selection-complete', choiceId: name, startTime: row.startTime, endTime: row.endTime, playing: true });
  beforeProgress.push(old.progressionValue);
  const choice = modern.graph.choices.find(choice => choice.id.endsWith(`:${name}`));
  modern = reduce(modern, { type: 'SELECT', choiceId: choice.id });
  const selectionId = modern.selection.id;
  modern = reduce(modern, { type: 'PLAYING', selectionId });
  modern = reduce(modern, { type: 'PLAYBACK', selectionId, time: row.endTime, elapsed: 7.2, playing: true });
  modern = reduce(modern, { type: 'CLIP_ENDED', selectionId, time: row.endTime });
  afterProgress.push(progression(modern).value);
}
assert.deepEqual(afterProgress, [50, 75, 75, 100]);

const continuityGraph = createGameplayGraph(analysis([observation('old', 0, { gameplayEvidence: evidence('old', {
  before: visual({ clothing: 'coat' }), after: visual({ clothing: 'coat' }) }) }),
observation('new', 8, { gameplayEvidence: evidence('new', { before: visual({ clothing: 'coat' }), after: visual({ clothing: 'shirt' }) }) })]));
let continuity = createGameplayState(continuityGraph);
continuity = reduce(continuity, { type: 'SELECT', choiceId: continuityGraph.choices[1].id });
continuity = reduce(continuity, { type: 'PLAYING', selectionId: continuity.selection.id });
continuity = reduce(continuity, { type: 'PLAYBACK', selectionId: continuity.selection.id, time: 15.2, elapsed: 7.2, playing: true });
continuity = reduce(continuity, { type: 'CLIP_ENDED', selectionId: continuity.selection.id, time: 15.2 });
const legacyCandidate = pickNextVariant([{ id: 'old', sourceVerified: true, loopStartTime: 0, loopEndTime: 7.2 },
  { id: 'new', sourceVerified: true, loopStartTime: 8, loopEndTime: 15.2 }], 'new', new Map([['new', 1]]));
const incompatibleAfter = availableChoices(continuity).filter(row => row.id === continuityGraph.choices[0].id).length;
assert.equal(incompatibleAfter, 0);
assert.equal(legacyCandidate.id, 'old');

const metadata = {
  fixture: 'Synthetic observations only; these are not measurements of unseen footage.',
  narrative: { verifiedObservations: 7, initialCardsBefore: narrativeBefore, initialCardsAfter: narrativeAfter,
    graphCardsAfter: storyGraph.choices.length },
  cutComposition: { verifiedSourceActions: 5, verifiedSourceClips: 6, cardsBefore: oldCards.length,
    cardsAfter: newGraph.choices.length, conflatedCardsBefore: falseOld, conflatedCardsAfter: falseNew,
    sourceSecondsBefore: oldCards.flatMap(card => card.variants).reduce((sum, row) => sum + row.endTime - row.startTime, 0),
    sourceSecondsAfter: newGraph.clips.reduce((sum, row) => sum + row.endTime - row.startTime, 0),
    duplicateClipIdsAfter: newGraph.choices.flatMap(card => card.clipIds).length - new Set(newGraph.choices.flatMap(card => card.clipIds)).size },
  progression: { twoChoiceSeconds: 14.4, selections: ['a', 'a', 'a', 'b'], before: beforeProgress, after: afterProgress },
  continuity: { incompatibleEarlierCandidateBefore: Number(legacyCandidate?.id === 'old'), incompatibleEarlierCandidateAfter: incompatibleAfter },
  mismatchingVideoCount: null,
  limitation: 'Actual visual correctness requires human review of source media; synthetic tests verify declared evidence and routes.'
};
console.log(JSON.stringify(metadata, null, 2));
