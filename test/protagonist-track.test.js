import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureProtagonistTrack } from '../lib/protagonist-track.js';

const act = (subjectTrackId, partnerTrackId, startTime, endTime) =>
  ({ subjectTrackId, partnerTrackId, involvedCharacterIds: [subjectTrackId, partnerTrackId], startTime, endTime });

test('a chapter that never names MAIN_MALE gets its most active man as MAIN_MALE', () => {
  const parsed = { actions: [act('man-orange-vest', 'woman-red', 0, 40), act('man-blue', 'woman-white', 40, 50)],
    storyContext: { characters: [{ id: 'man-orange-vest', participantTrackId: 'man-orange-vest', gender: 'male' },
      { id: 'man-blue', participantTrackId: 'man-blue', gender: 'male' }], relationships: [] } };
  const { parsed: next, inferred } = ensureProtagonistTrack(parsed);
  assert.equal(inferred, 'man-orange-vest');
  assert.equal(next.actions[0].subjectTrackId, 'MAIN_MALE');
  assert.deepEqual(next.actions[0].involvedCharacterIds, ['MAIN_MALE', 'woman-red']);
  // The other man keeps his own id, so his actions stay "another man's".
  assert.equal(next.actions[1].subjectTrackId, 'man-blue');
  assert.equal(next.storyContext.characters[0].participantTrackId, 'MAIN_MALE');
});

test('a chapter that already uses MAIN_MALE is left untouched', () => {
  const parsed = { actions: [act('MAIN_MALE', 'PARTNER_A', 0, 10), act('man-x', 'PARTNER_B', 10, 60)] };
  assert.equal(ensureProtagonistTrack(parsed).inferred, null);
  assert.equal(ensureProtagonistTrack(parsed).parsed, parsed);
});

test('no male actor means no guess', () => {
  const parsed = { actions: [act('woman-a', 'woman-b', 0, 10)], storyContext: { characters: [{ id: 'woman-a', gender: 'female' }] } };
  assert.equal(ensureProtagonistTrack(parsed).inferred, null);
});

test('track ids and gender words never become names or label text', async () => {
  const { verifiedCharacterName, stripTrackTokens, bindActionCharacter } = await import('../public/character-identity.js');
  const fact = displayName => ({ displayName, evidenceLevel: 'fact', confidence: 1, evidence: 'görüldü' });
  for (const name of ['FEMALE_1', 'MALE_2', 'OTHER_MALE', 'PARTNER_B', 'female', 'participant-001']) assert.equal(verifiedCharacterName(fact(name)), '');
  assert.equal(verifiedCharacterName(fact('Ayşe')), 'Ayşe');
  assert.equal(stripTrackTokens("PARTNER_A'nın oral seks yapmasına izin ver"), 'Oral seks yapmasına izin ver');
  const context = { characters: [{ id: 'FEMALE_1', participantTrackId: 'FEMALE_1', displayName: 'FEMALE_1', gender: 'female', evidenceLevel: 'fact', confidence: 1, evidence: 'x' },
    { id: 'MAIN_MALE', participantTrackId: 'MAIN_MALE', displayName: 'MAIN_MALE', gender: 'male', evidenceLevel: 'fact', confidence: 1, evidence: 'x' }] };
  const bound = bindActionCharacter({ label: "FEMALE_1'in üstüne çıkmasına izin ver", subjectTrackId: 'MAIN_MALE', partnerTrackId: 'FEMALE_1',
    involvedCharacterIds: ['MAIN_MALE', 'FEMALE_1'], actionType: 'position', adultScene: true }, context);
  assert.equal(bound.partnerLabel, 'Kadın 1');
  assert.equal(bound.label, 'Üstüne çıkmasına izin ver');
});
