import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUnownedIntervals, partitionProtagonistActions } from '../public/protagonist-ownership.js';

test('a contradictory protagonist label cannot override a separately tracked person in the same observation', () => {
  const context = { characters: [
    { id: 'char-001', participantTrackId: 'MAIN_MALE' },
    { id: 'char-003', participantTrackId: 'OTHER_MALE' },
    { id: 'char-004', participantTrackId: 'GUEST' }
  ] };
  const actions = [
    { actionId: 'main', subjectTrackId: 'MAIN_MALE', involvedCharacterIds: ['char-001', 'char-004'] },
    { actionId: 'uncertain', subjectTrackId: 'MAIN_MALE', involvedCharacterIds: ['char-001', 'char-003'] },
    { actionId: 'other', subjectTrackId: 'OTHER_MALE', involvedCharacterIds: ['char-003'] }
  ];
  const result = partitionProtagonistActions(actions, context);
  assert.deepEqual(result.playable.map(action => action.actionId), ['main']);
  assert.deepEqual(result.excluded.map(action => action.actionId), ['uncertain', 'other']);
});

test('explicit second-person tracks remain excluded even when the character registry omits them', () => {
  const { playable, excluded } = partitionProtagonistActions([
    { actionId: 'other', subjectTrackId: 'MAIN_MALE', participantTrackIds: ['MAIN_MALE', 'OTHER_MALE'] },
    { actionId: 'other-partner', subjectTrackId: 'MAIN_MALE', partnerTrackId: 'OTHER_MALE' },
    { actionId: 'main', subjectTrackId: 'MAIN_MALE', participantTrackIds: ['MAIN_MALE', 'GUEST'] }
  ]);
  assert.deepEqual(playable.map(action => action.actionId), ['main']);
  assert.deepEqual(excluded.map(action => action.actionId), ['other', 'other-partner']);
});

test('overlapping excluded source intervals form a single watchable chapter', () => {
  assert.deepEqual(mergeUnownedIntervals([
    { startTime: 12, endTime: 24 }, { startTime: 10, endTime: 20 },
    { startTime: 40, endTime: 48 }
  ]), [{ startTime: 10, endTime: 24 }, { startTime: 40, endTime: 48 }]);
});
