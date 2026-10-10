import path from 'node:path';

export const PIPELINE_VERSION = 'turkish-media-v1';
// Keep media translation independent of the expensive visual-analysis model.
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_TRANSLATION_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const integer = (value, fallback, min, max) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Geçersiz media yapılandırması: ${value}`);
  return parsed;
};

export function loadMediaConfig(env = process.env) {
  const qualityMode = env.DUB_QUALITY_MODE || 'quality';
  if (!['quality', 'fast'].includes(qualityMode)) throw new Error('DUB_QUALITY_MODE quality veya fast olmalı.');
  const provider = env.TRANSLATION_PROVIDER || 'gemini';
  if (provider !== 'gemini') throw new Error('Bu sürümde TRANSLATION_PROVIDER=gemini kullanılmalı.');
  const config = {
    version: PIPELINE_VERSION,
    directory: path.resolve(env.DUB_CACHE_DIRECTORY || '/tmp/videoquest-turkish-media'),
    qualityMode,
    language: env.DUB_DEFAULT_LANGUAGE || 'tr',
    concurrency: integer(env.DUB_MAX_CONCURRENCY, 2, 1, 8),
    cacheTtlSeconds: integer(env.DUB_CACHE_TTL, 86400, 60, 86400),
    requestTimeoutMs: integer(env.DUB_REQUEST_TIMEOUT_MS, 300000, 1000, 600000),
    maxRetries: integer(env.DUB_MAX_RETRIES, 3, 0, 5),
    maxTempo: 1.20,
    // Version isolated from prior strong-model and oversized-scene artifacts.
    translationVersion: env.TRANSLATION_VERSION || 'scene-tr-gemini-economy-v3',
    elevenLabs: {
      apiKey: String(env.ELEVENLABS_API_KEY || '').trim(),
      baseUrl: 'https://api.elevenlabs.io',
      dubModel: env.ELEVENLABS_DUB_MODEL || 'eleven_v4',
      fastModel: env.ELEVENLABS_FAST_MODEL || 'eleven_v4_turbo',
      sttModel: env.ELEVENLABS_STT_MODEL || 'scribe_v2',
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
      pronunciationDictionaryId: env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID || '',
      pronunciationDictionaryVersionId: env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID || '',
    },
    translation: {
      provider,
      apiKey: String(env.GEMINI_API_KEY || '').trim(),
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: env.TRANSLATION_MODEL || GEMINI_DEFAULT_MODEL,
      // An explicit translation model remains the operator's choice; never
      // silently replace it. Lite fallback is limited to the economy default.
      fallbackModel: env.TRANSLATION_MODEL ? '' : (env.TRANSLATION_FALLBACK_MODEL || GEMINI_TRANSLATION_FALLBACK_MODEL),
    },
  };
  if (config.elevenLabs.sttModel !== 'scribe_v2') throw new Error('Transcription modeli scribe_v2 olmalı.');
  if (config.elevenLabs.dubModel !== 'eleven_v4') throw new Error('Final dublaj modeli eleven_v4 olmalı; eski modele fallback yok.');
  if (config.elevenLabs.fastModel !== 'eleven_v4_turbo') throw new Error('Hızlı mod modeli eleven_v4_turbo olmalı.');
  if (config.language !== 'tr') throw new Error('Türkçe medya için DUB_DEFAULT_LANGUAGE=tr olmalı; kaynak dili Scribe otomatik belirler.');
  return config;
}

export function publicMediaConfig(config) {
  return {
    version: config.version,
    configured: Boolean(config.elevenLabs.apiKey && config.translation.apiKey),
    transcriptionConfigured: Boolean(config.elevenLabs.apiKey),
    translationConfigured: Boolean(config.translation.apiKey),
    serverMediaConfigured: Boolean(config.elevenLabs.apiKey && config.translation.apiKey),
    translationProvider: config.translation.provider,
    openAIRequired: false,
    browserKeysSupported: { gemini: true, elevenLabs: true },
    qualityMode: config.qualityMode,
    fastAvailable: false,
    fastUnavailableReason: 'FAST_MODEL_PROTOCOL_UNVERIFIED',
    models: { transcription: config.elevenLabs.sttModel, quality: config.elevenLabs.dubModel, fast: config.elevenLabs.fastModel },
    language: config.language,
    cacheTtlSeconds: config.cacheTtlSeconds,
  };
}
