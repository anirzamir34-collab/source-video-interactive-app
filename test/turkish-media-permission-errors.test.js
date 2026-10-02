import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRequest } from '../lib/turkish-media/http.js';
import { createElevenLabsProvider } from '../lib/turkish-media/elevenlabs.js';
import { loadMediaConfig } from '../lib/turkish-media/config.js';
import { publicMediaError } from '../lib/turkish-media/errors.js';
import { createStageLogger } from '../lib/turkish-media/stage-logging.js';

const key = 'browser-eleven-permission-test-secret-123456';
const requestId = 'source-permission-request-id';
const denied = (permission = 'speech_to_text') => ({ detail: {
  type: 'authentication_error', code: 'unauthorized', status: 'missing_permissions',
  message: 'The API key you used is missing the permission ' + permission + ' to execute this operation. ' + key,
  request_id: requestId,
} });

for (const status of [401, 403]) {
  test('Scribe HTTP ' + status + ' permission failure gives actionable Turkish guidance and keeps redacted cause without retry', async () => {
    let calls = 0;
    const entries = [];
    const request = createMediaRequest({ secrets: [key], maxRetries: 3,
      sleep: () => assert.fail('Changing key permissions requires user action, never automatic retry.'),
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
        assert.equal(options.headers['xi-api-key'], key);
        assert.equal(options.body.get('model_id'), 'scribe_v2');
        assert.equal(options.body.get('diarize'), 'true');
        return Response.json(denied(), { status });
      } });
    const provider = createElevenLabsProvider({ config: loadMediaConfig({ ELEVENLABS_API_KEY: key }), request });
    const logger = createStageLogger({ jobId: 'permission-job', secrets: [key], write: entry => entries.push(entry) });
    let caught;
    try { await logger.run('scribe', {}, () => provider.transcribe(new Blob(['source audio'], { type: 'audio/wav' }))); }
    catch (error) { caught = error; }
    assert.equal(caught?.code, 'ELEVENLABS_STT_PERMISSION_MISSING');
    assert.equal(caught.status, status);
    assert.equal(caught.retryable, false);
    assert.equal(calls, 1);
    const visible = publicMediaError(caught, [key]);
    assert.match(visible.message, /ElevenLabs.*Speech to Text.*izni/u);
    assert.match(visible.message, /anahtarı.*Speech to Text.*aç.*yeniden dene/u);
    assert.doesNotMatch(visible.message, /authentication_error|request_id|\{|\}/);
    assert.ok(visible.message.length < 300);
    assert.equal(caught.cause.code, 'PROVIDER_HTTP_' + status);
    assert.match(caught.cause.message, /missing_permissions/);
    assert.match(caught.cause.message, new RegExp(requestId));
    assert.match(caught.cause.message, /\[REDACTED\]/);
    const end = entries.find(entry => entry.event === 'media_stage_end');
    assert.equal(end.outcome, 'failed');
    assert.equal(end.error.code, 'ELEVENLABS_STT_PERMISSION_MISSING');
    assert.equal(end.error.cause.code, 'PROVIDER_HTTP_' + status);
    assert.match(end.error.cause.message, new RegExp(requestId));
    for (const value of [visible, caught.cause.message, entries]) assert.equal(JSON.stringify(value).includes(key), false);
  });
}

test('permission guidance never reclassifies other providers, operations, invalid keys or malformed responses', async () => {
  const cases = [
    { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent', body: denied() },
    { url: 'https://api.elevenlabs.io.invalid/v1/speech-to-text', body: denied() },
    { url: 'https://api.elevenlabs.io/v1/forced-alignment', body: denied() },
    { url: 'https://api.elevenlabs.io/v1/speech-to-text', body: denied('text_to_speech') },
    { url: 'https://api.elevenlabs.io/v1/speech-to-text', body: { detail: { status: 'invalid_api_key', message: 'Invalid key' } } },
    { url: 'https://api.elevenlabs.io/v1/speech-to-text', raw: '{malformed-json' },
    { url: 'https://api.elevenlabs.io/v1/speech-to-text', body: denied(), status: 503 },
  ];
  for (const row of cases) {
    const status = row.status || 401;
    const request = createMediaRequest({ maxRetries: 0, secrets: [key], fetchImpl: async () =>
      row.raw ? new Response(row.raw, { status }) : Response.json(row.body, { status }) });
    await assert.rejects(request(row.url), { code: 'PROVIDER_HTTP_' + status, retryable: status === 503 });
  }
});
