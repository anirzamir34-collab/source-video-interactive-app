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

test('verified main-character conversation stays playable with another male on screen', () => {
  const context = { characters: [
    { id: 'hero', participantTrackId: 'MAIN_MALE' },
    { id: 'guest', participantTrackId: 'OTHER_MALE' },
    { id: 'friend', participantTrackId: 'FRIEND' }
  ] };
  const actions = [
    { actionId: 'greeting', sourceVerified: true, subjectTrackId: 'hero',
      actionType: 'dialogue', choiceSurface: 'story',
      participantTrackIds: ['hero', 'guest', 'friend'] },
    { actionId: 'question', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'story', involvedCharacterIds: ['hero', 'guest'] },
    { actionId: 'other-replies', sourceVerified: true, subjectTrackId: 'guest',
      actionType: 'dialogue', involvedCharacterIds: ['hero', 'guest'] }
  ];
  const result = partitionProtagonistActions(actions, context);
  assert.deepEqual(result.playable.map(item => item.actionId), ['greeting', 'question']);
  assert.deepEqual(result.excluded.map(item => item.actionId), ['other-replies']);
});

test('unknown protagonist or intimate source keeps the existing ownership barrier', () => {
  const cast = ['MAIN_MALE', 'OTHER_MALE'];
  const actions = [
    { actionId: 'no-actor', sourceVerified: true, actionType: 'dialogue',
      involvedCharacterIds: cast },
    { actionId: 'unverified', sourceVerified: false, subjectTrackId: 'MAIN_MALE',
      actionType: 'dialogue', involvedCharacterIds: cast },
    { actionId: 'intimate', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'story', adultScene: true, involvedCharacterIds: cast },
    { actionId: 'position', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'position', positionId: 'scene-position', involvedCharacterIds: cast },
    { actionId: 'explicit', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'dialogue', activityType: 'anal', involvedCharacterIds: cast },
    { actionId: 'outcome', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'story', outcomeType: 'climax', involvedCharacterIds: cast },
    { actionId: 'verified-story', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'dialogue', involvedCharacterIds: cast }
  ];
  const result = partitionProtagonistActions(actions);
  assert.deepEqual(result.playable.map(item => item.actionId), ['verified-story']);
  assert.deepEqual(result.excluded.map(item => item.actionId),
    ['no-actor', 'unverified', 'intimate', 'position', 'explicit', 'outcome']);
});

test('ordinary choice with no other male is unaffected even with sparse metadata', () => {
  const actions = [
    { actionId: 'legacy', subjectTrackId: 'MAIN_MALE', actionType: 'other' },
    { actionId: 'modern', sourceVerified: true, subjectTrackId: 'MAIN_MALE',
      actionType: 'dialogue', involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A'] }
  ];
  const result = partitionProtagonistActions(actions);
  assert.deepEqual(result.playable.map(item => item.actionId), ['legacy', 'modern']);
  assert.deepEqual(result.excluded, []);
});
