import { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp3OutputFormat,
  Conversion, Quality, AudioSample } from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { MAX_AUDIO_BYTES } from './media-limits.js';

registerMp3Encoder();

// MP3 has no edit lists: preserve a delayed speech start as encoded silence.
export function preserveAudioGaps() {
  let nextTimestamp = 0;
  return sample => {
    const rows = [];
    while (sample.timestamp - nextTimestamp > 1.5 / sample.sampleRate) {
      const frames = Math.min(sample.sampleRate, Math.round((sample.timestamp - nextTimestamp) * sample.sampleRate));
      rows.push(new AudioSample({ format: 'f32-planar', sampleRate: sample.sampleRate,
        numberOfChannels: sample.numberOfChannels, timestamp: nextTimestamp,
        data: new Float32Array(frames * sample.numberOfChannels) }));
      nextTimestamp += frames / sample.sampleRate;
    }
    rows.push(sample);
    nextTimestamp = Math.max(nextTimestamp, sample.timestamp + sample.duration);
    return rows;
  };
}

export async function convertSourceToMp3(file, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  let conversion, outputSize = 0, stopListening;
  const cancel = () => { void conversion?.cancel().catch(() => {}); input.dispose(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    onProgress({ phase: 'decoding', loaded: 0, total: 0 });
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw Object.assign(new Error('Kaynak videoda ses kanalı bulunamadı.'), { code: 'SOURCE_AUDIO_EMPTY' });
    signal?.throwIfAborted();
    conversion = await Conversion.init({ input, output, tracks: 'primary',
      video: { discard: true }, trim: { start: 0 }, showWarnings: false,
      audio: { codec: 'mp3', quality: new Quality({ bitrate: 96000, bitrateMode: 'constant' }),
        sampleRate: 32000, numberOfChannels: Math.min(2, track.numberOfChannels),
        forceTranscode: true, process: preserveAudioGaps() } });
    signal?.throwIfAborted();
    if (!conversion.isValid) throw Object.assign(new Error('Bu dosyanın ses biçimi cihazda çözülemiyor.'), { code: 'LOCAL_AUDIO_UNSUPPORTED' });
    stopListening = target.on('write', ({ end }) => {
      outputSize = Math.max(outputSize, end);
      if (outputSize > MAX_AUDIO_BYTES) void conversion.cancel().catch(() => {});
    });
    conversion.onProgress = value => {
      signal?.throwIfAborted();
      onProgress({ phase: value >= 1 ? 'finalizing_mp3' : 'encoding',
        loaded: Math.min(1, Math.max(0, value)), total: 1, bytes: outputSize });
    };
    await conversion.execute();
    signal?.throwIfAborted();
    if (outputSize > MAX_AUDIO_BYTES) throw Object.assign(new Error('Ayrılan MP3 250 MiB sınırını aşıyor.'), { code: 'SOURCE_AUDIO_TOO_LARGE' });
    if (!target.buffer?.byteLength) throw Object.assign(new Error('Kaynak ses boş.'), { code: 'SOURCE_AUDIO_EMPTY' });
    onProgress({ phase: 'mp3_ready', loaded: 1, total: 1, bytes: target.buffer.byteLength });
    return new File([target.buffer], 'source-audio.mp3', { type: 'audio/mpeg' });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (outputSize > MAX_AUDIO_BYTES) throw Object.assign(new Error('Ayrılan MP3 250 MiB sınırını aşıyor.'), { code: 'SOURCE_AUDIO_TOO_LARGE' });
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    stopListening?.();
    if (conversion && !['done', 'canceled'].includes(conversion.state)) await conversion.cancel().catch(() => {});
    input.dispose();
  }
}
