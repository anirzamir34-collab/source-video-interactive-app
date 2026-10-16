import test from 'node:test';
import assert from 'node:assert/strict';
import { bindActionCharacter, mergeCharacterRecords } from '../public/character-identity.js';
import { storyChoiceLabelForAction } from '../public/story-engine.js';

const character = (id, participantTrackId, displayName, confidence = 0.92) => ({
  id, participantTrackId, displayName, evidenceLevel: 'fact', confidence,
  evidence: 'Kaynak diyalogda bu karakterin rolü doğrulanıyor.'
});
const family = {
  characters: [
    character('STEP_PARENT', 'MAIN_MALE', 'Üvey baba'),
    character('STEP_CHILD', 'PARTNER_A', 'Üvey kız'),
    character('VISITOR', 'PARTNER_B', 'Meral')
  ],
  relationships: [{
    from: 'STEP_PARENT', to: 'STEP_CHILD', relation: 'üvey kızı',
    evidenceLevel: 'fact', confidence: .96, evidence: 'Kaynak diyalogdaki aile bağı.'
  }]
};

test('adult scene retains exact FACT source identity metadata without sexualizing kinship in choices', () => {
  const source = {
    actionId: 'scene-211', label: 'Kesiti oynat', narrativeChoiceLabel: '',
    primaryCharacterId: 'STEP_PARENT', subjectTrackId: 'STEP_PARENT',
    partnerTrackId: 'STEP_CHILD', involvedCharacterIds: ['STEP_PARENT', 'STEP_CHILD'],
    adultScene: true, startTime: 211.158, endTime: 219.0, sourceVerified: true
  };
  const bound = bindActionCharacter(source, family);
  assert.equal(bound.primaryCharacterId, 'PARTNER_A');
  assert.equal(bound.primaryCharacterDisplayNameFact, 'Üvey kız');
  assert.equal(bound.partnerDisplayNameFact, 'Üvey kız');
  assert.equal(bound.subjectDisplayNameFact, 'Üvey baba');
  assert.equal(bound.relationshipRoleLabel, '');
  assert.equal(storyChoiceLabelForAction(bound), 'Kesiti oynat');
  assert.equal(family.characters[1].displayName, 'Üvey kız');
  assert.deepEqual([bound.actionId, bound.startTime, bound.endTime, bound.sourceVerified],
    ['scene-211', 211.158, 219.0, true]);
});

test('rebind never carries factual labels to a different person or conflicting track', () => {
  const source = {
    label: 'Kesiti oynat', adultScene: true,
    subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'PARTNER_A',
    partnerTrackId: 'PARTNER_A', involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A']
  };
  const first = bindActionCharacter(source, family);
  assert.equal(first.primaryCharacterDisplayNameFact, 'Üvey kız');
  const next = bindActionCharacter({
    ...first, primaryCharacterId: 'PARTNER_B', partnerTrackId: 'PARTNER_B',
    involvedCharacterIds: ['MAIN_MALE', 'PARTNER_B']
  }, family);
  assert.equal(next.primaryCharacterDisplayNameFact, 'Meral');
  assert.equal(next.partnerDisplayNameFact, 'Meral');
  assert.equal(next.subjectDisplayNameFact, 'Üvey baba');
  const mismatch = bindActionCharacter({
    ...first, primaryCharacterId: 'PARTNER_A', partnerTrackId: 'PARTNER_B',
    involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A', 'PARTNER_B']
  }, family);
  assert.equal(mismatch.primaryCharacterDisplayNameFact, '');
  assert.equal(mismatch.partnerDisplayNameFact, '');
  assert.equal(mismatch.subjectDisplayNameFact, '');
  assert.equal(mismatch.identityResolution, 'conflict');
});

test('evidenced kinship display name is not overwritten by a later provider placeholder', () => {
  const old = character('CHILD', 'PARTNER_A', 'Üvey kız', .88);
  const newer = character('CHILD_ALT', 'PARTNER_A', 'Karakter A', .99);
  const merged = mergeCharacterRecords([old, newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].displayName, 'Üvey kız');
  assert.equal(merged[0].identityConflict, undefined);
  assert.ok(merged[0].characterIds.includes('CHILD_ALT'));
});

test('unknown or conflicted source identities cannot claim FACT display names', () => {
  const source = {
    label: 'Kesiti oynat', adultScene: true, subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'PARTNER_A', partnerTrackId: 'PARTNER_A',
    involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A']
  };
  for (const changed of [
    { evidenceLevel: 'inference' },
    { confidence: 0.2 },
    { evidence: '' },
    { identityConflict: true }
  ]) {
    const context = { ...family, characters: family.characters.map((item,i) => i===1 ? {...item,...changed} : item) };
    assert.equal(bindActionCharacter(source,context).primaryCharacterDisplayNameFact,'');
  }
});
