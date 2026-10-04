import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithUploadProgress } from '../public/progress-request.js';

function transport() {
  let xhr;
  class Transfer {
    upload = {}; headers = {};
    constructor() { xhr = this; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  return { Transfer, current: () => xhr };
}

test('upload bytes finish before the server response and the wait remains explicit', async () => {
  const { Transfer, current } = transport(), updates = [];
  let resolved = false;
  const body = new Blob(['0123456789']);
  const pending = requestWithUploadProgress('/chunk/0', { body, XMLHttpRequestClass: Transfer,
    headers: { 'Content-Type': 'application/octet-stream' }, onProgress: row => updates.push(row) })
    .then(response => { resolved = true; return response; });
  const xhr = current();
  xhr.upload.onprogress({ loaded: 4, total: 10, lengthComputable: true });
  assert.deepEqual(updates.at(-1), { loaded: 4, total: 10, phase: 'sending' });
  xhr.upload.onload(); await Promise.resolve();
  assert.equal(resolved, false, 'sent bytes are not an acknowledged chunk');
  assert.deepEqual(updates.at(-1), { loaded: 10, total: 10, phase: 'waiting' });
  xhr.status = 200; xhr.responseText = '{"accepted":true}'; xhr.onload();
  const response = await pending;
  assert.equal(response.ok, true); assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(xhr.headers['content-type'], 'application/octet-stream');
});

test('multipart upload uses actual browser totals and cancellation stops late updates', async () => {
  const { Transfer, current } = transport(), updates = [], controller = new AbortController();
  const pending = requestWithUploadProgress('/storyboard', { body: new FormData(),
    signal: controller.signal, XMLHttpRequestClass: Transfer, onProgress: row => updates.push(row) });
  const xhr = current();
  xhr.upload.onprogress({ loaded: 1024, total: 2048, lengthComputable: true });
  assert.equal(updates.at(-1).total, 2048);
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  const count = updates.length;
  xhr.upload.onprogress({ loaded: 2048, total: 2048, lengthComputable: true });
  assert.equal(updates.length, count); assert.equal(xhr.aborted, true);
});

test('a stalled upload rejects on the native transport deadline', async () => {
  const { Transfer, current } = transport();
  const pending = requestWithUploadProgress('/chunk/1', { body: new Blob(['tail']),
    timeoutMs: 25, XMLHttpRequestClass: Transfer });
  assert.equal(current().timeout, 25);
  current().ontimeout();
  await assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
});
