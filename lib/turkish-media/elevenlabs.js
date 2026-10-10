import path from 'node:path';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { MediaError } from './errors.js';
import { createMediaRequest } from './http.js';
import { configuredDictionaryLocators } from './pronunciation.js';

// Verified REST enum; see docs/turkish-media-api-contract.md. Request headered
// WAV for configured raw audio so FFprobe can verify the actual channel count.
const OUTPUT_FORMATS = new Set([
  'alaw_8000', 'ulaw_8000',
  'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_32', 'mp3_44100_64',
  'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
  ...[8000, 16000, 22050, 24000, 32000, 44100, 48000].flatMap(rate => [`pcm_${rate}`, `wav_${rate}`]),
  ...[32, 64, 96, 128, 192].map(rate => `opus_48000_${rate}`),
]);
const validText = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const invalid = (message, code = 'PROVIDER_INVALID_RESPONSE') => new MediaError(code, message);
const clone = value => structuredClone(value);

function headeredFormat(format) {
  if (format === 'alaw_8000' || format === 'ulaw_8000') return 'wav_8000';
  return format.startsWith('pcm_') ? format.replace(/^pcm_/, 'wav_') : format;
}

function mimeType(format) {
  if (format.startsWith('mp3_')) return 'audio/mpeg';
  if (format.startsWith('wav_')) return 'audio/wav';
  if (format.startsWith('opus_')) return 'audio/ogg';
  return 'application/octet-stream';
}

function sourceMime(filename) {
  return ({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.aac': 'audio/aac' })[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

async function describeUpload(input, maximumBytes) {
  const filename = typeof input === 'string' ? input : input?.path ?? input?.filePath;
  let size;
  let makeBlob;
  let name;
  if (typeof filename === 'string' && filename) {
    const metadata = await stat(filename);
    if (!metadata.isFile()) throw new MediaError('INVALID_AUDIO_FILE', 'Ses kaynağı normal bir dosya olmalı.', { status: 422 });
    size = metadata.size;
    name = path.basename(filename);
    const type = input?.mimeType || sourceMime(name);
    // Keep large FLAC/WAV uploads file-backed; each retry opens a fresh Blob
    // rather than reading and copying the complete audio into memory.
    makeBlob = () => openAsBlob(filename, { type });
  } else {
    const value = input instanceof Blob || ArrayBuffer.isView(input) || input instanceof ArrayBuffer
      ? input : input?.bytes ?? input?.buffer ?? input?.blob ?? input;
    let blob;
    if (value instanceof Blob) blob = value;
    else if (ArrayBuffer.isView(value)) blob = new Blob([value], { type: input?.mimeType || 'audio/wav' });
    else if (value instanceof ArrayBuffer) blob = new Blob([value], { type: input?.mimeType || 'audio/wav' });
    else throw new MediaError('INVALID_AUDIO_FILE', 'Yüklenebilir ses dosyası bulunamadı.', { status: 422 });
    size = blob.size;
    name = input?.filename || 'source-audio.wav';
    makeBlob = async () => blob;
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size >= maximumBytes) {
    throw new MediaError('AUDIO_FILE_SIZE_INVALID', 'Ses dosyası boş veya sağlayıcının boyut sınırını aşıyor.', { status: 422 });
  }
  return { name, makeBlob };
}

function validateNativeAlignment(alignment) {
  if (alignment == null) return null;
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || !characters.length || starts.length !== characters.length || ends.length !== characters.length
    || characters.some(value => typeof value !== 'string')
    || starts.some((start, i) => !finite(start) || start < 0 || !finite(ends[i]) || ends[i] < start)) {
    throw invalid('Dublaj karakter zamanları geçersiz.', 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
  }
  return alignment;
}

function dialogueResult(response, inputs, model, outputFormat) {
  const encoded = response?.audio_base64;
  if (typeof encoded !== 'string' || !encoded.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || encoded.length % 4 === 1) throw invalid('Dublaj sağlayıcısı geçerli ses döndürmedi.');
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length) throw invalid('Dublaj sağlayıcısı boş ses döndürdü.');
  const alignment = validateNativeAlignment(response.alignment);
  const normalizedAlignment = validateNativeAlignment(response.normalized_alignment);
  if (!Array.isArray(response.voice_segments) || !response.voice_segments.length) {
    throw invalid('Dublajın gerçek konuşmacı aralıkları bulunamadı.', 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
  }
  const covered = new Set();
  const voiceSegments = response.voice_segments.map(segment => {
    const index = segment?.dialogue_input_index;
    const start = segment?.start_time_seconds;
    const end = segment?.end_time_seconds;
    const characterStart = segment?.character_start_index;
    const characterEnd = segment?.character_end_index;
    if (!Number.isInteger(index) || index < 0 || index >= inputs.length
      || segment.voice_id !== inputs[index].voice_id || !finite(start) || start < 0
      || !finite(end) || end <= start || !Number.isInteger(characterStart) || characterStart < 0
      || !Number.isInteger(characterEnd) || characterEnd <= characterStart
      || (alignment && characterEnd > alignment.characters.length)) {
      throw invalid('Dublaj konuşmacı aralığı kaynak cümleyle eşleşmiyor.', 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
    }
    covered.add(index);
    return { ...segment, start, end };
  });
  if (covered.size !== inputs.length) {
    throw invalid('Dublaj sonucu bazı kaynak cümleleri içermiyor.', 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
  }
  return { audio, voiceSegments, alignment, normalizedAlignment, model, outputFormat, mimeType: mimeType(outputFormat) };
}

function unsupportedOutputFormat(error) {
  return ['PROVIDER_HTTP_400', 'PROVIDER_HTTP_422'].includes(error?.code)
    && /output[_ ]format/i.test(error.message)
    && /unsupported|not supported|not allowed|invalid|permitted|allowed values/i.test(error.message);
}

export function createElevenLabsProvider({ config, request } = {}) {
  if (!config?.elevenLabs) throw new TypeError('ElevenLabs yapılandırması gerekli.');
  const settings = config.elevenLabs;
  const call = request || createMediaRequest({ timeoutMs: config.requestTimeoutMs, maxRetries: config.maxRetries,
    secrets: [settings.apiKey] });
  let modelCache = null;
  let voicesCache = null;

  function auth() {
    if (!validText(settings.apiKey)) {
      throw new MediaError('ELEVENLABS_NOT_CONFIGURED', 'Sunucuda ELEVENLABS_API_KEY yapılandırılmalı.', { status: 503 });
    }
    return { 'xi-api-key': settings.apiKey };
  }
  const url = (pathname, query = {}) => {
    const result = new URL(pathname, `${settings.baseUrl || 'https://api.elevenlabs.io'}/`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) result.searchParams.set(key, value);
    return result.href;
  };
  const options = signal => ({ signal, requestTimeoutMs: config.requestTimeoutMs, retries: config.maxRetries });

  async function getModels({ signal, refresh = false } = {}) {
    signal?.throwIfAborted();
    const headers = auth();
    if (!refresh && modelCache && modelCache.expires > Date.now()) return clone(modelCache.value);
    const result = await call(url('/v1/models'), { headers, ...options(signal) });
    if (!Array.isArray(result) || result.some(model => !validText(model?.model_id))) {
      throw invalid('ElevenLabs model kataloğu geçersiz.');
    }
    modelCache = { value: clone(result), expires: Date.now() + 60000 };
    return result;
  }

  async function validateCapabilities({ qualityMode = config.qualityMode || 'quality',
    language = config.language || 'tr', signal } = {}) {
    signal?.throwIfAborted();
    auth();
    if (!['quality', 'fast'].includes(qualityMode)) {
      throw new MediaError('INVALID_QUALITY_MODE', 'Dublaj modu quality veya fast olmalı.', { status: 422 });
    }
    // Official v4 turbo existence is verified, but the new TTD WebSocket
    // URL/protocol is not. Do not silently replace it with REST or old TTS WS.
    if (qualityMode === 'fast') throw new MediaError('FAST_MODEL_PROTOCOL_UNVERIFIED',
      'Eleven v4 turbo Text-to-Dialogue WebSocket sözleşmesi doğrulanamadı; hızlı mod bu sürümde kullanılamıyor.', { status: 503 });
    const modelId = settings.dubModel || 'eleven_v4';
    const models = await getModels({ signal });
    const model = models.find(item => item.model_id === modelId);
    if (!model || model.can_do_text_to_speech !== true) throw new MediaError('DUB_MODEL_UNAVAILABLE',
      `Yapılandırılmış dublaj modeli (${modelId}) bu hesapta TTS için kullanılabilir değil.`, { status: 503 });
    if (!Array.isArray(model.languages) || !model.languages.some(item => item.language_id === language)) {
      throw new MediaError('DUB_LANGUAGE_UNAVAILABLE', `Dublaj modeli ${language} dil desteğini doğrulamıyor.`, { status: 503 });
    }
    const maximum = model.maximum_text_length_per_request;
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum <= 0)) {
      throw invalid('Model kataloğunun metin uzunluğu sınırı geçersiz.');
    }
    return { modelId, model, language, qualityMode, maxTextLength: Math.min(2000, maximum ?? 2000) };
  }

  async function listVoices({ signal, refresh = false } = {}) {
    signal?.throwIfAborted();
    const headers = auth();
    if (!refresh && voicesCache && voicesCache.expires > Date.now()) return clone(voicesCache.value);
    const voices = new Map();
    const tokens = new Set();
    let nextPageToken;
    for (let page = 0; page < 100; page += 1) {
      const response = await call(url('/v2/voices', { page_size: 100, next_page_token: nextPageToken }),
        { headers, ...options(signal) });
      if (!Array.isArray(response?.voices) || response.voices.some(voice => !validText(voice?.voice_id))) {
        throw invalid('ElevenLabs ses kataloğu geçersiz.');
      }
      for (const voice of response.voices) voices.set(voice.voice_id, voice);
      if (response.has_more === false || (response.has_more == null && !response.next_page_token)) {
        const value = [...voices.values()];
        voicesCache = { value: clone(value), expires: Date.now() + 60000 };
        return value;
      }
      nextPageToken = response.next_page_token;
      if (!validText(nextPageToken) || tokens.has(nextPageToken)) {
        throw invalid('Ses kataloğunun sayfalama belirteci geçersiz.');
      }
      tokens.add(nextPageToken);
    }
    throw invalid('Ses kataloğunun sayfa sınırı aşıldı.');
  }

  async function transcribe(audioFile, { signal, languageCode, fileFormat = 'other' } = {}) {
    signal?.throwIfAborted();
    const headers = auth();
    if (settings.sttModel !== 'scribe_v2') throw new MediaError('STT_MODEL_UNSUPPORTED',
      'Kaynak konuşma için doğrulanmış scribe_v2 modeli kullanılmalı.', { status: 503 });
    if (!['other', 'pcm_s16le_16'].includes(fileFormat)) {
      throw new MediaError('INVALID_AUDIO_FORMAT', 'Transkripsiyon ses formatı geçersiz.', { status: 422 });
    }
    const upload = await describeUpload(audioFile, 5_000_000_000);
    const response = await call(url('/v1/speech-to-text'), { method: 'POST', headers, ...options(signal),
      bodyFactory: async () => {
        const form = new FormData();
        form.set('file', await upload.makeBlob(), upload.name);
        form.set('model_id', 'scribe_v2');
        form.set('diarize', 'true');
        // Scribe's default diarization threshold (~0.22) can split one real
        // speaker into several IDs in conversational video. A slightly higher
        // threshold favors stable speaker identity without forcing a speaker
        // count, so genuine multi-speaker videos remain supported.
        form.set('diarization_threshold', '0.32');
        form.set('timestamps_granularity', 'word');
        form.set('tag_audio_events', 'true');
        form.set('no_verbatim', 'false');
        form.set('file_format', fileFormat);
        if (languageCode) form.set('language_code', languageCode);
        return form;
      } });
    if (!Array.isArray(response?.words)) throw invalid('Scribe kaynak konuşmanın gerçek kelime zamanlarını döndürmedi.');
    return response;
  }

  async function synthesizeDialogue(inputs, { qualityMode = config.qualityMode || 'quality',
    language = config.language || 'tr', outputFormat = settings.outputFormat || 'mp3_44100_128', signal } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(inputs) || !inputs.length || inputs.some(input => !validText(input?.text) || !validText(input?.voice_id))) {
      throw new MediaError('INVALID_DIALOGUE_INPUT', 'Dublaj cümlesi ve ses kimliği gerekli.', { status: 422 });
    }
    const remoteInputs = inputs.map(({ text, voice_id }) => ({ text, voice_id }));
    if (new Set(remoteInputs.map(input => input.voice_id)).size > 10) {
      throw new MediaError('DIALOGUE_VOICE_LIMIT', 'Bir dublaj isteği en fazla 10 ayrı ses içerebilir.', { status: 422 });
    }
    if (!OUTPUT_FORMATS.has(outputFormat)) throw new MediaError('DIALOGUE_OUTPUT_FORMAT_UNSUPPORTED',
      'Dublaj çıktı formatı resmi REST sözleşmesinde bulunmuyor.', { status: 422 });
    const locators = configuredDictionaryLocators(config);
    const capability = await validateCapabilities({ qualityMode, language, signal });
    if (remoteInputs.reduce((count, input) => count + input.text.length, 0) > capability.maxTextLength) {
      throw new MediaError('DIALOGUE_TEXT_LIMIT', `Dublaj isteği en fazla ${capability.maxTextLength} karakter içerebilir.`, { status: 422 });
    }
    const body = JSON.stringify({ inputs: remoteInputs, model_id: capability.modelId, language_code: language,
      ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}) });
    const produce = format => call(url('/v1/text-to-dialogue/with-timestamps', { output_format: format }),
      { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body, ...options(signal) });
    let response;
    let actualFormat = headeredFormat(outputFormat);
    if (!OUTPUT_FORMATS.has(actualFormat)) throw new MediaError('RAW_PCM_CHANNELS_UNVERIFIED',
      'Ham PCM kanal sayısı doğrulanamadı ve aynı örnekleme hızında belgelenmiş WAV formatı bulunamadı.', { status: 503 });
    try { response = await produce(actualFormat); } catch (error) {
      if (!actualFormat.startsWith('wav_') || !unsupportedOutputFormat(error)) throw error;
      actualFormat = 'mp3_44100_128';
      response = await produce(actualFormat);
    }
    try {
      return { ...dialogueResult(response, remoteInputs, capability.modelId, actualFormat),
        requestedOutputFormat: outputFormat };
    } catch (error) {
      if (error?.code !== 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID' || remoteInputs.length !== 1) throw error;
      // Eleven v4 may emit invalid text-to-dialogue speaker indices even when
      // it returned audio. For a SINGLE turn use the same v4 TTS model/voice
      // and its *measured* character clock. This is not the Dubbing API.
      // Never invent an alignment or label an unverified voice as another one.
      const turn = remoteInputs[0];
      const fallback = await call(url(`/v1/text-to-speech/${encodeURIComponent(turn.voice_id)}/with-timestamps`,
        { output_format: actualFormat }), {
        method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ text: turn.text, model_id: capability.modelId,
          language_code: language,
          ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}) }),
        ...options(signal),
      });
      const measured = validateNativeAlignment(fallback?.alignment);
      const canonicalText = value => String(value || '').normalize('NFC')
        .toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, '');
      if (!measured || canonicalText(measured.characters.join('')) !== canonicalText(turn.text)) {
        throw invalid('Tek konuşmacı sesinin zamanları kaynak metinle doğrulanamadı.',
          'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
      }
      const starts = measured.character_start_times_seconds;
      const ends = measured.character_end_times_seconds;
      const start = Math.min(...starts), end = Math.max(...ends);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw invalid('Tek konuşmacı sesinin gerçek zamanları eksik.', 'PROVIDER_DIALOGUE_ALIGNMENT_INVALID');
      }
      const voiceSegments = [{
        dialogue_input_index: 0, voice_id: turn.voice_id,
        start_time_seconds: start, end_time_seconds: end,
        character_start_index: 0, character_end_index: measured.characters.length
      }];
      return { ...dialogueResult({ ...fallback, voice_segments: voiceSegments }, remoteInputs,
        capability.modelId, actualFormat), requestedOutputFormat: outputFormat,
        isolatedVoiceFallback: true };
    }
  }

  async function align(audioFile, text, { signal } = {}) {
    signal?.throwIfAborted();
    if (!validText(text)) throw new MediaError('INVALID_ALIGNMENT_TEXT', 'Hizalanacak gerçek konuşma metni gerekli.', { status: 422 });
    const headers = auth();
    const upload = await describeUpload(audioFile, 1_000_000_000);
    const response = await call(url('/v1/forced-alignment'), { method: 'POST', headers, ...options(signal),
      bodyFactory: async () => {
        const form = new FormData();
        form.set('file', await upload.makeBlob(), upload.name);
        form.set('text', text);
        return form;
      } });
    if (!Array.isArray(response?.words) || response.words.some(word => !finite(word?.start)
      || word.start < 0 || !finite(word?.end) || word.end < word.start || typeof word.text !== 'string')) {
      throw invalid('Forced Alignment geçerli kelime zamanlarını döndürmedi.');
    }
    return response;
  }

  return { transcribe, listVoices, getModels, validateCapabilities, synthesizeDialogue, align };
}
