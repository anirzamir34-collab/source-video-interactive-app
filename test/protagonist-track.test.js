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
  assert.equal(bound.partnerLabel, 'Kadın', 'a single unnamed woman is simply Kadın');
  assert.equal(bound.label, 'Üstüne çıkmasına izin ver');
});

test('a label that narrates the protagonist and asks to watch becomes his own move', async () => {
  const { protagonistFirstPerson, bindActionCharacter } = await import('../public/character-identity.js');
  assert.equal(protagonistFirstPerson('Erkeğin odaya girişini ve kadınla konuşmasını izle'), 'Odaya gir ve kadınla konuş');
  assert.equal(protagonistFirstPerson('Kadının dansını izle'), 'Kadının dansını izle');
  const bound = bindActionCharacter({ label: 'Erkeğin odaya girişini izle', subjectTrackId: 'MAIN_MALE' }, { characters: [] });
  assert.equal(bound.label, 'Odaya gir');
  const other = bindActionCharacter({ label: 'Adamın şarkı söylemesini izle', subjectTrackId: 'OTHER_MALE' }, { characters: [] });
  assert.equal(other.label, 'Adamın şarkı söylemesini izle', 'watching another man stays as it is');
});

test('a couple sex action with an empty subject belongs to the protagonist', async () => {
  const { protagonistPerspective } = await import('../public/protagonist-ownership.js');
  const action = { adultScene: true, choiceSurface: 'panel', subjectTrackId: '', partnerTrackId: 'PARTNER_A', involvedCharacterIds: [] };
  assert.equal(protagonistPerspective(action, { characters: [{ id: 'PARTNER_A', gender: 'female' }] }).subjectTrackId, 'MAIN_MALE');
  assert.equal(protagonistPerspective({ ...action, groupScene: true }, {}).subjectTrackId, '', 'a group never guesses');
  assert.equal(protagonistPerspective({ ...action, involvedCharacterIds: ['OTHER_MALE', 'PARTNER_A'] }, {}).subjectTrackId, '');
});

test('a thrusting body change inside a running position is a movement, not a story card', async () => {
  const { inPositionApproachAsMovement } = await import('../public/protagonist-ownership.js');
  const action = { choiceSurface: 'story', adultScene: true, actionType: 'body_transition', positionId: 'prone-bone',
    positionConfigurationConfidence: 0.98, positionEvidence: 'Kadın yüzükoyun, erkek üzerine eğilmiş.', movementType: 'thrusting' };
  assert.equal(inPositionApproachAsMovement(action).choiceSurface, 'panel');
  assert.equal(inPositionApproachAsMovement({ ...action, movementType: 'pozisyon değiştirme', positionId: '' }).choiceSurface, 'story');
});

test('on her back, the legs decide between legs-up and missionary', async () => {
  const { inPositionApproachAsMovement } = await import('../public/protagonist-ownership.js');
  const base = { choiceSurface: 'panel', adultScene: true, receiverBodyOrientation: 'on_back', positionConfigurationConfidence: 0.9 };
  assert.equal(inPositionApproachAsMovement({ ...base, positionId: 'missionary', receiverLegs: 'raised_on_shoulders' }).positionId, 'legs-up');
  assert.equal(inPositionApproachAsMovement({ ...base, positionId: 'legs-up', receiverLegs: 'spread' }).positionId, 'missionary');
  assert.equal(inPositionApproachAsMovement({ ...base, positionId: 'legs-up', receiverLegs: 'unclear' }).positionId, 'legs-up');
});

test('every canonical position has a fixed description from his point of view', async () => {
  const { positionBrief } = await import('../public/position-brief.js');
  assert.equal(positionBrief({ familyId: 'rear' }), 'Elleri ve dizleri üzerinde; sen arkasındasın.');
  assert.equal(positionBrief({ familyId: 'oral', movements: [{ oralGiver: 'main_male' }] }), 'Ona oral yapıyorsun.');
  assert.match(positionBrief({ familyId: 'prone-bone', routeNamespace: 'anal' }), /Anal\.$/);
});

test('a 69 filed as missionary becomes mutual oral named 69', async () => {
  const { sixtyNine, protagonistPerspective } = await import('../public/protagonist-ownership.js');
  const { positionBrief } = await import('../public/position-brief.js');
  const fixed = sixtyNine({ positionId: 'missionary', positionLabel: 'Misyoner Pozisyonu', label: '69 pozisyonunda devam et', choiceSurface: 'panel' });
  assert.deepEqual([fixed.positionId, fixed.positionLabel, fixed.oralGiver], ['oral', '69 Pozisyonu', 'mutual']);
  assert.equal(sixtyNine({ positionId: 'missionary', positionEvidence: 'Karşılıklı oral, baş ayak ters' }).oralGiver, 'mutual');
  assert.equal(sixtyNine({ positionId: 'missionary', label: '1690 saniyede devam et' }).positionId, 'missionary', 'a number inside another is not 69');
  assert.equal(protagonistPerspective({ subjectTrackId: 'MAIN_MALE', positionId: 'cowgirl', oralGiver: 'mutual' }).positionId, 'oral');
  assert.equal(positionBrief({ positionId: 'oral', oralGiver: 'mutual' }), '69: aynı anda birbirinize oral yapıyorsunuz.');
});

test('a male partner acting on the protagonist is part of his scene (gay scenes)', async () => {
  const { partitionProtagonistActions, protagonistPerspective } = await import('../public/protagonist-ownership.js');
  const characters = [{ id: 'MAIN_MALE', participantTrackId: 'MAIN_MALE', gender: 'male' },
    { id: 'PARTNER_A', participantTrackId: 'PARTNER_A', gender: 'male' }];
  const oral = { actionId: 'x', subjectTrackId: 'PARTNER_A', partnerTrackId: 'MAIN_MALE', involvedCharacterIds: ['MAIN_MALE', 'PARTNER_A'],
    adultScene: true, choiceSurface: 'panel', positionId: 'oral', sourceVerified: true, startTime: 0, endTime: 10 };
  assert.equal(partitionProtagonistActions([oral], { characters }).playable.length, 1);
  const owned = protagonistPerspective(oral, { characters });
  assert.deepEqual([owned.subjectTrackId, owned.partnerTrackId], ['MAIN_MALE', 'PARTNER_A']);
});

test('single-gender casts dub every voice in that gender; femboy is named', async () => {
  const { assignSingleGenderCast } = await import('../lib/turkish-media/cast-voices.js');
  const { stableCharacterName } = await import('../public/character-identity.js');
  const transcript = { speakers: [{ speakerId: 'a', gender: 'female' }, { speakerId: 'b', gender: 'male' }], utterances: [{ speakerId: 'a' }] };
  assert.equal(assignSingleGenderCast(transcript, [{ gender: 'male' }, { gender: 'male', genderIdentity: 'femboy' }]), true);
  assert.deepEqual(transcript.speakers.map(row => row.gender), ['male', 'male']);
  assert.equal(assignSingleGenderCast(transcript, [{ gender: 'male' }, { gender: 'female' }]), false);
  assert.equal(stableCharacterName({ id: 'f', gender: 'male', genderIdentity: 'femboy', ageGroup: 'young' }, []), 'Genç femboy');
});
