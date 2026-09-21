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

function fixture({ decodeFails = false, uploadFails = false, compact = false } = {}) {
  const original = new File(['original-video-bytes'], 'source.mp4', { type: 'video/mp4' });
  const audio = new File(['prepared-speech'], 'speech.wav', { type: 'audio/wav' });
  const compactAudio = new File(['compressed-speech'], 'dialogue.m4a', { type: 'audio/mp4' });
  const requests = [];
  const cleared = [];
  let extractions = 0;
  let remuxes = 0;
  const session = { file: original, sourceDuration: 123 };
  const element = () => ({ textContent: '', classList: { remove() {} } });
  const els = { analysisCard: element(), analysisTitle: element(), analysisOutput: element(),
    analysisState: element(), video: { duration: NaN }, protagonistInput: { value: '' } };
  const scope = vm.createContext({ canDecodeDialogueLocally, normalizeDialogueSegments, File, Blob, FormData, performance, els,
    state: { analysisSession: session, selectedRemoteVideo: { proxyUrl: '/proxy?token=old-token' } },
    console: { warn() {} }, localStorage: { removeItem() {} }, recordAiUsage() {},
    buildDubBlocks: segments => segments,
    setInterval: () => 42, clearInterval: id => cleared.push(id),
    extractMp4Audio: async () => { remuxes++; return compact ? compactAudio : null; },
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
  return { scope, original, audio, compactAudio, requests, session, els, cleared, extractions: () => extractions, remuxes: () => remuxes };
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
  assert.deepEqual(f.cleared, [42]);
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
  assert.deepEqual(f.cleared, [42]);
  assert.equal(f.session.audioFile, f.audio);
});
