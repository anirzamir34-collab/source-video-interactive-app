import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneSurfaceChoices } from '../public/choice-routing.js';
import { assertSpeakerProfiles, mapSpeakerVoices } from '../lib/turkish-media/voice-mapping.js';

test('a scene offers its verified dialogue clips without making a user watch the entire chapter', () => {
  const clips = [
    { id: 'talk-1', choiceSurface: 'story', sourceVerified: true, startTime: 112, endTime: 134 },
    { id: 'contact-1', choiceSurface: 'approach', sourceVerified: true, startTime: 134, endTime: 139 },
    { id: 'talk-2', choiceSurface: 'story', sourceVerified: true, startTime: 139, endTime: 157 },
    { id: 'talk-3', choiceSurface: 'story', sourceVerified: true, startTime: 157, endTime: 173 },
    { id: 'contact-2', choiceSurface: 'approach', sourceVerified: true, startTime: 210, endTime: 227 },
    { id: 'unverified', choiceSurface: 'story', sourceVerified: false, startTime: 180, endTime: 190 },
    { id: 'core', choiceSurface: 'approach', sourceVerified: true, startTime: 240, endTime: 258 }
  ];
  assert.deepEqual(sceneSurfaceChoices(clips, 'story', { floor: 112, ceiling: 236 }).map(row => row.id),
    ['talk-1', 'talk-2', 'talk-3']);
  assert.deepEqual(sceneSurfaceChoices(clips, 'approach', { floor: 227, ceiling: 236, replay: true })
    .map(row => row.id), ['contact-1', 'contact-2']);
  assert.deepEqual(sceneSurfaceChoices(clips, 'approach', { floor: 227, ceiling: 236 })
    .map(row => row.id), []);
});

test('unknown source voices never default to an arbitrary male voice or reuse a bad saved choice', () => {
  const speakers = [{ speakerId: 'voice-1', gender: null }, { speakerId: 'voice-2', gender: 'male' }];
  const catalog = [
    { voice_id: 'male', labels: { gender: 'male', language: 'tr' } },
    { voice_id: 'female', labels: { gender: 'female', language: 'tr' } }
  ];
  assert.throws(() => assertSpeakerProfiles(speakers, {}, { 'voice-1': 'male' }),
    error => error.code === 'VOICE_PROFILE_UNVERIFIED');
  assert.throws(() => mapSpeakerVoices(speakers, catalog, { 'voice-1': 'male' }),
    error => error.code === 'VOICE_PROFILE_UNVERIFIED');
  assert.deepEqual(mapSpeakerVoices(speakers, catalog, {}, { 'voice-1': 'female' }),
    { 'voice-1': 'female', 'voice-2': 'male' });
});

test('known source age rejects a catalogue voice from a conflicting age group', () => {
  const speakers = [{ speakerId: 'older', gender: 'female', age: 'elderly' }];
  const catalog = [
    { voice_id: 'young', labels: { gender: 'female', language: 'tr', age: 'child' } },
    { voice_id: 'older', labels: { gender: 'female', language: 'tr', age: 'senior' } }
  ];
  assert.deepEqual(mapSpeakerVoices(speakers, catalog), { older: 'older' });
});
