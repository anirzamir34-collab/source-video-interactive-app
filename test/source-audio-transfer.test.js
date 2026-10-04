import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createSourceAudioPreparer } from '../public/source-audio.js';
import { extractMp4Audio } from '../public/mp4-audio.js';
import { createTurkishMediaClient } from '../public/turkish-media-client.js';
import { createMediaUploads } from '../lib/turkish-media/uploads.js';
import { createAudioService } from '../lib/turkish-media/audio.js';

class Video extends EventTarget {
  duration = 4; currentTime = 0; paused = true; muted = false; volume = 1;
  readyState = 4; ended = false; seeking = false; playbackRate = 1;
  src = 'blob:original-video';
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'vq-source-audio-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test('real MP4 stays on the device while only MP3 reaches uploads, preserving the full video clock and reuse', async t => {
  const root = await directory(t), original = path.join(root, 'source.mp4');
  execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', original]);
  const source = new File([await fs.readFile(original)], 'source.mp4', { type: 'video/mp4' });
  const uploads = createMediaUploads({ directory: path.join(root, 'uploads') });
  const audio = createAudioService({ ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe' });
  const video = new Video(), statuses = [], starts = [], chunks = [];
  let extractionCount = 0, encodingCount = 0, measuredSource, jobs = 0;
  const prepareSourceAudio = createSourceAudioPreparer({ extract: (...args) => {
    extractionCount++; return extractMp4Audio(...args);
  }, encode: async file => {
    encodingCount++;
    assert.equal(file.type, 'audio/mp4');
    const bytes = execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-ar', '32000', '-f', 'mp3', 'pipe:1'],
    { input: Buffer.from(await file.arrayBuffer()) });
    return new File([bytes], 'source-audio.mp3', { type: 'audio/mpeg' });
  } });
  const manifest = { version: 1, jobId: 'audio-job', sourceTranscript: {
    source: { duration: 4 }, language: 'en', speakers: [], utterances: [], audioEvents: [] },
    subtitles: { source_tr: [], dub_tr: [] }, assets: {}, qualityReport: { sourceDuration: 4 } };
  const client = createTurkishMediaClient({ video, prepareSourceAudio, pollIntervalMs: 1,
    onStatus: value => statuses.push(value), fetchImpl: async (address, init = {}) => {
      const url = String(address);
      if (url.endsWith('/uploads/start')) {
        const body = JSON.parse(init.body); starts.push(body);
        assert.equal(body.mimeType, 'audio/mpeg'); assert.equal(body.timelineDuration, 4);
        assert.equal(body.fileName, 'source-audio.mp3');
        assert.ok(body.totalSize < source.size);
        return Response.json(await uploads.start(body));
      }
      const status = url.match(/\/uploads\/([^/]+)\/status$/);
      if (status) return Response.json(await uploads.status(status[1]));
      const chunk = url.match(/\/uploads\/([^/]+)\/chunk\/(\d+)$/);
      if (chunk) {
        chunks.push(init.body);
        return Response.json(await uploads.writeChunk(chunk[1], Number(chunk[2]), Buffer.from(await init.body.arrayBuffer())));
      }
      if (url.endsWith('/jobs') && init.method === 'POST') {
        const body = JSON.parse(init.body); measuredSource = await uploads.source(body.uploadId);
        assert.equal(measuredSource.timelineDuration, 4);
        if (!jobs++) {
          const probe = JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', measuredSource.path]));
          assert.deepEqual(probe.streams.map(stream => stream.codec_type), ['audio']);
          assert.equal(probe.streams[0].codec_name, 'mp3');
          const prepared = await audio.extractSource(measuredSource, { directory: path.join(root, 'prepared') });
          assert.ok(Math.abs(prepared.duration - 4) < 1 / 48000);
          // A shorter clock hint can never trim two seconds of real speech.
          const shorter = await audio.extractSource({ ...measuredSource, timelineDuration: 1 }, { directory: path.join(root, 'shorter') });
          assert.ok(shorter.duration >= 2);
        }
        return Response.json({ jobId: 'audio-job' });
      }
      if (url.endsWith('/jobs/audio-job')) return Response.json({ state: 'READY', result: manifest });
      throw new Error(`Unexpected media request: ${url}`);
    } });
  t.after(() => client.destroy());
  const options = { outputs: { dub: false, subtitles: false, transcriptOnly: true } };
  await client.start(source, options);
  const uploadedBytes = chunks.reduce((sum, item) => sum + item.size, 0);
  assert.equal(uploadedBytes, starts[0].totalSize);
  assert.ok(uploadedBytes < source.size);
  await client.start(source, options);
  assert.equal(extractionCount, 1, 'the transcript and final media pass reuse the extracted audio');
  assert.equal(encodingCount, 1, 'the final media pass reuses the completed MP3');
  assert.equal(chunks.reduce((sum, item) => sum + item.size, 0), uploadedBytes, 'completed audio chunks are not uploaded again');
  assert.equal(starts[0].clientUploadKey, starts[1].clientUploadKey);
  assert.equal(video.src, 'blob:original-video'); assert.equal(video.currentTime, 0);
  assert.ok(statuses.some(value => value.state === 'PREPARING_AUDIO'));
  t.diagnostic(JSON.stringify({ videoBytes: source.size, audioBytes: uploadedBytes, extractionCount, videoTimeline: 4 }));
});

test('unsupported source extraction never falls back to uploading the original video', async t => {
  const requests = [];
  const client = createTurkishMediaClient({ video: new Video(),
    prepareSourceAudio: createSourceAudioPreparer({ extract: async () => null, encode: async () => {
      throw Object.assign(new Error('No local decoder'), { code: 'LOCAL_AUDIO_UNSUPPORTED' });
    } }),
    fetchImpl: async url => { requests.push(url); throw new Error('Video must remain local'); } });
  t.after(() => client.destroy());
  await assert.rejects(client.start(new File(['unsupported video'], 'source.webm', { type: 'video/webm' })), { code: 'LOCAL_AUDIO_UNSUPPORTED' });
  assert.deepEqual(requests, []);
});

test('a preparer returning a video cannot bypass the audio-only upload boundary', async t => {
  const video = new File(['video bytes'], 'source.mp4', { type: 'video/mp4' });
  const requests = [];
  const client = createTurkishMediaClient({ video: new Video(), prepareSourceAudio: async () => video,
    fetchImpl: async url => { requests.push(url); throw new Error('No upload permitted'); } });
  t.after(() => client.destroy());
  await assert.rejects(client.start(video), { code: 'SOURCE_AUDIO_REQUIRED' });
  assert.deepEqual(requests, []);
});

test('unsupported containers use the local MP3 encoder and reject an uncompressed fallback', async () => {
  const source = new File(['local webm'], 'source.webm', { type: 'video/webm' });
  const phases = [];
  const prepare = createSourceAudioPreparer({ extract: async () => null, encode: async input => {
    assert.equal(input, source);
    return new File(['compressed sound'], 'source.mp3', { type: 'audio/mpeg' });
  } });
  assert.equal((await prepare(source, { onProgress: row => phases.push(row.phase) })).type, 'audio/mpeg');
  assert.ok(phases.includes('audio_extracted'));
  const invalid = createSourceAudioPreparer({ extract: async () => null,
    encode: async () => new File(['large PCM'], 'source.wav', { type: 'audio/wav' }) });
  await assert.rejects(invalid(source), { code: 'SOURCE_MP3_REQUIRED' });
});

test('cancelling local preparation discards the result and permits a clean audio retry', async () => {
  const source = new File(['source'], 'source.mp4', { type: 'video/mp4' });
  let attempts = 0;
  const prepare = createSourceAudioPreparer({ extract: async (_file, { signal }) => {
    if (++attempts > 1) return new File(['audio'], 'source.m4a', { type: 'audio/mp4' });
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, encode: async () => new File(['compressed sound'], 'source.mp3', { type: 'audio/mpeg' }) });
  const controller = new AbortController(), pending = prepare(source, { signal: controller.signal });
  controller.abort(new DOMException('Cancelled source', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await prepare(source)).type, 'audio/mpeg'); assert.equal(attempts, 2);
});

test('audio upload clocks reject invalid values and cannot reuse an incompatible timeline', async t => {
  const root = await directory(t), uploads = createMediaUploads({ directory: root });
  const input = { totalSize: 1, fileName: 'audio.m4a', mimeType: 'audio/mp4', clientUploadKey: 'one-audio', timelineDuration: 4 };
  for (const timelineDuration of [0, -1, '4', Infinity, 86401]) {
    await assert.rejects(uploads.start({ ...input, timelineDuration }), { code: 'INVALID_SOURCE_DURATION' });
  }
  await uploads.start(input);
  await assert.rejects(uploads.start({ ...input, timelineDuration: 5 }), { code: 'UPLOAD_KEY_CONFLICT' });
});

test('MP3 preparation obeys cancellation before reading or encoding the source', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('Stop encoding', 'AbortError'));
  const prepare = createSourceAudioPreparer({ extract: () => assert.fail('must not read'),
    encode: () => assert.fail('must not encode') });
  await assert.rejects(prepare(new File(['video'], 'source.mp4', { type: 'video/mp4' }),
    { signal: controller.signal }), { name: 'AbortError' });
});
