// Experimental "analyze with the video itself" mode: make a small analysis
// copy of the source on the phone (hardware WebCodecs via mediabunny), so the
// upload to Gemini is tens of MB instead of a full-size movie.
import { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  Conversion, Quality, canEncodeVideo, canEncodeAudio } from 'mediabunny';

// Phones encode H.264/AAC in hardware; browsers without those encoders fall
// back to WebM (VP9 or VP8 with Opus). Gemini accepts both containers.
const PROFILES = [
  { video: 'avc', audio: 'aac', type: 'video/mp4', name: 'analysis-proxy.mp4', format: () => new Mp4OutputFormat({ fastStart: 'in-memory' }) },
  { video: 'vp9', audio: 'opus', type: 'video/webm', name: 'analysis-proxy.webm', format: () => new WebMOutputFormat() },
  { video: 'vp8', audio: 'opus', type: 'video/webm', name: 'analysis-proxy.webm', format: () => new WebMOutputFormat() }
];

export const PROXY_MAX_BYTES = 400 * 1024 * 1024;

export async function createAnalysisProxy(file, { signal, onProgress = () => {}, width = 480, frameRate = 4 } = {}) {
  signal?.throwIfAborted();
  let profile = null;
  for (const candidate of PROFILES) {
    if (await canEncodeVideo(candidate.video).catch(() => false)) { profile = candidate; break; }
  }
  if (!profile) throw Object.assign(new Error('Bu cihaz videonun küçük analiz kopyasını oluşturamıyor.'), { code: 'PROXY_UNSUPPORTED' });
  const audioCodec = await canEncodeAudio(profile.audio).catch(() => false) ? profile.audio : null;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: profile.format(), target });
  let conversion;
  const cancel = () => { void conversion?.cancel().catch(() => {}); input.dispose(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw Object.assign(new Error('Videoda görüntü kanalı bulunamadı.'), { code: 'PROXY_NO_VIDEO' });
    const audio = await input.getPrimaryAudioTrack();
    const sourceWidth = Number(await video.getDisplayWidth().catch(() => 0)) || width;
    conversion = await Conversion.init({ input, output, tracks: 'primary', showWarnings: false,
      video: { width: Math.max(2, Math.floor(Math.min(width, sourceWidth) / 2) * 2), frameRate, codec: profile.video,
        quality: new Quality({ bitrate: 350000 }), forceTranscode: true },
      audio: audio && audioCodec ? { codec: audioCodec, numberOfChannels: 1, sampleRate: audioCodec === 'opus' ? 48000 : 22050,
        quality: new Quality({ bitrate: 32000 }), forceTranscode: true } : { discard: true } });
    signal?.throwIfAborted();
    if (!conversion.isValid) {
      throw Object.assign(new Error('Bu cihaz videonun küçük analiz kopyasını oluşturamıyor.'), { code: 'PROXY_UNSUPPORTED' });
    }
    conversion.onProgress = value => onProgress({ loaded: Math.min(1, Math.max(0, value)), total: 1 });
    await conversion.execute();
    signal?.throwIfAborted();
    const size = target.buffer?.byteLength || 0;
    if (!size) throw Object.assign(new Error('Analiz kopyası boş çıktı.'), { code: 'PROXY_EMPTY' });
    if (size > PROXY_MAX_BYTES) throw Object.assign(new Error('Analiz kopyası çok büyük.'), { code: 'PROXY_TOO_LARGE' });
    return new File([target.buffer], profile.name, { type: profile.type });
  } finally {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
  }
}
