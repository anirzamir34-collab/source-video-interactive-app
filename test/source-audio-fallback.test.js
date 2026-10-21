import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceAudioPreparer } from '../public/source-audio.js';

test('a failing fast remux falls back to decoding the file', async () => {
  let encoded = 0;
  const prepare = createSourceAudioPreparer({
    extract: async () => { throw new DOMException('read failed', 'NotReadableError'); },
    encode: async () => { encoded++; return new Blob(['mp3'], { type: 'audio/mpeg' }); }
  });
  const mp3 = await prepare(new Blob(['video'], { type: 'video/mp4' }));
  assert.equal(encoded, 1);
  assert.equal(mp3.type, 'audio/mpeg');
});

test('when nothing works the message carries the technical reason', async () => {
  const prepare = createSourceAudioPreparer({
    extract: async () => null,
    encode: async () => { throw new TypeError('decoder unavailable'); }
  });
  await assert.rejects(prepare(new Blob(['video'], { type: 'video/mp4' })), error =>
    error.code === 'LOCAL_AUDIO_UNSUPPORTED' && /decoder unavailable/.test(error.message));
});
