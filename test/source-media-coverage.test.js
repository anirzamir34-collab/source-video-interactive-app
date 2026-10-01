import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeLocalAudioDuration, prepareDialogueAudioWindow } from '../lib/dialogue-media.js';

const ffmpegStatic = await import('ffmpeg-static').then(module => module.default).catch(() => null);
const ffmpegPath = fs.existsSync(ffmpegStatic || '') ? ffmpegStatic : '/usr/bin/ffmpeg';
const ffprobePath = '/usr/bin/ffprobe';
const hasFfmpeg = fs.existsSync(ffmpegPath);
const run = promisify(execFile);

async function sourceFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-source-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'source.wav');
  // The only audible signal begins late in the source. An extraction that
  // accidentally restarts at zero cannot satisfy the late-window assertions.
  await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'aevalsrc=if(gte(t\\,120)\\,0.4*sin(2*PI*440*t)\\,0):s=16000:d=125',
    '-c:a', 'pcm_s16le', inputPath], { timeout: 8000 });
  return { directory, file: { path: inputPath } };
}

async function decodeSamples(filePath) {
  const { stdout: data } = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', filePath, '-map', '0:a:0', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', '-f', 's16le', '-'], { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
  return Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
}

function rms(samples) {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

test('source duration and late audio windows cover the real source beyond the first minute', {
  skip: !hasFfmpeg || !fs.existsSync(ffprobePath), timeout: 15000
}, async t => {
  const { file } = await sourceFixture(t);
  const original = fs.readFileSync(file.path);
  const sourceDuration = await probeLocalAudioDuration(file, { ffmpegPath });
  assert.ok(Math.abs(sourceDuration - 125) < 0.02);

  const early = await prepareDialogueAudioWindow(file, { ffmpegPath, startTime: 0, endTime: 10 });
  const late = await prepareDialogueAudioWindow(file, { ffmpegPath, startTime: 115, endTime: 125 });
  assert.notEqual(early.path, late.path);
  assert.deepEqual([late.startTime, late.endTime], [115, 125]);
  assert.equal(late.mimetype, 'audio/mpeg');
  assert.ok(late.size > 0 && late.size < 100000);
  assert.ok(Math.abs(late.duration - 10) < 0.2);
  const metadata = JSON.parse((await run(ffprobePath,
    ['-v', 'error', '-show_streams', '-of', 'json', late.path])).stdout);
  assert.equal(metadata.streams.length, 1);
  assert.equal(metadata.streams[0].codec_name, 'mp3');
  assert.equal(metadata.streams[0].sample_rate, '16000');
  assert.equal(metadata.streams[0].channels, 1);
  assert.ok(Math.abs(Number(metadata.streams[0].duration) - 10) < 0.2);

  const earlySamples = await decodeSamples(early.path);
  const lateSamples = await decodeSamples(late.path);
  assert.ok(Math.abs(lateSamples.length / 16000 - 10) < 0.02);
  assert.ok(rms(earlySamples) < 0.001);
  assert.ok(rms(lateSamples.slice(0, 4 * 16000)) < 0.001);
  assert.ok(rms(lateSamples.slice(6 * 16000)) > 0.2);
  assert.deepEqual(fs.readFileSync(file.path), original);
});

test('duration probing decodes bounded audio timing when the container declares no duration', {
  skip: !hasFfmpeg, timeout: 10000
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-unknown-duration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'source.webm');
  await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '3', '-c:a', 'libopus', '-live', '1', inputPath], { timeout: 8000 });
  const { stderr } = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-i', inputPath,
    '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { timeout: 8000 });
  assert.match(stderr, /Duration: N\/A/);
  const duration = await probeLocalAudioDuration({ path: inputPath }, { ffmpegPath });
  assert.ok(Math.abs(duration - 3) < 0.05);
});

test('duration probing measures VBR audio when bitrate metadata gives an inaccurate duration', {
  skip: !hasFfmpeg, timeout: 10000
}, async t => {
  const { directory, file } = await sourceFixture(t);
  const inputPath = path.join(directory, 'source-without-index.mp3');
  await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', file.path, '-c:a', 'libmp3lame', '-q:a', '0', '-write_xing', '0', inputPath], { timeout: 8000 });
  const { stderr } = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-i', inputPath,
    '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { timeout: 8000 });
  assert.match(stderr, /Estimating duration from bitrate, this may be inaccurate/);
  const [, hours, minutes, remainingSeconds] = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const metadataDuration = Number(hours) * 3600 + Number(minutes) * 60 + Number(remainingSeconds);
  assert.ok(Math.abs(metadataDuration - 125) > 0.3, 'the fixture must expose an inaccurate header estimate');
  const duration = await probeLocalAudioDuration({ path: inputPath }, { ffmpegPath });
  assert.ok(Math.abs(duration - 125) < 0.2);
});

test('audio windows reject incomplete source spans and clean derived files after cancellation', {
  skip: !hasFfmpeg, timeout: 15000
}, async t => {
  const { directory, file } = await sourceFixture(t);
  const original = fs.readFileSync(file.path);
  await assert.rejects(prepareDialogueAudioWindow(file, {
    ffmpegPath, startTime: 120, endTime: 130
  }), /tamamını kapsamıyor/);
  assert.deepEqual(fs.readdirSync(directory), ['source.wav']);

  // Throttle actual ffmpeg input so cancellation reliably happens after a
  // partial output file exists, rather than racing a completed conversion.
  const slowFfmpeg = path.join(directory, 'slow-ffmpeg');
  const quotedFfmpeg = `'${ffmpegPath.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(slowFfmpeg, `#!/bin/sh\nexec ${quotedFfmpeg} -re "$@"\n`, { mode: 0o755 });
  const controller = new AbortController();
  const reason = new Error('test cancellation');
  const conversion = prepareDialogueAudioWindow(file, {
    ffmpegPath: slowFfmpeg, startTime: 0, endTime: 125, signal: controller.signal
  });
  const rejected = assert.rejects(conversion, error => error === reason);
  const deadline = Date.now() + 4000;
  let partialExists = false;
  try {
    while (Date.now() < deadline && !partialExists) {
      partialExists = fs.readdirSync(directory).some(name => name.endsWith('.mp3'));
      if (!partialExists) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(partialExists, true);
  } finally {
    controller.abort(reason);
    await rejected;
  }
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.mp3')), false);
  assert.deepEqual(fs.readFileSync(file.path), original);

  await assert.rejects(probeLocalAudioDuration(file, {
    ffmpegPath, signal: AbortSignal.abort(reason)
  }), error => error === reason);
});
