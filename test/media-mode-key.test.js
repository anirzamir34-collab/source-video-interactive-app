import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaModeKeyFromOptions } from '../public/media-mode-key.js';

test('automatic ElevenLabs dubbing retains its provider identity through regeneration', () => {
  const ui = { outputs: { dub: true, subtitles: true, dubbingProvider: 'elevenlabs_v1' },
    qualityMode: 'quality' };
  const regeneration = { outputs: { ...ui.outputs }, qualityMode: ui.qualityMode,
    voiceMapping: { 'speaker-a': 'voice-a' } };
  assert.equal(mediaModeKeyFromOptions(ui), mediaModeKeyFromOptions(regeneration));
  assert.equal(mediaModeKeyFromOptions(ui),
    '{"dub":true,"subtitles":true,"quality":"quality","provider":"elevenlabs_v1"}');
});

test('classic dubbing and direct dubbing never share a wrongly reusable audio manifest', () => {
  const base = { dub: true, subtitles: true };
  assert.notEqual(mediaModeKeyFromOptions({ outputs: { ...base, dubbingProvider: 'elevenlabs_v1' } }),
    mediaModeKeyFromOptions({ outputs: { ...base, dubbingProvider: 'classic' } }));
  assert.equal(mediaModeKeyFromOptions({ outputs: base, qualityMode: 'quality' }),
    '{"dub":true,"subtitles":true,"quality":"quality"}');
  assert.notEqual(mediaModeKeyFromOptions({ outputs: base, qualityMode: 'fast' }),
    mediaModeKeyFromOptions({ outputs: base, qualityMode: 'quality' }));
});
