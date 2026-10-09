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
});
