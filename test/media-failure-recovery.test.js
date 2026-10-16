import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecoverableTurkishMediaFailure, mediaFallbackMessage } from '../public/media-failure-recovery.js';

test('translation, dubbing and voice provider failures cannot erase an otherwise complete game', () => {
  for (const code of ['TRANSLATION_BLOCKED', 'DUB_FIT_FAILED', 'PROVIDER_HTTP_404',
    'ELEVENLABS_NOT_CONFIGURED', 'VOICE_MAPPING_INVALID']) {
    assert.equal(isRecoverableTurkishMediaFailure({ code }), true);
    assert.match(mediaFallbackMessage({ code }), /analiz|Analiz/);
  }
});

test('do not mask cancellation, unknown application bugs or credential values in user messages', () => {
  assert.equal(isRecoverableTurkishMediaFailure({ code: 'DUB_FIT_FAILED', name: 'AbortError' }), false);
  assert.equal(isRecoverableTurkishMediaFailure(new TypeError('bug')), false);
  assert.equal(isRecoverableTurkishMediaFailure({ code: 'UNKNOWN_BUG' }), false);
  assert.doesNotMatch(mediaFallbackMessage({ code: 'PROVIDER_HTTP_503', message: 'secret user key' }), /secret user key/);
});
