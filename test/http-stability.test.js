import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';

// Real Express/body-parser/multer integration, isolated from provider services.
test('HTTP integration: authentication, JSON errors and resumable upload', { timeout: 20000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), APP_PASSWORD: 'local-stability-test', GEMINI_API_KEY: '', EXTERNAL_ANALYSIS_URL: 'http://127.0.0.1:1' }
  });
  let diagnostics = '';
  server.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  t.after(async () => { server.kill('SIGTERM'); await exited; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error(`Startup timed out: ${diagnostics}`)), 8000);
    server.once('exit', code => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${diagnostics}`)); });
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('listening on')) { clearTimeout(deadline); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(5000), redirect: 'manual', ...options });
  let cookie;

  await t.test('health is public; protected API still requires authentication', async () => {
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const denied = await request('/api/missing');
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).reason, 'AUTH_REQUIRED');
  });
  await t.test('malformed cookie does not break login', async () => {
    const response = await request('/login', { headers: { Cookie: 'videoquest_owner=%E0%A4%A' } });
    assert.equal(response.status, 200);
    await response.text();
  });
  await t.test('login grants a session and application assets load', async () => {
    const response = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=local-stability-test' });
    assert.equal(response.status, 302);
    cookie = response.headers.get('set-cookie').split(';')[0];
    const page = await request('/', { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /app\.js/);
    for (const id of ['dubBufferStatus', 'dubBufferMessage', 'dubRetryBtn', 'dubContinueOriginalBtn']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    for (const path of ['/app.js', '/mp4-audio.js', '/dubbing-audio.js', '/dubbing-queue.js', '/adult-gameplay.js', '/engine-hardening.js', '/sequence-integrity.js', '/story-engine.js', '/character-identity.js']) {
      const script = await request(path, { headers: { Cookie: cookie } });
      assert.equal(script.status, 200, path);
      assert.match(script.headers.get('content-type'), /javascript/);
      await script.text();
    }
  });
  await t.test('unknown API and malformed or oversized JSON return JSON errors', async () => {
    const missing = await request('/api/does-not-exist', { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).reason, 'API_NOT_FOUND');
    for (const [body, status] of [['{"bad":', 400], [JSON.stringify({ value: 'x'.repeat(1024 * 1024) }), 413]]) {
      const response = await request('/api/dialogue-upload/start', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, status);
      assert.equal((await response.json()).available, false);
    }
  });
  await t.test('upload accepts ordered chunks and tolerates duplicate delivery', async () => {
    const start = await request('/api/dialogue-upload/start', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ totalSize: 6, fileName: 'test.wav', mimeType: 'audio/wav' }) });
    assert.equal(start.status, 200);
    const { uploadId } = await start.json();
    const filePath = `/tmp/videoquest-dialogue/${uploadId}.part`;
    t.after(() => fs.unlink(filePath).catch(() => {}));
    const chunk = (index, body) => request(`/api/dialogue-upload/${uploadId}/chunk`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'x-chunk-index': String(index) }, body });
    assert.equal((await (await chunk(0, 'abc')).json()).receivedSize, 3);
    assert.equal((await (await chunk(0, 'abc')).json()).duplicate, true);
    assert.equal((await (await chunk(1, 'def')).json()).complete, true);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'abcdef');
    const invalid = await request('/api/dialogue-upload/start', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"totalSize":1.5}' });
    assert.equal(invalid.status, 400);
    await invalid.json();
  });
  await t.test('duplicate device upload starts reuse one server upload session', async () => {
    const body = JSON.stringify({
      totalSize: 8,
      fileName: 'device.wav',
      mimeType: 'audio/wav',
      clientUploadKey: 'device-test-one'
    });
    const first = await request('/api/dialogue-upload/start', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.reused, false);
    const second = await request('/api/dialogue-upload/start', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.reused, true);
    assert.equal(secondBody.uploadId, firstBody.uploadId);
    const filePath = `/tmp/videoquest-dialogue/${firstBody.uploadId}.part`;
    t.after(() => fs.unlink(filePath).catch(() => {}));
  });

  await t.test('provider failure retains completed upload bytes for analysis retry', async () => {
    const body = JSON.stringify({ totalSize: 6, mimeType: 'audio/wav', fileName: 'retry.wav', clientUploadKey: 'provider-retry', chunkSize: 6 });
    const starts = await Promise.all([0, 1].map(() => request('/api/dialogue-upload/start', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body
    }).then(response => response.json())));
    assert.equal(starts[0].uploadId, starts[1].uploadId);
    const uploadId = starts[0].uploadId;
    const filePath = `/tmp/videoquest-dialogue/${uploadId}.part`;
    t.after(() => fs.unlink(filePath).catch(() => {}));
    const chunk = await request(`/api/dialogue-upload/${uploadId}/chunk`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'x-chunk-index': '0', 'x-chunk-offset': '0' }, body: 'abcdef'
    });
    assert.equal(chunk.status, 200); await chunk.json();
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData(); form.set('uploadId', uploadId); form.set('duration', '900');
      const failed = await request('/api/gemini-dialogue-analyze', { method: 'POST', headers: { Cookie: cookie }, body: form });
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).reason, 'GEMINI_NOT_CONFIGURED');
      assert.equal(await fs.readFile(filePath, 'utf8'), 'abcdef');
    }
    const resumed = await request('/api/dialogue-upload/start', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body
    });
    const retained = await resumed.json();
    assert.equal(retained.uploadId, uploadId); assert.equal(retained.complete, true);
    assert.equal(retained.chunkSize, 6); assert.deepEqual(retained.receivedChunks, [0]);
  });

  await t.test('parallel audio chunks may arrive out of order and are written at exact offsets', async () => {
    const start = await request('/api/dialogue-upload/start', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalSize: 12, fileName: 'parallel.wav', mimeType: 'audio/wav' })
    });
    const { uploadId } = await start.json();
    const filePath = `/tmp/videoquest-dialogue/${uploadId}.part`;
    t.after(() => fs.unlink(filePath).catch(() => {}));
    const chunk = (index, offset, body) => request(`/api/dialogue-upload/${uploadId}/chunk`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'x-chunk-index': String(index),
        'x-chunk-offset': String(offset)
      },
      body
    });
    const status = async (index, offset, length) => {
      const response = await request(`/api/dialogue-upload/${uploadId}/chunk/${index}/status?offset=${offset}&length=${length}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await status(0, 0, 4)).received, false);
    await chunk(0, 0, 'ABCD');
    assert.equal((await status(0, 0, 4)).received, true);
    assert.equal((await status(0, 1, 4)).received, false);
    const results = await Promise.all([
      chunk(2, 8, 'IJKL'),
      chunk(0, 0, 'ABCD'),
      chunk(1, 4, 'EFGH')
    ]);
    const payloads = await Promise.all(results.map(response => response.json()));
    assert.ok(payloads.some(item => item.complete === true));
    assert.equal(await fs.readFile(filePath, 'utf8'), 'ABCDEFGHIJKL');
  });

  await t.test('late upload middleware errors retain their format and status', async () => {
    const form = new FormData();
    form.append('video', new Blob(['not-video'], { type: 'text/plain' }), 'test.txt');
    const response = await request('/api/gemini-dialogue-analyze', { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).reason, 'UNSUPPORTED_VIDEO_FORMAT');
    const raw = await request('/api/dialogue-upload/missing/chunk', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'x-chunk-index': '0' }, body: Buffer.alloc(10 * 1024 * 1024 + 1)
    });
    assert.equal(raw.status, 413);
    assert.equal((await raw.json()).reason, 'UPLOAD_TOO_LARGE');
  });
  await t.test('compact M4A is accepted by the resumable audio upload endpoint', async () => {
    const response = await request('/api/dialogue-upload/start', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalSize: 6, fileName: 'dialogue.m4a', mimeType: 'audio/mp4' })
    });
    assert.equal(response.status, 200);
    const { uploadId } = await response.json();
    const filePath = `/tmp/videoquest-dialogue/${uploadId}.part`;
    t.after(() => fs.unlink(filePath).catch(() => {}));
    const uploaded = await request(`/api/dialogue-upload/${uploadId}/chunk`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'x-chunk-index': '0' },
      body: 'speech'
    });
    assert.equal((await uploaded.json()).complete, true);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'speech');
  });
});
