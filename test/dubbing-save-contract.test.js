import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGame, exportGame, importGame, validateGame } from '../public/saved-games.js';

function game() {
  const raw = [
    { segmentId: 'a', speakerId: 'speaker-a', gender: 'female', confidence: .4, startTime: 0, endTime: .5,
      originalText: 'Hello', turkishText: 'Merhaba' },
    { segmentId: 'b', speakerId: 'speaker-a', gender: 'male', confidence: .95, startTime: .5, endTime: 10,
      originalText: 'everyone', turkishText: 'herkese' }
  ];
  return prepareGame({ title: 'Dialogue test', duration: 900, video: new Blob(['source-video'], { type: 'video/mp4' }),
    payload: {
      dialogue: { segments: raw, dubSegments: [{ ...raw[0], segmentId: 'dub-block:a+b', endTime: 10 }] },
      dubCache: [['dub-block:a+b', 'data:audio/mpeg;base64,AQIDBA==']],
      dubSegmentMetadata: [['dub-block:a+b', { provider: 'elevenlabs', model: 'eleven_v3', voiceId: 'voice-a', apiKey: 'must-be-removed' }]],
      dubProviderLock: 'elevenlabs',
      dubSpeakerVoices: [{ speakerId: 'speaker-a', gender: 'male', voiceId: 'voice-a' }],
      dubbingEnabled: true
    }
  });
}

test('saved dubbing keeps provider, model and stable voice metadata through export/import', async () => {
  const original = game();
  const restored = await importGame(exportGame(original));
  assert.equal(restored.payload.dubProviderLock, 'elevenlabs');
  assert.deepEqual(restored.payload.dubSegmentMetadata, [['dub-block:a+b', {
    provider: 'elevenlabs', model: 'eleven_v3', voiceId: 'voice-a'
  }]]);
  assert.deepEqual(restored.payload.dubCache, original.payload.dubCache);
  assert.deepEqual(restored.payload.dubSpeakerVoices, original.payload.dubSpeakerVoices);
});

test('saved voice validation uses original timed speaker evidence instead of the first merged annotation', () => {
  assert.doesNotThrow(game);
  const saved = game(); saved.payload.dubSpeakerVoices[0].gender = 'female';
  assert.throws(() => validateGame(saved), /ayrı ve sabit/);
});

test('malformed dubbing metadata is rejected without requiring IndexedDB or provider access', () => {
  const saved = game(); saved.payload.dubSegmentMetadata = [['one', { voiceId: 123 }]];
  assert.throws(() => validateGame(saved), /sağlayıcı bilgileri/);
  delete saved.payload.dubSegmentMetadata;
  assert.doesNotThrow(() => validateGame(saved), 'legacy saves without metadata remain readable');
});
