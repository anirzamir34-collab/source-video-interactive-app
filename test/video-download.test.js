import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoDownloader } from '../public/video-download.js';
import { MAX_VIDEO_BYTES, MAX_MEMORY_VIDEO_BYTES, dialogueUploadLimit, dialogueUploadMimeType } from '../public/media-limits.js';

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

test('large CDN and local files with generic or missing MIME types retain their video upload allowance', () => {
  for (const type of ['', 'application/octet-stream', 'binary/octet-stream']) {
    for (const name of ['download.mp4', 'source.WEBM', 'local.MOV']) {
      assert.equal(dialogueUploadLimit(dialogueUploadMimeType({ type, name })), MAX_VIDEO_BYTES);
    }
  }
  assert.equal(dialogueUploadMimeType({ name: 'wrong.mp4', type: 'text/html' }), 'text/html');
  assert.equal(dialogueUploadMimeType({ name: 'speech.wav', type: 'audio/wav' }), 'audio/wav');
});

test('small network packets use bounded batched disk writes and preserve every byte', async () => {
  const disk = diskFixture();
  const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => i % 251);
  let offset = 0;
  let packets = 0;
  const progress = [];
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 16 * 1024);
    controller.enqueue(bytes.slice(offset, end)); offset = end; packets++;
  } }), { headers: { 'content-length': String(bytes.length), 'content-type': 'video/mp4' } });
  const downloads = createVideoDownloader({ ...disk, fetch: async () => response });
  const file = await downloads.download('/video', { onProgress: row => progress.push(row) });
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.equal(packets, 193);
  assert.equal(disk.events.filter(event => event === 'write').length, 4);
  assert.ok([...disk.files.values()][0].chunks.every(chunk => chunk.byteLength <= 1024 * 1024));
  assert.ok(progress.length < packets);
  assert.equal(progress.at(-1).loaded, bytes.length);
  await downloads.release(file);
});

const directUrl = 'https://cdn.example.com/source.mp4';
test('failed parallel ranges delete the partial disk file before retaining one serial replacement', async () => {
  const disk = diskFixture();
  const downloads = createVideoDownloader({ ...disk, fetch: async (_url, options) => {
    if (!options.headers) return new Response('complete replacement', { headers: { 'content-type': 'video/mp4' } });
    if (options.headers.Range === 'bytes=0-0') return new Response(new Uint8Array([1]), { status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/12582912', 'content-length': '1', etag: '"original"' } });
    return new Response('changed file', { status: 200 });
  } });
  const file = await downloads.download('/video', { parallel: true });
  assert.equal(await file.text(), 'complete replacement');
  assert.equal(disk.files.size, 1);
  assert.equal(disk.held.size, 1);
  assert.equal(disk.events.filter(event => event === 'abort').length, 1);
  assert.equal(disk.events.filter(event => event === 'remove').length, 1);
  await downloads.release(file);
  assert.equal(disk.files.size, 0);
  assert.equal(disk.held.size, 0);
});

test('permitted direct media needs one source request, no proxy and no credentials', async () => {
  const disk = diskFixture();
  const calls = [];
  const progress = [];
  const downloads = createVideoDownloader({ ...disk, fetch: async (url, options) => {
    calls.push(url);
    assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.headers, undefined);
    return new Response('exact original video', { headers: { 'content-type': 'video/mp4' } });
  } });
  const file = await downloads.download('/proxy', { directUrl, expectedSize: 20, onProgress: row => progress.push(row) });
  assert.equal(await file.text(), 'exact original video');
  assert.deepEqual(calls, [directUrl]);
  assert.equal(progress.at(-1).transport, 'direct');
  await downloads.release(file);
});

test('CORS, HTTP, HTML, changed size and broken direct streams fall back cleanly to the proxy', async () => {
  for (const failure of ['cors', 'http', 'html', 'size', 'stream']) {
    const disk = diskFixture();
    const calls = [];
    const downloads = createVideoDownloader({ ...disk, fetch: async url => {
      calls.push(url);
      if (url === '/proxy') return new Response('video', { headers: { 'content-length': '5', 'content-type': 'video/mp4' } });
      if (failure === 'cors') throw new TypeError('Failed to fetch');
      if (failure === 'http') return new Response('denied', { status: 403 });
      if (failure === 'html') return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      if (failure === 'size') return new Response('other video', { headers: { 'content-length': '11' } });
      let pulled = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (pulled) { controller.error(new Error('connection lost')); return; }
        pulled = true; controller.enqueue(new Uint8Array([1, 2]));
      } }), { headers: { 'content-type': 'video/mp4' } });
    } });
    const file = await downloads.download('/proxy', { directUrl, expectedSize: 5 });
    assert.equal(await file.text(), 'video', failure);
    assert.deepEqual(calls, [directUrl, '/proxy']);
    assert.equal(disk.files.size, 1);
    assert.equal(disk.held.size, 1);
    await downloads.release(file);
    assert.equal(disk.files.size, 0);
  }
});

test('a direct source that never sends headers is bounded and releases its request before fallback', async () => {
  let firstSignal;
  const downloads = createVideoDownloader({ storage: null, locks: null, fetch: async (url, { signal }) => {
    if (url === '/proxy') { assert.equal(firstSignal.aborted, true); return new Response('video'); }
    firstSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const file = await downloads.download('/proxy', { directUrl, directHeaderTimeoutMs: 5 });
  assert.equal(await file.text(), 'video');
});

test('a rejected direct response never waits for its error body before proxy fallback', async () => {
  let cancelled = false;
  const downloads = createVideoDownloader({ storage: null, locks: null, fetch: async url => {
    if (url === '/proxy') { assert.equal(cancelled, true); return new Response('video'); }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 });
  } });
  assert.equal(await (await downloads.download('/proxy', { directUrl })).text(), 'video');
});

test('quota errors, size limits and user cancellation never start a second download', async () => {
  for (const failure of ['quota', 'limit', 'cancel']) {
    const disk = diskFixture(failure === 'quota' ? { quota: 1 } : {});
    const controller = new AbortController();
    let calls = 0;
    const downloads = createVideoDownloader({ ...disk, fetch: async () => {
      calls++;
      return new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': '5' } });
    } });
    await assert.rejects(downloads.download('/proxy', { directUrl, signal: controller.signal,
      maxBytes: failure === 'limit' ? 1 : MAX_VIDEO_BYTES,
      onProgress() { if (failure === 'cancel') controller.abort(); }
    }));
    assert.equal(calls, 1);
    assert.equal(disk.files.size, 0);
    assert.equal(disk.held.size, 0);
  }
});

test('manifest and non-HTTPS inputs always retain the existing proxy flow', async () => {
  for (const directUrl of ['', 'http://cdn.example.com/video.mp4', 'https://cdn.example.com/video.m3u8', 'https://cdn.example.com/video.mpd']) {
    const downloads = createVideoDownloader({ storage: null, locks: null, fetch: async url => {
      assert.equal(url, '/proxy');
      return new Response('video');
    } });
    assert.equal(await (await downloads.download('/proxy', { directUrl })).text(), 'video');
  }
});

test('direct-only mode never fetches the fallback URL, including failed, absent or unsupported sources', async () => {
  for (const candidate of [directUrl, '', 'http://cdn.example.com/video.mp4', 'https://cdn.example.com/video.m3u8']) {
    const disk = diskFixture();
    let calls = 0;
    const downloads = createVideoDownloader({ ...disk, fetch: async url => {
      calls++;
      assert.equal(url, directUrl);
      throw new TypeError('network denied');
    } });
    await assert.rejects(downloads.download('/proxy-never', { directOnly: true, directUrl: candidate }), { code: 'DIRECT_VIDEO_BLOCKED' });
    assert.equal(calls, candidate === directUrl ? 1 : 0);
    assert.equal(disk.files.size, 0);
    assert.equal(disk.held.size, 0);
  }
});

test('direct-only partial transfers are discarded without redownloading through the server', async () => {
  const disk = diskFixture();
  let calls = 0;
  let pulled = false;
  const downloads = createVideoDownloader({ ...disk, fetch: async url => {
    calls++;
    assert.equal(url, directUrl);
    return new Response(new ReadableStream({ pull(controller) {
      if (pulled) controller.error(new Error('disconnected'));
      else { pulled = true; controller.enqueue(new Uint8Array(1024 * 1024)); }
    } }), { headers: { 'content-type': 'video/mp4' } });
  } });
  await assert.rejects(downloads.download('/proxy-never', { directOnly: true, directUrl }), { code: 'DIRECT_VIDEO_BLOCKED' });
  assert.equal(calls, 1);
  assert.equal(disk.files.size, 0);
  assert.equal(disk.held.size, 0);
});
