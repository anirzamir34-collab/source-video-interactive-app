import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFamilyOrSpouseContext, isSpouseRelationshipRole } from '../public/relationship-roles.js';
import { bindActionCharacter } from '../public/character-identity.js';
import { storyChoiceLabelForAction } from '../public/story-engine.js';

const person = (id, track, name) => ({
  id, participantTrackId: track, displayName: name,
  evidenceLevel: 'fact', confidence: 0.96,
  evidence: `Diyalogda adı ${name} olarak geçiyor.`
});
const relationship = (from, to, relation, confidence = 0.95) => ({
  from, to, relation, confidence, evidenceLevel: 'fact',
  evidence: 'Kaynağın eşzamanlı konuşmasında iki kişinin ilişkisi doğrulandı.'
});
const family = {
  characters: [
    person('ADAM', 'MAIN_MALE', 'Mert'),
    person('ES', 'PARTNER_A', 'Meral'),
    person('COCUK', 'PARTNER_B', 'Deniz')
  ],
  relationships: [
    relationship('ADAM', 'ES', 'karısı'),
    relationship('ADAM', 'COCUK', 'kızı'),
    relationship('ES', 'COCUK', 'kızı')
  ]
};

test('family context cues are conditional and do not match unrelated generic words', () => {
  assert.equal(hasFamilyOrSpouseContext('Kızıl saçlı birisi geldi.', '{}'), false);
  assert.equal(hasFamilyOrSpouseContext('Bir kız kapıyı açtı.', '{}'), false);
  assert.equal(hasFamilyOrSpouseContext('Sıradan bir konuşma yapıldı.', '{}'), false);
  for (const term of ['Baba', 'ANNESİ', 'kızı', 'oğlu', 'üvey', 'teyze', 'amca', 'eşi', 'karısı', 'kocası', 'eşler']) {
    assert.equal(hasFamilyOrSpouseContext(`Konuşmada ${term} dendi.`, '{}'), true, term);
  }
  assert.equal(hasFamilyOrSpouseContext('Merhaba', '{"relationships":[{"relation":"eşi"}]}'), true);
  assert.equal(isSpouseRelationshipRole('wife'), true);
  assert.equal(isSpouseRelationshipRole('daughter'), false);
});

test('FACT spouse pair is preserved in adult labels without borrowing the daughter role', () => {
  const source = {
    label: 'Onunla yakınlaş', narrativeChoiceLabel: 'Onunla yakınlaş',
    subjectTrackId: 'MAIN_MALE', primaryCharacterId: 'MAIN_MALE',
    partnerTrackId: 'PARTNER_A',
    involvedCharacterIds: ['ADAM', 'ES'],
    adultScene: true, actionId: 'action-1',
    startTime: 31, endTime: 36, sourceVerified: true
  };
  const spouse = bindActionCharacter(source, family);
  assert.equal(spouse.primaryCharacterId, 'PARTNER_A');
  assert.equal(spouse.primaryCharacterLabel, 'Meral');
  assert.equal(spouse.relationshipRoleLabel, 'karısı');
  assert.equal(spouse.label, 'Karısıyla yakınlaş');
  assert.equal(spouse.narrativeChoiceLabel, 'Karısıyla yakınlaş');
  assert.equal(storyChoiceLabelForAction(spouse), 'Karısıyla yakınlaş');
  assert.deepEqual([spouse.actionId, spouse.startTime, spouse.endTime, spouse.sourceVerified],
    ['action-1', 31, 36, true]);

  const child = bindActionCharacter({
    ...source, label: 'Kesiti oynat', narrativeChoiceLabel: '',
    primaryCharacterId: 'COCUK', partnerTrackId: 'PARTNER_B',
    involvedCharacterIds: ['ADAM', 'COCUK']
  }, family);
  assert.equal(child.relationshipRoleLabel, '');
  assert.equal(child.relationshipResolution, 'unknown');
  assert.equal(storyChoiceLabelForAction(child), 'Kesiti oynat · Deniz');

  const ordinary = bindActionCharacter({
    label: 'Onunla konuş', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'COCUK', involvedCharacterIds: ['ADAM', 'COCUK'],
    adultScene: false
  }, family);
  assert.equal(ordinary.label, 'Kızıyla konuş');
});

test('equivalent spouse facts do not create a false conflict, but contradictory kinship facts do', () => {
  const source = {
    label: 'Onunla yakınlaş', subjectTrackId: 'MAIN_MALE',
    primaryCharacterId: 'ES', partnerTrackId: 'PARTNER_A',
    involvedCharacterIds: ['ADAM', 'ES'], adultScene: true
  };
  const aliases = { ...family, relationships: [
    relationship('ADAM', 'ES', 'eşi', 0.91),
    relationship('MAIN_MALE', 'PARTNER_A', 'karısı', 0.97)
  ] };
  assert.equal(bindActionCharacter(source, aliases).label, 'Karısıyla yakınlaş');

  const conflict = { ...aliases, relationships: [
    ...aliases.relationships, relationship('ES', 'ADAM', 'kardeşi', 0.98)
  ] };
  const neutral = bindActionCharacter(source, conflict);
  assert.equal(neutral.relationshipResolution, 'unknown');
  assert.equal(neutral.relationshipRoleLabel, '');
  assert.ok(neutral.label.includes('yakınlaş'));
  assert.doesNotMatch(storyChoiceLabelForAction(neutral), /karısı|kardeşi/i);
});
