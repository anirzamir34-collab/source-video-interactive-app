import fs from 'node:fs/promises';
import path from 'node:path';
import { openAsBlob } from 'node:fs';
import { MediaError } from './errors.js';
import { toSrt, toWebVtt } from './subtitles.js';

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(done, ms);
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  signal?.addEventListener('abort', abort, { once: true });
});
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);

export function createDirectDubbing({ config, request, fetchImpl = globalThis.fetch }) {
  const base = config.elevenLabs.baseUrl || 'https://api.elevenlabs.io';
  const headers = () => ({ 'xi-api-key': config.elevenLabs.apiKey });
  const endpoint = (projectId, suffix = '') => `${base}/v1/dubbing/project/${encodeURIComponent(projectId)}${suffix}`;
  const poll = async (url, wanted, signal) => {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const row = await request(url, { headers: headers(), signal, retries: 1 });
      if (row.status === wanted) return row;
      if (row.status === 'failed') throw new MediaError('DIRECT_DUBBING_FAILED',
        'ElevenLabs doğrudan dublaj işlemi başarısız oldu. Aynı projeyi yeniden denemeden önce hesabındaki durumunu kontrol et.');
      await pause(3500, signal);
    }
    throw new MediaError('DIRECT_DUBBING_PENDING',
      'ElevenLabs dublajı henüz bitmedi. Aynı işlemi yeniden denediğinde mevcut proje sorgulanır.', { retryable: true });
  };
  return async function dub({ audioPath, directory, jobId, resume, signal, onProject, onProgress }) {
    if (!config.elevenLabs.apiKey) throw new MediaError('ELEVENLABS_NOT_CONFIGURED', 'ElevenLabs API anahtarı gerekli.');
    let projectId = resume?.projectId, languageId = resume?.languageId;
    if (resume?.creating && !projectId) throw new MediaError('DUBBING_PROJECT_UNCERTAIN',
      'ElevenLabs projesinin oluşturulup oluşturulmadığı doğrulanamadı. Yeniden ücretlenmemek için ElevenLabs hesabındaki projeleri kontrol et.');
    if (!projectId) {
      // Mark the charge boundary before the POST; an interrupted request cannot be reissued blindly.
      await onProject({ creating: true });
      const file = await openAsBlob(audioPath, { type: 'audio/mpeg' });
      const form = new FormData();
      form.set('file', file, 'source.mp3');
      form.set('reference', `VideoQuest ${jobId}`);
      form.set('model_id', 'dubbing_v2');
      form.set('target_language', 'tr');
      const created = await request(`${base}/v1/dubbing/project`, {
        method: 'POST', headers: headers(), body: form, signal, retries: 0, requestTimeoutMs: 10 * 60 * 1000,
      });
      if (!validId(created.project_id)) throw new MediaError('DIRECT_DUBBING_INVALID_PROJECT', 'ElevenLabs proje kimliği geçersiz.');
      projectId = created.project_id;
      languageId = created.language_ids?.[0];
      await onProject({ projectId, languageId, creating: false });
    }
    const project = await poll(endpoint(projectId), 'ready', signal);
    if (!languageId) {
      languageId = project.language_ids?.[0];
      if (!validId(languageId)) {
        // Never create a second language target automatically: it may generate another bill.
        throw new MediaError('DIRECT_DUBBING_MISSING_TARGET', 'Türkçe dublaj hedefi bulunamadı; ElevenLabs projesini kontrol et.');
      }
      await onProject({ projectId, languageId, creating: false });
    }
    await onProgress?.();
    const target = await poll(endpoint(projectId, `/language/${encodeURIComponent(languageId)}`), 'completed', signal);
    const transcript = await request(endpoint(projectId, `/language/${encodeURIComponent(languageId)}/transcript`),
      { headers: headers(), signal });
    if (!Array.isArray(transcript.segments)) throw new MediaError('DIRECT_DUBBING_NO_TRANSCRIPT',
      'ElevenLabs Türkçe konuşma zamanlarını döndürmedi.');
    const rows = transcript.segments.map((row, index) => ({
      segmentId: String(row.id || `dub-${index}`), speakerId: String(row.speaker_id || 'speaker_0'),
      start: Number(row.start_s), end: Number(row.end_s),
      sourceText: String(row.source_text || '').trim(), text: String(row.translation || '').trim(),
    }));
    if (rows.some(row => !Number.isFinite(row.start) || !Number.isFinite(row.end) ||
      row.start < 0 || row.end <= row.start || !row.text))
      throw new MediaError('DIRECT_DUBBING_INVALID_TRANSCRIPT', 'Türkçe altyazı zamanları geçersiz.');
    if (!target.outputs?.lossless_audio) throw new MediaError('DIRECT_DUBBING_NO_AUDIO', 'ElevenLabs Türkçe ses bağlantısını döndürmedi.');
    const download = new URL(target.outputs.lossless_audio);
    if (download.protocol !== 'https:' || download.hostname !== 'storage.googleapis.com' ||
      !download.pathname.startsWith('/eleven-dubbing/'))
      throw new MediaError('DIRECT_DUBBING_INVALID_AUDIO_URL', 'ElevenLabs ses bağlantısı güvenli değil.');
    const response = await fetchImpl(download, { signal, redirect: 'error' });
    if (!response.ok) throw new MediaError('DIRECT_DUBBING_AUDIO_UNAVAILABLE', 'Türkçe dublaj sesi indirilemedi.');
    const dubbedPath = path.join(directory, 'direct-dubbing.flac');
    if (!response.body?.getReader) throw new MediaError('DIRECT_DUBBING_AUDIO_INVALID', 'Türkçe ses akışı geçersiz.');
    const output = await fs.open(dubbedPath, 'w', 0o600);
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 500_000_000) {
          await reader.cancel();
          throw new MediaError('DIRECT_DUBBING_AUDIO_INVALID', 'Türkçe ses dosyası çok büyük.');
        }
        await output.write(value);
      }
    } finally { await output.close(); }
    if (!size) throw new MediaError('DIRECT_DUBBING_AUDIO_INVALID', 'Türkçe dublaj sesi boş.');
    const cues = rows.map(row => ({ cueId: row.segmentId, segmentId: row.segmentId,
      speakerId: row.speakerId, start: row.start, end: row.end, text: row.text, words: [] }));
    const subtitles = { source_tr: cues, dub_tr: cues };
    const artifacts = {};
    for (const [name, track] of Object.entries(subtitles)) {
      artifacts[`${name}.srt`] = Buffer.from(toSrt(track), 'utf8');
      artifacts[`${name}.vtt`] = Buffer.from(toWebVtt(track), 'utf8');
    }
    return { rows, subtitles, artifacts, dubbedPath, projectId, languageId };
  };
}
