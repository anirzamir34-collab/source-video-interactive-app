import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReady } from '../lib/turkish-media/readiness.js';

const options = {
  env: { APP_PASSWORD: 'owner-secret-marker' },
  config: { qualityMode: 'quality', elevenLabs: { apiKey: 'eleven-secret-marker' }, translation: { apiKey: 'gemini-secret-marker' } },
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
  assert.deepEqual(report.warnings, []);
  assert.equal(report.serverMediaConfigured, true);
  assert.equal(report.checks.geminiConfigured, true);
  assert.equal('openAIConfigured' in report.checks, false);
  assert.deepEqual(report.browserKeysSupported, { gemini: true, elevenLabs: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, ['-version']);
    assert.equal(call.settings.timeout, 5000); assert.equal(call.settings.killSignal, 'SIGKILL');
    assert.equal(call.settings.maxBuffer, 65536);
  }
  assert.doesNotMatch(JSON.stringify(report), /secret-marker|private|secret-process-output/);
});

test('missing infrastructure and fast mode are errors while missing provider keys are informational warnings', async () => {
  const report = await runtimeReady({ env: { APP_PASSWORD: ' ' }, config: { qualityMode: 'fast' } });
  assert.equal(report.ready, false);
  assert.equal(report.errors.length, 4);
  assert.equal(report.warnings.length, 2);
  assert.ok(report.errors.some(error => error.code === 'QUALITY_MODE_UNAVAILABLE'));
  assert.equal(report.checks.elevenLabsConfigured, false);
  assert.equal(report.checks.geminiConfigured, false);
  assert.equal(report.serverMediaConfigured, false);
  assert.deepEqual(report.warnings.map(warning => warning.code), ['ELEVENLABS_NOT_CONFIGURED', 'GEMINI_NOT_CONFIGURED']);
});

test('working infrastructure is ready without backend provider keys because browser keys are supported', async () => {
  let calls = 0;
  const report = await runtimeReady({ ...options, config: { qualityMode: 'quality' },
    execFileImpl(binary, _args, _settings, callback) {
      calls++;
      callback(null, `${binary.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.0`);
    } });
  assert.equal(calls, 2);
  assert.equal(report.ready, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 2);
  assert.equal(report.serverMediaConfigured, false);
  assert.deepEqual(report.browserKeysSupported, { gemini: true, elevenLabs: true });
  assert.equal(report.checks.elevenLabsConfigured, false);
  assert.equal(report.checks.geminiConfigured, false);
});

test('Gemini and ElevenLabs environment keys only expose configuration booleans', async () => {
  const report = await runtimeReady({ ...options, config: { qualityMode: 'quality' }, env: {
    APP_PASSWORD: 'owner-secret-marker', GEMINI_API_KEY: 'gemini-secret-marker', ELEVENLABS_API_KEY: 'eleven-secret-marker',
    OPENAI_API_KEY: 'unused-legacy-marker',
  }, execFileImpl(binary, _args, _settings, callback) {
    callback(null, `${binary.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.0`);
  } });
  assert.equal(report.ready, true);
  assert.equal(report.serverMediaConfigured, true);
  assert.equal(report.checks.geminiConfigured, true);
  assert.deepEqual(report.warnings, []);
  assert.doesNotMatch(JSON.stringify(report), /secret-marker|unused-legacy-marker|OPENAI/);
});

test('tool failures redact raw errors, paths, credentials and abort reasons', async () => {
  const report = await runtimeReady({ ...options, execFileImpl(_binary, _args, _settings, callback) {
    callback(Object.assign(new Error('/private/file owner-secret-marker eleven-secret-marker gemini-secret-marker'), { code: 'ENOENT' }));
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
