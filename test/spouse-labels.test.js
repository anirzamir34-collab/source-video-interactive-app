import test from 'node:test';
import assert from 'node:assert/strict';
import { protagonistSpouseTracks, withSpouseLabel } from '../public/spouse-labels.js';

const story = relation => ({ characters: [{ id: 'char-1', participantTrackId: 'MAIN_MALE' }, { id: 'char-2', participantTrackId: 'PARTNER_A' }],
  relationships: [{ from: 'char-1', to: 'char-2', relation, evidenceLevel: 'fact', confidence: 0.9 }] });

test('a verified wife of the protagonist is addressed as karın in intimate choices', () => {
  const tracks = protagonistSpouseTracks(story('karısı'));
  assert.deepEqual([...tracks], ['PARTNER_A']);
  const kiss = withSpouseLabel({ partnerTrackId: 'PARTNER_A', subjectTrackId: 'MAIN_MALE', choiceSurface: 'approach',
    partnerLabel: 'Genç Kadın', primaryCharacterLabel: 'Genç Kadın' }, tracks);
  assert.equal(kiss.partnerLabel, 'Karın');
  assert.equal(kiss.primaryCharacterLabel, 'Karın');
  const talk = withSpouseLabel({ partnerTrackId: 'PARTNER_A', subjectTrackId: 'MAIN_MALE', choiceSurface: 'story' }, tracks);
  assert.equal(talk.primaryCharacterLabel, undefined, 'story wording is left to the story labels');
});

test('another man\'s wife, an ex or an unverified guess never becomes karın', () => {
  assert.equal(protagonistSpouseTracks(story('sorgulanan kişi')).size, 0);
  assert.equal(protagonistSpouseTracks(story('eski eşi')).size, 0);
  const guess = story('karısı'); guess.relationships[0].evidenceLevel = 'inference';
  assert.equal(protagonistSpouseTracks(guess).size, 0);
});
