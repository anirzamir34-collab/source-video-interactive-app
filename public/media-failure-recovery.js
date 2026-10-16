// Keep a completed visual game playable if an independent Turkish-media
// provider or synthesis stage fails. Never mask unrelated application bugs.
const MEDIA_CODE = /^(?:TRANSLATION_|DUB_|ELEVENLABS_|PROVIDER_|MEDIA_|AUDIO_|VOICE_|STT_|GEMINI_|SCRIBE_|SPEAKER_)/;
export function isRecoverableTurkishMediaFailure(error) {
  return error?.name !== 'AbortError' && MEDIA_CODE.test(String(error?.code || ''));
}

export function mediaFallbackMessage(error) {
  const code = String(error?.code || 'MEDIA_FAILED').replace(/[^A-Z0-9_]/g, '').slice(0, 70);
  if (code === 'TRANSLATION_BLOCKED') {
    return 'Türkçe çeviri sağlayıcı tarafından reddedildi; analiz ve oyun korundu. Özgün kaynak sesle devam edebilirsin.';
  }
  if (code === 'DUB_FIT_FAILED' || code === 'DUB_REGENERATE_REQUIRED') {
    return 'Türkçe dublaj kaynak konuşma sürelerine sağlıklı biçimde sığmadı; analiz korundu, özgün ses kullanılıyor.';
  }
  return `Türkçe medya hazırlanamadı (${code}); görsel analiz ve seçimler korundu. Özgün kaynak sesle oynayabilirsin.`;
}
