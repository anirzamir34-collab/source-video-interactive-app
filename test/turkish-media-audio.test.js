import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudioService } from '../lib/turkish-media/audio.js';
import { repairSavedAudio } from '../public/saved-audio.js';
import { fitNativeDialogueWords } from '../lib/turkish-media/dialogue-alignment.js';
import { normalizeScribeTranscript } from '../lib/turkish-media/model.js';
import { buildSubtitleTracks, normalizeDubWords } from '../lib/turkish-media/subtitles.js';

const execute = promisify(execFile);
const FFMPEG = process.env.VIDEOQUEST_TEST_FFMPEG || '/usr/bin/ffmpeg';
const FFPROBE = process.env.VIDEOQUEST_TEST_FFPROBE || '/usr/bin/ffprobe';
const MEDIA_AVAILABLE = fs.existsSync(FFMPEG);
const SAMPLE_RATE = 48000;

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vq-new-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (binary, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kills: []
    });
    child.kill = signal => {
      child.kills.push(signal);
      queueMicrotask(() => {
        if (child.exitCode == null && child.signalCode == null) {
          child.signalCode = signal;
          child.emit('close', null, signal);
        }
      });
      return true;
    };
    calls.push({ binary, args, options, child });
    setImmediate(async () => {
      try { await handler(binary, args, child, calls); }
      catch (error) { child.emit('error', error); }
    });
    return child;
  };
  return { spawn, calls };
}

function close(child, code = 0) {
  child.exitCode = code;
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code, null);
}

function probeResponse(child, duration, codec = 'pcm_f32le') {
  child.stdout.write(JSON.stringify({ streams: [{ codec_name: codec, duration_ts: Math.round(duration * SAMPLE_RATE),
    time_base: `1/${SAMPLE_RATE}`, duration: String(duration), sample_rate: String(SAMPLE_RATE) }],
  format: { duration: String(duration) } }));
  close(child);
}

test('duration probing ignores compressed bitrate estimates and counts actual decoded samples', async () => {
  const mocked = fakeSpawn((binary, _args, child) => {
    if (binary === 'probe') probeResponse(child, 100, 'mp3');
    else { child.stdout.write(Buffer.alloc(SAMPLE_RATE * 4 * 2)); close(child); }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  assert.equal(await service.probeDuration('/tmp/audio.mp3'), 2);
  assert.equal(mocked.calls.length, 2);
  assert.ok(mocked.calls[1].args.includes('pcm_f32le'));
  assert.ok(mocked.calls[1].args.includes('pipe:1'));
});

test('missing binary, failed exit and empty decoded audio produce explicit errors', async () => {
  for (const failure of ['start', 'exit', 'empty']) {
    const mocked = fakeSpawn((_binary, _args, child) => {
      if (failure === 'start') child.emit('error', Object.assign(new Error('not installed'), { code: 'ENOENT' }));
      else { child.stderr.write('media diagnostic'); close(child, failure === 'exit' ? 1 : 0); }
    });
    const service = createAudioService({ ffmpegPath: 'media', spawn: mocked.spawn });
    await assert.rejects(service.probeDuration('/tmp/audio.wav'), {
      code: failure === 'start' ? 'AUDIO_PROCESS_START_FAILED' : failure === 'exit' ? 'AUDIO_PROCESS_FAILED' : 'AUDIO_EMPTY'
    });
  }
});

test('extraction keeps the original stereo bed separate from the speech codec and timeline padding', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.mp4');
  await writeFile(source, 'original video bytes');
  const mocked = fakeSpawn(async (binary, args, child) => {
    if (binary === 'probe') probeResponse(child, 2, args.at(-1).endsWith('.flac') ? 'flac' : 'pcm_f32le');
    else { await writeFile(args.at(-1), 'derived audio'); close(child); }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const result = await service.extractSource({ path: source, duration: 2 }, { directory });
  assert.equal(result.duration, 2);
  assert.notEqual(result.originalPath, result.sttPath);
  assert.equal(await readFile(source, 'utf8'), 'original video bytes');
  const original = mocked.calls.find(row => row.args.at(-1) === result.originalPath && row.binary === 'media');
  const speech = mocked.calls.find(row => row.args.at(-1) === result.sttPath && row.binary === 'media');
  assert.equal(original.args[original.args.indexOf('-ac') + 1], '2');
  assert.equal(original.args[original.args.indexOf('-ar') + 1], '48000');
  assert.ok(original.args.includes('pcm_f32le'));
  assert.ok(original.args.includes('-copyts'));
  assert.match(original.args[original.args.indexOf('-af') + 1], /first_pts=0.*apad=whole_dur=2/);
  assert.doesNotMatch(original.args.join(' '), /16000|tanh|loudnorm|dynaudnorm/);
  assert.ok(speech.args.includes('flac'));
  assert.equal(speech.args[speech.args.indexOf('-ac') + 1], '1');
  assert.equal(speech.args[speech.args.indexOf('-i') + 1], result.originalPath);
});

test('failed extraction removes derived files without deleting the original input', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.mp4');
  await writeFile(source, 'source');
  const mocked = fakeSpawn(async (_binary, args, child) => { await writeFile(args.at(-1), 'partial'); close(child, 1); });
  const service = createAudioService({ ffmpegPath: 'media', spawn: mocked.spawn });
  await assert.rejects(service.extractSource({ path: source, duration: 2 }, { directory }), { code: 'AUDIO_PROCESS_FAILED' });
  assert.deepEqual(await readdir(directory), ['source.mp4']);
});

test('cancelled and timed-out extraction wait for process close and remove partial artifacts', async t => {
  for (const cancel of [true, false]) {
    const directory = await workspace(t);
    const source = path.join(directory, 'source.mp4');
    await writeFile(source, 'source');
    const controller = new AbortController();
    const cancellation = new Error('explicit cancellation');
    const mocked = fakeSpawn(async (_binary, args) => {
      await writeFile(args.at(-1), 'partial');
      if (cancel) controller.abort(cancellation);
    });
    const service = createAudioService({ ffmpegPath: 'media', spawn: mocked.spawn, timeoutMs: 20 });
    await assert.rejects(service.extractSource({ path: source, duration: 2 }, { directory, signal: controller.signal }),
      cancel ? error => error === cancellation : { code: 'AUDIO_PROCESS_TIMEOUT' });
    assert.deepEqual(await readdir(directory), ['source.mp4']);
    assert.deepEqual(mocked.calls[0].child.kills, ['SIGTERM']);
  }
});

test('a pre-aborted operation neither launches a process nor creates a working directory', async t => {
  const directory = await workspace(t);
  const reason = new Error('cancelled before starting');
  const mocked = fakeSpawn(() => assert.fail('aborted task must not launch media processing'));
  const service = createAudioService({ ffmpegPath: 'media', spawn: mocked.spawn });
  await assert.rejects(service.extractSource({ path: '/tmp/source.mp4', duration: 2 }, {
    directory, signal: AbortSignal.abort(reason)
  }), error => error === reason);
  assert.deepEqual(await readdir(directory), []);
});

test('TTD input indexes must cover every turn in order, without overlap or invented ranges', async () => {
  const mocked = fakeSpawn((_binary, _args, child) => probeResponse(child, 3));
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const voice = (index, start, end) => ({ dialogue_input_index: index, start_time_seconds: start, end_time_seconds: end });
  for (const segments of [
    [voice(0, 0, 1)], [voice(0, 0, 1), voice(2, 1, 2)],
    [voice(1, 0, 1), voice(0, 1, 2)], [voice(0, 0, 2), voice(1, 1, 3)],
    [voice(0, 0, 1), voice(1, 2, 4)], [voice(0, null, 1), voice(1, 2, 3)],
    [voice(0, 0, 1), { dialogue_input_index: 1, start: 2, end: 3 }]
  ]) {
    await assert.rejects(service.splitDialogueTurns('/tmp/dialogue.wav', { voiceSegments: segments, inputCount: 2 }),
      error => ['DIALOGUE_TURN_MAP_INVALID', 'DIALOGUE_TURN_MAP_INCOMPLETE'].includes(error.code));
  }
  assert.ok(mocked.calls.every(row => row.binary === 'probe'), 'invalid maps never extract audio');
});

test('TTD split uses generated audio coordinates and retains real silent gaps between turns', async t => {
  const directory = await workspace(t);
  const mocked = fakeSpawn(async (binary, args, child) => {
    if (binary === 'probe') probeResponse(child, args.at(-1).includes('turn-') ? 0.5 : 3);
    else { await writeFile(args.at(-1), 'turn'); close(child); }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const result = await service.splitDialogueTurns('/tmp/scene.wav', { directory, inputCount: 2, voiceSegments: [
    { dialogue_input_index: 0, start_time_seconds: 0.25, end_time_seconds: 0.75 },
    { dialogue_input_index: 1, start_time_seconds: 2, end_time_seconds: 2.5 }
  ] });
  assert.deepEqual(result.map(row => [row.dialogueInputIndex, row.start, row.end, row.duration]), [[0, .25, .75, .5], [1, 2, 2.5, .5]]);
  const filters = mocked.calls.filter(row => row.binary === 'media').map(row => row.args[row.args.indexOf('-af') + 1]);
  assert.match(filters[0], /atrim=start=0.25:end=0.75/);
  assert.match(filters[1], /atrim=start=2:end=2.5/);
});

test('joining dialogue parts keeps their input order and complete measured duration', async t => {
  const directory = await workspace(t);
  const mocked = fakeSpawn(async (binary, args, child) => {
    if (binary === 'probe') probeResponse(child, args.at(-1).endsWith('dialogue.wav') ? .75 : args.at(-1).endsWith('a.wav') ? .25 : .5);
    else { await writeFile(args.at(-1), 'audio'); close(child); }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const output = await service.joinDialogueParts(['/tmp/a.wav', '/tmp/b.wav'], { directory });
  assert.equal(output.duration, .75);
  const args = mocked.calls.find(call => call.binary === 'media').args;
  assert.ok(args.indexOf('/tmp/a.wav') < args.indexOf('/tmp/b.wav'));
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[part0\]\[part1\]concat=n=2:v=0:a=1/);
  assert.ok(!args.includes('-t'));
  await assert.rejects(service.joinDialogueParts([]), { code: 'DIALOGUE_PARTS_REQUIRED' });
});

test('overlong dubbing requests regeneration before any shortening or truncation', async t => {
  const directory = await workspace(t);
  const mocked = fakeSpawn((_binary, _args, child) => probeResponse(child, 1.09));
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  await assert.rejects(service.fitDubSegment('/tmp/long.wav', { targetDuration: 1, directory }), error => {
    assert.equal(error.code, 'DUB_REGENERATE_REQUIRED');
    assert.equal(error.regenerateNeeded, true);
    assert.ok(Math.abs(error.requiredTempo - 1.09) < 1e-9);
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
  assert.equal(mocked.calls.length, 1);
  await assert.rejects(service.fitDubSegment('/tmp/long.wav', { targetDuration: 1, maxTempo: 1.3 }), { code: 'DUB_TEMPO_INVALID' });
});

test('fit measures converted duration and pads only silence, without -t or atrim', async t => {
  const directory = await workspace(t);
  const mocked = fakeSpawn(async (binary, args, child) => {
    if (binary === 'probe') probeResponse(child, args.at(-1).endsWith('audio.wav') ? 1 : .75);
    else { await writeFile(args.at(-1), 'audio'); close(child); }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const result = await service.fitDubSegment('/tmp/short.wav', { targetDuration: 1, directory });
  assert.equal(result.duration, 1);
  assert.equal(result.tempo, 1);
  assert.equal(result.padded, true);
  for (const row of mocked.calls.filter(row => row.binary === 'media')) {
    assert.ok(!row.args.includes('-t'));
    assert.doesNotMatch(row.args.join(' '), /atrim/);
  }
  assert.match(mocked.calls.find(row => row.args.at(-1) === result.path && row.binary === 'media').args.join(' '), /apad=whole_len=48000/);
});

test('mix uses sourceStart sample offsets, ducks the original language and supports verified source overlap', async t => {
  const directory = await workspace(t);
  let graph;
  const mocked = fakeSpawn(async (binary, args, child) => {
    if (binary === 'probe') probeResponse(child, args.at(-1).endsWith('turkish-mix.wav') ? 3 : .5);
    else {
      graph = await readFile(args[args.indexOf('-filter_complex_script') + 1], 'utf8');
      await writeFile(args.at(-1), 'mixed'); close(child);
    }
  });
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const result = await service.mixAudio({ sourceAudio: '/tmp/bed.wav', duration: 3, directory, dubSegments: [
    { segmentId: 'a', speakerId: 'male', start: 20, end: 21, sourceStart: .125, sourceEnd: 1, audioPath: '/tmp/a.wav', duration: 50 },
    { segmentId: 'b', speakerId: 'female', start: .375, end: 1.25, audioPath: '/tmp/b.wav' }
  ] });
  assert.match(graph, /1-0.82\*min/);
  assert.match(graph, /val\(0\)\*/);
  assert.match(graph, /adelay=6000S:all=1/);
  assert.match(graph, /adelay=18000S:all=1/);
  assert.match(graph, /acompressor=threshold=0.125/);
  assert.doesNotMatch(graph, /loudnorm/);
  assert.match(graph, /alimiter=limit=0.95:level=0:latency=1/);
  assert.equal(result.qa.mixMode, 'speech-ducking');
  assert.equal(result.qa.originalSpeechMuted, false);
  assert.equal(result.qa.originalSpeechLevel, .18);
  assert.equal(result.qa.preservesMusicDuringSpeech, true);
  assert.match(result.qa.limitation, /music and ambience are reduced/);
  assert.equal(await stat(result.path).then(row => row.size), 5);
});

test('mix refuses duplicate IDs, fabricated overflow and a source soundtrack masquerading as separation', async () => {
  const mocked = fakeSpawn((_binary, _args, child) => probeResponse(child, .75));
  const service = createAudioService({ ffmpegPath: 'media', ffprobePath: 'probe', spawn: mocked.spawn });
  const row = { segmentId: 'a', speakerId: 'male', start: 1, end: 1.5, audioPath: '/tmp/a.wav' };
  await assert.rejects(service.mixAudio({ sourceAudio: '/tmp/source.wav', duration: 3, dubSegments: [row] }), { code: 'DUB_REGENERATE_REQUIRED' });
  await assert.rejects(service.mixAudio({ sourceAudio: '/tmp/source.wav', duration: 3, dubSegments: [
    { ...row, end: 2 }, { ...row, end: 2 }
  ] }), { code: 'DUB_SOURCE_RANGE_INVALID' });
  await assert.rejects(service.mixAudio({ sourceAudio: '/tmp/source.wav', backgroundPath: '/tmp/source.wav',
    duration: 3, dubSegments: [] }), { code: 'SEPARATED_BACKGROUND_REQUIRED' });
});

async function realMedia(t) {
  if (!MEDIA_AVAILABLE) { t.skip('A real ffmpeg engine is not installed.'); return null; }
  const directory = await workspace(t);
  const fixture = async (name, expression, duration) => {
    const file = path.join(directory, name);
    try {
      await execute(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        `aevalsrc=${expression}:s=${SAMPLE_RATE}:d=${duration}`, '-ac', '2', '-c:a', 'pcm_f32le', '-threads', '1', file], { timeout: 15000 });
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) {
        t.skip(`The execution environment cannot launch ffmpeg: ${error.code}.`); return null;
      }
      throw error;
    }
    return file;
  };
  const service = createAudioService({ ffmpegPath: FFMPEG,
    ffprobePath: fs.existsSync(FFPROBE) ? FFPROBE : null, directory, timeoutMs: 15000 });
  return { directory, fixture, service };
}

async function samples(file) {
  const { stdout } = await execute(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
  { timeout: 15000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
}

function rms(values) { return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); }

test('compressed source fallback also retains quiet source speech and normal sound outside dialogue', async t => {
  const media = await realMedia(t); if (!media) return;
  const raw = await media.fixture('fallback-bed.wav', '.1*sin(2*PI*440*t)', 3);
  const bed = path.join(media.directory, 'fallback-bed.mp3');
  await execute(FFMPEG, ['-nostdin', '-v', 'error', '-i', raw, '-c:a', 'libmp3lame', '-b:a', '128k', bed]);
  const dub = await media.fixture('fallback-dub.wav', '.2*sin(2*PI*880*t)', 1);
  const output = await media.service.mixAudio({ sourceAudio: bed, duration: 3,
    dubSegments: [{ segmentId: 'one', speakerId: 'speaker', start: 1, end: 2, audioPath: dub }] });
  const decoded = await samples(output.path);
  assert.ok(frequencyAmplitude(decoded.slice(.2 * SAMPLE_RATE, .8 * SAMPLE_RATE), 440) > .08);
  assert.ok(Math.abs(frequencyAmplitude(decoded.slice(1.2 * SAMPLE_RATE, 1.8 * SAMPLE_RATE), 440) - .018) < .003);
  assert.ok(frequencyAmplitude(decoded.slice(1.2 * SAMPLE_RATE, 1.8 * SAMPLE_RATE), 880) > .15);
});

test('real mix softens discontinuous source/dub boundaries without a click or shifted speech clock', async t => {
  const media = await realMedia(t); if (!media) return;
  const bed = await media.fixture('constant-bed.wav', '.1', 3);
  const dub = await media.fixture('constant-dub.wav', '.2', 1);
  const output = await media.service.mixAudio({ sourceAudio: bed, duration: 3,
    dubSegments: [{ segmentId: 'one', speakerId: 'speaker', start: 1, end: 2, audioPath: dub }] });
  const decoded = await samples(output.path);
  assert.equal(decoded.length, 3 * SAMPLE_RATE);
  for (const edge of [1, 2]) {
    const at = edge * SAMPLE_RATE;
    const around = decoded.slice(at - 400, at + 400);
    assert.ok(Math.max(...around.slice(1).map((value, i) => Math.abs(value - around[i]))) < .02);
  }
  assert.ok(rms(decoded.slice(1.1 * SAMPLE_RATE, 1.9 * SAMPLE_RATE)) > .1);
});

test('real old float WAV repairs to PCM16 with the same duration and audible signal', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('old-saved.wav', '.2*sin(2*PI*880*t)', 3);
  const original = new Blob([await readFile(input)], { type: 'audio/wav' });
  const repaired = await repairSavedAudio(original);
  assert.notEqual(repaired, original);
  const file = path.join(media.directory, 'repaired.wav');
  await writeFile(file, Buffer.from(await repaired.arrayBuffer()));
  const decoded = await samples(file);
  assert.equal(decoded.length, 3 * SAMPLE_RATE);
  assert.ok(frequencyAmplitude(decoded, 880) > .19);
});

test('final MP3 retains the complete timeline, audible dub and original non-speech with a small single output', async t => {
  const media = await realMedia(t); if (!media) return;
  const source = await media.fixture('bed.wav', '.1*sin(2*PI*440*t)', 8);
  const dub = await media.fixture('dub.wav', '.2*sin(2*PI*880*t)', 1);
  const output = await media.service.mixAudio({ sourceAudio: source, duration: 8, format: 'mp3',
    dubSegments: [{ segmentId: 'one', speakerId: 'speaker-1', sourceStart: 2, sourceEnd: 3, audioPath: dub }] });
  assert.equal(output.mimeType, 'audio/mpeg');
  assert.equal(output.qa.playbackFormat, 'mp3');
  const decoded = await samples(output.path);
  assert.equal(decoded.length, 8 * SAMPLE_RATE, 'Xing gapless decoding preserves the video clock');
  assert.ok(frequencyAmplitude(decoded.slice(2.1 * SAMPLE_RATE, 2.9 * SAMPLE_RATE), 880) > .15);
  assert.ok(frequencyAmplitude(decoded.slice(.2 * SAMPLE_RATE, .8 * SAMPLE_RATE), 440) > .08);
  assert.ok(Math.abs(frequencyAmplitude(decoded.slice(2.1 * SAMPLE_RATE, 2.9 * SAMPLE_RATE), 440) - .018) < .003);
  assert.ok((await stat(output.path)).size < (await stat(source)).size / 10);
  assert.ok(!(await readdir(path.dirname(output.path))).includes('turkish-mix.wav'));
});

function frequencyAmplitude(values, frequency, offset = 0) {
  let sine = 0, cosine = 0;
  for (let index = 0; index < values.length; index++) {
    const phase = 2 * Math.PI * frequency * (index + offset) / SAMPLE_RATE;
    sine += values[index] * Math.sin(phase); cosine += values[index] * Math.cos(phase);
  }
  return 2 * Math.sqrt(sine * sine + cosine * cosine) / values.length;
}

test('real extraction retains the original amplitude/stereo rate and complete lossless speech input', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('source.wav', '0.12*sin(2*PI*440*t)', 1.25); if (!input) return;
  const original = await readFile(input);
  const output = await media.service.extractSource(input, { directory: media.directory });
  assert.ok(Math.abs(output.duration - 1.25) < 2 / SAMPLE_RATE);
  assert.ok(Math.abs(await media.service.probeDuration(output.sttPath) - 1.25) < 2 / SAMPLE_RATE);
  assert.deepEqual(await readFile(input), original);
  assert.ok(Math.abs(rms(await samples(output.originalPath)) - .12 / Math.sqrt(2)) < .0001);
});

test('real extraction without ffprobe does not truncate a rounded audio header duration', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('unrounded.wav', '.12*sin(2*PI*440*t)', .123458333333); if (!input) return;
  const service = createAudioService({ ffmpegPath: FFMPEG, directory: media.directory, timeoutMs: 15000 });
  const expected = await service.probeDuration(input);
  const output = await service.extractSource(input);
  assert.ok(Math.abs(output.duration - expected) < 2 / SAMPLE_RATE);
  assert.equal((await samples(output.originalPath)).length, (await samples(input)).length);
});

test('real extraction preserves delayed video audio and trailing source silence', async t => {
  const media = await realMedia(t); if (!media) return;
  const tone = await media.fixture('delayed-tone.wav', '.2*sin(2*PI*880*t)', .5); if (!tone) return;
  const video = path.join(media.directory, 'source-offset.mkv');
  await execute(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-itsoffset', '0.25', '-i', tone,
    '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10:d=2', '-map', '1:v:0', '-map', '0:a:0',
    '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-threads', '1', video], { timeout: 15000 });
  const output = await media.service.extractSource({ path: video, duration: 2 });
  const audio = await samples(output.originalPath);
  assert.equal(audio.length, 2 * SAMPLE_RATE);
  assert.ok(audio.slice(0, .25 * SAMPLE_RATE).every(value => Math.abs(value) < .00001));
  assert.ok(rms(audio.slice(.3 * SAMPLE_RATE, .7 * SAMPLE_RATE)) > .1);
  assert.ok(audio.slice(.8 * SAMPLE_RATE).every(value => Math.abs(value) < .00001));
});

test('real generated dialogue ranges split each turn without carrying another voice or timeline gap', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('scene.wav',
    'if(between(t\\,0.25\\,0.75)\\,.2*sin(2*PI*880*t)\\,if(between(t\\,2\\,2.5)\\,.2*sin(2*PI*1320*t)\\,0))', 3);
  if (!input) return;
  const turns = await media.service.splitDialogueTurns(input, { inputCount: 2, voiceSegments: [
    { dialogue_input_index: 0, start_time_seconds: .25, end_time_seconds: .75 },
    { dialogue_input_index: 1, start_time_seconds: 2, end_time_seconds: 2.5 }
  ] });
  assert.deepEqual(turns.map(row => row.duration), [.5, .5]);
  const first = await samples(turns[0].audioPath), second = await samples(turns[1].audioPath);
  assert.ok(frequencyAmplitude(first, 880) > .19);
  assert.ok(frequencyAmplitude(first, 1320) < .0001);
  assert.ok(frequencyAmplitude(second, 1320) > .19);
  assert.ok(frequencyAmplitude(second, 880) < .0001);
});

test('PCM splitting, duration checks and padding need no media process', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('native-pcm.wav', '.2*sin(2*PI*880*t)', 2); if (!input) return;
  const service = createAudioService({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, directory: media.directory,
    spawn: () => assert.fail('valid PCM must not be decoded or probed again') });
  const rows = await service.splitDialogueTurns(input, { inputCount: 2, voiceSegments: [
    { dialogue_input_index: 0, start_time_seconds: .25, end_time_seconds: .75 },
    { dialogue_input_index: 1, start_time_seconds: 1, end_time_seconds: 1.5 }
  ] });
  const fitted = await service.fitDubSegment(rows[0].audioPath, { targetDuration: 1 });
  assert.equal(await service.probeDuration(fitted.path), 1);
  const audio = await samples(fitted.path);
  assert.ok(frequencyAmplitude(audio.slice(0, .5 * SAMPLE_RATE), 880) > .19);
  assert.ok(audio.slice(.5 * SAMPLE_RATE).every(value => Math.abs(value) < .00001));
});

test('verified native speech boundaries remove only outside padding and report the real clock offset', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('native-gaps.wav', 'if(between(t\\,0.25\\,0.65)\\,.2*sin(2*PI*880*t)\\,0)', 1); if (!input) return;
  const fitted = await media.service.fitDubSegment(input, { targetDuration: .5,
    speechRange: { start: .25, end: .65 }, directory: media.directory });
  assert.ok(Math.abs(fitted.sourceOffset - .22) < 2 / SAMPLE_RATE);
  assert.equal(fitted.tempo, 1); assert.equal(fitted.duration, .5);
  const audio = await samples(fitted.path);
  assert.ok(frequencyAmplitude(audio.slice(.04 * SAMPLE_RATE, .4 * SAMPLE_RATE), 880, .04 * SAMPLE_RATE) > .19);
});

test('real dialogue parts concatenate in order without truncating or inventing a pause', async t => {
  const media = await realMedia(t); if (!media) return;
  const first = await media.fixture('first-part.wav', '.2*sin(2*PI*880*t)', .25); if (!first) return;
  const second = await media.fixture('second-part.wav', '.2*sin(2*PI*1320*t)', .5);
  const joined = await media.service.joinDialogueParts([first, second]);
  assert.ok(Math.abs(joined.duration - .75) < 2 / SAMPLE_RATE);
  const audio = await samples(joined.path);
  assert.ok(frequencyAmplitude(audio.slice(0, .25 * SAMPLE_RATE), 880) > .19);
  assert.ok(frequencyAmplitude(audio.slice(.25 * SAMPLE_RATE), 1320) > .19);
  assert.ok(frequencyAmplitude(audio.slice(0, .25 * SAMPLE_RATE), 1320) < .0001);
});

test('measured internal pauses are compacted while both words and their transformed clocks survive', async t => {
  const media = await realMedia(t); if (!media) return;
  const file = await media.fixture('long-pause.wav',
    'if(between(t\\,0.2\\,0.6)\\,.2*sin(2*PI*880*t)\\,if(between(t\\,2\\,2.4)\\,.2*sin(2*PI*1320*t)\\,0))', 3);
  if (!file) return;
  const nativeWords = [{ text: 'Merhaba.', start: .2, end: .6 }, { text: 'Evet.', start: 2, end: 2.4 }];
  const fitted = await media.service.fitDubSegment(file, { targetDuration: 1, maxTempo: 1.2,
    speechRange: { start: .2, end: 2.4 }, speechWords: nativeWords });
  const words = fitNativeDialogueWords([{ nativeWords, nativeDuration: 3 }], 'Merhaba. Evet.', fitted);
  assert.equal(words.length, 2); assert.equal(fitted.removedPauses.length, 1);
  assert.ok(fitted.removedPauses[0].start > nativeWords[0].end);
  assert.ok(fitted.removedPauses[0].end < nativeWords[1].start);
  assert.ok(fitted.tempo <= 1.2); assert.equal(fitted.duration, 1);
  const audio = await samples(fitted.path);
  for (const [i, frequency] of [880, 1320].entries()) {
    const start = Math.round((words[i].start + .05) * SAMPLE_RATE), end = Math.round((words[i].end - .05) * SAMPLE_RATE);
    assert.ok(frequencyAmplitude(audio.slice(start, end), frequency, start) > .12);
  }
});

test('adaptive fitting chains tempo stages, keeps pitch and both audio sections instead of rejecting duration', async t => {
  const media = await realMedia(t); if (!media) return;
  const file = await media.fixture('adaptive.wav', 'if(lt(t\\,1.5)\\,.2*sin(2*PI*880*t)\\,.2*sin(2*PI*1320*t))', 3);
  if (!file) return;
  const fitted = await media.service.fitDubSegment(file, { targetDuration: 1, maxTempo: 1.2, adaptiveTempo: true });
  assert.ok(fitted.tempo >= 3); assert.equal(fitted.duration, 1); assert.equal(fitted.adaptiveTempo, true);
  const audio = await samples(fitted.path);
  assert.ok(frequencyAmplitude(audio.slice(.1 * SAMPLE_RATE, .3 * SAMPLE_RATE), 880, .1 * SAMPLE_RATE) > .1);
  assert.ok(frequencyAmplitude(audio.slice(.6 * SAMPLE_RATE, .85 * SAMPLE_RATE), 1320, .6 * SAMPLE_RATE) > .1);
  const words = fitNativeDialogueWords([{ nativeDuration: 3, nativeWords: [
    { text: 'Merhaba.', start: .03, end: 1.4 }, { text: 'Evet.', start: 1.55, end: 2.94 }
  ] }], 'Merhaba. Evet.', fitted);
  assert.equal(words.length, 2); assert.ok(words[1].end <= 1);
});

test('production short slots converge by sample count instead of repeating the same tempo plateau', async t => {
  const media = await realMedia(t); if (!media) return;
  for (const duration of [.72, .88]) for (const [name, expression] of [
    ['chirp', '.2*sin(2*PI*(200*t+300*t*t))'],
    ['pulse', 'if(lt(mod(n\\,800)\\,150)\\,.2*sin(2*PI*380*t)\\,0)']
  ]) {
    const file = await media.fixture(`${name}-${duration}.wav`, expression, duration); if (!file) return;
    let attempts = 0;
    const service = createAudioService({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, directory: media.directory,
      spawn: (binary, args, options) => { if (args.includes('-af')) attempts++; return realSpawn(binary, args, options); } });
    const result = await service.fitDubSegment(file, { targetDuration: .639999999999997, maxTempo: 1.2, adaptiveTempo: true });
    const values = await samples(result.path);
    assert.equal(values.length, 30720, 'the 640ms source slot has exactly 30,720 samples');
    assert.equal(result.duration, .64); assert.ok(attempts <= 3, `${name} should leave the analysis-window plateau promptly`);
    assert.ok(rms(values) > .01, 'fitting retains the actual sound');
    const words = fitNativeDialogueWords([{ nativeDuration: duration, nativeWords: [{ text: 'Evet.', start: .02, end: duration - .02 }] }],
      'Evet.', result);
    assert.equal(words.length, 1); assert.ok(words[0].end <= .64);
  }
});

test('real PCM, native words, subtitles and final mix agree at a fractional video boundary', async t => {
  const media = await realMedia(t); if (!media) return;
  const input = await media.fixture('boundary-turn.wav', '.2*sin(2*PI*380*t)', .64);
  const bed = await media.fixture('boundary-bed.wav', '.04*sin(2*PI*230*t)', 3);
  if (!input || !bed) return;
  const start = 1.731215, end = start + .6399999;
  const transcript = normalizeScribeTranscript({ words: [{ text: 'Hello.', type: 'word',
    start, end, speaker_id: 'speaker_0' }] }, { sourceHash: 'fractional-clock-fixture', duration: 3 });
  const turn = transcript.utterances[0];
  const fitted = await media.service.fitDubSegment(input, { targetDuration: end - start, maxTempo: 1.2 });
  assert.equal(fitted.duration, .64);
  const native = fitNativeDialogueWords([{ nativeDuration: .64,
    nativeWords: [{ text: 'Merhaba.', start: 0, end: .64 }] }], 'Merhaba.', fitted);
  const measured = native.map(word => ({ ...word, start: start + word.start, end: start + word.end }));
  assert.ok(measured[0].end > end, 'the actual PCM clock recreates the previous strict-boundary failure');
  const words = normalizeDubWords(measured, { start, end, segmentId: turn.segmentId });
  const dub = { segmentId: turn.segmentId, speakerId: turn.speakerId, start, end,
    words, audioPath: fitted.path, duration: fitted.duration };
  const tracks = buildSubtitleTracks(transcript, [{ segmentId: turn.segmentId, speakerId: turn.speakerId,
    translatedText: 'Merhaba.' }], [dub]);
  assert.equal(tracks.dub_tr[0].end, end); assert.equal(tracks.source_tr[0].end, end);
  const mixed = await media.service.mixAudio({ sourceAudio: bed, dubSegments: [dub], duration: 3 });
  assert.equal(mixed.duration, 3); assert.equal((await samples(mixed.path)).length, 144000);
  assert.ok(rms((await samples(mixed.path)).slice(Math.round(start * 48000), Math.round(end * 48000))) > .01);
});

test('a redistributed dub ducks the original speech clock and preserves the bed outside it', async t => {
  const media = await realMedia(t); if (!media) return;
  const bed = await media.fixture('shifted-bed.wav', '.12*sin(2*PI*440*t)', 2); if (!bed) return;
  const voice = await media.fixture('shifted-voice.wav', '.2*sin(2*PI*880*t)', .5);
  const mixed = await media.service.mixAudio({ sourceAudio: bed, duration: 2, dubSegments: [
    { segmentId: 'shifted', speakerId: 'a', start: .5, end: 1, originalSpeechStart: 1, originalSpeechEnd: 1.5, audioPath: voice }
  ] });
  const audio = await samples(mixed.path);
  assert.ok(Math.abs(frequencyAmplitude(audio.slice(.6 * SAMPLE_RATE, .8 * SAMPLE_RATE), 440, .6 * SAMPLE_RATE) - .12 * .18) < .002,
    'source is quiet whenever the redistributed dub is speaking');
  assert.ok(Math.abs(rms(audio.slice(1.1 * SAMPLE_RATE, 1.4 * SAMPLE_RATE)) - .12 * .18 / Math.sqrt(2)) < .002,
    'original speech is retained at a low level');
  assert.ok(frequencyAmplitude(audio.slice(1.7 * SAMPLE_RATE, 1.9 * SAMPLE_RATE), 440) > .1, 'other scenes return to normal');
});

test('real short dub padding and gentle atempo never exceed the verified source slot', async t => {
  const media = await realMedia(t); if (!media) return;
  const short = await media.fixture('short.wav', '.2*sin(2*PI*880*t)', .25); if (!short) return;
  const padded = await media.service.fitDubSegment(short, { targetDuration: .5, directory: media.directory });
  assert.equal(padded.padded, true);
  assert.ok(Math.abs(padded.duration - .5) < 2 / SAMPLE_RATE);
  const audio = await samples(padded.path);
  assert.ok(rms(audio.slice(0, .2 * SAMPLE_RATE)) > .1);
  assert.ok(rms(audio.slice(.3 * SAMPLE_RATE)) < .00001);
  const slightlyLong = await media.fixture('slightly-long.wav', '.2*sin(2*PI*880*t)', 1.04);
  const fitted = await media.service.fitDubSegment(slightlyLong, { targetDuration: 1, directory: media.directory });
  assert.ok(fitted.tempo > 1 && fitted.tempo <= 1.08);
  assert.ok(Math.abs(fitted.duration - 1) < 2 / SAMPLE_RATE);
});

test('real mix preserves non-speech bed, retains quiet original speech, aligns offsets and avoids clipping', async t => {
  const media = await realMedia(t); if (!media) return;
  const source = await media.fixture('bed.wav', '.12*sin(2*PI*440*t)', 3); if (!source) return;
  const male = await media.fixture('male.wav', '.7*sin(2*PI*880*t)', .75);
  const female = await media.fixture('female.wav', '.7*sin(2*PI*1320*t)', .5);
  const output = await media.service.mixAudio({ sourceAudio: source, duration: 3, directory: media.directory,
    dubSegments: [{ segmentId: 'm', speakerId: 'male', start: 1, end: 1.75, audioPath: male },
      { segmentId: 'f', speakerId: 'female', start: 1.25, end: 1.75, audioPath: female }] });
  const audio = await samples(output.path);
  assert.ok(Math.abs(audio.length / SAMPLE_RATE - 3) < 2 / SAMPLE_RATE);
  const early = audio.slice(.2 * SAMPLE_RATE, .4 * SAMPLE_RATE);
  const overlap = audio.slice(1.35 * SAMPLE_RATE, 1.6 * SAMPLE_RATE);
  assert.ok(Math.abs(frequencyAmplitude(early, 440, .2 * SAMPLE_RATE) - .12) < .002);
  assert.ok(Math.abs(frequencyAmplitude(overlap, 440, 1.35 * SAMPLE_RATE) - .12 * .18) < .002, 'original language stays quiet during source speech');
  assert.ok(frequencyAmplitude(overlap, 880, 1.35 * SAMPLE_RATE) > .01);
  assert.ok(frequencyAmplitude(overlap, 1320, 1.35 * SAMPLE_RATE) > .01);
  assert.ok(audio.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0) <= .951);
  assert.equal(output.qa.mixMode, 'speech-ducking');

  const silent = await media.fixture('silent.wav', '0', 1);
  const voice = await media.fixture('offset.wav', '.3*sin(2*PI*880*t)', .25);
  const exact = await media.service.mixAudio({ sourceAudio: silent, duration: 1, directory: media.directory,
    dubSegments: [{ segmentId: 'offset', speakerId: 'male', start: .125, end: .375, audioPath: voice }] });
  const placed = await samples(exact.path);
  assert.ok(placed.slice(0, .125 * SAMPLE_RATE).every(value => Math.abs(value) < .00001));
  assert.ok(rms(placed.slice(.15 * SAMPLE_RATE, .25 * SAMPLE_RATE)) > .01);
});
