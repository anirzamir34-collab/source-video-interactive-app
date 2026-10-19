import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyPitchSamples, fundamentalFrequency, inferSpeakerProfiles } from '../lib/turkish-media/speaker-profile.js';

test('source pitch windows distinguish stable low and high voices without guessing the overlap', () => {
  const tone = frequency => Float32Array.from({ length: 2048 }, (_, i) =>
    .28 * Math.sin(2 * Math.PI * frequency * i / 12000));
  const low = fundamentalFrequency(tone(110));
  const high = fundamentalFrequency(tone(215));
  assert.ok(Math.abs(low - 110) < 4);
  assert.ok(Math.abs(high - 215) < 4);
  // Regression: the previous period-picker preferred subharmonics, returning
  // 110 Hz for 220 Hz and 75 Hz for 225 Hz source speakers.
  for (const hz of [220, 225]) {
    const measured = fundamentalFrequency(tone(hz));
    assert.ok(measured !== null && Math.abs(measured - hz) < 4,
      `Expected a ${hz} Hz voice near its fundamental, received ${measured} Hz`);
  }
  assert.equal(classifyPitchSamples(Array(10).fill(low)), 'male');
  assert.equal(classifyPitchSamples(Array(10).fill(high)), 'female');
  assert.equal(classifyPitchSamples(Array(10).fill(169)), null);
  assert.equal(classifyPitchSamples([low, high, low]), null);
  assert.equal(classifyPitchSamples([low, high, low, high, low, high, low, high]), null);
});

test('a cached source WAV supplies speaker profiles without provider calls', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vq-speaker-profile-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const rate = 48000, frames = rate * 8, bytes = frames * 8;
  const wave = Buffer.alloc(44 + bytes);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(3, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 8, 28);
  wave.writeUInt16LE(8, 32); wave.writeUInt16LE(32, 34); wave.write('data', 36);
  wave.writeUInt32LE(bytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const second = frame / rate, hz = second < 4 ? 110 : 215;
    const value = .28 * Math.sin(2 * Math.PI * hz * second);
    wave.writeFloatLE(value, 44 + frame * 8);
    wave.writeFloatLE(value, 48 + frame * 8);
  }
  const file = path.join(folder, 'source.wav');
  await writeFile(file, wave);
  const transcript = {
    speakers: [{ speakerId: 'one', gender: null }, { speakerId: 'two', gender: null }],
    utterances: [
      ...[0, 1, 2].map(index => ({ speakerId: 'one', sourceStart: index + .1, sourceEnd: index + .9 })),
      ...[4, 5, 6].map(index => ({ speakerId: 'two', sourceStart: index + .1, sourceEnd: index + .9 }))
    ]
  };
  const profiles = await inferSpeakerProfiles(file, transcript);
  assert.equal(profiles.one?.gender, 'male');
  assert.equal(profiles.two?.gender, 'female');
  const singleTurn = await inferSpeakerProfiles(file, {
    speakers: [{ speakerId: 'single', gender: null }],
    utterances: [{ speakerId: 'single', sourceStart: 4.2, sourceEnd: 6.2 }]
  });
  assert.equal(singleTurn.single?.gender, 'female', 'one sustained voice supplies enough independent pitch windows');
});

test('lenient pitch decision resolves near-boundary voices the strict test leaves open', async () => {
  const { classifyPitchLenient } = await import('../lib/turkish-media/speaker-profile.js');
  assert.equal(classifyPitchLenient([140, 150, 155, 158, 210, 145, 150]), 'male');
  assert.equal(classifyPitchLenient([190, 200, 175, 180, 120, 195, 205]), 'female');
  assert.equal(classifyPitchLenient([150, 180]), null, 'too little evidence stays unresolved');
});

test('one diarization ID with both a man and a woman is split by utterance pitch', async () => {
  const { utteranceGenderSplit } = await import('../lib/turkish-media/speaker-profile.js');
  const { splitMixedGenderSpeakers } = await import('../lib/turkish-media/pipeline.js');
  const split = utteranceGenderSplit({ a: 120, b: 125, c: 210, d: 215, e: 168 });
  assert.deepEqual(split, { a: 'male', b: 'male', c: 'female', d: 'female' });
  assert.equal(utteranceGenderSplit({ a: 120, b: 125, c: 130, d: 215 }), null, 'one stray high line is not a second person');
  const transcript = {
    speakers: [{ speakerId: 's3', gender: null }, { speakerId: 's1', gender: 'female' }],
    utterances: [
      { segmentId: 'a', speakerId: 's3', sourceStart: 1 }, { segmentId: 'b', speakerId: 's3', sourceStart: 2 },
      { segmentId: 'c', speakerId: 's3', sourceStart: 10 }, { segmentId: 'd', speakerId: 's3', sourceStart: 11 },
      { segmentId: 'e', speakerId: 's3', sourceStart: 10.5 }, { segmentId: 'x', speakerId: 's1', sourceStart: 5 }
    ],
    audioEvents: []
  };
  splitMixedGenderSpeakers(transcript, { s3: { mixed: true, utteranceGenders: split } });
  assert.deepEqual(transcript.speakers.map(row => [row.speakerId, row.gender]),
    [['s3-m', 'male'], ['s3-f', 'female'], ['s1', 'female']]);
  assert.equal(transcript.utterances.find(row => row.segmentId === 'e').speakerId, 's3-f',
    'an unmeasured line follows the nearest measured line');
});
