import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SAMPLE_RATE = 48000;
const SAMPLE_TOLERANCE = 2 / SAMPLE_RATE;
const SEGMENT_RANGE_TOLERANCE = 0.1;
const MAX_PROBE_TEXT = 64 * 1024;

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
    const duration = await sourceTimelineDuration(file, signal);
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
    const duration = await probeDuration(sourcePath, { signal });
    const turns = [];
    for (const row of voiceSegments) {
      const index = row?.dialogue_input_index;
      const rawStart = row?.start_time_seconds;
      const rawEnd = row?.end_time_seconds;
      if (!Number.isSafeInteger(index) || index < 0 || index >= inputCount || !Number.isFinite(rawStart) ||
          !Number.isFinite(rawEnd) || rawStart < -SEGMENT_RANGE_TOLERANCE || rawStart >= duration ||
          rawEnd <= rawStart || rawEnd > duration + SEGMENT_RANGE_TOLERANCE) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'A generated voice segment is outside its input or audio range.', {
          dialogueInputIndex: index, startTimeSeconds: rawStart, endTimeSeconds: rawEnd, audioDuration: duration
        });
      }
      // ElevenLabs can return timestamps a few milliseconds beyond the decoded
      // WAV boundary because provider/container timestamps and decoded samples
      // are represented with different clocks. Normalize only a small boundary
      // drift; a materially invalid range remains a hard error.
      const start = Math.max(0, rawStart);
      const end = Math.min(duration, rawEnd);
      if (end <= start) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'A generated voice segment collapses after timestamp normalization.', {
          dialogueInputIndex: index, startTimeSeconds: rawStart, endTimeSeconds: rawEnd, audioDuration: duration
        });
      }
      const previous = turns.at(-1);
      if (previous && (index < previous.dialogueInputIndex || start < previous.end - SAMPLE_TOLERANCE)) {
        throw problem('DIALOGUE_TURN_MAP_INVALID', 'Generated dialogue voice segments overlap or are out of order.');
      }
      if (previous?.dialogueInputIndex === index) previous.end = end;
      else turns.push({ dialogueInputIndex: index, start, end });
    }
    if (turns.length !== inputCount || turns.some((row, index) => row.dialogueInputIndex !== index)) {
      throw problem('DIALOGUE_TURN_MAP_INCOMPLETE', 'Every supplied dialogue input needs its own generated audio range.');
    }
    return withWorkspace(directory, 'turns', signal, async work => {
      const results = [];
      for (const turn of turns) {
        const audioPath = path.join(work, `turn-${turn.dialogueInputIndex}.wav`);
        await run(ffmpegPath, [...baseArgs(), ...inputArgs(sourcePath), '-map', '0:a:0', '-vn', '-af',
          `atrim=start=${turn.start}:end=${turn.end},asetpts=PTS-STARTPTS`, ...wavArgs(audioPath)], { signal });
        const actual = await verifyFile(audioPath, signal);
        if (Math.abs(actual - (turn.end - turn.start)) > SAMPLE_TOLERANCE) {
          throw problem('DIALOGUE_TURN_AUDIO_INCOMPLETE', 'A generated dialogue turn could not be extracted completely.');
        }
        results.push({ ...turn, audioPath, duration: actual });
      }
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

  async function fitDubSegment(file, { targetDuration, maxTempo = 1.08, directory, signal } = {}) {
    const inputPath = localPath(file);
    const target = positiveSeconds(targetDuration, 'Target duration');
    if (!Number.isFinite(maxTempo) || maxTempo < 1 || maxTempo > 1.08) {
      throw problem('DUB_TEMPO_INVALID', 'Dub tempo may increase by at most eight percent.');
    }
    const actualDuration = await probeDuration(inputPath, { signal });
    const regenerate = requiredTempo => problem('DUB_REGENERATE_REQUIRED',
      'The translated speech is too long for its source interval and must be regenerated.', {
        regenerateNeeded: true, actualDuration, targetDuration: target, requiredTempo, maxTempo
      });
    let tempo = Math.max(1, actualDuration / target);
    if (tempo > maxTempo + SAMPLE_TOLERANCE / target) throw regenerate(tempo);
    tempo = Math.min(tempo, maxTempo);
    return withWorkspace(directory || path.dirname(inputPath), 'fit', signal, async work => {
      const fittedPath = path.join(work, 'fitted.wav');
      const outputPath = path.join(work, 'audio.wav');
      let fittedDuration;
      for (let attempt = 0; attempt < 3; attempt++) {
        await run(ffmpegPath, [...baseArgs(), ...inputArgs(inputPath), '-map', '0:a:0', '-vn', '-af',
          `aresample=${SAMPLE_RATE}${tempo > 1 ? `,atempo=${tempo.toFixed(9)}` : ''}`,
          ...wavArgs(fittedPath)], { signal });
        fittedDuration = await verifyFile(fittedPath, signal);
        if (fittedDuration <= target + SAMPLE_TOLERANCE) break;
        const revised = tempo * fittedDuration / target * 1.00001;
        if (revised > maxTempo || attempt === 2) throw regenerate(revised);
        tempo = revised;
      }
      // apad adds only silence. There is deliberately no -t or atrim: neither
      // a spoken word nor an alignment tail is cut to pretend the dub fits.
      const targetSamples = Math.round(target * SAMPLE_RATE);
      await run(ffmpegPath, [...baseArgs(), ...inputArgs(fittedPath), '-map', '0:a:0', '-vn', '-af',
        `apad=whole_len=${targetSamples}`, ...wavArgs(outputPath)], { signal });
      const duration = await verifyFile(outputPath, signal);
      if (duration > target + SAMPLE_TOLERANCE || Math.abs(duration - target) > SAMPLE_TOLERANCE) {
        throw regenerate(tempo);
      }
      await rm(fittedPath, { force: true });
      return { path: outputPath, duration, mimeType: 'audio/wav', tempo,
        padded: fittedDuration < target - SAMPLE_TOLERANCE };
    });
  }

  async function mixAudio({ sourceAudio, dubSegments, duration, directory, backgroundPath, signal } = {}) {
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
      const outputPath = path.join(work, 'turkish-mix.wav');
      const graphPath = path.join(work, 'mix.filter');
      const intervals = [];
      for (const row of timed) {
        const previous = intervals.at(-1);
        if (previous && row.start <= previous.end) previous.end = Math.max(previous.end, row.end);
        else intervals.push({ start: row.start, end: row.end });
      }
      const mute = intervals.map(row => `between(t,${row.start},${row.end})`).join('+');
      const bedFilters = [`aresample=${SAMPLE_RATE}:async=1:first_pts=0`,
        `aformat=sample_fmts=fltp:channel_layouts=stereo`, `apad=whole_dur=${target}`, `atrim=duration=${target}`,
        'asetpts=PTS-STARTPTS'];
      if (!backgroundPath && mute) {
        // aeval evaluates every sample. Frame-based volume expressions can leak
        // the original language for a frame at the beginning of a spoken turn.
        bedFilters.push(`aeval=exprs='val(0)*if(${mute},0,1)|val(1)*if(${mute},0,1)':c=stereo`);
      }
      const graph = [`[0:a]${bedFilters.join(',')}[bed]`];
      for (const [index, row] of timed.entries()) {
        const delaySamples = Math.round(row.start * SAMPLE_RATE);
        graph.push(`[${index + 1}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo,` +
          'loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,asetpts=PTS-STARTPTS,' +
          `adelay=${delaySamples}S:all=1[dub${index}]`);
      }
      const inputs = ['[bed]', ...timed.map((_, index) => `[dub${index}]`)].join('');
      graph.push(`${inputs}amix=inputs=${timed.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
        'alimiter=limit=0.95:level=0:latency=1[mixed]');
      await writeFile(graphPath, graph.join(';\n'));
      await run(ffmpegPath, [...baseArgs(), ...inputArgs(bedPath),
        ...timed.flatMap(row => inputArgs(row.audioPath)), '-filter_complex_threads', '1', '-filter_complex_script', graphPath,
        '-map', '[mixed]', ...wavArgs(outputPath)], { signal });
      const actual = await verifyFile(outputPath, signal);
      if (Math.abs(actual - target) > SAMPLE_TOLERANCE) {
        throw problem('DUB_MIX_DURATION_INVALID', 'The final mix does not match the source-video duration.', {
          duration: target, actualDuration: actual
        });
      }
      await rm(graphPath, { force: true });
      return { path: outputPath, duration: actual, mimeType: 'audio/wav', qa: {
        mixMode: backgroundPath ? 'separated-background' : 'speech-ducking',
        originalSpeechMuted: !backgroundPath,
        preservesOriginalNonSpeech: !backgroundPath,
        preservesMusicDuringSpeech: Boolean(backgroundPath),
        normalization: 'loudnorm', peakLimit: 0.95,
        limitation: backgroundPath ? '' : 'Without separated background audio, music and ambience are muted during source speech.'
      } };
    });
  }

  return { probeDuration, extractSource, splitDialogueTurns, joinDialogueParts, fitDubSegment, mixAudio };
}
