import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoDownloader } from '../public/video-download.js';
import { MAX_VIDEO_BYTES, MAX_MEMORY_VIDEO_BYTES, dialogueUploadLimit } from '../public/media-limits.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function diskFixture({ quota = 10 * MAX_VIDEO_BYTES, writeError, closeError, writable = true } = {}) {
  const files = new Map();
  const held = new Set();
  const events = [];
  const locks = { async request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (held.has(name)) {
      assert.equal(options.ifAvailable, true);
      return callback(null);
    }
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
  const dir = {
    async *entries() { for (const name of [...files.keys()]) yield [name, { kind: 'file' }]; },
    async removeEntry(name) { events.push('remove'); files.delete(name); },
    async getFileHandle(name) {
      if (!files.has(name)) files.set(name, { bytes: 0, chunks: [] });
      const entry = files.get(name);
      return {
        async getFile() {
          // Virtual chunks test byte budgets without allocating gigabytes in CI.
          if (entry.chunks.some(chunk => !(chunk instanceof Uint8Array))) {
            return { size: entry.bytes, slice: (_start, _end, type) => ({ size: entry.bytes, type }) };
          }
          return new File(entry.chunks, name);
        },
        createWritable: !writable ? undefined : async () => ({
          async write(value) {
            events.push('write');
            await tick();
            if (writeError) throw writeError;
            entry.bytes += value.byteLength;
            entry.chunks.push(value);
          },
          async close() { events.push('close'); if (closeError) throw closeError; },
          async abort() { events.push('abort'); }
        })
      };
    }
  };
  const storage = { getDirectory: async () => ({ getDirectoryHandle: async () => dir }), estimate: async () => ({ quota, usage: 0 }) };
  return { storage, locks, dir, files, held, events };
}

function virtualResponse(lengths, total) {
  let index = 0;
  let cancelled = false;
  let reads = 0;
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'video/mp4', ...(total === undefined ? {} : { 'content-length': String(total) }) }),
    body: {
      async cancel() { cancelled = true; },
      getReader: () => ({
        async read() { reads++; return index < lengths.length ? { value: { byteLength: lengths[index++] } } : { done: true }; },
        async cancel() { cancelled = true; }, releaseLock() {}
      })
    },
    get cancelled() { return cancelled; }, get reads() { return reads; }
  };
}

test('disk transfers accept 700 MiB and the exact 2 GiB boundary, with or without Content-Length', async () => {
  for (const size of [700 * 1024 * 1024, MAX_VIDEO_BYTES]) {
    for (const total of [size, undefined]) {
      const disk = diskFixture();
      const response = virtualResponse([size / 2, size / 2], total);
      const downloads = createVideoDownloader({ ...disk, fetch: async () => response });
      const progress = [];
      const blob = await downloads.download('/video', { onProgress: value => progress.push(value) });
      assert.equal(blob.size, size);
      assert.equal(progress.at(-1).loaded, size);
      assert.equal(disk.files.size, 1);
      assert.deepEqual(disk.events, ['write', 'write', 'close']);
      await downloads.release(blob);
      assert.equal(disk.files.size, 0);
      assert.equal(disk.held.size, 0);
    }
  }
});

test('over-limit known and unknown streams abort and delete temporary bytes', async () => {
  for (const total of [MAX_VIDEO_BYTES + 1, undefined]) {
    const disk = diskFixture();
    const response = virtualResponse([MAX_VIDEO_BYTES, 1], total);
    let signal;
    const downloads = createVideoDownloader({ ...disk, fetch: async (_url, options) => { signal = options.signal; return response; } });
    await assert.rejects(downloads.download('/video'), /2048 MB/);
    assert.equal(response.cancelled, true);
    assert.equal(signal.aborted, true);
    assert.equal(disk.files.size, 0);
    assert.equal(disk.held.size, 0);
    if (total) assert.equal(response.reads, 0);
  }
});

test('disk bytes and MIME survive adoption, while source release removes only its own temporary file', async () => {
  const disk = diskFixture();
  const downloads = createVideoDownloader({ ...disk, fetch: async () => new Response('exact bytes', { headers: { 'content-type': 'video/webm' } }) });
  const blob = await downloads.download('/video');
  assert.equal(await blob.text(), 'exact bytes');
  assert.equal(blob.type, 'video/webm');
  const file = downloads.adopt(blob, new File([blob], 'source.webm', { type: blob.type }));
  await downloads.release(blob);
  assert.equal(disk.files.size, 1);
  assert.equal(await file.text(), 'exact bytes');
  await downloads.release(file);
  await downloads.release(file);
  assert.equal(disk.files.size, 0);
});

test('quota failures, failed close and truncated responses never return partial media or leak files', async () => {
  for (const options of [
    { quota: 2 },
    { writeError: new DOMException('full', 'QuotaExceededError') },
    { closeError: new DOMException('full', 'QuotaExceededError') },
    { truncated: true }
  ]) {
    const disk = diskFixture(options);
    const downloads = createVideoDownloader({ ...disk, fetch: async () => new Response('bytes', { headers: { 'content-length': options.truncated ? '10' : '5' } }) });
    await assert.rejects(downloads.download('/video'), /depolama|eksik/);
    assert.equal(disk.files.size, 0);
    assert.equal(disk.held.size, 0);
  }
});

test('cancellation during a disk write discards the partial file and closes its lock', async () => {
  const disk = diskFixture();
  const controller = new AbortController();
  const downloads = createVideoDownloader({ ...disk, fetch: async () => new Response('bytes') });
  await assert.rejects(downloads.download('/video', {
    signal: controller.signal, onProgress() { controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(disk.files.size, 0);
  assert.equal(disk.held.size, 0);
  assert.ok(disk.events.includes('abort'));
});

test('new tabs remove abandoned downloads but preserve another tab’s active video', async () => {
  const disk = diskFixture();
  disk.files.set('download-abandoned', { bytes: 0, chunks: [] });
  disk.files.set('unrelated-file', { bytes: 0, chunks: [] });
  const options = { ...disk, fetch: async () => new Response('bytes') };
  const first = createVideoDownloader(options);
  const file = await first.download('/video');
  assert.equal(disk.files.has('download-abandoned'), false);
  const second = createVideoDownloader(options);
  const other = await second.download('/video');
  assert.equal(disk.files.size, 3); // Two live files and the unrelated entry.
  await first.release(file);
  assert.equal(disk.files.size, 2);
  await second.release(other);
  assert.equal(disk.files.size, 1);
});

test('unavailable disk writes retain a bounded fallback and reject huge files before reading', async () => {
  for (const disk of [{ storage: null, locks: null }, diskFixture({ writable: false })]) {
    const response = virtualResponse([], MAX_MEMORY_VIDEO_BYTES + 1);
    const downloads = createVideoDownloader({ ...disk, fetch: async () => response });
    await assert.rejects(downloads.download('/video'), /600 MB/);
    assert.equal(response.reads, 0);
    assert.equal(response.cancelled, true);
    if (disk.files) assert.equal(disk.files.size, 0);
  }
});

test('video and audio upload limits remain separate and unknown MIME types are rejected', () => {
  assert.equal(dialogueUploadLimit('video/mp4'), MAX_VIDEO_BYTES);
  assert.equal(dialogueUploadLimit('audio/wav'), 250 * 1024 * 1024);
  assert.equal(dialogueUploadLimit('text/html'), 0);
});
