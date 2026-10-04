import { extractMp4Audio } from './mp4-audio.js';
import { MAX_AUDIO_BYTES } from './media-limits.js';

const DECODE_LIMIT = 128 * 1024 * 1024;
const MAX_DECODE_SECONDS = 15 * 60;
const failure = (code, message) => Object.assign(new Error(message), { code });

function audioOnly(file) {
  if (!(file instanceof Blob) || !file.size || !/^audio\//i.test(file.type)) {
    throw failure('SOURCE_AUDIO_REQUIRED', 'Kaynak ses cihazda ayrılamadı. Ses kanalına sahip bir MP4 seç veya ayrı ses dosyası kullan.');
  }
  if (file.size > MAX_AUDIO_BYTES) throw failure('SOURCE_AUDIO_TOO_LARGE', 'Ayrılan ses dosyası 250 MiB sınırını aşıyor.');
  return file;
}

function untilCancelled(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(work).then(value => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

// Preserve the decoded soundtrack's stereo channels and amplitude. Only the
// fallback is resampled to 24 kHz PCM; regular MP4 AAC is copied losslessly.
export async function decodedAudioWav(decoded, { duration, signal, onProgress = () => {} } = {}) {
  const rate = Math.min(24000, decoded.sampleRate);
  const channels = Math.min(2, decoded.numberOfChannels);
  if (!(decoded.duration > 0) || !(rate > 0) || !(channels > 0)) throw failure('SOURCE_AUDIO_EMPTY', 'Kaynak dosyada okunabilir ses bulunamadı.');
  const timeline = Math.max(decoded.duration, Number(duration) || 0);
  const frames = Math.ceil(timeline * rate);
  const size = frames * channels * 2;
  if (!Number.isSafeInteger(size) || size + 44 > MAX_AUDIO_BYTES) throw failure('SOURCE_AUDIO_TOO_LARGE', 'Ayrılan ses dosyası 250 MiB sınırını aşıyor.');
  const header = new Uint8Array(44), view = new DataView(header.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, size + 36, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, size, true);
  const inputs = Array.from({ length: channels }, (_, channel) => decoded.getChannelData(channel));
  const parts = [header];
  for (let start = 0; start < frames;) {
    signal?.throwIfAborted();
    const end = Math.min(frames, start + 16384), bytes = new Uint8Array((end - start) * channels * 2);
    const data = new DataView(bytes.buffer);
    for (let i = start; i < end; i++) {
      const sourceIndex = Math.floor(i * decoded.sampleRate / rate);
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, inputs[channel][sourceIndex] || 0));
        data.setInt16(((i - start) * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
    }
    parts.push(bytes); start = end;
    onProgress({ phase: 'encoding', loaded: start, total: frames });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return new File(parts, 'source-audio.wav', { type: 'audio/wav' });
}

export function createSourceAudioPreparer({ extract = extractMp4Audio,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  timeoutMs = 15 * 60 * 1000 } = {}) {
  const completed = new WeakMap();
  return async function prepare(source, { signal, duration, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!(source instanceof Blob) || !source.size) throw failure('SOURCE_AUDIO_REQUIRED', 'Kaynak medya dosyası eksik.');
    if (/^audio\//i.test(source.type)) return audioOnly(source);
    const previous = completed.get(source);
    if (previous) { onProgress({ phase: 'cached', loaded: previous.size, total: previous.size }); return previous; }
    const deadline = new AbortController();
    const ownedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = globalThis.setTimeout(() => deadline.abort(failure('LOCAL_AUDIO_PREPARATION_TIMEOUT', 'Cihazda ses ayırma zaman aşımına uğradı.')), timeoutMs);
    let context;
    const close = () => { if (context) void Promise.resolve(context.close()).catch(() => {}); };
    ownedSignal.addEventListener('abort', close, { once: true });
    try {
      let audio = await extract(source, { signal: ownedSignal, onProgress, timeoutMs });
      ownedSignal.throwIfAborted();
      if (!audio) {
        if (source.size > DECODE_LIMIT || Number(duration) > MAX_DECODE_SECONDS || !AudioContextClass) {
          throw failure('LOCAL_AUDIO_UNSUPPORTED', 'Bu dosyanın sesi cihazda ayrılamıyor. AAC ses içeren standart MP4 veya ayrı bir ses dosyası kullan.');
        }
        onProgress({ phase: 'decoding', loaded: 0, total: 0 });
        context = new AudioContextClass();
        const bytes = await untilCancelled(() => source.arrayBuffer(), ownedSignal);
        const decoded = await untilCancelled(() => context.decodeAudioData(bytes), ownedSignal);
        audio = await decodedAudioWav(decoded, { duration, signal: ownedSignal, onProgress });
      }
      ownedSignal.throwIfAborted();
      audioOnly(audio);
      completed.set(source, audio);
      return audio;
    } catch (error) {
      if (ownedSignal.aborted) throw ownedSignal.reason;
      if (error.code) throw error;
      throw failure('LOCAL_AUDIO_UNSUPPORTED', 'Bu dosyanın sesi cihazda ayrılamadı. AAC ses içeren standart MP4 veya ayrı bir ses dosyası kullan.');
    } finally {
      globalThis.clearTimeout(timer);
      ownedSignal.removeEventListener('abort', close);
      if (context) await Promise.resolve(context.close()).catch(() => {});
    }
  };
}
