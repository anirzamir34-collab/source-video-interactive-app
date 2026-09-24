import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionProtagonistActions } from '../public/protagonist-ownership.js';

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
