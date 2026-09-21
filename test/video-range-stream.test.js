import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createVideoDownloader } from '../public/video-download.js';

const bytes = Uint8Array.from({ length: 12 * 1024 * 1024 + 17 }, (_, i) => (i * 17 + (i >>> 16)) % 251);
const digest = value => createHash('sha256').update(value).digest('hex');
const expectedHash = digest(bytes);
const full = () => new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
function part(range, changes = {}) {
  const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range);
  const start = Number(first), end = Number(last);
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: {
    'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${bytes.length}`,
    'content-length': String(end - start + 1), etag: '"original"', ...changes
  } });
}
const downloader = fetch => createVideoDownloader({ fetch, storage: null, locks: null });

test('parallel ranges preserve original bytes, ordering and one consistent version', async () => {
  const requests = [], progress = [];
  const downloads = downloader(async (_url, options) => {
    const range = options.headers.Range;
    requests.push(range);
    if (range !== 'bytes=0-0') assert.equal(options.headers['If-Range'], '"original"');
    // Later ranges can finish first; output must remain in source order.
    await new Promise(resolve => setTimeout(resolve, range.startsWith('bytes=1-') ? 15 : 1));
    return part(range);
  });
  const file = await downloads.download('/video', { parallel: true, onProgress: row => progress.push(row) });
  assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash);
  assert.equal(requests.length, 8);
  assert.equal(new Set(requests).size, requests.length);
  assert.equal(progress.at(-1).loaded, bytes.length);
  assert.equal(progress.at(-1).connections, 4);
});

test('servers ignoring Range reuse their full response without a second download', async () => {
  let calls = 0;
  const file = await downloader(async () => { calls++; return full(); }).download('/video', { parallel: true });
  assert.equal(calls, 1);
  assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash);
});

test('missing or weak identity and unavailable range metadata select serial transfer', async () => {
  for (const headers of [{ etag: '' }, { etag: 'W/"original"' }, { 'content-range': '' }, { 'content-encoding': 'gzip' }]) {
    const requests = [];
    const file = await downloader(async (_url, options) => {
      requests.push(options.headers?.Range);
      return options.headers ? part(options.headers.Range, headers) : full();
    }).download('/video', { parallel: true });
    assert.deepEqual(requests, ['bytes=0-0', undefined]);
    assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash);
  }
});

test('stable Last-Modified dates allow ranges when ETag is unavailable', async () => {
  const modified = 'Mon, 01 Jun 2026 00:00:00 GMT';
  let calls = 0;
  const file = await downloader(async (_url, options) => {
    calls++;
    if (options.headers.Range !== 'bytes=0-0') assert.equal(options.headers['If-Range'], modified);
    return part(options.headers.Range, { etag: '', 'last-modified': modified, date: 'Mon, 01 Jun 2026 00:02:00 GMT' });
  }).download('/video', { parallel: true });
  assert.equal(calls, 8);
  assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash);
});

test('changed identity, wrong range, short body and ignored conditional range discard all parts and retry serial once', async () => {
  for (const failure of ['identity', 'range', 'short', 'ignored', 'network']) {
    let serial = 0, rangeRequests = 0;
    const file = await downloader(async (_url, options) => {
      const range = options.headers?.Range;
      if (!range) { serial++; return full(); }
      rangeRequests++;
      if (range === 'bytes=0-0') return part(range);
      if (failure === 'ignored') return full();
      if (failure === 'network') throw new TypeError('connection reset');
      if (failure === 'short') {
        const response = part(range);
        return new Response(new Uint8Array([1]), { status: 206, headers: response.headers });
      }
      return part(range, failure === 'identity' ? { etag: '"changed"' } : { 'content-range': `bytes 2-3/${bytes.length}` });
    }).download('/video', { parallel: true });
    assert.equal(serial, 1, failure);
    assert.equal(rangeRequests, 5, failure);
    assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash, failure);
  }
});

test('a long Retry-After stops range requests without starting another transfer', async () => {
  let serial = 0;
  const downloads = downloader(async (_url, options) => {
    if (!options.headers) { serial++; return full(); }
    if (options.headers.Range === 'bytes=0-0') return part(options.headers.Range);
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
  });
  await assert.rejects(downloads.download('/video', { parallel: true }), { retryAfterMs: 60000 });
  assert.equal(serial, 0);
});

test('user cancellation aborts every active range and never retries', async () => {
  const controller = new AbortController();
  const signals = [];
  let serial = 0;
  const downloads = downloader(async (_url, options) => {
    if (!options.headers) { serial++; return full(); }
    if (options.headers.Range === 'bytes=0-0') return part(options.headers.Range);
    signals.push(options.signal);
    if (signals.length === 4) queueMicrotask(() => controller.abort());
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  await assert.rejects(downloads.download('/video', { parallel: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(signals.length, 4);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(serial, 0);
});

test('controlled HTTP benchmark: concurrent requests improve a per-connection bottleneck without changing bytes', async t => {
  let active = 0, peak = 0;
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : bytes.length - 1;
    if (match && start > 0) assert.equal(req.headers['if-range'], '"original"');
    active++; peak = Math.max(peak, active);
    let offset = start, timer;
    res.on('close', () => { active--; clearTimeout(timer); });
    res.writeHead(match ? 206 : 200, {
      'content-type': 'video/mp4', 'content-length': end - start + 1, etag: '"original"',
      ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {})
    });
    const send = () => {
      if (res.destroyed) return;
      const next = Math.min(end + 1, offset + 64 * 1024);
      const ready = res.write(bytes.subarray(offset, next));
      offset = next;
      if (offset > end) { res.end(); return; }
      if (ready) timer = setTimeout(send, 8);
      else res.once('drain', () => { timer = setTimeout(send, 8); });
    };
    send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/video`;
    const downloads = downloader(fetch);
    const durations = [];
    for (const parallel of [false, true]) {
      const started = performance.now();
      const file = await downloads.download(url, { parallel });
      durations.push(performance.now() - started);
      assert.equal(digest(new Uint8Array(await file.arrayBuffer())), expectedHash);
    }
    const [serial, parallel] = durations;
    t.diagnostic(`12 MiB: serial=${Math.round(serial)}ms parallel=${Math.round(parallel)}ms speedup=${(serial / parallel).toFixed(2)}x peak=${peak}`);
    assert.equal(peak, 4);
    assert.ok(parallel < serial * 0.8, `controlled per-connection limit: ${parallel}ms vs ${serial}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
