import { spawn } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { MAX_AUDIO_BYTES } from '../public/media-limits.js';

// Decode from a seekable disk file, never a multi-GB Buffer in Node or the phone.
export async function prepareLocalDialogueAudio(file, { ffmpegPath, signal, timeoutMs = 20 * 60 * 1000 } = {}) {
  const outputPath = `${file.path}.dialogue.mp3`;
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,ogg',
        '-i', file.path, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1',
        '-fs', String(MAX_AUDIO_BYTES), outputPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let failure;
      let killTimer;
      const stop = error => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        killTimer.unref();
      };
      const onAbort = () => stop(signal.reason || new Error('Ses hazırlama iptal edildi.'));
      const timer = setTimeout(() => stop(new Error('Konuşma sesi hazırlanırken süre doldu. Tekrar dene.')), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // Drain errors without retaining source metadata or unbounded process output.
      child.stderr.resume();
      child.once('error', error => { failure ||= error; });
      child.once('close', code => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('Videonun konuşma sesi hazırlanamadı; dosyanın ses kanalını kontrol et.'));
        else resolve();
      });
    });
    signal?.throwIfAborted();
    const { size } = await stat(outputPath);
    if (!size || size >= MAX_AUDIO_BYTES) throw new Error('Hazırlanan ses boş veya 250 MB ses sınırını aşıyor.');
    return { path: outputPath, originalname: 'video-dialogue.mp3', mimetype: 'audio/mpeg', size };
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }
}
