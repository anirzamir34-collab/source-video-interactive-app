import { extractMp4Audio } from './mp4-audio.js';
import { MAX_AUDIO_BYTES } from './media-limits.js';

const failure = (code, message) => Object.assign(new Error(message), { code });
const isMp3 = file => /^audio\/(?:mpeg|mp3)$/i.test(file?.type || '');

async function encodeSourceMp3(source, options) {
  options.signal?.throwIfAborted();
  options.onProgress({ phase: 'loading_encoder' });
  // npm ci builds this local module, including WASM; no CDN or video upload.
  const { convertSourceToMp3 } = await import('./source-audio-codec.bundle.js');
  options.signal?.throwIfAborted();
  return convertSourceToMp3(source, options);
}

function checkedMp3(file) {
  if (!(file instanceof Blob) || !file.size || !isMp3(file)) {
    throw failure('SOURCE_MP3_REQUIRED', 'Kaynak ses MP3 olarak hazırlanamadı.');
  }
  if (file.size > MAX_AUDIO_BYTES) throw failure('SOURCE_AUDIO_TOO_LARGE', 'Ayrılan ses dosyası 250 MiB sınırını aşıyor.');
  return file;
}

export function createSourceAudioPreparer({ extract = extractMp4Audio, encode = encodeSourceMp3,
  timeoutMs = 15 * 60 * 1000 } = {}) {
  const completed = new WeakMap();
  return async function prepare(source, { signal, duration, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!(source instanceof Blob) || !source.size) throw failure('SOURCE_AUDIO_REQUIRED', 'Kaynak medya dosyası eksik.');
    if (isMp3(source)) {
      onProgress({ phase: 'cached', loaded: source.size, total: source.size, mimeType: source.type });
      return checkedMp3(source);
    }
    const previous = completed.get(source);
    if (previous) { onProgress({ phase: 'cached', loaded: previous.size, total: previous.size, mimeType: previous.type }); return previous; }
    const deadline = new AbortController();
    const ownedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = globalThis.setTimeout(() => deadline.abort(failure('LOCAL_AUDIO_PREPARATION_TIMEOUT', 'Cihazda MP3 hazırlama zaman aşımına uğradı.')), timeoutMs);
    let cancel;
    const stopped = new Promise((_, reject) => {
      cancel = () => reject(ownedSignal.reason);
      ownedSignal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const operation = (async () => {
        const audio = /^audio\//i.test(source.type) ? source :
          await extract(source, { signal: ownedSignal, onProgress, timeoutMs });
        ownedSignal.throwIfAborted();
        onProgress({ phase: 'audio_extracted', loaded: audio?.size || 0, total: audio?.size || 0 });
        return checkedMp3(await encode(audio || source, { signal: ownedSignal, duration, onProgress }));
      })();
      const mp3 = await Promise.race([operation, stopped]);
      ownedSignal.throwIfAborted();
      completed.set(source, mp3);
      return mp3;
    } catch (error) {
      if (ownedSignal.aborted) throw ownedSignal.reason;
      if (error.code) throw error;
      throw failure('LOCAL_AUDIO_UNSUPPORTED', 'Bu dosyanın sesi cihazda MP3’e dönüştürülemedi. Desteklenen bir MP4 veya ayrı ses dosyası kullan.');
    } finally {
      globalThis.clearTimeout(timer);
      ownedSignal.removeEventListener('abort', cancel);
    }
  };
}
