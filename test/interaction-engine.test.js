import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInteractionState, normalizeInteractionScene, interactionProgressPacing,
  progressionPacing, progressForSelection, advanceInteraction, unlockNextCoreGroup,
  selectInteractionGroup, selectInteractionChoice, visibleApproachChoices,
  switchInteractionScene, interactionTrace
} from '../public/interaction-engine.js';

const range = (id, startTime, endTime, occurrenceId = id) => ({
  id, startTime, endTime, occurrenceId, sourceVerified: true
});
const group = (id, startTime, endTime, overrides = {}) => ({
  id, phase: 'CORE', sourceVerified: true, occurrenceId: `${id}-occurrence`,
  sourceRanges: [range(`${id}-source`, startTime, endTime, `${id}-occurrence`)],
  movements: [], ...overrides
});
const choice = (id, startTime, endTime, overrides = {}) => ({
  id, phase: 'APPROACH', sourceVerified: true, occurrenceId: `${id}-occurrence`,
  sourceRanges: [range(`${id}-source`, startTime, endTime, `${id}-occurrence`)],
  ...overrides
});
const scene = (overrides = {}) => ({
  id: 'scene-a', choices: [choice('opening-a', 0, 10), choice('opening-b', 12, 20)],
  groups: [group('chapter-a', 30, 60), group('chapter-b', 200, 230)], ...overrides
});

test('long opening pacing uses first verified core time and available choice count', () => {
  const short = interactionProgressPacing(scene());
  const long = interactionProgressPacing(scene({ groups: [group('chapter-a', 300, 330)] }));
  assert.equal(short.progressionScale, 1);
  assert.equal(long.openingDuration, 300);
  assert.equal(long.firstCoreTime, 300);
  assert.equal(long.verifiedChoiceCount, 2);
  assert.ok(long.progressionScale < short.progressionScale);
  let state = createInteractionState(scene({ groups: [group('chapter-a', 300, 330)] }));
  state = progressForSelection(state, 'opening-a');
  assert.ok(state.progressionValue > 0 && state.progressionValue < 10);
});

test('short opening keeps normal pacing and verified choice count ignores invalid rows', () => {
  const data = scene({ choices: [choice('a', 0, 10), choice('bad', 10, 20, { sourceVerified: false })] });
  const pacing = interactionProgressPacing(data);
  assert.equal(pacing.progressionScale, 1);
  assert.equal(pacing.verifiedChoiceCount, 1);
  assert.equal(progressForSelection(createInteractionState(data), 'a').progressionValue, 25);
});

test('verified choices with progression disabled remain selectable without contributing to pacing or progress', () => {
  const data = scene({ choices: [choice('dialogue', 0, 250, { progressionEnabled: false }),
    choice('opening', 250, 270)], groups: [group('chapter', 280, 310)] });
  const state = createInteractionState(data);
  assert.equal(state.openingDuration, 30);
  assert.equal(state.verifiedChoiceCount, 1);
  assert.equal(state.progressionScale, 1);
  assert.equal(selectInteractionChoice(state, 'dialogue').target.startTime, 0);
  assert.equal(progressForSelection(state, 'dialogue', 1000), state);
  assert.deepEqual(state.unlockedGroupIds, []);
  assert.equal(progressForSelection(advanceInteraction(state, 250), 'opening').progressionValue, 25);
});

test('an entirely progress-disabled opening does not acquire a synthetic progression budget', () => {
  const state = createInteractionState(scene({ choices: [choice('dialogue', 0, 300,
    { progressionEnabled: false })], groups: [group('chapter', 300, 330)] }));
  assert.equal(state.openingDuration, 0);
  assert.equal(state.verifiedChoiceCount, 0);
  assert.equal(state.progressionValue, 0);
  assert.deepEqual(advanceInteraction(state, 300).unlockedGroupIds, ['chapter']);
});

test('later approach records cannot slow the first opening progress budget', () => {
  const data = scene({ choices: [choice('first', 0, 10),
    ...Array.from({ length: 20 }, (_, index) => choice(`later-${index}`, 100 + index * 2, 101 + index * 2))] });
  const pacing = interactionProgressPacing(data);
  assert.equal(pacing.verifiedChoiceCount, 1);
  assert.equal(pacing.openingDuration, 30);
  assert.equal(pacing.progressionScale, 1);
});

test('configured playback and selection rates normalize expected opening progress without a floor', () => {
  const parameters = { openingStartTime: 0, firstCoreTime: 1000, verifiedChoiceCount: 20,
    playbackPointsPerSecond: 0.24 * 100 / 35, selectionPoints: 3 * 100 / 35 };
  const pacing = progressionPacing(parameters);
  assert.equal(pacing.openingDuration, 1000);
  assert.ok(pacing.scale < 0.12);
  assert.ok(Math.abs((1000 * parameters.playbackPointsPerSecond + 20 * parameters.selectionPoints) * pacing.scale - 100) < 1e-8);
  assert.equal(progressionPacing({ ...parameters, firstCoreTime: 35, verifiedChoiceCount: 3 }).scale, 1);
});

test('progress stays bounded and repeat choices contribute less than a new verified choice', () => {
  let state = createInteractionState(scene());
  state = progressForSelection(state, 'opening-a');
  assert.equal(state.progressionValue, 25);
  state = progressForSelection(state, 'opening-a');
  assert.equal(state.progressionValue, 37.5);
  state = progressForSelection(state, 'opening-b');
  assert.equal(state.progressionValue, 62.5);
  state = progressForSelection(state, 'opening-b', 1000);
  assert.equal(state.progressionValue, 100);
  assert.equal(progressForSelection(state, 'missing', 100).progressionValue, 100);
});

test('progress 100 unlocks next existing verified core without exhausting any variants or seeking', () => {
  const internal = { id: 'unused-card', sourceVerified: true, sourcePositionId: 'chapter-a-source',
    occurrenceId: 'chapter-a-occurrence', startTime: 40, endTime: 45, variants: ['opaque-a', 'opaque-b'] };
  let state = createInteractionState(scene({ groups: [group('chapter-a', 30, 60, { movements: [internal] })] }));
  state = progressForSelection(state, 'opening-a', 100);
  assert.equal(state.progressionValue, 100);
  assert.deepEqual(state.unlockedGroupIds, ['chapter-a']);
  assert.deepEqual(state.revealedGroupIds, ['chapter-a']);
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.unlockReason, 'progress-full');
  assert.equal(state.currentTime, 0);
  assert.equal(state.lastSeekTarget, null);
  assert.equal(state.activeGroupId, null);
  assert.equal(state.choicePlayCounts['unused-card'], undefined);
});

test('one full progress cycle does not reveal every future group through repeats', () => {
  let state = progressForSelection(createInteractionState(scene()), 'opening-a', 100);
  state = progressForSelection(state, 'opening-a', 100);
  assert.deepEqual(state.unlockedGroupIds, ['chapter-a']);
});

test('next core unlock cannot reveal an earlier skipped occurrence after source-boundary selection', () => {
  const data = scene({ groups: [group('chapter-a', 30, 60), group('chapter-b', 200, 230), group('chapter-c', 300, 330)] });
  const state = advanceInteraction(createInteractionState(data), 201);
  assert.deepEqual(state.unlockedGroupIds, ['chapter-b']);
  const next = unlockNextCoreGroup(state);
  assert.deepEqual(next.unlockedGroupIds, ['chapter-b', 'chapter-c']);
  assert.equal(next.unlockedGroupIds.includes('chapter-a'), false);
  assert.equal(next.lastSeekTarget, null);
});

test('entry selection honors provider source identity independently of UI group id', () => {
  const providerRange = range('provider-range', 200, 230, 'provider-occurrence');
  const data = scene({ groups: [group('ui-tab', 200, 230, {
    occurrenceId: 'logical-occurrence', sourceRanges: [providerRange]
  })], choices: [choice('card', 202, 205, { phase: 'CORE', groupId: 'ui-tab',
    occurrenceId: 'logical-occurrence', sourceOccurrenceId: 'provider-occurrence',
    sourceRanges: [{ ...providerRange, startTime: 202, endTime: 205 }] })] });
  const state = unlockNextCoreGroup(createInteractionState(data));
  const selected = selectInteractionChoice(state, 'card');
  assert.equal(selected.blockedReason, null);
  assert.equal(selected.target.sourcePositionId, 'provider-range');
  assert.equal(selected.target.sourceOccurrenceId, 'provider-occurrence');
  assert.equal(selected.target.startTime, 202);
  assert.equal(selected.target.endTime, 205);
  const bad = createInteractionState({ ...data, choices: [{ ...data.choices[0], sourcePositionId: 'ui-tab' }] });
  assert.equal(selectInteractionChoice(unlockNextCoreGroup(bad), 'card').target, null);
});

test('unlocked distant group stays clickable and explicit selection ignores passive lookahead', () => {
  let state = unlockNextCoreGroup(createInteractionState(scene()));
  state = unlockNextCoreGroup(state);
  const result = selectInteractionGroup(state, 'chapter-b');
  assert.equal(result.blockedReason, null);
  assert.equal(result.target.startTime, 200);
  assert.equal(result.target.sourcePositionId, 'chapter-b-source');
  assert.equal(result.target.sourceOccurrenceId, 'chapter-b-occurrence');
  assert.equal(result.state.lastSeekTarget, 200);
  assert.equal(result.state.currentTime, 0, 'pure selection returns a target; it does not seek media');
  assert.equal(result.state.panelVisible, true);
  state = advanceInteraction(state, 5);
  assert.equal(selectInteractionGroup(state, 'chapter-b').blockedReason, null);
});

test('verified source boundary reveals locked core independently of empty progress', () => {
  let state = createInteractionState(scene());
  assert.deepEqual(state.unlockedGroupIds, []);
  state = advanceInteraction(state, 31);
  assert.equal(state.progressionValue, 0);
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.activeGroupId, 'chapter-a');
  assert.equal(state.activeOccurrenceId, 'chapter-a-occurrence');
  assert.deepEqual(state.unlockedGroupIds, ['chapter-a']);
  assert.equal(state.unlockReason, 'source-boundary');
});

test('an unlock reached during opening is retained until a rewind recomputes source phase', () => {
  let state = progressForSelection(createInteractionState(scene()), 'opening-a', 100);
  state = advanceInteraction(state, 5);
  assert.equal(state.currentPhase, 'CORE');
  state = advanceInteraction(state, 0);
  assert.equal(state.currentPhase, 'APPROACH');
  assert.deepEqual(state.unlockedGroupIds, ['chapter-a']);
});

test('approach choices prepare next verified action during active choice and reject distant choices', () => {
  const data = scene({ choices: [choice('opening-a', 0, 40), choice('opening-b', 41, 50), choice('distant', 250, 260)] });
  let state = createInteractionState(data);
  assert.deepEqual(visibleApproachChoices(state, { forwardWindowSeconds: 5 }).map(row => row.id), ['opening-a']);
  state = selectInteractionChoice(state, 'opening-a', { forwardWindowSeconds: 5 }).state;
  assert.deepEqual(visibleApproachChoices(state, { forwardWindowSeconds: 5 }).map(row => row.id), ['opening-a', 'opening-b']);
  assert.equal(selectInteractionChoice(state, 'distant', { forwardWindowSeconds: 1000 }).target, null);
  assert.equal(selectInteractionChoice(state, 'distant').blockedReason, 'outside-approach-window');
});

test('a long active choice cannot expose source choices hundreds of seconds forward', () => {
  const data = scene({ choices: [choice('opening-a', 0, 300), choice('distant', 301, 310)] });
  const state = selectInteractionChoice(createInteractionState(data), 'opening-a').state;
  assert.deepEqual(visibleApproachChoices(state).map(row => row.id), ['opening-a']);
  assert.equal(selectInteractionChoice(state, 'distant').target, null);
});

test('first verified opening source action is retained without expanding source intervals', () => {
  const data = normalizeInteractionScene(scene({
    choices: [choice('later', 20, 25), choice('first', 0, 10)],
    groups: [group('chapter-a', 170, 200)]
  }));
  assert.equal(data.choices[0].id, 'first');
  assert.deepEqual(data.choices[0].sourceRanges, [range('first-source', 0, 10, 'first-occurrence')]);
  assert.equal(interactionProgressPacing(data).openingDuration, 170);
});

test('first selection keeps panel visible and carries one exact pending source range', () => {
  const result = selectInteractionChoice(createInteractionState(scene()), 'opening-a');
  assert.equal(result.state.panelVisible, true);
  assert.equal(result.target.startTime, 0);
  assert.equal(result.target.endTime, 10);
  assert.equal(result.state.activeMovementId, 'opening-a');
  assert.equal(advanceInteraction(result.state, 5).panelVisible, true);
});

test('scene switch clears stale selection ids and rhythm while source boundary may establish new group', () => {
  const stale = { ...createInteractionState(scene()), activeGroupId: 'chapter-a',
    activeOccurrenceId: 'chapter-a-occurrence', activeMovementId: 'card-a',
    pendingSelection: { startTime: 35 }, rhythm: { held: true, taps: 5 } };
  const next = switchInteractionScene(stale, scene({ id: 'scene-b' }), 0);
  assert.equal(next.activeGroupId, null);
  assert.equal(next.activeOccurrenceId, null);
  assert.equal(next.activeMovementId, null);
  assert.equal(next.pendingSelection, null);
  assert.deepEqual(next.rhythm, { held: false, taps: 0 });
  assert.deepEqual(next.unlockedGroupIds, []);
});

test('rewind recomputes source phase and active occurrence without changing source ranges', () => {
  let state = advanceInteraction(createInteractionState(scene()), 201);
  state = { ...state, activeMovementId: 'card-b', pendingSelection: { startTime: 201 }, rhythm: { held: true, taps: 2 } };
  state = advanceInteraction(state, 32);
  assert.equal(state.currentPhase, 'CORE');
  assert.equal(state.activeGroupId, 'chapter-a');
  assert.equal(state.activeOccurrenceId, 'chapter-a-occurrence');
  assert.equal(state.activeMovementId, null);
  assert.equal(state.pendingSelection, null);
  assert.deepEqual(state.rhythm, { held: false, taps: 0 });
  state = advanceInteraction(state, 1);
  assert.equal(state.currentPhase, 'APPROACH');
  assert.equal(state.activeGroupId, null);
  assert.equal(state.activeOccurrenceId, null);
  assert.equal(state.panelVisible, true);
});

test('unverified content is never playable, unlockable, or rewarded', () => {
  const data = scene({ choices: [choice('bad-choice', 0, 10, { sourceVerified: false })],
    groups: [group('bad-group', 30, 60, { sourceVerified: false })] });
  let state = createInteractionState(data);
  assert.equal(selectInteractionChoice(state, 'bad-choice').target, null);
  assert.equal(selectInteractionGroup(state, 'bad-group').target, null);
  state = progressForSelection(state, 'bad-choice', 100);
  assert.equal(state.progressionValue, 0);
  assert.deepEqual(unlockNextCoreGroup(state).unlockedGroupIds, []);
  assert.deepEqual(advanceInteraction(state, 35).unlockedGroupIds, []);
});

test('a mislabeled movement outside its owning occurrence cannot grant progression', () => {
  const movement = { id: 'outside-card', phase: 'CORE', sourceVerified: true,
    sourcePositionId: 'chapter-a-source', sourceOccurrenceId: 'chapter-a-occurrence',
    occurrenceId: 'chapter-a-occurrence', startTime: 205, endTime: 210 };
  const data = scene({ groups: [group('chapter-a', 30, 60, { movements: [movement] })] });
  const state = createInteractionState(data);
  assert.equal(progressForSelection(state, 'outside-card', 100).progressionValue, 0);
  assert.deepEqual(progressForSelection(state, 'outside-card', 100).unlockedGroupIds, []);
});

test('entry tab returns only verified entry clip and does not schedule internal movements', () => {
  const entryClip = { id: 'entry-a', sourcePositionId: 'chapter-a-source',
    sourceOccurrenceId: 'chapter-a-occurrence', sourceVerified: true, startTime: 30, endTime: 33 };
  const data = scene({ groups: [group('chapter-a', 30, 60, {
    entryClip, movements: [{ id: 'card-a', variants: [{ startTime: 40, endTime: 45 }, { startTime: 50, endTime: 55 }] }]
  })] });
  const result = selectInteractionGroup(unlockNextCoreGroup(createInteractionState(data)), 'chapter-a');
  assert.equal(result.target.startTime, 30);
  assert.equal(result.target.endTime, 33);
  assert.equal(result.target.variants, undefined);
  assert.equal(result.state.activeMovementId, null);
  assert.deepEqual(result.state.pendingSelection, result.target);
});

test('outcome and aftermath transition only on their existing verified source ranges', () => {
  const data = scene({ groups: [group('chapter-a', 30, 60),
    group('outcome', 60, 65, { phase: 'OUTCOME' }),
    group('aftermath', 65, 70, { phase: 'AFTERMATH' }),
    group('fake', 80, 100, { phase: 'OUTCOME', sourceVerified: false })] });
  let state = advanceInteraction(createInteractionState(data), 62);
  assert.equal(state.currentPhase, 'OUTCOME');
  state = advanceInteraction(state, 66);
  assert.equal(state.currentPhase, 'AFTERMATH');
  state = advanceInteraction(state, 81);
  assert.equal(state.currentPhase, 'AFTERMATH');
  assert.equal(advanceInteraction(createInteractionState(data), 81).currentPhase, 'APPROACH',
    'jumping into a gap cannot invent a terminal source boundary');
});

test('generic trace has source identities, unlock and blocked seek evidence without altering labels', () => {
  const data = scene({ groups: [group('chapter-a', 30, 60, { label: 'OPAQUE_PROVIDER_LABEL' })] });
  let state = selectInteractionGroup(createInteractionState(data), 'chapter-a').state;
  const trace = interactionTrace(state, { overlayCount: 1, playbackBlocked: true, playbackFailureReason: 'NotAllowedError' });
  assert.equal(trace.currentPhase, 'APPROACH');
  assert.equal(trace.blockedSeekReason, 'locked-group');
  assert.equal(trace.overlayCount, 1);
  assert.equal(trace.sourceRanges[0].id, 'chapter-a-source');
  assert.equal(trace.sourceRanges[0].groupId, 'chapter-a');
  assert.equal(trace.playbackFailureReason, 'NotAllowedError');
  assert.equal(state.scene.groups[0].label, 'OPAQUE_PROVIDER_LABEL');
});
