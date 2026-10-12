import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiRequestPacer, isGeminiGenerationRequest } from '../lib/turkish-media/gemini-pacer.js';

test('thirty-two concurrent Gemini requests reserve at least 6.5 seconds between starts', async () => {
  let now = 1000;
  const delays = [];
  // Reservation is serialized inside the pacer. A synchronous fake clock can
  // advance before unrelated promise continuations observe it, so compare the
  // actual booked sleep slots, not callback completion timestamps.
  const pacer = createGeminiRequestPacer({ intervalMs: 6500, now: () => now,
    sleep: async ms => { delays.push(ms); now += ms; } });
  await Promise.all(Array.from({ length: 32 }, () => pacer.beforeRequest()));
  assert.equal(delays.length, 31);
  assert.ok(delays.every(ms => ms >= 6500), 'each queued request reserves another full interval');
  assert.equal(now, 1000 + 31 * 6500);
});

test('cancelling an enqueued request consumes no Gemini request slot', async () => {
  let now = 1000, waiting;
  const pacer = createGeminiRequestPacer({ intervalMs: 6500, now: () => now,
    sleep: async ms => { waiting = ms; now += ms; } });
  await pacer.beforeRequest();
  const aborted = new AbortController();
  aborted.abort(new Error('no credit use'));
  await assert.rejects(pacer.beforeRequest(aborted.signal), /no credit use/);
  await pacer.beforeRequest();
  assert.equal(waiting, 6500);
});

test('only Gemini generateContent requests are paced, not ElevenLabs or Gemini key status', () => {
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  assert.equal(isGeminiGenerationRequest(base + '/models/gemini-3.1-flash-lite:generateContent', base), true);
  assert.equal(isGeminiGenerationRequest(base + '/models/gemini-2.5-flash-lite:generateContent', base), true);
  assert.equal(isGeminiGenerationRequest(base + '/models/gemini-3.1-flash-lite', base), false);
  assert.equal(isGeminiGenerationRequest('https://api.elevenlabs.io/v1/speech-to-text', base), false);
  assert.throws(() => createGeminiRequestPacer({ intervalMs: -10 }), RangeError);
});
