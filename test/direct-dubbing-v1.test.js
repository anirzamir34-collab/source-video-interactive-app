import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDirectDubbing } from '../lib/turkish-media/direct-dubbing.js';

test('Dubbing v1 is selected, completed audio survives bad cues, and retry does not create a second project', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videoquest-v1-'));
  const audioPath = path.join(directory, 'source.mp3');
  await fs.writeFile(audioPath, Buffer.from('source-audio'));
  let creates = 0;
  let failTranscript = false;
  const projectUpdates = [];
  const request = async (url, options = {}) => {
    if (options.method === 'POST') {
      creates++;
      assert.equal(options.body.get('model_id'), 'dubbing_v1');
      assert.equal(options.body.get('target_language'), 'tr');
      return { project_id: 'proj_1234567890', language_ids: ['lang_1234567890'] };
    }
    if (url.endsWith('/transcript')) {
      if (failTranscript) throw new Error('transcript unavailable');
      return { segments: [
      { id: 'valid', start_s: 1, end_s: 2, translation: 'Merhaba' },
      { id: 'silent', start_s: 3, end_s: 3, translation: '' },
      { id: 'outside', start_s: 4, end_s: 5, translation: 'Geçersiz' },
    ] };
    }
    if (url.endsWith('/language/lang_1234567890')) return { status: 'completed',
      outputs: { lossless_audio: 'https://storage.googleapis.com/eleven-dubbing/test/output.flac' } };
    return { status: 'ready', model_id: 'dubbing_v1' };
  };
  const fetchImpl = async () => ({ ok: true, body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  }) });
  const dub = createDirectDubbing({ config: { elevenLabs: { apiKey: 'test', baseUrl: 'https://api.elevenlabs.io' } },
    request, fetchImpl });
  try {
    const input = { audioPath, directory, jobId: 'test-job', modelId: 'dubbing_v1', duration: 3,
      signal: new AbortController().signal, onProject: value => projectUpdates.push(value) };
    const first = await dub(input);
    assert.equal(first.skippedTranscriptSegments, 2);
    assert.equal(first.rows.length, 1);
    assert.equal(first.modelId, 'dubbing_v1');
    assert.equal(creates, 1);
    assert.deepEqual(await fs.readFile(first.dubbedPath), Buffer.from([1, 2, 3]));
    failTranscript = true;
    const retried = await dub({ ...input, resume: projectUpdates.find(value => value.projectId) });
    assert.equal(retried.subtitleUnavailable, true);
    assert.equal(creates, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a v2 paid project cannot be resumed as v1', async () => {
  const dub = createDirectDubbing({ config: { elevenLabs: { apiKey: 'test', baseUrl: 'https://api.elevenlabs.io' } },
    request: async () => ({ status: 'ready', model_id: 'dubbing_v2' }) });
  await assert.rejects(dub({ resume: { projectId: 'proj_1234567890', languageId: 'lang_1234567890' },
    modelId: 'dubbing_v1', signal: new AbortController().signal }), { code: 'DIRECT_DUBBING_MODEL_MISMATCH' });
});
