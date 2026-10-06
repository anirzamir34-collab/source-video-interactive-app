import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readPcm, copyPcm, fileExists } from './pcm.js';

const SAMPLE_RATE = 48000;
const SAMPLE_TOLERANCE = 2 / SAMPLE_RATE;
const SEGMENT_RANGE_TOLERANCE = 0.1;
const SEGMENT_DRIFT_MAX_SECONDS = 2;
const SEGMENT_DRIFT_MAX_RATIO = 0.15;
const MAX_PROBE_TEXT = 64 * 1024;

function tempoFilters(tempo) {
  if (tempo <= 1) return '';
  // Every stage stays at or below 2: a single larger atempo value skips samples.
  const count = Math.max(1, Math.ceil(Math.log2(tempo)));
  const value = Math.pow(tempo, 1 / count).toFixed(9);
  return Array(count).fill(`atempo=${value}`).join(',');
}

function problem(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function localPath(file) {
  const value = typeof file === 'string' ? file : file?.path || file?.audioPath;
  if (typeof value !== 'string' || !value.trim() || /\0|^https?:\/\//i.test(value)) {
    throw problem('LOCAL_AUDIO_REQUIRED', 'A local source audio or video file is required.');
  }
  return path.resolve(value);
}

function positiveSeconds(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw problem('INVALID_AUDIO_DURATION', `${name} must be a positive duration in seconds.`);
  }
  return result;
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason || problem('AUDIO_CANCELLED', 'Audio work was cancelled.');
}

function ratio(value) {
  const parts = String(value || '').split('/').map(Number);
  return parts.length === 2 && parts[1] > 0 ? parts[0] / parts[1] : NaN;
}

// Every provider uses this service. Providers do not launch media processes or
// change the source timeline themselves. Returned files belong to the caller;
// failed/cancelled operations remove their complete private working directory.
export function createAudioService({
  ffmpegPath,
  ffprobePath = null,
  spawn = nodeSpawn,
  timeoutMs = 20 * 60 * 1000,
  killGraceMs = 3000,
  directory: defaultDirectory = path.join(os.tmpdir(), 'videoquest-media'),
  sttCodec = 'flac',
  sttChannels = 1,
  sttSampleRate = SAMPLE_RATE,
  sttBitrate = '128k'
} = {}) {
  if (typeof ffmpegPath !== 'string' || !ffmpegPath) throw new TypeError('ffmpegPath is required.');
  if (!['flac', 'aac'].includes(sttCodec)) throw new TypeError('sttCodec must be flac or aac.');
  if (![1, 2].includes(sttChannels) || !Number.isInteger(sttSampleRate) || sttSampleRate < 16000 || sttSampleRate > 48000) {
    throw new TypeError('Unsupported STT audio channel count or sample rate.');
  }
  if (!(Number(timeoutMs) > 0) || !(Number(killGraceMs) >= 0)) throw new TypeError('Invalid audio process timeout.');

  async function run(binary, args, { signal, countStdout = false } = {}) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let child;
      let deadline;
      let killTimer;
      let failure;
      let settled = false;
      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ stdout, stdoutBytes, stderr });
      };
      const stop = error => {
        if (settled || failure) return;
        failure = error;
        if (child && child.exitCode == null && child.signalCode == null) {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (!settled && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
          }, killGraceMs);
          killTimer.unref?.();
        }
      };
      const abort = () => stop(signal.reason || problem('AUDIO_CANCELLED', 'Audio work was cancelled.'));
      try {
        child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', data => {
          stdoutBytes += data.length;
          if (!countStdout) stdout = (stdout + data.toString()).slice(-MAX_PROBE_TEXT);
        });
        child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
        child.once('error', error => finish(problem('AUDIO_PROCESS_START_FAILED', 'The media process could not start.', {
          cause: error, processCode: error.code
        })));
        child.once('close', (code, signalCode) => {
          if (failure) return finish(failure);
          if (code !== 0) return finish(problem('AUDIO_PROCESS_FAILED', 'The media process failed.', {
            exitCode: code, signalCode, diagnostic: stderr
          }));
          finish();
        });
        deadline = setTimeout(() => stop(problem('AUDIO_PROCESS_TIMEOUT', 'Audio processing timed out.')), timeoutMs);
        deadline.unref?.();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      } catch (error) {
        finish(problem('AUDIO_PROCESS_START_FAILED', 'The media process could not start.', { cause: error }));
      }
    });
  }

  const baseArgs = () => ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1'];
  const inputArgs = file => ['-protocol_whitelist', 'file,pipe', '-i', localPath(file)];
  const wavArgs = file => ['-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_f32le', '-threads', '1', file];

  async function workingDirectory(parent, prefix, signal) {
    checkSignal(signal);
    const directory = path.resolve(parent || defaultDirectory);
    await mkdir(directory, { recursive: true });
    checkSignal(signal);
    return mkdtemp(path.join(directory, `${prefix}-`));
  }

  async function withWorkspace(parent, prefix, signal, work) {
    const directory = await workingDirectory(parent, prefix, signal);
    try {
      const result = await work(directory);
      checkSignal(signal);
      return result;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async function probeMetadata(file, signal) {
    if (!ffprobePath) return null;
    const result = await run(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=codec_name,duration,duration_ts,time_base,sample_rate,start_time:format=duration,start_time',
      '-of', 'json', localPath(file)], { signal });
    try { return JSON.parse(result.stdout); }
    catch { throw problem('AUDIO_PROBE_INVALID', 'The media probe did not return valid metadata.'); }
  }

  async function probeDuration(file, { signal } = {}) {
    checkSignal(signal);
    const pcm = await readPcm(localPath(file));
    if (pcm) return pcm.duration;
    const metadata = await probeMetadata(file, signal);
    const stream = metadata?.streams?.[0];
    // Lossless streams expose an exact sample duration. Compressed/VBR header
    // estimates and a video's longer format duration cannot time a dubbed clip.
    if (/^(?:pcm_|flac$|alac$)/.test(String(stream?.codec_name || ''))) {
      const sampled = Number(stream.duration_ts) * ratio(stream.time_base);
      if (Number.isFinite(sampled) && sampled > 0) return sampled;
      const declared = Number(stream.duration);
      if (Number.isFinite(declared) && declared > 0) return declared;
    }
    return decodedDuration(file, signal);
  }

  async function decodedDuration(file, signal, preserveTimeline = false) {
    // Count decoded samples without retaining the soundtrack in Node memory.
    const decoded = await run(ffmpegPath, [...baseArgs(), ...inputArgs(file), '-map', '0:a:0', '-vn',
      ...(preserveTimeline ? ['-af', `aresample=${SAMPLE_RATE}:async=1:first_pts=0`] : []),
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { signal, countStdout: true });
    const duration = decoded.stdoutBytes / (4 * SAMPLE_RATE);
    if (!Number.isFinite(duration) || duration <= 0 || decoded.stdoutBytes % 4 !== 0) {
      throw problem('AUDIO_EMPTY', 'The source contains no decodable audio samples.');
    }
    return duration;
  }

  async function sourceTimelineDuration(file, signal) {
    if (file && typeof file === 'object' && file.duration != null) return positiveSeconds(file.duration, 'Source duration');
    const metadata = await probeMetadata(file, signal);
    const declared = Number(metadata?.format?.duration);
    if (Number.isFinite(declared) && declared > 0) return declared;
    if (!ffprobePath) {
      const header = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'info', ...inputArgs(file),
        '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { signal });
      const match = header.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const decoded = await decodedDuration(file, signal, true);
      if (match && !/Estimating duration from bitrate/i.test(header.stderr)) {
        const headerDuration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        // FFmpeg's human-readable header rounds to hundredths. Audio-only files
        // use exact samples so rounding can never cut a spoken tail. A video
        // may extend beyond its audio; callers should pass its verified duration
        // or configure ffprobe for an exact complete container timeline.
        return /Stream[^\n]*Video:/.test(header.stderr) ? Math.max(headerDuration, decoded) : decoded;
      }
      return decoded;
    }
    return probeDuration(file, { signal });
  }

  async function verifyFile(file, signal) {
    checkSignal(signal);
    if (!(await stat(file)).size) throw problem('AUDIO_EMPTY', 'The media process returned an empty audio file.');
    return probeDuration(file, { signal });
  }

  async function extractSource(file, { directory, signal } = {}) {
    const sourcePath = localPath(file);
    const measuredTimeline = await sourceTimelineDuration(file, signal);
    // An audio-only MP4 can end before its video's final silent frames. The
    // device sends that clock separately; it may pad silence but never shorten
    // the independently measured audio or alter its edit-list start offset.
    const duration = file?.timelineDuration == null ? measuredTimeline
      : Math.max(measuredTimeline, positiveSeconds(file.timelineDuration, 'Source timeline duration'));
    return withWorkspace(directory, 'source', signal, async work => {
      const originalPath = path.join(work, 'original.wav');
      const sttPath = path.join(work, sttCodec === 'aac' ? 'speech.m4a' : 'speech.flac');
      // Preserve delayed audio starts and source gaps, including container edit
      // lists. The original bed is stereo float PCM: no speech gain, tanh,
      // downmix or 16 kHz STT resampling can affect the final soundtrack.
      await run(ffmpegPath, [...baseArgs(), '-copyts', '-start_at_zero', ...inputArgs(sourcePath),
        '-map', '0:a:0', '-vn', '-af',
        `aresample=async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`,
        ...wavArgs(originalPath)], { signal });
      const actual = await verifyFile(originalPath, signal);
      if (Math.abs(actual - duration) > SAMPLE_TOLERANCE) {
        throw problem('SOURCE_AUDIO_DURATION_MISMATCH', 'Extracted source audio does not cover the source timeline.', {
          duration, actualDuration: actual
        });
      }
      await run(ffmpegPath, [...baseArgs(), ...inputArgs(originalPath), '-map', '0:a:0', '-vn',
        '-ac', String(sttChannels), '-ar', String(sttSampleRate),
        ...(sttCodec === 'aac' ? ['-c:a', 'aac', '-b:a', sttBitrate, '-movflags', '+faststart']
          : ['-c:a', 'flac', '-compression_level', '5']), '-threads', '1', sttPath], { signal });
      const sttDuration = await verifyFile(sttPath, signal);
      if (Math.abs(sttDuration - actual) > 0.05) {
        throw problem('SOURCE_STT_DURATION_MISMATCH', 'Speech input does not cover the complete original audio.');
      }
      return { sttPath, originalPath, duration: actual };
    });
  }

  async function splitDialogueTurns(sceneAudio, { voiceSegments, inputCount, directory, signal } = {}) {
    const sourcePath = localPath(sceneAudio);
    if (!Number.isSafeInteger(inputCount) || inputCount < 1 || !Array.isArray(voiceSegments)) {
      throw problem('DIALOGUE_TURN_MAP_INVALID', 'A complete dialogue input count and voice segment map are required.');
    }
    return withWorkspace(directory, 'turns', signal, async work => {
    let pcm = await readPcm(sourcePath);
    let decodedPath;
    if (!pcm && await fileExists(sourcePath)) {
      decodedPath = path.join(work, 'decoded.wav');
      await run(ffmpegPath, [...baseArgs(), ...inputArgs(sourcePath), '-map', '0:a:0', '-vn', ...wavArgs(decodedPath)], { signal });
      pcm = await readPcm(decodedPath);
      if (!pcm) throw problem('AUDIO_PROBE_INVALID', 'Decoded dialogue did not contain valid PCM samples.');
    }
    const duration = pcm?.duration ?? await probeDuration(sourcePath, { signal });
    const turns = [];
    const rows = voiceSegments.map(row => ({
      index: row?.dialogue_input_index,
      rawStart: row?.start_time_seconds,
      rawEnd: row?.end_time_seconds,
    }));
    for (const row of rows) {
      if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= inputCount ||
          !Number.isFinite(row.rawStart) || !Number.isFinite(row.rawEnd) ||
          row.rawStart < -SEGMENT_RANGE_TOLERANCE || row.rawEnd <= row.rawStart) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'A generated voice segment is outside its input or audio range.', {
          dialogueInputIndex: row.index, startTimeSeconds: row.rawStart, endTimeSeconds: row.rawEnd, audioDuration: duration
        });
      }
    }

    // ElevenLabs returns voice-segment timestamps from its generation clock.
    // After a model/output-format change, that clock can drift from the exact
    // decoded duration of the returned file by more than the old 100 ms guard.
    // A small bounded clock drift is safe to normalize globally; a large
    // mismatch remains a hard provider error rather than silently inventing a
    // timeline.
    const maxRawEnd = Math.max(...rows.map(row => row.rawEnd));
    const drift = maxRawEnd - duration;
    let timestampScale = 1;
    if (drift > SEGMENT_RANGE_TOLERANCE) {
      const allowedDrift = Math.min(SEGMENT_DRIFT_MAX_SECONDS, duration * SEGMENT_DRIFT_MAX_RATIO);
      if (drift > allowedDrift) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'A generated voice segment is outside its input or audio range.', {
          startTimeSeconds: rows[0]?.rawStart, endTimeSeconds: maxRawEnd, audioDuration: duration, timestampDrift: drift
        });
      }
      timestampScale = duration / maxRawEnd;
    }

    for (const row of rows) {
      const start = Math.max(0, Math.min(duration, row.rawStart * timestampScale));
      const end = Math.max(0, Math.min(duration, row.rawEnd * timestampScale));
      if (end <= start) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'A generated voice segment collapses after timestamp normalization.', {
          dialogueInputIndex: row.index, startTimeSeconds: row.rawStart, endTimeSeconds: row.rawEnd, audioDuration: duration
        });
      }
      const previous = turns.at(-1);
      if (previous && (row.index < previous.dialogueInputIndex || start < previous.end - SAMPLE_TOLERANCE)) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'Generated dialogue voice segments overlap or are out of order.');
      }
      if (previous?.dialogueInputIndex === row.index) previous.end = end;
      else turns.push({ dialogueInputIndex: row.index, start, end });
    }
    if (turns.length !== inputCount || turns.some((row, index) => row.dialogueInputIndex !== index)) {
      throw problem('DIALOGUE_TURN_MAP_INCOMPLETE', 'Every supplied dialogue input needs its own generated audio range.');
    }
      const results = [];
      for (const turn of turns) {
        const audioPath = path.join(work, `turn-${turn.dialogueInputIndex}.wav`);
        if (pcm) await copyPcm(pcm, audioPath, { start: Math.round(turn.start * pcm.rate),
          end: Math.min(pcm.samples, Math.round(turn.end * pcm.rate)), signal });
        else await run(ffmpegPath, [...baseArgs(), ...inputArgs(sourcePath), '-map', '0:a:0', '-vn', '-af',
          `atrim=start=${turn.start}:end=${turn.end},asetpts=PTS-STARTPTS`, ...wavArgs(audioPath)], { signal });
        const actual = await verifyFile(audioPath, signal);
        if (Math.abs(actual - (turn.end - turn.start)) > SAMPLE_TOLERANCE) {
          throw problem('DIALOGUE_TURN_AUDIO_INCOMPLETE', 'A generated dialogue turn could not be extracted completely.');
        }
        results.push({ ...turn, audioPath, duration: actual });
      }
      if (decodedPath) await rm(decodedPath, { force: true });
      return results;
    });
  }

  async function joinDialogueParts(files, { directory, signal } = {}) {
    if (!Array.isArray(files) || !files.length) throw problem('DIALOGUE_PARTS_REQUIRED', 'Ordered generated dialogue parts are required.');
    const inputs = files.map(localPath);
    let expected = 0;
    for (const file of inputs) expected += await probeDuration(file, { signal });
    return withWorkspace(directory, 'joined-turn', signal, async work => {
      const outputPath = path.join(work, 'dialogue.wav');
      const graph = inputs.map((_file, index) => `[${index}:a]aresample=${SAMPLE_RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[part${index}]`);
      graph.push(inputs.map((_file, index) => `[part${index}]`).join('') + `concat=n=${inputs.length}:v=0:a=1[joined]`);
      await run(ffmpegPath, [...baseArgs(), ...inputs.flatMap(inputArgs), '-filter_complex_threads', '1',
        '-filter_complex', graph.join(';'), '-map', '[joined]', ...wavArgs(outputPath)], { signal });
      const duration = await verifyFile(outputPath, signal);
      if (Math.abs(duration - expected) > SAMPLE_TOLERANCE * inputs.length) {
        throw problem('DIALOGUE_PARTS_DURATION_INVALID', 'Joining generated dialogue parts changed their audio duration.', {
          duration, expectedDuration: expected
        });
      }
      return { path: outputPath, duration };
    });
  }

  async function fitDubSegment(file, { targetDuration, maxTempo = 1.08, speechRange, speechWords,
    adaptiveTempo = false, directory, signal } = {}) {
    let inputPath = localPath(file);
    const targetSamples = Math.max(1, Math.round(positiveSeconds(targetDuration, 'Target duration') * SAMPLE_RATE));
    const target = targetSamples / SAMPLE_RATE;
    if (!Number.isFinite(maxTempo) || maxTempo < 1 || maxTempo > 1.25) {
      throw problem('DUB_TEMPO_INVALID', 'Dublaj tempo sınırı geçersiz.');
    }
    let pcm = await readPcm(inputPath);
    let actualDuration = pcm?.duration ?? await probeDuration(inputPath, { signal });
    let sourceOffset = 0;
    const removedPauses = [];
    if (actualDuration > target && pcm && speechRange && Number.isFinite(speechRange.start) && Number.isFinite(speechRange.end) &&
      speechRange.start >= 0 && speechRange.end > speechRange.start && speechRange.end <= actualDuration + SAMPLE_TOLERANCE) {
      const start = Math.max(0, Math.floor((speechRange.start - .03) * pcm.rate));
      const end = Math.min(pcm.samples, Math.ceil((speechRange.end + .03) * pcm.rate));
      if (end - start < pcm.samples) {
        const trimmed = await withWorkspace(directory || path.dirname(inputPath), 'speech', signal, async work =>
          copyPcm(pcm, path.join(work, 'speech.wav'), { start, end, signal }));
        sourceOffset = start / pcm.rate; inputPath = trimmed.path;
        pcm = await readPcm(inputPath); actualDuration = trimmed.duration;
      }
    }
    // Only remove measured gaps between complete words. Keep 140ms of each
    // pause, and never use an amplitude gate that might delete quiet speech.
    if (pcm && actualDuration > target * maxTempo && Array.isArray(speechWords) && speechWords.length > 1 &&
      speechWords.every((word, i) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= sourceOffset &&
        word.end > word.start && word.end <= sourceOffset + actualDuration + SAMPLE_TOLERANCE &&
        (!i || word.start >= speechWords[i - 1].end))) {
      let needed = Math.ceil((actualDuration - target * maxTempo * .99) * pcm.rate);
      const removals = [];
      for (let i = 1; i < speechWords.length && needed > 0; i++) {
        const left = speechWords[i - 1], right = speechWords[i];
        const start = Math.ceil((left.end + .05 - sourceOffset) * pcm.rate);
        const limit = Math.floor((right.start - .09 - sourceOffset) * pcm.rate);
        const count = Math.min(needed, Math.max(0, limit - start));
        if (count < pcm.rate * .02) continue;
        removals.push({ start, end: start + count }); needed -= count;
        removedPauses.push({ start: sourceOffset + start / pcm.rate, end: sourceOffset + (start + count) / pcm.rate });
      }
      if (removals.length) {
        const ranges = []; let start = 0;
        for (const row of removals) { ranges.push({ start, end: row.start }); start = row.end; }
        ranges.push({ start, end: pcm.samples });
        const compact = await withWorkspace(directory || path.dirname(inputPath), 'pauses', signal, async work =>
          copyPcm(pcm, path.join(work, 'compact.wav'), { ranges, signal }));
        inputPath = compact.path; pcm = await readPcm(inputPath); actualDuration = compact.duration;
      }
    }
    const regenerate = requiredTempo => problem('DUB_REGENERATE_REQUIRED',
      'Türkçe konuşma ayrılan süreye sığmadı; kısa çeviri hazırlanması gerekiyor.', {
        regenerateNeeded: true, actualDuration, targetDuration: target, requiredTempo, maxTempo
      });
    let tempo = Math.max(1, actualDuration / target);
    if (!adaptiveTempo && tempo > maxTempo + SAMPLE_TOLERANCE / target) throw regenerate(tempo);
    if (!adaptiveTempo) tempo = Math.min(tempo, maxTempo);
    return withWorkspace(directory || path.dirname(inputPath), 'fit', signal, async work => {
      const fittedPath = path.join(work, 'fitted.wav');
      const outputPath = path.join(work, 'audio.wav');
      if (pcm?.rate === SAMPLE_RATE && pcm.samples <= targetSamples && tempo === 1) {
        const result = await copyPcm(pcm, outputPath, { samples: targetSamples, signal });
        return { ...result, tempo, sourceOffset, removedPauses, padded: pcm.samples < targetSamples };
      }
      let fittedDuration, fittedPcm;
      for (let attempt = 0; attempt < (adaptiveTempo ? 6 : 3); attempt++) {
        await run(ffmpegPath, [...baseArgs(), ...inputArgs(inputPath), '-map', '0:a:0', '-vn', '-af',
          `aresample=${SAMPLE_RATE}${tempo > 1 ? `,${tempoFilters(tempo)}` : ''}`,
          ...wavArgs(fittedPath)], { signal });
        fittedDuration = await verifyFile(fittedPath, signal);
        fittedPcm = await readPcm(fittedPath);
        const outputSamples = fittedPcm?.rate === SAMPLE_RATE ? fittedPcm.samples : Math.round(fittedDuration * SAMPLE_RATE);
        if (outputSamples <= targetSamples) break;
        // WSOLA output is quantized by analysis windows and waveform phase.
        // A near-unity retry can sit on the same plateau indefinitely. Reserve
        // a small, growing measured margin, then add only silence to the slot.
        const reserve = Math.max(2, Math.min(Math.ceil(SAMPLE_RATE * .01 * 2 ** attempt), Math.floor(targetSamples * .1)));
        const revised = tempo * outputSamples / Math.max(1, targetSamples - reserve);
        if (!adaptiveTempo && (revised > maxTempo || attempt === 2)) throw regenerate(revised);
        if (adaptiveTempo && attempt === 5) throw problem('DUB_FIT_FAILED', 'Ses süresi dönüştürücü tarafından doğrulanamadı.', {
          actualDuration, fittedDuration, targetDuration: target, requiredTempo: tempo, outputSamples, targetSamples });
        tempo = revised;
      }
      // apad adds only silence. There is deliberately no -t or atrim: neither
      // a spoken word nor an alignment tail is cut to pretend the dub fits.
      if (fittedPcm?.rate === SAMPLE_RATE && fittedPcm.samples <= targetSamples)
        await copyPcm(fittedPcm, outputPath, { samples: targetSamples, signal });
      else await run(ffmpegPath, [...baseArgs(), ...inputArgs(fittedPath), '-map', '0:a:0', '-vn', '-af',
        `apad=whole_len=${targetSamples}`, ...wavArgs(outputPath)], { signal });
      const duration = await verifyFile(outputPath, signal);
      if (duration > target + SAMPLE_TOLERANCE || Math.abs(duration - target) > SAMPLE_TOLERANCE) {
        throw regenerate(tempo);
      }
      await rm(fittedPath, { force: true });
      return { path: outputPath, duration, mimeType: 'audio/wav', tempo, sourceOffset, removedPauses,
        adaptiveTempo: tempo > maxTempo,
        padded: fittedDuration < target - SAMPLE_TOLERANCE };
    });
  }

  async function mixAudio({ sourceAudio, dubSegments, duration, directory, backgroundPath, signal, format = 'wav' } = {}) {
    if (!['wav', 'mp3'].includes(format)) throw problem('DUB_MIX_FORMAT_INVALID', 'Dublaj dosya biçimi geçersiz.');
    const sourcePath = localPath(sourceAudio);
    const bedPath = backgroundPath ? localPath(backgroundPath) : sourcePath;
    if (backgroundPath && bedPath === sourcePath) {
      throw problem('SEPARATED_BACKGROUND_REQUIRED', 'A separated background cannot be the original source soundtrack.');
    }
    const target = positiveSeconds(duration, 'Mix duration');
    if (!Array.isArray(dubSegments)) throw problem('DUB_SEGMENTS_REQUIRED', 'Timed dubbed segments are required.');
    const ids = new Set();
    const timed = [];
    for (const row of dubSegments) {
      checkSignal(signal);
      const start = Number(row?.sourceStart ?? row?.start);
      const end = Number(row?.sourceEnd ?? row?.end);
      if (!row?.segmentId || !row?.speakerId || ids.has(row.segmentId) || !Number.isFinite(start) ||
          !Number.isFinite(end) || start < 0 || end <= start || end > target + SAMPLE_TOLERANCE) {
        throw problem('DUB_SOURCE_RANGE_INVALID', 'Each dubbed segment needs its own valid source-video interval.');
      }
      ids.add(row.segmentId);
      const audioPath = localPath(row.audioPath);
      const actual = await probeDuration(audioPath, { signal });
      if (actual > end - start + SAMPLE_TOLERANCE) {
        throw problem('DUB_REGENERATE_REQUIRED', 'A dubbed segment exceeds its source interval; mixing cannot truncate it.', {
          regenerateNeeded: true, segmentId: row.segmentId, actualDuration: actual, targetDuration: end - start
        });
      }
      timed.push({ ...row, start, end, audioPath, actualDuration: actual });
    }
    timed.sort((left, right) => left.start - right.start || left.end - right.end);
    return withWorkspace(directory, 'mix', signal, async work => {
      const outputPath = path.join(work, `turkish-mix.${format}`);
      const graphPath = path.join(work, 'mix.filter');
      const intervals = [];
      const speechIntervals = timed.flatMap(row => [row, { ...row, originalSpeechStart: row.start, originalSpeechEnd: row.end }])
        .sort((a, b) => (a.originalSpeechStart ?? a.start) - (b.originalSpeechStart ?? b.start));
      for (const row of speechIntervals) {
        const start = Number.isFinite(row.originalSpeechStart) ? row.originalSpeechStart : row.start;
        const end = Number.isFinite(row.originalSpeechEnd) ? row.originalSpeechEnd : row.end;
        if (start < 0 || end <= start || end > target + SAMPLE_TOLERANCE)
          throw problem('DUB_SOURCE_RANGE_INVALID', 'Kaynak konuşma aralığı geçersiz.');
        const previous = intervals.at(-1);
        if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
        else intervals.push({ start, end });
      }
      // Decode each source once and mix directly to the requested playback
      // format. The old path copied a full-length float WAV, normalized it,
      // copied it again, ducked another full-length WAV, mixed to a WAV and
      // finally transcoded that WAV to MP3. Long videos spent minutes in I/O.
      const gains = intervals.map(row => {
        const attack = Math.min(.04, (row.end - row.start) / 2), release = Math.min(.08, (row.end - row.start) / 2);
        return `1-0.82*min(1,min(max(0,(t-${row.start})/${attack}),max(0,(${row.end}-t)/${release})))`;
      });
      const mute = gains.reduce((all, gain) => all ? `min(${all},${gain})` : gain, '');
      const bedFilters = [`aresample=${SAMPLE_RATE}:async=1:first_pts=0`,
        `aformat=sample_fmts=fltp:channel_layouts=stereo`, `apad=whole_dur=${target}`, `atrim=duration=${target}`,
        'asetpts=PTS-STARTPTS'];
      if (!backgroundPath && mute) {
        // Apply the same smooth duck envelope to every sample in the fallback
        // decoder path; source speech remains audible beneath the dub.
        bedFilters.push(`aeval=exprs='val(0)*(${mute})|val(1)*(${mute})':c=stereo`);
      }
      const graph = [`[0:a]${bedFilters.join(',')}[bed]`];
      for (const [index, row] of timed.entries()) {
        const delaySamples = Math.round(row.start * SAMPLE_RATE);
        // Decoder fallback inputs need the same soft edges as composePcm.
        // Fade on the segment clock before placing it on the video timeline.
        const fade = Math.min(.005, row.actualDuration / 2);
        const edgeFilters = fade ? `afade=t=in:st=0:d=${fade},` +
          `afade=t=out:st=${row.actualDuration - fade}:d=${fade},` : '';
        graph.push(`[${index + 1}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo,` +
          'volume=1.5,acompressor=threshold=0.125:ratio=2:attack=5:release=100:makeup=1,asetpts=PTS-STARTPTS,' +
          edgeFilters + `adelay=${delaySamples}S:all=1[dub${index}]`);
      }
      if (timed.length) {
        const inputs = ['[bed]', ...timed.map((_, index) => `[dub${index}]`)].join('');
        graph.push(`${inputs}amix=inputs=${timed.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
          'alimiter=limit=0.95:level=0:latency=1[mixed]');
      } else graph.push('[bed]alimiter=limit=0.95:level=0:latency=1[mixed]');
      await writeFile(graphPath, graph.join(';\n'));
      await run(ffmpegPath, [...baseArgs(), ...inputArgs(bedPath),
        ...timed.flatMap(row => inputArgs(row.audioPath)), '-filter_complex_threads', '1', '-filter_complex_script', graphPath,
        '-map', '[mixed]', ...(format === 'mp3'
          ? ['-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k',
            '-write_xing', '1', '-threads', '1', outputPath]
          : wavArgs(outputPath))], { signal });
      const actual = await verifyFile(outputPath, signal);
      if (Math.abs(actual - target) > SAMPLE_TOLERANCE) {
        throw problem('DUB_MIX_DURATION_INVALID', 'The final mix does not match the source-video duration.', {
          duration: target, actualDuration: actual
        });
      }
      await rm(graphPath, { force: true });
      if (!(await stat(outputPath)).size) throw problem('AUDIO_EMPTY', 'Dublaj ses dosyası boş.');
      return { path: outputPath, duration: actual, mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', qa: {
        mixMode: backgroundPath ? 'separated-background' : 'speech-ducking',
        originalSpeechMuted: false, originalSpeechLevel: backgroundPath ? null : .18,
        preservesOriginalNonSpeech: !backgroundPath,
        preservesMusicDuringSpeech: true,
        edgeFadeVersion: 1, normalization: 'single-pass-compressor', peakLimit: 0.95, playbackFormat: format,
        limitation: backgroundPath ? '' : 'Without separated background audio, source speech, music and ambience are reduced together during dubbing.'
      } };
    });
  }

  return { probeDuration, extractSource, splitDialogueTurns, joinDialogueParts, fitDubSegment, mixAudio };
}
