import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installTurkishMediaRoutes } from '../lib/turkish-media/routes.js';

const require = createRequire(import.meta.url);
function dependenciesAvailable(t, names) {
  for (const name of names) {
    try { require.resolve(name); }
    catch { t.skip(`HTTP integration requires the installed ${name} dependency; no installation was performed.`); return false; }
  }
  return true;
}
async function reservePort(t) {
  const reservation = createServer();
  try {
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    return port;
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`The execution environment blocks local HTTP listeners: ${error.code}.`); return null; }
    throw error;
  }
}

// The real application runs with provider secrets empty, so no paid API call
// can occur. Upload persistence is tested across an actual process restart.
test('HTTP integration: authentication, safe errors and restart-resumable full-source upload', { timeout: 30000 }, async t => {
  if (!dependenciesAvailable(t, ['express', 'multer', '@google/genai', 'ffmpeg-static', 'youtube-dl-exec'])) return;
  const port = await reservePort(t); if (port === null) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vq-http-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let server, exited, diagnostics = '';
  const stop = async () => { if (server && server.exitCode === null) server.kill('SIGTERM'); await exited; };
  t.after(stop);
  const startServer = async () => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), APP_PASSWORD: 'local-stability-test', GEMINI_API_KEY: '',
        ELEVENLABS_API_KEY: '', OPENAI_API_KEY: '', DUB_CACHE_DIRECTORY: directory,
        DUB_QUALITY_MODE: 'quality', TRANSLATION_PROVIDER: 'openai', EXTERNAL_ANALYSIS_URL: 'http://127.0.0.1:1' }
    });
    server.stderr.on('data', chunk => { diagnostics += chunk; });
    exited = new Promise(resolve => server.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error(`Startup timed out: ${diagnostics}`)), 8000);
      server.once('exit', code => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${diagnostics}`)); });
      server.stdout.on('data', chunk => { if (String(chunk).includes('listening on')) { clearTimeout(deadline); resolve(); } });
    });
  };
  await startServer();
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000), redirect: 'manual', ...options });
  let cookie;
  const jsonRequest = (route, body) => request(route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const uploadStart = async body => { const response = await jsonRequest('/api/turkish-media/uploads/start', body); assert.equal(response.status, 200); return response.json(); };
  const chunk = (id, index, body) => request(`/api/turkish-media/uploads/${id}/chunk/${index}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body });
  const sourcePath = id => path.join(directory, 'uploads', id, 'source.bin');

  await t.test('health is public; media API and artifacts require authentication', async () => {
    assert.equal((await (await request('/health')).json()).status, 'ok');
    for (const route of ['/api/missing', '/api/turkish-media/capabilities', '/api/turkish-media/voices', '/api/turkish-media/jobs/id/artifacts/mix.wav']) {
      const response = await request(route); assert.equal(response.status, 401);
      assert.equal((await response.json()).reason, 'AUTH_REQUIRED');
    }
  });
  await t.test('malformed cookie cannot crash login', async () => {
    const response = await request('/login', { headers: { Cookie: 'videoquest_owner=%E0%A4%A' } });
    assert.equal(response.status, 200); await response.text();
  });
  await t.test('login grants a session and current application assets load', async () => {
    const response = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=local-stability-test' });
    assert.equal(response.status, 302); cookie = response.headers.get('set-cookie').split(';')[0];
    const page = await request('/', { headers: { Cookie: cookie } }); assert.equal(page.status, 200);
    const html = await page.text(); assert.match(html, /app\.js/);
    for (const id of ['dubBufferStatus', 'dubBufferMessage', 'dubRetryBtn', 'dubContinueOriginalBtn']) assert.ok(html.includes(`id="${id}"`), id);
    for (const file of ['/app.js', '/turkish-media-client.js', '/adult-gameplay.js', '/engine-hardening.js', '/sequence-integrity.js', '/story-engine.js', '/character-identity.js']) {
      const script = await request(file, { headers: { Cookie: cookie } }); assert.equal(script.status, 200, file);
      assert.match(script.headers.get('content-type'), /javascript/); await script.text();
    }
  });
  await t.test('unknown and obsolete APIs, malformed JSON and oversized bodies return safe JSON errors', async () => {
    for (const route of ['/api/does-not-exist', '/api/ai-usage-status']) {
      const missing = await request(route, { headers: { Cookie: cookie } }); assert.equal(missing.status, 404);
      assert.equal((await missing.json()).reason, 'API_NOT_FOUND');
    }
    for (const [body, status] of [['{"bad":', 400], [JSON.stringify({ value: 'x'.repeat(1024 * 1024) }), 413]]) {
      const response = await request('/api/turkish-media/uploads/start', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, status); assert.equal((await response.json()).available, false);
    }
  });
  await t.test('ordered uploads are idempotent and reject changed retry bytes', async () => {
    const { uploadId } = await uploadStart({ totalSize: 6, chunkSize: 3, fileName: 'test.mp4', mimeType: 'video/mp4' });
    assert.equal((await (await chunk(uploadId, 0, 'abc')).json()).receivedSize, 3);
    assert.equal((await (await chunk(uploadId, 0, 'abc')).json()).duplicate, true);
    const conflict = await chunk(uploadId, 0, 'xyz'); assert.equal(conflict.status, 409); await conflict.json();
    assert.equal((await (await chunk(uploadId, 1, 'def')).json()).complete, true);
    assert.equal(await fs.readFile(sourcePath(uploadId), 'utf8'), 'abcdef');
    const invalid = await jsonRequest('/api/turkish-media/uploads/start', { totalSize: 1.5 }); assert.equal(invalid.status, 400); await invalid.json();
  });
  await t.test('device key dedup and partial chunk status survive server restart', async () => {
    const body = { totalSize: 6, chunkSize: 3, fileName: 'device.mp4', mimeType: 'video/mp4', clientUploadKey: 'restart-device' };
    const [first, second] = await Promise.all([uploadStart(body), uploadStart(body)]);
    assert.equal(first.uploadId, second.uploadId);
    await (await chunk(first.uploadId, 0, 'abc')).json();
    await stop(); await startServer();
    const resumed = await uploadStart(body); assert.equal(resumed.uploadId, first.uploadId); assert.deepEqual(resumed.receivedChunks, [0]);
    await (await chunk(resumed.uploadId, 1, 'def')).json();
    assert.equal(await fs.readFile(sourcePath(resumed.uploadId), 'utf8'), 'abcdef');
  });
  await t.test('provider configuration failure retains complete source bytes for job retry', async () => {
    const body = { totalSize: 6, chunkSize: 6, fileName: 'retry.mp4', mimeType: 'video/mp4', clientUploadKey: 'provider-retry' };
    const { uploadId } = await uploadStart(body); await (await chunk(uploadId, 0, 'abcdef')).json();
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await jsonRequest('/api/turkish-media/jobs', { uploadId, outputs: { dub: true, subtitles: true } });
      assert.equal(failed.status, 503); assert.equal((await failed.json()).reason, 'ELEVENLABS_NOT_CONFIGURED');
      assert.equal(await fs.readFile(sourcePath(uploadId), 'utf8'), 'abcdef');
    }
    const retained = await uploadStart(body); assert.equal(retained.uploadId, uploadId); assert.equal(retained.complete, true);
  });
  await t.test('parallel chunk deliveries retain their exact fixed offsets', async () => {
    const { uploadId } = await uploadStart({ totalSize: 12, chunkSize: 4, fileName: 'parallel.mp4', mimeType: 'video/mp4' });
    const payloads = await Promise.all([chunk(uploadId, 2, 'IJKL'), chunk(uploadId, 0, 'ABCD'), chunk(uploadId, 1, 'EFGH')].map(async response => (await response).json()));
    assert.ok(payloads.some(item => item.complete === true));
    assert.equal(await fs.readFile(sourcePath(uploadId), 'utf8'), 'ABCDEFGHIJKL');
    const status = await request(`/api/turkish-media/uploads/${uploadId}/status`, { headers: { Cookie: cookie } });
    assert.deepEqual((await status.json()).receivedChunks, [0, 1, 2]);
  });
  await t.test('raw parser size errors and unsupported source formats retain their status', async () => {
    const unsupported = await jsonRequest('/api/turkish-media/uploads/start', { totalSize: 6, mimeType: 'text/plain' });
    assert.equal(unsupported.status, 415); assert.equal((await unsupported.json()).reason, 'UNSUPPORTED_VIDEO_FORMAT');
    const raw = await chunk('missing', 0, Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.equal(raw.status, 413); assert.equal((await raw.json()).reason, 'UPLOAD_TOO_LARGE');
  });
  await t.test('complete M4A sources use the same resumable media transport', async () => {
    const { uploadId } = await uploadStart({ totalSize: 6, chunkSize: 6, fileName: 'source.m4a', mimeType: 'audio/mp4' });
    assert.equal((await (await chunk(uploadId, 0, 'speech')).json()).complete, true);
    assert.equal(await fs.readFile(sourcePath(uploadId), 'utf8'), 'speech');
  });
  await t.test('capabilities contain configured flags and never expose a credential', async () => {
    const response = await request('/api/turkish-media/capabilities', { headers: { Cookie: cookie } });
    const body = await response.json(); assert.equal(body.configured, false);
    assert.doesNotMatch(JSON.stringify(body), /apiKey|authorization|x-elevenlabs-key/i);
  });
  await t.test('voice catalog fails safely when the backend key is absent', async () => {
    const response = await request('/api/turkish-media/voices', { headers: { Cookie: cookie } });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.reason, 'ELEVENLABS_NOT_CONFIGURED');
    assert.doesNotMatch(JSON.stringify(body), /local-stability-test|\/private/);
  });
});

test('HTTP artifacts send exact Range bytes and retain the cache lease until response finishes', { timeout: 10000 }, async t => {
  if (!dependenciesAvailable(t, ['express'])) return;
  const express = (await import('express')).default;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vq-http-artifact-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mix.wav'); await fs.writeFile(file, '0123456789');
  let acquired = 0, released = 0;
  const app = express();
  app.use((req, res, next) => req.get('cookie') === 'owner=yes' ? next() : res.status(401).json({ reason: 'AUTH_REQUIRED' }));
  installTurkishMediaRoutes(app, { uploads: {}, rawParser: express.raw(), jobs: {
    artifact: async () => { acquired++; return { path: file, release: () => { released++; } }; }
  } });
  let server;
  try { server = await new Promise((resolve, reject) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject); }); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`Local HTTP listener blocked: ${error.code}.`); return; } throw error; }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/turkish-media/jobs/id/artifacts/mix.wav`;
  assert.equal((await fetch(url)).status, 401); assert.equal(acquired, 0);
  const response = await fetch(url, { headers: { Cookie: 'owner=yes', Range: 'bytes=2-4' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(response.headers.get('content-length'), '3'); assert.equal(await response.text(), '234');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquired, released);
  const invalid = await fetch(url, { headers: { Cookie: 'owner=yes', Range: 'bytes=20-30' } });
  assert.equal(invalid.status, 416); await invalid.text();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquired, released);
});
