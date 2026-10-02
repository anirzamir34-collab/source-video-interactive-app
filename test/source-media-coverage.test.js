import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createAudioService } from '../lib/turkish-media/audio.js';

const ffmpegPath = process.env.VIDEOQUEST_TEST_FFMPEG || '/usr/bin/ffmpeg';
const ffprobePath = process.env.VIDEOQUEST_TEST_FFPROBE || '/usr/bin/ffprobe';
const execute = promisify(execFile);

async function sourceFixture(t) {
  if (!fs.existsSync(ffmpegPath)) { t.skip('A real ffmpeg engine is not installed.'); return null; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-source-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'source.wav');
  // Late source speech must survive preparation of the whole STT asset; the
  // earlier silence cannot replace or shift the final five audible seconds.
  try {
    await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=if(gte(t\\,120)\\,0.4*sin(2*PI*440*t)\\,0):s=16000:d=125', '-c:a', 'pcm_s16le', inputPath], { timeout: 8000 });
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) { t.skip(`The environment cannot launch ffmpeg: ${error.code}.`); return null; }
    throw error;
  }
  const service = createAudioService({ ffmpegPath,
    ffprobePath: fs.existsSync(ffprobePath) ? ffprobePath : null, directory, timeoutMs: 15000 });
  return { directory, inputPath, service };
}

async function decodeSamples(filePath, { start = 0, duration = 10 } = {}) {
  const { stdout: data } = await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-i', filePath, '-t', String(duration), '-map', '0:a:0', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
  return Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
}
const rms = samples => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

test('complete source preparation preserves real late speech beyond the first minute in both STT and original bed', { timeout: 15000 }, async t => {
  const fixture = await sourceFixture(t); if (!fixture) return;
  const { inputPath, service } = fixture;
  const original = fs.readFileSync(inputPath);
  assert.ok(Math.abs(await service.probeDuration(inputPath) - 125) < 2 / 48000);
  const prepared = await service.extractSource(inputPath);
  assert.ok(Math.abs(prepared.duration - 125) < 2 / 48000);
  assert.ok(Math.abs(await service.probeDuration(prepared.sttPath) - 125) < 2 / 48000);
  for (const filePath of [prepared.sttPath, prepared.originalPath]) {
    const early = await decodeSamples(filePath);
    const late = await decodeSamples(filePath, { start: 115 });
    assert.equal(late.length, 10 * 16000);
    assert.ok(rms(early) < .001);
    assert.ok(rms(late.slice(0, 4 * 16000)) < .001);
    assert.ok(rms(late.slice(6 * 16000)) > .2);
  }
  assert.deepEqual(fs.readFileSync(inputPath), original);
});

test('duration probing counts actual samples when a source container declares no duration', { timeout: 10000 }, async t => {
  const fixture = await sourceFixture(t); if (!fixture) return;
  const inputPath = path.join(fixture.directory, 'source.webm');
  await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=16000', '-t', '3', '-c:a', 'libopus', '-live', '1', inputPath], { timeout: 8000 });
  const { stderr } = await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-i', inputPath,
    '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { timeout: 8000 });
  assert.match(stderr, /Duration: N\/A/);
  assert.ok(Math.abs(await fixture.service.probeDuration(inputPath) - 3) < .05);
});

test('VBR source duration ignores a demonstrably inaccurate bitrate header estimate', { timeout: 15000 }, async t => {
  const fixture = await sourceFixture(t); if (!fixture) return;
  const inputPath = path.join(fixture.directory, 'source-without-index.mp3');
  await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', fixture.inputPath,
    '-c:a', 'libmp3lame', '-q:a', '0', '-write_xing', '0', inputPath], { timeout: 8000 });
  const { stderr } = await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-i', inputPath,
    '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { timeout: 8000 });
  assert.match(stderr, /Estimating duration from bitrate, this may be inaccurate/);
  const [, hours, minutes, seconds] = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const headerDuration = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  assert.ok(Math.abs(headerDuration - 125) > .3, 'the fixture must expose an inaccurate estimate');
  assert.ok(Math.abs(await fixture.service.probeDuration(inputPath) - 125) < .2);
});

test('cancellation stops real FFmpeg and removes its partially extracted original bed', { timeout: 15000 }, async t => {
  const fixture = await sourceFixture(t); if (!fixture) return;
  const original = fs.readFileSync(fixture.inputPath);
  const controller = new AbortController();
  const reason = new Error('test cancellation');
  const service = createAudioService({ ffmpegPath, directory: fixture.directory, timeoutMs: 15000,
    spawn: (binary, args, options) => spawn(binary, ['-re', ...args], options) });
  const conversion = service.extractSource({ path: fixture.inputPath, duration: 125 }, { signal: controller.signal });
  const rejected = assert.rejects(conversion, error => error === reason);
  const deadline = Date.now() + 4000;
  let partialExists = false;
  try {
    while (Date.now() < deadline && !partialExists) {
      partialExists = fs.readdirSync(fixture.directory).some(name => name.startsWith('source-') &&
        fs.existsSync(path.join(fixture.directory, name, 'original.wav')));
      if (!partialExists) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(partialExists, true);
  } finally { controller.abort(reason); await rejected; }
  assert.deepEqual(fs.readdirSync(fixture.directory), ['source.wav']);
  assert.deepEqual(fs.readFileSync(fixture.inputPath), original);
  await assert.rejects(service.probeDuration(fixture.inputPath, { signal: AbortSignal.abort(reason) }), error => error === reason);
});
