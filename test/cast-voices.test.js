import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSameGenderSpeakers, assignCastAges, widestPitchGap, voiceFitScore, normalizeCastProfiles } from '../lib/turkish-media/cast-voices.js';
import { mapSpeakerVoices } from '../lib/turkish-media/voice-mapping.js';
import { characterAgeGroup, castProfilesFor } from '../public/voice-cast.js';

const line = (id, speakerId, start) => ({ segmentId: id, speakerId, sourceStart: start, sourceEnd: start + 2 });

test('two women heard as one voice become two voices, the lower one the mature woman', () => {
  const transcript = {
    speakers: [{ speakerId: 's1', gender: 'male', characterId: 'MAIN_MALE' }, { speakerId: 's2', gender: 'female', characterId: 'PARTNER_A' }],
    utterances: [line('a', 's2', 0), line('b', 's2', 5), line('c', 's2', 10), line('d', 's2', 15), line('e', 's2', 20), line('f', 's1', 25)],
    audioEvents: [] };
  const measured = { s2: { medianHz: 205, utteranceMedians: { a: 182, b: 178, c: 245, d: 250, e: 186 } }, s1: { medianHz: 110, utteranceMedians: {} } };
  const cast = normalizeCastProfiles([{ characterId: 'MAIN_MALE', gender: 'male', ageGroup: 'mature' },
    { characterId: 'PARTNER_A', gender: 'female', ageGroup: 'mature' }, { characterId: 'PARTNER_B', gender: 'female', ageGroup: 'young' },
    { characterId: 'OTHER_MALE', gender: 'male', ageGroup: 'young' }]);
  splitSameGenderSpeakers(transcript, measured, cast);
  assignCastAges(transcript, measured, cast);
  const women = transcript.speakers.filter(row => row.gender === 'female');
  assert.equal(women.length, 2);
  const low = women.find(row => row.speakerId.endsWith('-lo')), high = women.find(row => row.speakerId.endsWith('-hi'));
  assert.deepEqual([low.characterId, low.ageGroup, high.characterId, high.ageGroup], ['PARTNER_A', 'mature', 'PARTNER_B', 'young']);
  assert.deepEqual(transcript.utterances.filter(row => row.speakerId === high.speakerId).map(row => row.segmentId), ['c', 'd']);
  assert.equal(transcript.speakers.length, 3, 'the silent young man gets no invented voice');
});

test('one woman whose lines only vary a little is never split', () => {
  assert.equal(widestPitchGap({ a: 200, b: 210, c: 218, d: 225, e: 232 }), null);
});

test('mature and older voices prefer mature catalogue voices and avoid girlish ones', () => {
  const girl = { voice_id: 'g', labels: { gender: 'female', age: 'young', description: 'bright' } };
  const woman = { voice_id: 'w', labels: { gender: 'female', age: 'middle_aged', description: 'warm husky' } };
  const speaker = { speakerId: 's', gender: 'female', ageGroup: 'mature', pitchHz: 180 };
  assert.ok(voiceFitScore(woman, speaker) > voiceFitScore(girl, speaker));
  assert.equal(mapSpeakerVoices([speaker], [girl, woman])['s'], 'w');
  assert.equal(mapSpeakerVoices([speaker], [girl, woman], { s: 'g' })['s'], 'w', 'an earlier unfitting pick is redone');
  const light = { speakerId: 'l', gender: 'female', ageGroup: 'young', pitchHz: 250 };
  assert.equal(mapSpeakerVoices([light], [girl, woman])['l'], 'g');
});

test('the visible description decides the voice age when the analysis gives none', () => {
  assert.equal(characterAgeGroup({ displayName: 'Olgun erkek' }), 'mature');
  assert.equal(characterAgeGroup({ displayName: 'Siyah saçlı genç kadın' }), 'young');
  assert.equal(characterAgeGroup({ displayName: 'Yaşlı adam' }), 'senior');
  assert.equal(characterAgeGroup({ ageGroup: 'senior', displayName: 'Genç' }), 'senior');
  const analysis = { storyContext: { characters: [{ id: 'char-olga', gender: 'female', evidenceLevel: 'fact', displayName: 'Olya' },
    { id: 'x', gender: 'uncertain', evidenceLevel: 'fact' }] } };
  assert.deepEqual(castProfilesFor(analysis), [{ characterId: 'char-olga', gender: 'female' }]);
});

test('more people than catalogue voices share a fitting voice instead of stopping the dub', () => {
  const catalog = [
    { voice_id: 'f1', labels: { gender: 'female', age: 'young' } },
    { voice_id: 'f2', labels: { gender: 'female', age: 'middle_aged' } },
    { voice_id: 'm1', labels: { gender: 'male', age: 'middle_aged' } },
  ];
  const speakers = [
    { speakerId: 'a', gender: 'female', ageGroup: 'mature' }, { speakerId: 'b', gender: 'female', ageGroup: 'young' },
    { speakerId: 'c', gender: 'female', ageGroup: 'young' }, { speakerId: 'd', gender: 'male' }, { speakerId: 'e', gender: 'male' },
  ];
  const result = mapSpeakerVoices(speakers, catalog);
  assert.deepEqual(Object.keys(result).sort(), ['a', 'b', 'c', 'd', 'e']);
  for (const id of ['a', 'b', 'c']) assert.ok(['f1', 'f2'].includes(result[id]), 'women keep female voices');
  assert.equal(result.d, 'm1'); assert.equal(result.e, 'm1');
  assert.notEqual(result.a, result.b, 'distinct voices while the catalogue has them');
});
