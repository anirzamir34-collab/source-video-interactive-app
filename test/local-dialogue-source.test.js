import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canDecodeDialogueLocally } from '../public/media-limits.js';
import { normalizeDialogueSegments } from '../public/dialogue-integrity.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function prepareDialoguePayload(');
const end = source.indexOf('\nfunction renderSubtitle(', start);
const code = source.slice(start, end);

function fixture({ decodeFails = false, uploadFails = false, compact = false, remux } = {}) {
  const original = new File(['original-video-bytes'], 'source.mp4', { type: 'video/mp4' });
  const audio = new File(['prepared-speech'], 'speech.wav', { type: 'audio/wav' });
  const compactAudio = new File(['compressed-speech'], 'dialogue.m4a', { type: 'audio/mp4' });
  const requests = [];
  const cleared = [];
  const timers = new Map();
  let timerId = 0;
  let extractions = 0;
  let remuxes = 0;
  const session = { file: original, sourceDuration: 123 };
  const element = () => ({ textContent: '', classList: { remove() {} } });
  const els = { analysisCard: element(), analysisTitle: element(), analysisOutput: element(),
    analysisState: element(), video: { duration: NaN }, protagonistInput: { value: '' } };
  const scope = vm.createContext({ canDecodeDialogueLocally, normalizeDialogueSegments, File, Blob, FormData, performance, els, AbortController,
    state: { analysisSession: session, selectedRemoteVideo: { proxyUrl: '/proxy?token=old-token' } },
    console: { warn() {} }, localStorage: { removeItem() {} }, recordAiUsage() {},
    buildDubBlocks: segments => segments,
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => { cleared.push(id); timers.delete(id); },
    extractMp4Audio: async (file, options) => { remuxes++; return remux ? remux(file, options) : compact ? compactAudio : null; },
    extractDialogueAudio: async file => {
      extractions++; assert.ok(file instanceof Blob);
      if (decodeFails) throw Error('Unsupported codec');
      return audio;
    },
    uploadDialogueWithProgress: async (form, progress, complete) => {
      requests.push(form);
      progress({ percent: 100, loaded: form.get('video').size, total: form.get('video').size, speed: 2 });
      complete();
      assert.equal(els.analysisState.textContent, 'DIALOGUE_PROCESSING');
      if (uploadFails) throw Error('Provider unavailable');
      return { ok: true, body: { available: true, segments: [] } };
    },
    fetch: () => assert.fail('speech analysis must upload local bytes, never request a remote token')
  });
  vm.runInContext(code, scope);
  return { scope, original, audio, compactAudio, requests, session, els, cleared, timers, extractions: () => extractions, remuxes: () => remuxes };
}

test('large local MP4 uploads only its compact track and reuses it when analysis is retried', async () => {
  const f = fixture({ compact: true });
  Object.defineProperty(f.original, 'size', { value: 1919.4 * 1024 * 1024 });
  assert.equal(canDecodeDialogueLocally(f.original, 3600), false);
  await f.scope.analyzeSelectedDialogue(f.original);
  await f.scope.analyzeSelectedDialogue(f.original);
  assert.equal(f.extractions(), 0);
  assert.equal(f.remuxes(), 1);
  assert.equal(f.session.audioSource, f.original);
  for (const request of f.requests) {
    assert.equal(request.get('video').type, 'audio/mp4');
    assert.equal(await request.get('video').text(), await f.compactAudio.text());
    assert.equal(request.has('remoteToken'), false);
  }
});

test('local speech upload preserves duration across object-URL reload and ignores the retained remote token', async () => {
  const f = fixture();
  await f.scope.analyzeSelectedDialogue(f.original);
  assert.equal(await f.requests[0].get('video').text(), await f.audio.text());
  assert.equal(f.requests[0].get('video').type, f.audio.type);
  assert.equal(f.requests[0].get('duration'), '123');
  assert.equal(f.requests[0].has('remoteToken'), false);
  assert.equal(f.timers.size, 0);
  assert.match(f.els.analysisOutput.textContent, /Yükleme tamamlandı/);
});

test('retrying reuses prepared speech, while selecting another local file extracts new audio', async () => {
  const f = fixture();
  await f.scope.analyzeSelectedDialogue(f.original);
  await f.scope.analyzeSelectedDialogue(f.original);
  assert.equal(f.extractions(), 1);
  assert.equal(f.session.audioSource, f.original);
  assert.equal(await f.requests[1].get('video').text(), await f.audio.text());
  await f.scope.analyzeSelectedDialogue(new File(['other'], 'other.mp4', { type: 'video/mp4' }));
  assert.equal(f.extractions(), 2);
});

test('unsupported local audio decoding submits the existing source file without downloading again', async () => {
  const f = fixture({ decodeFails: true });
  await f.scope.analyzeSelectedDialogue(f.original);
  assert.equal(await f.requests[0].get('video').text(), await f.original.text());
  assert.equal(f.requests[0].get('video').type, f.original.type);
  assert.equal(f.requests[0].has('remoteToken'), false);
});

test('provider failure stops the elapsed-time display and keeps prepared audio for retry', async () => {
  const f = fixture({ uploadFails: true });
  await assert.rejects(f.scope.analyzeSelectedDialogue(f.original), /Provider unavailable/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.session.audioFile, f.audio);
});

test('a preparation timeout uploads original local bytes and skips another full-file decoder', async () => {
  const f = fixture({ remux: async () => {
    throw Object.assign(new Error('stalled read'), { code: 'LOCAL_AUDIO_PREPARATION_TIMEOUT' });
  } });
  await f.scope.analyzeSelectedDialogue(f.original);
  await f.scope.analyzeSelectedDialogue(f.original);
  assert.equal(f.extractions(), 0);
  assert.equal(f.remuxes(), 1, 'retry reuses the server fallback without another minute of waiting');
  assert.equal(f.session.audioFile, f.original);
  assert.equal(f.timers.size, 0);
  for (const request of f.requests) {
    assert.equal(await request.get('video').text(), await f.original.text());
    assert.equal(request.get('duration'), '123');
    assert.equal(request.has('remoteToken'), false);
  }
});

test('preparation displays actual copied bytes and stops its clock after completion', async () => {
  const f = fixture({ remux: async (_file, { onProgress }) => {
    onProgress({ phase: 'packing', loaded: 1024 * 1024, total: 2 * 1024 * 1024 });
    assert.match(f.els.analysisTitle.textContent, /%50/);
    assert.match(f.els.analysisOutput.textContent, /1\.0 \/ 2\.0 MB/);
    assert.match(f.els.analysisOutput.textContent, /60 saniyede/);
    return f.compactAudio;
  } });
  assert.equal(await f.scope.prepareDialoguePayload(f.original), f.compactAudio);
  assert.equal(f.timers.size, 0);
  assert.equal(f.session.audioPreparationController, undefined);
});

test('cancelling a local preparation never uploads the abandoned file or caches its audio', async () => {
  const f = fixture({ remux: async (_file, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = f.scope.analyzeSelectedDialogue(f.original);
  f.session.audioPreparationController.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.audioFile, undefined);
  assert.equal(f.session.audioPreparationController, undefined);
  assert.equal(f.timers.size, 0);
});
