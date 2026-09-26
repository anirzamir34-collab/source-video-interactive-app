import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { prepareLocalDialogueAudio } from '../lib/dialogue-media.js';

const ffmpegPath = fs.existsSync(ffmpegStatic || '') ? ffmpegStatic : '/usr/bin/ffmpeg';
const ffprobe = '/usr/bin/ffprobe';

test('uploaded video yields a compact complete speech track without changing original video bytes', {
  skip: !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobe), timeout: 15000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-local-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.mp4');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input], { timeout: 8000 });
  const original = fs.readFileSync(input);
  const audio = await prepareLocalDialogueAudio({ path: input }, { ffmpegPath });
  assert.equal(audio.mimetype, 'audio/mpeg');
  assert.ok(audio.size > 0 && audio.size < original.length);
  assert.deepEqual(fs.readFileSync(input), original);
  const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', audio.path]));
  assert.equal(metadata.streams.length, 1);
  assert.equal(metadata.streams[0].codec_name, 'mp3');
  assert.equal(metadata.streams[0].sample_rate, '16000');
  assert.equal(metadata.streams[0].channels, 1);
  assert.ok(Number(metadata.streams[0].duration) >= 3);
});

test('failed or cancelled audio preparation never leaves partial derived files', {
  skip: !fs.existsSync(ffmpegPath), timeout: 10000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-audio-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'bad.mp4');
  fs.writeFileSync(input, 'invalid media');
  for (const options of [
    { ffmpegPath },
    { ffmpegPath: path.join(dir, 'missing-ffmpeg') },
    { ffmpegPath, signal: AbortSignal.abort() },
    { ffmpegPath, timeoutMs: 1 }
  ]) {
    await assert.rejects(prepareLocalDialogueAudio({ path: input }, options));
    assert.equal(fs.existsSync(`${input}.dialogue.mp3`), false);
    assert.equal(fs.readFileSync(input, 'utf8'), 'invalid media');
  }
});

test('oversized audio fallback transcodes the complete track to compact inline-ready MP3', {
  skip: !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobe), timeout: 15000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-inline-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.mp3');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '3', '-c:a', 'libmp3lame', '-b:a', '192k', input], { timeout: 8000 });
  const compact = await prepareLocalDialogueAudio({ path: input }, {
    ffmpegPath, audioInput: true, bitrate: '32k'
  });
  assert.ok(compact.size > 0 && compact.size < fs.statSync(input).size);
  const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', compact.path]));
  assert.equal(metadata.streams[0].codec_name, 'mp3');
  assert.ok(Number(metadata.streams[0].duration) >= 3);
});
