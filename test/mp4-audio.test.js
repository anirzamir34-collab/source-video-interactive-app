import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractMp4Audio, packAudioChunks } from '../public/mp4-audio.js';
import { dialogueUploadLimit, dialogueUploadMimeType } from '../public/media-limits.js';

const ffmpeg = '/usr/bin/ffmpeg';
const ffprobe = '/usr/bin/ffprobe';
const skip = !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe);
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-mp4-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function createVideo(file, extra = [], inputExtra = []) {
  execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    ...inputExtra, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, file], { timeout: 10000 });
}
function packets(file) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,duration,size,data_hash', '-of', 'json', file])).packets;
}
async function verifyTrack(t, { extra = [], inputExtra = [] } = {}) {
  const dir = directory(t), input = path.join(dir, 'source.mp4'), output = path.join(dir, 'speech.m4a');
  createVideo(input, extra, inputExtra);
  const source = fs.readFileSync(input);
  const audio = await extractMp4Audio(new File([source], 'source.mp4', { type: 'video/mp4' }));
  assert.ok(audio instanceof File);
  assert.equal(audio.type, 'audio/mp4');
  assert.ok(audio.size < source.length);
  fs.writeFileSync(output, Buffer.from(await audio.arrayBuffer()));
  const streams = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output])).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0].codec_type, 'audio');
  // Compare every compressed packet and its timing, not just a plausible duration.
  assert.deepEqual(packets(output), packets(input));
  execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { timeout: 10000 });
  assert.deepEqual(fs.readFileSync(input), source);
  return { audioBytes: audio.size, videoBytes: source.length };
}

test('ordinary MP4 with index at the end keeps every audio packet and timestamp', { skip }, async t => {
  const sizes = await verifyTrack(t);
  t.diagnostic(JSON.stringify(sizes));
});
test('fast-start MP4 keeps every audio packet and timestamp', { skip }, t => verifyTrack(t, { extra: ['-movflags', '+faststart'] }));
test('delayed audio keeps its original edit list and timestamps', { skip }, t => verifyTrack(t, { inputExtra: ['-itsoffset', '0.6'] }));

test('a 1.9 GB disk-backed MP4 reads only its small index and uploads audio-sized bytes', { skip }, async t => {
  const dir = directory(t), input = path.join(dir, 'large.mp4');
  createVideo(input);
  const originalSize = fs.statSync(input).size;
  const totalSize = Math.round(1919.4 * 1024 * 1024);
  const padding = Buffer.alloc(8);
  padding.writeUInt32BE(totalSize - originalSize, 0);
  padding.write('free', 4);
  const fd = fs.openSync(input, 'r+');
  fs.writeSync(fd, padding, 0, padding.length, originalSize);
  fs.ftruncateSync(fd, totalSize);
  fs.closeSync(fd);
  const source = await fs.openAsBlob(input, { type: 'video/mp4' });
  let readBytes = 0, largestRead = 0;
  const slice = source.slice.bind(source);
  source.arrayBuffer = () => assert.fail('must never read the whole source video');
  source.slice = (start, end) => {
    const part = slice(start, end);
    const read = part.arrayBuffer.bind(part);
    part.arrayBuffer = () => { readBytes += part.size; largestRead = Math.max(largestRead, part.size); return read(); };
    return part;
  };
  const audio = await extractMp4Audio(source);
  assert.ok(audio?.size > 0 && audio.size < 100000);
  assert.ok(readBytes < 100000 && largestRead < 100000);
  const output = path.join(dir, 'speech.m4a');
  fs.writeFileSync(output, Buffer.from(await audio.arrayBuffer()));
  assert.deepEqual(packets(output), packets(input));
  t.diagnostic(JSON.stringify({ sourceBytes: source.size, uploadedBytes: audio.size, indexReadBytes: readBytes }));
});

test('fragmented or malformed files return to existing preparation without truncated audio', { skip }, async t => {
  const dir = directory(t), input = path.join(dir, 'fragmented.mp4');
  createVideo(input, ['-movflags', 'frag_keyframe+empty_moov']);
  assert.equal(await extractMp4Audio(await fs.openAsBlob(input)), null);
  for (const bytes of [Buffer.from('invalid-video'), Buffer.from('00000001mdat0000'), Buffer.alloc(16)]) {
    assert.equal(await extractMp4Audio(new File([bytes], 'bad.mp4')), null);
  }
});

test('chunk offsets outside source media are rejected instead of producing incomplete audio', { skip }, async t => {
  const dir = directory(t), input = path.join(dir, 'source.mp4');
  createVideo(input);
  const bytes = fs.readFileSync(input);
  let at = -1, count = 0;
  while ((at = bytes.indexOf('stco', at + 1)) !== -1) {
    bytes.writeUInt32BE(bytes.length + 10, at + 12);
    count++;
  }
  assert.ok(count >= 2);
  assert.equal(await extractMp4Audio(new File([bytes], 'broken.mp4')), null);
});

test('audio-only M4A uses the existing audio upload limit and MIME type', () => {
  const mime = dialogueUploadMimeType(new File(['audio'], 'dialogue.m4a'));
  assert.equal(mime, 'audio/mp4');
  assert.equal(dialogueUploadLimit(mime), 250 * 1024 * 1024);
});

test('thousands of source fragments become a few sequential upload blocks without changing bytes', async () => {
  const bytes = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
  const file = new File([bytes], 'fragmented-source.mp4');
  const chunks = Array.from(bytes, (_value, index) => ({ start: index, size: 1 }));
  const parts = await packAudioChunks(file, chunks, bytes.length, 1024);
  assert.equal(parts.length, 5);
  assert.ok(parts.every((part, index) => part.byteLength === (index < 4 ? 1024 : 1)));
  const packed = new Uint8Array(await new Blob(parts).arrayBuffer());
  assert.deepEqual(packed, bytes);
});

test('packing sparse audio uses bounded batch reads, not one async file read per tiny sample', async t => {
  const bytes = Uint8Array.from({ length: 8194 }, (_, index) => index % 251);
  const file = new File([bytes], 'interleaved.mp4');
  const chunks = Array.from({ length: 4097 }, (_, i) => ({ start: i * 2, size: 1 }));
  const originalRead = Blob.prototype.arrayBuffer;
  const reads = [];
  const progress = [];
  Blob.prototype.arrayBuffer = function () { reads.push(this.size); return originalRead.call(this); };
  t.after(() => { Blob.prototype.arrayBuffer = originalRead; });
  const parts = await packAudioChunks(file, chunks, chunks.length, 1024, {
    onProgress: value => progress.push(value)
  });
  assert.ok(reads.length <= 5, `${reads.length} file reads for only 4097 audio bytes`);
  assert.ok(reads.every(size => size <= 1024));
  assert.equal(progress.at(-1)?.loaded, 4097);
  assert.equal(progress.at(-1)?.total, 4097);
  assert.ok(progress.every((row, i) => !i || row.loaded > progress[i - 1].loaded));
  assert.deepEqual(new Uint8Array(await new Blob(parts).arrayBuffer()),
    Uint8Array.from(chunks, chunk => bytes[chunk.start]));
});

test('a never-settling Android file read releases preparation at its deadline', async () => {
  const file = new File([new Uint8Array(32)], 'stalled.mp4');
  file.slice = () => Object.assign(new Blob(['pending-read']), { arrayBuffer: () => new Promise(() => {}) });
  let watchdog;
  try {
    await assert.rejects(Promise.race([
      extractMp4Audio(file, { timeoutMs: 5 }),
      new Promise(resolve => { watchdog = setTimeout(() => resolve('still-pending'), 100); })
    ]), error => error.code === 'LOCAL_AUDIO_PREPARATION_TIMEOUT');
  } finally { clearTimeout(watchdog); }
});

test('cancelled extraction never reads the old file or reports progress', async () => {
  const file = new File([new Uint8Array(32)], 'old.mp4');
  file.slice = () => assert.fail('cancelled source must not be read');
  const reason = new Error('new source selected');
  await assert.rejects(extractMp4Audio(file, {
    signal: AbortSignal.abort(reason), onProgress: () => assert.fail('stale progress')
  }), error => error === reason);
});

test('a late batch read after cancellation cannot publish progress or start another batch', async t => {
  const originalRead = Blob.prototype.arrayBuffer;
  let finishRead;
  let reads = 0;
  Blob.prototype.arrayBuffer = function () {
    reads++;
    return new Promise(resolve => { finishRead = () => resolve(new ArrayBuffer(this.size)); });
  };
  t.after(() => { Blob.prototype.arrayBuffer = originalRead; });
  const controller = new AbortController();
  const progress = [];
  const pending = packAudioChunks(new File([new Uint8Array(2048)], 'source.mp4'),
    [{ start: 0, size: 2048 }], 2048, 1024, { signal: controller.signal, onProgress: row => progress.push(row) });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishRead();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(progress.length, 0);
});
