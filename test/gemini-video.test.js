import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGeminiVideoFiles, isGeminiFileUri, absoluteClipTimes } from '../lib/gemini-video.js';

const URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc-123';

test('only real Gemini file URIs are accepted', () => {
  assert.equal(isGeminiFileUri(URI), true);
  assert.equal(isGeminiFileUri('https://example.com/v1beta/files/abc'), false);
  assert.equal(isGeminiFileUri(`${URI}?x=1`), false);
});

test('prepare uploads once, waits for ACTIVE and reuses the file for the same key and source', async () => {
  const calls = [];
  class GoogleGenAI {
    constructor({ apiKey }) { this.apiKey = apiKey; }
    files = {
      upload: async ({ file, config }) => { calls.push(['upload', file, config.mimeType]); return { name: 'files/abc-123', state: 'PROCESSING' }; },
      get: async ({ name }) => { calls.push(['get', name]); return { name, state: 'ACTIVE', uri: URI, mimeType: 'video/mp4' }; }
    };
  }
  const uploads = { source: async id => ({ path: `/tmp/${id}/source.bin`, hash: 'f'.repeat(64) }) };
  const files = createGeminiVideoFiles({ GoogleGenAI, uploads, sleep: async () => {} });
  const first = await files.prepare({ apiKey: 'key-a', uploadId: 'u1' });
  assert.deepEqual(first, { fileUri: URI, mimeType: 'video/mp4', name: 'files/abc-123' });
  await files.prepare({ apiKey: 'key-a', uploadId: 'u1' });
  assert.equal(calls.filter(row => row[0] === 'upload').length, 1);
  // A different API key cannot read the first key's file: upload again.
  await files.prepare({ apiKey: 'key-b', uploadId: 'u1' });
  assert.equal(calls.filter(row => row[0] === 'upload').length, 2);
  assert.equal(calls[0][2], 'video/mp4');
});

test('a rejected or never-ready video fails instead of returning a file', async () => {
  const make = state => class { files = { upload: async () => ({ name: 'files/x', state }), get: async () => ({ name: 'files/x', state }) }; };
  const uploads = { source: async () => ({ path: '/tmp/s', hash: 'a'.repeat(64) }) };
  await assert.rejects(createGeminiVideoFiles({ GoogleGenAI: make('FAILED'), uploads, sleep: async () => {} })
    .prepare({ apiKey: 'k', uploadId: 'u' }), { code: 'GEMINI_VIDEO_REJECTED' });
  let t = 0;
  await assert.rejects(createGeminiVideoFiles({ GoogleGenAI: make('PROCESSING'), uploads, now: () => (t += 60000), sleep: async () => {} })
    .prepare({ apiKey: 'k', uploadId: 'u' }), { code: 'GEMINI_VIDEO_PROCESSING_TIMEOUT' });
});

test('clip-relative times are shifted to absolute source seconds, absolute times are kept', () => {
  const relative = absoluteClipTimes([{ startTime: 2, endTime: 10, loopStartTime: 3, loopEndTime: 9,
    verifiedSubsequences: [{ startTime: 3, endTime: 8 }] }], 120, 180);
  assert.equal(relative[0].startTime, 122);
  assert.equal(relative[0].loopEndTime, 129);
  assert.deepEqual(relative[0].verifiedSubsequences[0], { startTime: 123, endTime: 128 });
  const absolute = absoluteClipTimes([{ startTime: 125, endTime: 140 }], 120, 180);
  assert.equal(absolute[0].startTime, 125);
});

test('the analysis route sends the video clip instead of storyboard images when a file URI is given', async () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /fileData: \{ fileUri: videoFileUri, mimeType: geminiVideoMime\(req\.body\?\.videoMimeType\) \}/);
  assert.match(server, /videoMetadata: \{ startOffset: `\$\{chunkStart\}s`, endOffset: `\$\{chunkEnd\}s`, fps: GEMINI_VIDEO_FPS \}/);
  assert.match(server, /if \(!files\.length && !videoFileUri\)/);
  assert.match(server, /app\.post\('\/api\/gemini-video\/prepare'/);
});

test('client builds the copy, uploads it in resumable chunks and asks the server to hand it to Google', async () => {
  const { prepareGeminiVideo } = await import('../public/gemini-video-client.js');
  const calls = [];
  const proxy = new File([new Uint8Array(20 * 1024 * 1024)], 'analysis-proxy.webm', { type: 'video/webm' });
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method, options.headers?.['X-Gemini-Api-Key'] || '']);
    const body = url.endsWith('/uploads/start') ? { uploadId: 'u-1', chunkSize: 8 * 1024 * 1024 }
      : url.endsWith('/prepare') ? { available: true, fileUri: URI, mimeType: 'video/webm' } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await prepareGeminiVideo(new Blob(['x']), { fetchImpl, makeProxy: async () => proxy,
    headers: { 'X-Gemini-Api-Key': 'user-key' } });
  assert.deepEqual(result, { fileUri: URI, mimeType: 'video/webm', proxyBytes: proxy.size });
  assert.equal(calls.filter(([url]) => /\/chunk\/\d+$/.test(url)).length, 3);
  assert.equal(calls.at(-1)[0], '/api/gemini-video/prepare');
  assert.equal(calls.at(-1)[2], 'user-key');
});
