import test from 'node:test';
import assert from 'node:assert/strict';
import { DUB_CACHE_ENGINE_VERSION, compatibleSavedDubCache } from '../public/dub-cache.js';
import { prepareGame, exportGame, importGame } from '../public/saved-games.js';
const payload = () => ({ dubCacheEngineVersion: DUB_CACHE_ENGINE_VERSION,
  dubCache: [['one', 'data:audio/mpeg;base64,AQID']],
  dubSegmentMetadata: [['one', { provider: 'elevenlabs', model: 'eleven_v3', voiceId: 'fixed' }]],
  dubSpeakerVoices: [{ speakerId: 'speaker', voiceId: 'fixed', gender: 'male' }] });
test('current provider/model/voice cache contract survives a saved-game round trip', async () => {
  const p = { ...payload(), dialogue: { segments: [{ speakerId: 'speaker', gender: 'male',
    startTime: 1, endTime: 3, originalText: 'Hello', turkishText: 'Merhaba' }] } };
  const game = prepareGame({ duration: 100, video: new Blob(['video']), payload: p });
  const restored = await importGame(exportGame(game));
  assert.deepEqual(compatibleSavedDubCache(restored.payload), p.dubCache);
});
test('legacy or obsolete generation contracts cannot play broken cached audio', () => {
  for (const version of [undefined, 0, 1, 3]) {
    assert.deepEqual(compatibleSavedDubCache({ ...payload(), dubCacheEngineVersion: version }), []);
  }
});
test('cached audio without matching provider, supported model or assigned voice is rejected', () => {
  for (const patch of [{ provider: '' }, { provider: 'other' }, { model: 'eleven_v3_conversational' }, { voiceId: 'other' }]) {
    const p = payload(); Object.assign(p.dubSegmentMetadata[0][1], patch);
    assert.deepEqual(compatibleSavedDubCache(p), []);
  }
});
