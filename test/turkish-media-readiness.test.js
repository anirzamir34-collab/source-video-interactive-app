import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReady } from '../lib/turkish-media/readiness.js';

const options = {
  env: { APP_PASSWORD: 'owner-secret-marker' },
  config: { qualityMode: 'quality', elevenLabs: { apiKey: 'eleven-secret-marker' }, translation: { apiKey: 'openai-secret-marker' } },
  ffmpegPath: '/private/ffmpeg', ffprobePath: '/private/ffprobe',
};

test('runtime diagnostics execute both tools with bounded options and expose only safe flags', async () => {
  const calls = [];
  const report = await runtimeReady({ ...options, execFileImpl(binary, args, settings, callback) {
    calls.push({ binary, args, settings });
    callback(null, `${binary.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.0\nsecret-process-output`);
  } });
  assert.equal(report.ready, true);
  assert.deepEqual(report.errors, []);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, ['-version']);
    assert.equal(call.settings.timeout, 5000); assert.equal(call.settings.killSignal, 'SIGKILL');
    assert.equal(call.settings.maxBuffer, 65536);
  }
  assert.doesNotMatch(JSON.stringify(report), /secret-marker|private|secret-process-output/);
});

test('missing secrets and fast mode report unavailable without throwing or contacting providers', async () => {
  const report = await runtimeReady({ env: { APP_PASSWORD: ' ' }, config: { qualityMode: 'fast' } });
  assert.equal(report.ready, false);
  assert.equal(report.errors.length, 6);
  assert.ok(report.errors.some(error => error.code === 'QUALITY_MODE_UNAVAILABLE'));
  assert.equal(report.checks.elevenLabsConfigured, false);
  assert.equal(report.checks.openAIConfigured, false);
});

test('tool failures redact raw errors, paths, credentials and abort reasons', async () => {
  const report = await runtimeReady({ ...options, execFileImpl(_binary, _args, _settings, callback) {
    callback(Object.assign(new Error('/private/file owner-secret-marker eleven-secret-marker openai-secret-marker'), { code: 'ENOENT' }));
  } });
  assert.equal(report.ready, false);
  assert.ok(report.errors.every(error => error.code === 'MEDIA_BINARY_ENOENT'));
  assert.doesNotMatch(JSON.stringify(report), /secret-marker|private/);
  let calls = 0;
  const aborted = await runtimeReady({ ...options, signal: AbortSignal.abort(new Error('owner-secret-marker')), execFileImpl() { calls++; } });
  assert.equal(calls, 0); assert.equal(aborted.ready, false);
  assert.ok(aborted.errors.every(error => error.code === 'MEDIA_CHECK_CANCELLED'));
  assert.doesNotMatch(JSON.stringify(aborted), /secret-marker/);
});

test('timeouts and invalid version output cannot become successful runtime checks', async () => {
  const report = await runtimeReady({ ...options, timeoutMs: Infinity, execFileImpl(binary, _args, settings, callback) {
    assert.equal(settings.timeout, 5000);
    if (binary.endsWith('ffmpeg')) callback(Object.assign(new Error('raw-secret'), { killed: true }));
    else callback(null, 'unrelated executable');
  } });
  assert.equal(report.ready, false);
  assert.deepEqual(report.errors.map(error => error.code), ['MEDIA_CHECK_TIMEOUT', 'MEDIA_BINARY_INVALID_RESPONSE']);
});
