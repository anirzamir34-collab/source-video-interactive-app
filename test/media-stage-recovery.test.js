import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeminiTranslationQuota, canResumePreparedTurkishMedia } from '../public/media-stage-recovery.js';

test('Gemini translation quota is distinct from ElevenLabs throttling and content restrictions', () => {
  assert.equal(isGeminiTranslationQuota({ code: 'GEMINI_CREDITS_EXHAUSTED' }), true);
  assert.equal(isGeminiTranslationQuota({ code: 'GEMINI_RATE_LIMITED' }), true);
  assert.equal(isGeminiTranslationQuota({ status: 429, message: 'Gemini quota reached' }), true);
  assert.equal(isGeminiTranslationQuota({ status: 429, code: 'ELEVENLABS_RATE_LIMITED' }), false);
  assert.equal(isGeminiTranslationQuota({ code: 'TRANSLATION_BLOCKED' }), false);
  assert.equal(isGeminiTranslationQuota({ code: 'SPEAKER_ALIGNMENT_FAILED' }), false);
});

test('retry requires completed visual analysis, the same source and the same requested media mode', () => {
  const session = { sourceKey: 'file:a:123:456', pendingTurkishMedia: { modeKey: 'dub-tr' } };
  const context = { session, sourceKey: 'file:a:123:456', mediaModeKey: 'dub-tr',
    analysis: { actions: [{ actionId: 'verified' }] } };
  assert.equal(canResumePreparedTurkishMedia(context), true);
  assert.equal(canResumePreparedTurkishMedia({ ...context, sourceKey: 'file:b:123:456' }), false);
  assert.equal(canResumePreparedTurkishMedia({ ...context, mediaModeKey: 'subtitles-only' }), false);
  assert.equal(canResumePreparedTurkishMedia({ ...context, analysis: { actions: [] } }), false);
  assert.equal(canResumePreparedTurkishMedia({ ...context, session: { ...session, pendingTurkishMedia: null } }), false);
});
