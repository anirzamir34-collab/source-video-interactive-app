import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { MAX_AUDIO_BYTES } from '../public/media-limits.js';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_PROBE_TEXT_BYTES = 16 * 1024;
const MP3_DURATION_TOLERANCE_SECONDS = 0.2;

function localPath(file) {
  if (typeof file?.path !== 'string' || !file.path) throw new TypeError('Yerel ses dosyasının yolu eksik.');
  return file.path;
}

function runFfmpeg(ffmpegPath, args, { signal, timeoutMs, onStdout, onStderr } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', onStdout ? 'pipe' : 'ignore', 'pipe'] });
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
    if (onStdout) child.stdout.on('data', chunk => onStdout(chunk.toString()));
    // Consume process output as a stream, retaining only bounded probe text.
    if (onStderr) child.stderr.on('data', chunk => onStderr(chunk.toString()));
    else child.stderr.resume();
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
}

async function validatePreparedAudio(outputPath) {
  const { size } = await stat(outputPath);
  if (!size || size >= MAX_AUDIO_BYTES) throw new Error('Hazırlanan ses boş veya 250 MB ses sınırını aşıyor.');
  return size;
}

// Probe the seekable source without loading its bytes or decoding its full
// soundtrack. Containers with no duration fall back to streamed audio timing.
export async function probeLocalAudioDuration(file, {
  ffmpegPath, signal, timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const inputPath = localPath(file);
  const deadline = Date.now() + timeoutMs;
  let duration = 0;
  let estimatedDuration = false;
  let probeText = '';
  await runFfmpeg(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'info',
    '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-map', '0:a:0', '-vn', '-t', '0', '-f', 'null', '-'
  ], { signal, timeoutMs, onStderr: chunk => {
    probeText = (probeText + chunk).slice(-MAX_PROBE_TEXT_BYTES);
    if (/Estimating duration from bitrate, this may be inaccurate/i.test(probeText)) estimatedDuration = true;
    const match = probeText.match(/(?:^|\n)  Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  } });
  signal?.throwIfAborted();
  if (!estimatedDuration && Number.isFinite(duration) && duration > 0) return duration;

  duration = 0;
  let pending = '';
  await runFfmpeg(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    '-af', 'asetpts=PTS-STARTPTS', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'
  ], { signal, timeoutMs: Math.max(1, deadline - Date.now()), onStdout: chunk => {
    pending = (pending + chunk).slice(-MAX_PROBE_TEXT_BYTES);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const match = line.match(/^out_time_us=(\d+)$/);
      if (match) duration = Math.max(duration, Number(match[1]) / 1_000_000);
    }
  } });
  signal?.throwIfAborted();
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Ses kaynağının süresi belirlenemedi.');
  return duration;
}

// Extract each requested source interval to its own bounded disk file. Input
// seeking is accurate during transcoding, and the source remains untouched.
export async function prepareDialogueAudioWindow(file, {
  ffmpegPath, startTime, endTime, signal, timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const inputPath = localPath(file);
  const start = Number(startTime), end = Number(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new RangeError('Ses aralığının başlangıç ve bitiş zamanları geçersiz.');
  }
  const outputPath = `${inputPath}.dialogue-${randomUUID()}.mp3`;
  const deadline = Date.now() + timeoutMs;
  try {
    await runFfmpeg(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', inputPath,
      '-t', String(end - start), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1',
      '-fs', String(MAX_AUDIO_BYTES), outputPath
    ], { signal, timeoutMs });
    signal?.throwIfAborted();
    const size = await validatePreparedAudio(outputPath);
    const duration = await probeLocalAudioDuration({ path: outputPath }, {
      ffmpegPath, signal, timeoutMs: Math.max(1, deadline - Date.now())
    });
    if (Math.abs(duration - (end - start)) > MP3_DURATION_TOLERANCE_SECONDS) {
      throw new Error('Hazırlanan ses istenen kaynak aralığının tamamını kapsamıyor.');
    }
    signal?.throwIfAborted();
    return { path: outputPath, originalname: 'video-dialogue-window.mp3',
      mimetype: 'audio/mpeg', size, startTime: start, endTime: end, duration };
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }
}

// Decode from a seekable disk file, never a multi-GB Buffer in Node or the phone.
export async function prepareLocalDialogueAudio(file, {
  ffmpegPath, signal, timeoutMs = DEFAULT_TIMEOUT_MS, audioInput = false, bitrate = '64k'
} = {}) {
  const inputPath = localPath(file);
  const outputPath = `${inputPath}.dialogue.mp3`;
  try {
    await runFfmpeg(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,pipe',
      ...(audioInput ? [] : ['-format_whitelist', 'mov,matroska,webm,ogg']),
      '-i', inputPath, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', bitrate, '-map_metadata', '-1',
      '-fs', String(MAX_AUDIO_BYTES), outputPath
    ], { signal, timeoutMs });
    signal?.throwIfAborted();
    const size = await validatePreparedAudio(outputPath);
    return { path: outputPath, originalname: 'video-dialogue.mp3', mimetype: 'audio/mpeg', size };
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }
}
