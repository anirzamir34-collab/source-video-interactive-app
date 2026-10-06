import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMediaUploads } from '../lib/turkish-media/uploads.js';
import { createTurkishMediaClient, AUDIO_UPLOAD_CHUNK_BYTES } from '../public/turkish-media-client.js';
import { createAnalysisProgress } from '../public/analysis-progress.js';

class Video extends EventTarget {
  duration = 480; currentTime = 0; paused = true; muted = false; volume = 1;
  pause() { this.paused = true; }
}
const result = { version: 1, assets: {}, subtitles: {}, sourceTranscript: { utterances: [], speakers: [] } };
const json = body => Response.json(body);

test('a 5.63 MiB audio transfer checkpoints in three 2 MiB requests and survives a lost response', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vq-upload-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const uploads = createMediaUploads({ directory });
  const source = new File([new Uint8Array(Math.ceil(5.63 * 1024 * 1024)).fill(7)], 'sound.mp3', { type: 'audio/mpeg' });
  const sent = [], statuses = [];
  let lost = false, statusReads = 0, sourcePath;
  const client = createTurkishMediaClient({ video: new Video(), retryDelayMs: 1,
    onStatus: value => statuses.push(value), fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/uploads/start')) {
        const body = JSON.parse(init.body);
        assert.equal(body.chunkSize, AUDIO_UPLOAD_CHUNK_BYTES);
        return json(await uploads.start(body));
      }
      const status = url.match(/\/uploads\/([^/]+)\/status$/);
      if (status) { statusReads++; return json(await uploads.status(status[1])); }
      const chunk = url.match(/\/uploads\/([^/]+)\/chunk\/(\d+)$/);
      if (chunk) {
        sent.push({ index: Number(chunk[2]), size: init.body.size });
        const body = await uploads.writeChunk(chunk[1], Number(chunk[2]), Buffer.from(await init.body.arrayBuffer()));
        if (Number(chunk[2]) === 2 && !lost) { lost = true; throw Error('Network response lost'); }
        return json(body);
      }
      if (url.endsWith('/jobs') && init.method === 'POST') {
        sourcePath = (await uploads.source(JSON.parse(init.body).uploadId)).path;
        return json({ jobId: 'test-job' });
      }
      if (url.endsWith('/jobs/test-job')) return json({ state: 'READY', result });
      throw Error(`Unexpected request ${url}`);
    } });
  t.after(() => client.destroy());
  await client.start(source, { outputs: { transcriptOnly: true, dub: false, subtitles: false } });
  assert.equal(sent.length, Math.ceil(source.size / AUDIO_UPLOAD_CHUNK_BYTES));
  assert.ok(sent.every(chunk => chunk.size <= AUDIO_UPLOAD_CHUNK_BYTES));
  assert.equal(sent.filter(chunk => chunk.index === 2).length, 1);
  assert.equal(sent.reduce((sum, chunk) => sum + chunk.size, 0), source.size);
  assert.equal(statusReads, 2);
  assert.deepEqual(await fs.readFile(sourcePath), Buffer.from(await source.arrayBuffer()));
  assert.ok(statuses.some(status => status.message.includes('alınan ses korunuyor')));
});

test('an upgraded client resumes a partially saved 128 KiB session without starting the audio again', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vq-upload-upgrade-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const uploads = createMediaUploads({ directory });
  const source = new File([new Uint8Array(512 * 1024).fill(11)], 'sound.mp3', { type: 'audio/mpeg' });
  let oldId, selectedId;
  const sent = [];
  const client = createTurkishMediaClient({ video: new Video(), retryDelayMs: 1,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/uploads/start')) {
        const body = JSON.parse(init.body);
        assert.equal(body.chunkSize, AUDIO_UPLOAD_CHUNK_BYTES);
        assert.ok(body.resumeUploadKey);
        if (!oldId) {
          const old = await uploads.start({ ...body, chunkSize: 128 * 1024,
            clientUploadKey: body.resumeUploadKey, resumeUploadKey: undefined });
          oldId = old.uploadId;
          for (let index = 0; index < 2; index++) {
            const bytes = Buffer.from(await source.slice(index * old.chunkSize, (index + 1) * old.chunkSize).arrayBuffer());
            await uploads.writeChunk(oldId, index, bytes);
          }
        }
        const resumed = await uploads.start(body);
        assert.equal(resumed.reused, true);
        return json(resumed);
      }
      const status = url.match(/\/uploads\/([^/]+)\/status$/);
      if (status) return json(await uploads.status(status[1]));
      const chunk = url.match(/\/uploads\/([^/]+)\/chunk\/(\d+)$/);
      if (chunk) {
        sent.push(Number(chunk[2]));
        return json(await uploads.writeChunk(chunk[1], Number(chunk[2]), Buffer.from(await init.body.arrayBuffer())));
      }
      if (url.endsWith('/jobs') && init.method === 'POST') {
        selectedId = JSON.parse(init.body).uploadId;
        return json({ jobId: 'upgrade-job' });
      }
      if (url.endsWith('/jobs/upgrade-job')) return json({ state: 'READY', result });
      throw Error(`Unexpected request ${url}`);
    } });
  t.after(() => client.destroy());
  await client.start(source, { outputs: { transcriptOnly: true } });
  assert.equal(selectedId, oldId);
  assert.deepEqual(sent, [2, 3]);
  assert.deepEqual(await fs.readFile((await uploads.source(oldId)).path), Buffer.from(await source.arrayBuffer()));
});

function fakeClock() {
  let time = 0, next = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(work, ms) { const id = ++next; tasks.set(id, { work, at: time + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      const until = time + ms;
      for (;;) {
        const first = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        tasks.delete(first[0]); time = first[1].at; first[1].work();
      }
      time = until;
    },
    tickNext() {
      const first = [...tasks.values()].sort((a, b) => a.at - b.at)[0];
      if (first) this.advance(first.at - time);
    },
    count: () => tasks.size
  };
}

function transferFixture(send, options = {}) {
  const clock = fakeClock(), requests = [], transfers = [], statuses = [];
  let acknowledged = false;
  class XHR {
    upload = {};
    constructor() { transfers.push(this); }
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    abort() { this.aborted = true; this.onabort?.(); }
    send(body) { this.body = body; send(this, clock, () => { acknowledged = true; }, transfers.length); }
  }
  const client = createTurkishMediaClient({ video: new Video(), clock, XMLHttpRequestClass: XHR,
    uploadRequestTimeoutMs: 120000, uploadIdleTimeoutMs: 30000, retryDelayMs: 1, onStatus: status => statuses.push(status),
    fetchImpl: async url => {
      requests.push(url);
      if (url.endsWith('/uploads/start')) return json({ uploadId: 'audio', chunkSize: 128 * 1024 });
      if (url.endsWith('/uploads/audio/status')) return json({ receivedChunks: acknowledged ? [0] : [] });
      if (url.endsWith('/jobs')) return json({ jobId: 'job' });
      if (url.endsWith('/jobs/job')) return json({ state: 'READY', result });
      throw Error(`Unexpected request ${url}`);
    }, ...options });
  return { client, clock, requests, transfers, statuses };
}
function accept(xhr, acknowledge) {
  acknowledge(); xhr.upload.onload(); xhr.status = 200; xhr.responseText = '{}'; xhr.onload();
}

test('a steadily progressing slow upload is not aborted at the old 120-second deadline', async t => {
  const f = transferFixture((xhr, clock, acknowledge) => {
    assert.equal(xhr.timeout, 0, 'the native absolute deadline is replaced by inactivity detection');
    for (let loaded = 1; loaded <= 6; loaded++) {
      clock.advance(25000);
      assert.notEqual(xhr.aborted, true);
      xhr.upload.onprogress({ loaded, total: 6, lengthComputable: true });
    }
    accept(xhr, acknowledge);
  });
  t.after(() => f.client.destroy());
  await f.client.start(new File(['123456'], 'source.mp3', { type: 'audio/mpeg' }), { outputs: { transcriptOnly: true } });
  assert.equal(f.clock.now(), 150000); assert.equal(f.transfers.length, 1);
  assert.equal(f.clock.count(), 0);
});

test('saving an uploaded audio part can take longer than the network idle limit without restarting', async t => {
  const f = transferFixture((xhr, clock, acknowledge) => {
    xhr.upload.onprogress({ loaded: 6, total: 6, lengthComputable: true });
    xhr.upload.onload();
    clock.advance(45000);
    assert.notEqual(xhr.aborted, true);
    acknowledge(); xhr.status = 200; xhr.responseText = '{}'; xhr.onload();
  });
  t.after(() => f.client.destroy());
  await f.client.start(new File(['123456'], 'source.mp3', { type: 'audio/mpeg' }),
    { outputs: { transcriptOnly: true } });
  assert.equal(f.transfers.length, 1);
  assert.equal(f.clock.count(), 0);
});

test('stalled uploads cannot keep the deadline alive with duplicate progress events and stop after bounded retries', async t => {
  const f = transferFixture((xhr, clock) => {
    clock.advance(15000);
    xhr.upload.onprogress({ loaded: 0, total: 6, lengthComputable: true });
    clock.advance(15000);
    assert.equal(xhr.aborted, true);
  });
  t.after(() => f.client.destroy());
  let finished = false, failure;
  const pending = f.client.start(new File(['123456'], 'source.mp3', { type: 'audio/mpeg' }), { outputs: { transcriptOnly: true } })
    .catch(error => { failure = error; }).finally(() => { finished = true; });
  const deadline = Date.now() + 10000;
  while (!finished && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
    if (!finished) f.clock.tickNext();
  }
  if (!finished) f.client.destroy();
  await pending;
  assert.equal(failure?.code, 'UPLOAD_STALLED'); assert.equal(f.transfers.length, 3);
  assert.equal(f.clock.count(), 0); assert.equal(f.requests.some(url => url.endsWith('/jobs')), false);
});

test('device audio preparation never marks server processing as active during upload', async t => {
  const detail = {}, view = createAnalysisProgress({ detail, now: () => 1000, setTimer: () => 1, clearTimer() {} });
  view.begin({ motion: true, dubbing: false, subtitles: false }); view.done('source');
  const snapshots = [];
  const f = transferFixture((xhr, _clock, acknowledge) => accept(xhr, acknowledge), {
    prepareSourceAudio: async (_source, { onProgress }) => {
      onProgress({ phase: 'audio_extracted', loaded: 6, total: 6 });
      onProgress({ phase: 'mp3_ready', loaded: 1, total: 1 });
      return new File(['123456'], 'source.mp3', { type: 'audio/mpeg' });
    }, onStatus: status => {
      view.observe(status);
      if (status.state === 'UPLOADING') snapshots.push({ row: view.snapshot().find(row => row.id === 'serverAudio'), detail: detail.textContent });
    }
  });
  t.after(() => f.client.destroy());
  await f.client.start(new File(['local video'], 'source.mp4', { type: 'video/mp4' }), { outputs: { transcriptOnly: true } });
  assert.ok(snapshots.length > 0);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.row.status, 'pending');
    assert.equal(snapshot.row.startedAt, undefined);
    assert.doesNotMatch(snapshot.detail, /Sesin sunucuda hazırlanması/);
  }
});
