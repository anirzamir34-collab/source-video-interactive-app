import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { choiceSurfaceForAction } from '../public/choice-routing.js';
import { buildVerifiedMovementChoices, consolidateVerifiedPositions,
  expandVerifiedMovementVariants, sourceMotionProgressRate } from '../public/adult-gameplay.js';
import { playableAdultPanelFamily, movementBelongsToVerifiedPosition } from '../public/adult-gameplay.js';

// Only source times, neutral track identifiers and structural metadata from
// the user report. The source video and descriptive text are not committed.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/anonymous-source-analysis.json', import.meta.url)));
const action = id => fixture.actions.find(item => item.actionId === id);
const position = id => {
  const item = action(id);
  return { id, familyId: item.positionId, progressionRole: 'core', routeNamespace: 'other',
    partnerTrackId: item.partnerTrackId, subjectTrackId: item.subjectTrackId,
    receiverBodyOrientation: item.receiverBodyOrientation, receiverSupport: item.receiverSupport,
    positionConfigurationConfidence: item.positionConfigurationConfidence,
    startTime: item.startTime, endTime: item.endTime,
    sourceRanges: [{ id, startTime: item.startTime, endTime: item.endTime }],
    movements: [{ ...item, id, sourcePositionId: id,
      loopStartTime: item.startTime, loopEndTime: item.endTime }] };
};

test('anonymous report retains its original source timing and observed counts', () => {
  assert.deepEqual(fixture.baseline, { actionCount: 35, positionCount: 8,
    movementCount: 21, movementChoiceCount: 21 });
  assert.equal(fixture.actions.length, 35);
  assert.equal(fixture.duration, 884.782993);
  assert.ok(fixture.actions.every(item => !('femaleProgressRate' in item) &&
    !('maleProgressRate' in item)));
});

test('continuous verified motion remains on its position surface across a camera cut', () => {
  for (const id of ['tl-010', 'tl-011', 'tl-012']) {
    const item = action(id);
    assert.equal(playableAdultPanelFamily(item), 'oral', id);
    assert.equal(choiceSurfaceForAction(item, { panelFamily: playableAdultPanelFamily(item) }), 'panel', id);
    assert.equal(movementBelongsToVerifiedPosition({ ...item, choiceSurface: 'panel' }, 'oral'), true, id);
  }
  assert.equal(choiceSurfaceForAction({ ...action('tl-011'), positionId: '',
    movementType: '', movementTempo: 'unclear' }, { panelFamily: '' }), 'story');
  assert.equal(choiceSurfaceForAction(action('tl-001'), { panelFamily: '' }), 'story');
});

test('same verified configuration across a short cut uses one tab and exact separate ranges', () => {
  const groups = consolidateVerifiedPositions([position('tl-020'), position('tl-021')]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sourceRanges.map(range => [range.startTime, range.endTime]),
    [[410.134, 437.783], [442.391, 488.474]]);
  assert.equal(groups[0].movements.length, 2);
});

test('a different pose or a long analysis gap does not become one position', () => {
  assert.equal(consolidateVerifiedPositions([position('tl-020'), position('tl-026')]).length, 2);
  assert.equal(consolidateVerifiedPositions([position('tl-021'), position('tl-023')]).length, 2);
  assert.equal(consolidateVerifiedPositions([position('tl-020'), {
    ...position('tl-021'), receiverSupport: 'seated' }]).length, 2);
  assert.equal(consolidateVerifiedPositions([{ ...position('tl-020'),
    beforeState: { clothing: 'stage-a' } }, { ...position('tl-021'),
    beforeState: { clothing: 'stage-b' } }]).length, 2);
});

test('separate observed actions retain their own cards despite matching motion types', () => {
  const entries = ['tl-023', 'tl-024', 'tl-025'].map(position);
  const group = consolidateVerifiedPositions(entries)[0];
  const cards = buildVerifiedMovementChoices(group.movements, 'Source position', 5, group);
  assert.deepEqual(cards.map(card => card.variants.map(item => item.id)),
    [['tl-023'], ['tl-024'], ['tl-025']]);
});

test('one long action uses only independently verified source subsequences', () => {
  const base = { ...action('tl-021'), id: 'long', loopStartTime: 442.391,
    loopEndTime: 488.474, startTime: 442.391, endTime: 488.474 };
  assert.equal(expandVerifiedMovementVariants([base], 442.391, 488.474).length, 1);
  const verifiedSubsequences = [
    { startTime: 442.391, endTime: 454, sourceVerified: true, movementTempo: 'moderate' },
    { startTime: 454, endTime: 469, sourceVerified: true, movementTempo: 'moderate' },
    { startTime: 469, endTime: 488.474, sourceVerified: true, movementTempo: 'moderate' }
  ];
  const result = expandVerifiedMovementVariants([{ ...base, verifiedSubsequences }], 442.391, 488.474);
  assert.deepEqual(result.map(item => [item.loopStartTime, item.loopEndTime]),
    verifiedSubsequences.map(item => [item.startTime, item.endTime]));
  const unverified = expandVerifiedMovementVariants([{ ...base, verifiedSubsequences: [
    { startTime: 442.391, endTime: 454, sourceVerified: false }
  ] }], 442.391, 488.474);
  assert.equal(unverified.length, 1, 'invalid subranges never manufacture playable clips');
});

test('verified slow, steady and fast motion have bounded distinct pacing without numeric input', () => {
  const base = action('tl-021');
  assert.equal(sourceMotionProgressRate({ ...base, movementTempo: 'slow' }), 0.72);
  assert.equal(sourceMotionProgressRate({ ...base, movementTempo: 'moderate' }), 1);
  assert.equal(sourceMotionProgressRate({ ...base, movementTempo: 'fast' }), 1.28);
  assert.equal(sourceMotionProgressRate({ ...base, movementTempo: 'fast' }, 1.8), 1.8);
  assert.equal(sourceMotionProgressRate({ ...base, sourceVerified: false, movementTempo: 'fast' }), 1);
});

test('source subsequences with a tempo change never share a card', () => {
  const base = { ...action('tl-021'), id: 'source', sourcePositionId: 'recorded-parent',
    loopStartTime: 442.391, loopEndTime: 488.474,
    verifiedSubsequences: [
      { startTime: 442.391, endTime: 455, sourceVerified: true, movementTempo: 'slow' },
      { startTime: 455, endTime: 469, sourceVerified: true, movementTempo: 'slow' },
      { startTime: 469, endTime: 488.474, sourceVerified: true, movementTempo: 'fast' }
    ] };
  const clips = expandVerifiedMovementVariants([base], 442.391, 488.474);
  assert.deepEqual(buildVerifiedMovementChoices(clips).map(card => card.variants.length), [2, 1]);
  assert.deepEqual(clips.map(clip => clip.femaleProgressRate), [0.72, 0.72, 1.28]);
});

test('replaying the anonymous report structure retains distinct observed cards', () => {
  const projected = fixture.positions.map(item => {
    const source = item.actionIds.map(action).concat(item.familyId === 'oral' && item.sceneIndex === 0
      ? [action('tl-010'), action('tl-011')] : []);
    const first = source[0];
    return { ...item, id: `position-${item.sceneIndex}-${item.positionIndex}`,
      subjectTrackId: first.subjectTrackId, partnerTrackId: first.partnerTrackId,
      routeNamespace: ['oral', 'manual'].includes(item.familyId) ? item.familyId : 'other',
      receiverBodyOrientation: first.receiverBodyOrientation, receiverSupport: first.receiverSupport,
      positionConfigurationConfidence: first.positionConfigurationConfidence,
      sourceRanges: source.map(entry => ({ id: `source-${entry.actionId}`,
        startTime: entry.loopStartTime, endTime: entry.loopEndTime })),
      movements: source.map(entry => ({ ...entry, id: entry.actionId,
        sourcePositionId: `source-${entry.actionId}` })) };
  });
  const groups = [...new Set(projected.map(item => item.sceneIndex))].flatMap(sceneIndex =>
    consolidateVerifiedPositions(projected.filter(item => item.sceneIndex === sceneIndex)));
  const cards = groups.flatMap(group => buildVerifiedMovementChoices(group.movements,
    group.familyId, 5, group));
  assert.equal(groups.length, 7);
  assert.equal(cards.flatMap(card => card.variants).length, 23);
  assert.equal(cards.length, 23);
});
