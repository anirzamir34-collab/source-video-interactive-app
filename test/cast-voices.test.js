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

test('a voice left open gets its gender from pitch or the cast instead of asking', async () => {
  const { resolveOpenGenders } = await import('../lib/turkish-media/cast-voices.js');
  const transcript = { speakers: [{ speakerId: 'a', gender: null }, { speakerId: 'b', gender: null }, { speakerId: 'c', gender: 'male' }],
    utterances: [{ speakerId: 'a' }, { speakerId: 'b' }] };
  resolveOpenGenders(transcript, { a: { medianHz: 120 } }, [{ characterId: 'x', gender: 'female' }, { characterId: 'y', gender: 'female' }, { characterId: 'z', gender: 'male' }]);
  assert.deepEqual(transcript.speakers.map(row => row.gender), ['male', 'female', 'male']);
  assert.deepEqual(transcript.utterances.map(row => row.gender), ['male', 'female']);
  const unknown = { speakers: [{ speakerId: 'q', gender: null }], utterances: [] };
  resolveOpenGenders(unknown, {}, []);
  assert.ok(['male', 'female'].includes(unknown.speakers[0].gender), 'even with nothing known the dub does not stop');
  const tie = { speakers: [{ speakerId: 'w1', gender: 'female' }, { speakerId: 'w2', gender: 'female' }, { speakerId: 'm1', gender: 'male' }, { speakerId: 'q', gender: null }], utterances: [] };
  resolveOpenGenders(tie, {}, [{ characterId: 'a', gender: 'male' }, { characterId: 'b', gender: 'female' }]);
  assert.equal(tie.speakers[3].gender, 'male', 'a tie takes the gender with fewer found voices');
});

test('a man\'s line inside a woman\'s voice moves to a male voice; a raised male voice stays', async () => {
  const { correctUtteranceGenders } = await import('../lib/turkish-media/cast-voices.js');
  const transcript = {
    speakers: [{ speakerId: 'w', gender: 'female' }, { speakerId: 'm', gender: 'male' }],
    utterances: [{ segmentId: 'a', speakerId: 'w' }, { segmentId: 'b', speakerId: 'w' }, { segmentId: 'c', speakerId: 'm' }] };
  const measured = { w: { medianHz: 220, utteranceMedians: { a: 225, b: 118 } }, m: { medianHz: 115, utteranceMedians: { c: 190 } } };
  assert.deepEqual(correctUtteranceGenders(transcript, measured), ['b']);
  assert.deepEqual(transcript.utterances.map(row => row.speakerId), ['w', 'm', 'm']);
  const alone = { speakers: [{ speakerId: 'w', gender: 'female' }], utterances: [{ segmentId: 'x', speakerId: 'w' }] };
  correctUtteranceGenders(alone, { w: { utteranceMedians: { x: 110 } } });
  assert.equal(alone.utterances[0].speakerId, 'w-m');
  assert.equal(alone.speakers.find(row => row.speakerId === 'w-m').gender, 'male');
});

test('Turkish voices added later replace an earlier non-Turkish automatic pick', () => {
  const english = { voice_id: 'en1', labels: { gender: 'female', language: 'en' } };
  const turkish = { voice_id: 'tr1', labels: { gender: 'female', language: 'tr' } };
  const speaker = { speakerId: 's', gender: 'female' };
  assert.equal(mapSpeakerVoices([speaker], [english, turkish], { s: 'en1' })['s'], 'tr1');
  assert.equal(mapSpeakerVoices([speaker], [english, turkish], {}, { s: 'en1' })['s'], 'en1', 'a manual choice stays');
});

test('the library helper adds the most used Turkish voices the account lacks and stops at the voice limit', async () => {
  const { createElevenLabsProvider } = await import('../lib/turkish-media/elevenlabs.js');
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push([options.method || 'GET', new URL(url).pathname + new URL(url).search]);
    if (url.includes('/v2/voices')) return { voices: [{ voice_id: 'have', name: 'TR Ayşe', labels: { language: 'tr', gender: 'female', age: 'young' } }], has_more: false };
    if (url.includes('/v1/shared-voices')) {
      const q = new URL(url).searchParams;
      return { voices: [{ voice_id: `${q.get('gender')}-${q.get('age')}`, public_owner_id: 'owner', name: `${q.get('gender')} ${q.get('age')}` }] };
    }
    if (url.includes('male-middle_aged') && !url.includes('female')) throw new Error('voice_limit_reached: maximum number of voices');
    return { voice_id: 'new' };
  };
  const provider = createElevenLabsProvider({ config: { elevenLabs: { apiKey: 'k' }, requestTimeoutMs: 1000, maxRetries: 0 }, request });
  const result = await provider.addTurkishLibraryVoices();
  assert.deepEqual(result.skipped.map(row => `${row.gender}-${row.age}`), ['female-young']);
  assert.deepEqual(result.added.map(row => `${row.gender}-${row.age}`), ['male-young', 'female-middle_aged']);
  assert.equal(result.failed.length, 1, 'stops after the voice limit');
  assert.ok(calls.some(([method, path]) => method === 'GET' && path.includes('language=tr') && path.includes('sort=usage_character_count_1y')));
});
