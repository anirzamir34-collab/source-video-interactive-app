import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaCredentialScopes } from '../lib/turkish-media/jobs.js';
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

test('changing Gemini credential preserves completed ElevenLabs work but not unfinished translations', () => {
  const initial = mediaCredentialScopes('eleven-labs-synthetic-A', 'gemini-synthetic-A');
  const newGemini = mediaCredentialScopes('eleven-labs-synthetic-A', 'gemini-synthetic-B');
  const newEleven = mediaCredentialScopes('eleven-labs-synthetic-B', 'gemini-synthetic-A');
  assert.equal(initial.voiceCredentialScope, newGemini.voiceCredentialScope);
  assert.notEqual(initial.translationCredentialScope, newGemini.translationCredentialScope);
  assert.notEqual(initial.credentialScope, newGemini.credentialScope);
  assert.equal(initial.translationCredentialScope, newEleven.translationCredentialScope);
  assert.notEqual(initial.voiceCredentialScope, newEleven.voiceCredentialScope);
  assert.equal(initial.voiceCredentialScope.length, 64);
  assert.doesNotMatch(JSON.stringify(initial), /synthetic-A|synthetic-B/);
});

test('server media job quota messages remain recognizable after polling strips original HTTP status', () => {
  assert.equal(isGeminiTranslationQuota({ code: 'PROVIDER_HTTP_429',
    message: 'Gemini kota veya hız sınırına ulaştı.' }), true);
  assert.equal(isGeminiTranslationQuota(new Error('Gemini kota veya hız sınırına ulaştı.')), true);
  assert.equal(isGeminiTranslationQuota({ code: 'MEDIA_JOB_FAILED',
    message: 'Gemini API günlük kotasına ulaştı.' }), true);
  assert.equal(isGeminiTranslationQuota({ code: 'PROVIDER_HTTP_429',
    message: 'Bu anahtar için sağlayıcı sınırı doldu.' }), false);
  assert.equal(isGeminiTranslationQuota({ code: 'ELEVENLABS_RATE_LIMITED',
    message: 'ElevenLabs kota doldu.' }), false);
  assert.equal(isGeminiTranslationQuota({ code: 'TRANSLATION_BLOCKED',
    message: 'Gemini içerik güvenlik kısıtlaması.' }), false);
});
