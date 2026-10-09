import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDirectDubbing } from '../lib/turkish-media/direct-dubbing.js';
import { createMediaRequest } from '../lib/turkish-media/http.js';

test('direct dubbing resumes the paid project and never creates a second target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'videoquest-direct-dub-'));
  try {
    const audioPath = path.join(directory, 'source.mp3');
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    let chargedPosts = 0, checkpoint;
    const request = async (url, options = {}) => {
      if (options.method === 'POST') {
        chargedPosts += 1;
        assert.equal(options.body.get('model_id'), 'dubbing_v2');
        assert.equal(options.body.get('target_language'), 'tr');
        return { project_id: 'proj_12345678', language_ids: ['lang_12345678'] };
      }
      if (url.endsWith('/transcript')) return { segments: [{
        id: 'segment123', speaker_id: 'speaker0', start_s: .5, end_s: 2,
        source_text: 'Hello', translation: 'Merhaba',
      }] };
      if (url.endsWith('/language/lang_12345678')) return { status: 'completed', outputs: {
        lossless_audio: 'https://storage.googleapis.com/eleven-dubbing/p/l/output.flac',
      } };
      return { status: 'ready', language_ids: ['lang_12345678'] };
    };
    const dub = createDirectDubbing({
      config: { elevenLabs: { apiKey: 'test-key', baseUrl: 'https://api.elevenlabs.io' } },
      request, fetchImpl: async () => ({ ok: true, body: new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
      }) }),
    });
    const options = { audioPath, directory, jobId: 'test-job', modelId: 'dubbing_v2', onProject: async value => { checkpoint = value; } };
    const first = await dub(options);
    assert.equal(first.rows[0].text, 'Merhaba');
    assert.equal(chargedPosts, 1);
    await dub({ ...options, resume: checkpoint });
    assert.equal(chargedPosts, 1);
    await assert.rejects(dub({ ...options, resume: { creating: true } }),
      error => error.code === 'DUBBING_PROJECT_UNCERTAIN');
    assert.equal(chargedPosts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('permission rejection clears uncertain marker and permits a later explicit retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'videoquest-dub-permission-'));
  try {
    const audioPath = path.join(directory, 'source.mp3');
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    let checkpoint, attempts = 0;
    const request = async (url, options = {}) => {
      if (options.method === 'POST') {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('missing dubbing_write'), { status: 401 });
        return { project_id: 'proj_12345678', language_ids: ['lang_12345678'] };
      }
      if (url.endsWith('/transcript')) return { segments: [{
        id: 'segment123', speaker_id: 'speaker0', start_s: .5, end_s: 2,
        source_text: 'Hello', translation: 'Merhaba',
      }] };
      if (url.endsWith('/language/lang_12345678')) return { status: 'completed', outputs: {
        lossless_audio: 'https://storage.googleapis.com/eleven-dubbing/p/l/output.flac',
      } };
      return { status: 'ready', language_ids: ['lang_12345678'] };
    };
    const dub = createDirectDubbing({
      config: { elevenLabs: { apiKey: 'test-key', baseUrl: 'https://api.elevenlabs.io' } },
      request, fetchImpl: async () => ({ ok: true, body: new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
      }) }),
    });
    const options = { audioPath, directory, jobId: 'test-job', onProject: async value => { checkpoint = value; } };
    await assert.rejects(dub(options), error => error.status === 401);
    assert.deepEqual(checkpoint, { creating: false });
    await dub({ ...options, resume: checkpoint });
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Dubbing scope error reports the actionable permission', async () => {
  const request = createMediaRequest({
    fetchImpl: async () => ({
      ok: false, status: 401, headers: { get: () => null },
      text: async () => JSON.stringify({ detail: {
        type: 'authentication_error', code: 'unauthorized', status: 'missing_permissions',
        message: 'The API key you used is missing the permission dubbing_write to execute this operation.',
      } }),
    }), maxRetries: 0,
  });
  await assert.rejects(request('https://api.elevenlabs.io/v1/dubbing/project'), error =>
    error.code === 'ELEVENLABS_DUBBING_PERMISSION_MISSING' && /dubbing_write/.test(error.message));
});
