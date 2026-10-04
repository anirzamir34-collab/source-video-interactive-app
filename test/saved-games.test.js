import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameStore, prepareGame, exportGame, importGame, storageError } from '../public/saved-games.js';

const fakeIdb = await import('fake-indexeddb').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const { IDBFactory, IDBObjectStore } = fakeIdb || {};
const databaseTest = (name, run) => test(name, { skip: !IDBFactory && 'fake-indexeddb is not installed' }, run);

function mediaFixture() {
  const speakerId = 'speaker-source-1', segmentId = 'segment-source-1';
  return { manifest: { version: 1,
    sourceTranscript: { version: 1, source: { hash: 'source-hash', duration: 90 }, language: 'en',
      speakers: [{ speakerId, providerId: 'speaker_0' }], audioEvents: [],
      utterances: [{ segmentId, speakerId, sourceText: 'Hello.', sourceStart: 1, sourceEnd: 2,
        words: [{ text: 'Hello.', start: 1, end: 2, type: 'word', logprob: -.1 }], language: 'en', confidence: null }] },
    translatedUtterances: [{ segmentId, speakerId, translatedText: 'Merhaba.', displaySubtitleText: 'Merhaba.', targetDuration: 1, estimatedDuration: 1 }],
    voiceMapping: { [speakerId]: 'voice-1' },
    dubSegments: [{ segmentId, speakerId, start: 1, end: 2, duration: 1,
      words: [{ text: 'Merhaba.', start: 1.1, end: 1.9 }] }],
    subtitles: { source_tr: [{ segmentId, speakerId, start: 1, end: 2, text: 'Merhaba.', words: [] }],
      dub_tr: [{ segmentId, speakerId, start: 1.1, end: 1.9, text: 'Merhaba.', words: [{ text: 'Merhaba.', start: 1.1, end: 1.9 }] }] },
    assets: { mix: { mimeType: 'audio/wav', duration: 90 } },
    qualityReport: { sourceUtteranceCount: 1, translatedUtteranceCount: 1, generatedDubCount: 1, missingDubCount: 0 } },
    dubEnabled: true, subtitleTrack: 'dub_tr', syncOffset: 0 };
}

const fixture = (overrides = {}) => ({
  title: 'Park gezisi', fileName: 'park.mp4', sourceKind: 'url', duration: 90,
  video: new Blob([new Uint8Array([0, 1, 2, 3, 255])], { type: 'video/mp4' }),
  dubAudio: new Blob([new Uint8Array([82, 73, 70, 70, 255, 0, 42])], { type: 'audio/wav' }),
  turkishMedia: mediaFixture(),
  payload: {
    analysis: { schemaVersion: 5, actions: [{ id: 'walk', startTime: 0, endTime: 10, label: 'Parkta yürü', sourceVerified: true }] },
    dialogue: { segments: [{ id: 'hello', start: 1, end: 2, originalText: 'Hello.', turkishText: 'Merhaba' }] }
  }, ...overrides
});
const bytes = async blob => [...new Uint8Array(await blob.arrayBuffer())];

databaseTest('legacy audio repair updates only the mix while preserving saved video, analysis and language settings', async t => {
  const store = createGameStore({ indexedDB: new IDBFactory(), database: 'saved-audio-repair' });
  t.after(() => store.close());
  const input = fixture(), saved = await store.save(input);
  const repaired = new Blob(['repaired PCM'], { type: 'audio/wav' });
  await store.updateDubAudio(saved.id, repaired);
  const loaded = await store.load(saved.id);
  assert.deepEqual(await bytes(loaded.video), await bytes(input.video));
  assert.deepEqual(loaded.turkishMedia, input.turkishMedia);
  assert.equal(await loaded.dubAudio.text(), 'repaired PCM');
  const meta = (await store.list())[0];
  assert.equal(meta.mixBytes, repaired.size);
  await assert.rejects(store.updateDubAudio(saved.id, new Blob(['wrong'], { type: 'audio/mpeg' })));
  assert.equal(await (await store.load(saved.id)).dubAudio.text(), 'repaired PCM');
});

function legacyFixture() {
  const input = fixture({ dubAudio: null, turkishMedia: null });
  Object.assign(input.payload, {
    dubCache: [['hello', 'data:audio/wav;base64,AQIDBA==']], dubCacheEngineVersion: 2,
    dubStableSpeakerGenders: [['narrator', 'female']], dubSegmentMetadata: [['hello', { model: 'eleven_v3' }]],
    dubProviderLock: 'elevenlabs', dubVoiceIds: { female: 'old-voice' }, dubSpeakerVoices: [{ speakerId: 'narrator', voiceId: 'old-voice' }],
    dubbingEnabled: true, subtitlesEnabled: true, keepOriginalAudioEnabled: false, languageSyncOffset: 1.25
  });
  input.payload.dialogue.dubSegments = [{ ...input.payload.dialogue.segments[0], audioBase64: 'AQIDBA==' }];
  input.payload.dialogue.dubCoverage = { ready: 1, total: 1, complete: true };
  input.payload.dialogue.segments[0].audioBase64 = 'AQIDBA==';
  input.payload.dialogue.segments[0].voiceId = 'old-voice';
  return input;
}

function assertSourceOnlyPayload(payload, source) {
  assert.deepEqual(payload.analysis, source.analysis);
  assert.deepEqual(Object.keys(payload).sort(), ['analysis', 'dialogue']);
  assert.equal(Object.hasOwn(payload, 'dubbingEnabled'), false);
  assert.equal(payload.dialogue.segments[0].originalText, 'Hello.');
  assert.equal(payload.dialogue.segments[0].start, 1);
  assert.equal(payload.dialogue.segments[0].end, 2);
  assert.doesNotMatch(JSON.stringify(payload), /dubCache|dubStableSpeakerGenders|dubSegmentMetadata|dubProviderLock|dubVoiceIds|dubSpeakerVoices|audioBase64|old-voice|data:audio|dubCoverage/);
}

databaseTest('reopening the database restores URL video, visual analysis, canonical transcript and final audio bytes', async () => {
  const indexedDB = new IDBFactory();
  const store = createGameStore({ indexedDB });
  const source = fixture();
  const meta = await store.save(source);
  await store.close();
  const reopened = createGameStore({ indexedDB });
  const [row] = await reopened.list();
  assert.equal(row.id, meta.id);
  assert.equal(row.video, undefined);
  assert.equal(row.payload, undefined);
  assert.equal(row.turkishMedia, undefined);
  assert.equal(row.dubAudio, undefined);
  assert.equal(row.mixBytes, source.dubAudio.size);
  assert.equal(row.totalBytes, source.video.size + source.dubAudio.size);
  assert.equal(row.dubReady, true);
  assert.equal(row.dialogueCount, 1);
  assert.equal(row.dubCount, 1);
  const loaded = await reopened.load(row.id);
  assert.deepEqual(await bytes(loaded.video), await bytes(source.video));
  assert.deepEqual(loaded.payload.analysis, source.payload.analysis);
  assertSourceOnlyPayload(loaded.payload, source.payload);
  assert.deepEqual(await bytes(loaded.dubAudio), await bytes(source.dubAudio));
  assert.deepEqual(loaded.turkishMedia, source.turkishMedia);
  assert.equal(loaded.sourceKind, 'url');
  await reopened.close();
});

databaseTest('the saved-game shelf counts explicit gaps and updates that same record after repair', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const input = fixture();
  input.payload.analysis.analysisGaps = [{ startTime: 20, endTime: 30 }];
  const saved = await store.save(input);
  assert.equal((await store.list())[0].analysisGapCount, 1);
  const loaded = await store.load(saved.id);
  loaded.payload.analysis.analysisGaps = [];
  loaded.payload.analysis.actions.push({ id: 'repaired', startTime: 20, endTime: 30, sourceVerified: true });
  const updated = await store.save(loaded, saved.id);
  assert.equal(updated.id, saved.id);
  assert.equal((await store.list())[0].analysisGapCount, 0);
  assert.deepEqual(await bytes((await store.load(saved.id)).video), await bytes(input.video));
  await store.close();
});

databaseTest('changing language sync updates media settings and preserves stored video and mix bytes', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const source = fixture();
  const saved = await store.save(source);
  await store.updateLanguageSync(saved.id, 1.25);
  const restored = await store.load(saved.id);
  assert.equal(restored.turkishMedia.syncOffset, 1.25);
  assert.deepEqual(await bytes(restored.video), await bytes(source.video));
  assert.deepEqual(await bytes(restored.dubAudio), await bytes(source.dubAudio));
  assert.equal((await importGame(exportGame(restored))).turkishMedia.syncOffset, 1.25);
  assert.throws(() => store.updateLanguageSync(saved.id, Number.NaN));
  await store.close();
});

databaseTest('device files and media-only analyses can be saved and replayed', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const input = fixture({ sourceKind: 'file' });
  input.payload.analysis = null;
  const saved = await store.save(input);
  const game = await store.load(saved.id);
  assert.equal(game.payload.analysis, null);
  assert.equal(game.payload.dialogue.segments[0].turkishText, 'Merhaba');
  assert.equal(game.sourceKind, 'file');
  await store.close();
});

databaseTest('updates keep the same ID; explicit deletion affects only the chosen record and its mix', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const first = await store.save(fixture());
  const second = await store.save(fixture({ title: 'Başka video' }));
  const updated = await store.save(fixture({ title: 'Yeni başlık' }), first.id);
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal((await store.list()).length, 2);
  await store.remove(first.id);
  await assert.rejects(store.load(first.id));
  assert.equal((await store.load(second.id)).title, 'Başka video');
  await store.close();
});

databaseTest('mix quota failure rolls back metadata, payload, source video and final audio together', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const original = await store.save(fixture());
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'mixes') throw new DOMException('disk full', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try {
    await assert.rejects(store.save(fixture({ title: 'Kaydedilmemeli' }), original.id), { name: 'QuotaExceededError' });
    await assert.rejects(store.save(fixture({ title: 'Yarım kayıt' })), { name: 'QuotaExceededError' });
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load(original.id)).title, 'Park gezisi');
  assert.deepEqual(await bytes((await store.load(original.id)).dubAudio), await bytes(fixture().dubAudio));
  assert.match(storageError({ name: 'QuotaExceededError' }), /mevcut kayıtların silinmedi/);
  await store.close();
});

test('backup round trip retains exact video and dub bytes; importing never replaces an existing ID', async () => {
  const original = prepareGame(fixture());
  const backup = exportGame(original);
  const restored = await importGame(backup);
  assert.deepEqual(await bytes(restored.video), await bytes(original.video));
  assert.equal(restored.video.type, original.video.type);
  assert.deepEqual(restored.payload, original.payload);
  assert.equal(await backup.slice(0, 8).text(), 'VQGAME2\n');
  assert.deepEqual(await bytes(restored.dubAudio), await bytes(original.dubAudio));
  assert.deepEqual(restored.turkishMedia, original.turkishMedia);
  assert.notEqual(restored.id, original.id);
  if (IDBFactory) {
    const store = createGameStore({ indexedDB: new IDBFactory() });
    await store.save(original);
    await store.save(restored);
    assert.equal((await store.list()).length, 2);
    await store.close();
  }
});

test('credentials and temporary links never enter the record or exported backup', async () => {
  const input = fixture();
  input.geminiApiKey = 'secret';
  input.sourceUrl = 'https://source.test/expiring';
  input.payload.password = 'secret';
  input.payload.dialogue.authorization = 'secret';
  input.payload.analysis.proxyUrl = '/proxy?token=secret';
  input.payload.analysis.api_key = 'secret';
  input.turkishMedia.manifest.assets.mix.url = '/api/turkish-media/jobs/secret/artifacts/mix';
  input.turkishMedia.manifest.artifactKey = 'backend-cache-key';
  input.turkishMedia.manifest.sourceTranscript.apiKey = 'secret';
  input.turkishMedia.manifest.dubSegments[0].audioPath = '/tmp/secret-dub.wav';
  input.turkishMedia.manifest.dubSegments[0].alignmentTrace = { native: { providerToken: 'secret', credentials: 'secret', path: '/tmp/secret-alignment.json', openaiApiKey: 'secret' } };
  input.turkishMedia.manifest.qualityReport.debug = { providerSecret: 'secret', traceLocation: '/tmp/secret-native-words.json' };
  const game = prepareGame(input);
  const json = JSON.stringify(game);
  assert.doesNotMatch(json, /secret|expiring|proxy|backend-cache-key|\/tmp\//);
  const backup = exportGame(game);
  const headerSize = new DataView(await backup.slice(8, 12).arrayBuffer()).getUint32(0);
  assert.doesNotMatch(await backup.slice(12, 12 + headerSize).text(), /secret|expiring|proxy|backend-cache-key|\/tmp\//);
  input.payload.analysis.actions[0].label = 'Sonradan değişti';
  assert.equal(game.payload.analysis.actions[0].label, 'Parkta yürü');
});

test('truncated, unknown and oversized backup headers fail before saving', async () => {
  const good = exportGame(fixture());
  await assert.rejects(importGame(good.slice(0, good.size - 1)), /boyutu/);
  await assert.rejects(importGame(new Blob(['wrong file'])), /yede/);
  const large = new Uint8Array(4);
  new DataView(large.buffer).setUint32(0, 0xffffffff);
  await assert.rejects(importGame(new Blob(['VQGAME1\n', large, '{}video'])), /bozuk/);
  const header = JSON.stringify({ version: 99, videoSize: 1 });
  new DataView(large.buffer).setUint32(0, header.length);
  await assert.rejects(importGame(new Blob(['VQGAME1\n', large, header, 'x'])), /sürümü/);
});

test('missing media, absent final audio, malformed voice mappings and unavailable storage fail explicitly', async () => {
  assert.throws(() => prepareGame(fixture({ video: new Blob([]) })), /video/);
  assert.throws(() => prepareGame(fixture({ dubAudio: null })), /ses dosyası eksik/);
  const badVoice = fixture();
  badVoice.turkishMedia.manifest.voiceMapping = { 'unknown-speaker': 'voice-x' };
  assert.throws(() => prepareGame(badVoice), /konuşmacı|ayrı ve sabit/);
  await assert.rejects(createGameStore({ indexedDB: null }).list(), /desteklemiyor/);
});

test('four canonical speaker voice assignments survive backup without being merged', async () => {
  const input = fixture();
  const m = input.turkishMedia.manifest;
  m.sourceTranscript.speakers = ['one', 'two', 'three', 'four'].map(speakerId => ({ speakerId, providerId: speakerId }));
  m.sourceTranscript.utterances = m.sourceTranscript.speakers.map((row, index) => ({ ...m.sourceTranscript.utterances[0],
    segmentId: `segment-${index}`, speakerId: row.speakerId, sourceStart: index, sourceEnd: index + 1,
    words: [{ text: 'Hello.', start: index, end: index + 1, type: 'word' }] }));
  m.translatedUtterances = m.sourceTranscript.utterances.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId, translatedText: 'Merhaba.' }));
  m.dubSegments = m.sourceTranscript.utterances.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId, start: row.sourceStart, end: row.sourceEnd, words: [] }));
  m.subtitles = { source_tr: [], dub_tr: [] };
  m.voiceMapping = Object.fromEntries(m.sourceTranscript.speakers.map((row, index) => [row.speakerId, `voice-${index}`]));
  const store = IDBFactory ? createGameStore({ indexedDB: new IDBFactory() }) : null;
  const saved = store ? await store.save(input) : null;
  const loaded = store ? await store.load(saved.id) : prepareGame(input);
  assert.deepEqual(loaded.turkishMedia.manifest.voiceMapping, m.voiceMapping);
  const imported = await importGame(exportGame(loaded));
  assert.deepEqual(imported.turkishMedia.manifest.voiceMapping, m.voiceMapping);
  m.voiceMapping.two = 'voice-0';
  assert.throws(() => prepareGame(input), /ayrı ve sabit/);
  await store?.close();
});

function legacyBackup(input) {
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, id: 'legacy-id', title: input.title,
    fileName: input.fileName, sourceKind: input.sourceKind, duration: input.duration,
    payload: input.payload, videoSize: input.video.size, videoType: input.video.type }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength);
  return new Blob(['VQGAME1\n', length, header, input.video]);
}

test('v1 backup imports source video and analysis while dropping all old audio and player state', async () => {
  const original = legacyFixture();
  const restored = await importGame(legacyBackup(original));
  assert.equal(restored.version, 2);
  assert.equal(restored.turkishMedia, null);
  assert.equal(restored.dubAudio, null);
  assertSourceOnlyPayload(restored.payload, original.payload);
  assert.deepEqual(await bytes(restored.video), await bytes(original.video));
  const exported = exportGame(restored);
  const headerSize = new DataView(await exported.slice(8, 12).arrayBuffer()).getUint32(0);
  assert.doesNotMatch(await exported.slice(12, 12 + headerSize).text(), /dubCache|dubStableSpeakerGenders|data:audio|audioBase64|old-voice/);
  assert.deepEqual(original.payload.dubCache, [['hello', 'data:audio/wav;base64,AQIDBA==']], 'import does not mutate its input fixture');
});

test('obsolete audio formats are ignored at preparation without blocking valid source analysis', async () => {
  const input = legacyFixture();
  Object.assign(input.payload, { dubCache: 'corrupt-old-cache', dubStableSpeakerGenders: 42,
    dubSegmentMetadata: { malformed: true }, dubSpeakerVoices: 'old-invalid-voice-plan' });
  input.payload.analysis.oldAudio = 'data:audio/wav;base64,AQIDBA==';
  const prepared = prepareGame(input);
  assert.equal(prepared.payload.analysis.oldAudio, undefined);
  assert.deepEqual(prepared.payload.analysis.actions, input.payload.analysis.actions);
  assert.equal(Object.hasOwn(prepared.payload, 'dubbingEnabled'), false);
  assert.doesNotMatch(JSON.stringify(prepared.payload), /dubCache|dubStableSpeakerGenders|dubSegmentMetadata|dubSpeakerVoices|corrupt-old-cache|data:audio/);
  const restored = await importGame(exportGame(prepared));
  assert.deepEqual(restored.payload, prepared.payload);
  assert.deepEqual(await bytes(restored.video), await bytes(input.video));
});

test('v2 backup rejects mismatched mix length or content type and preserves exact word alignment metadata', async () => {
  const original = fixture();
  const restored = await importGame(exportGame(original));
  assert.deepEqual(restored.turkishMedia.manifest.sourceTranscript.utterances[0].words,
    original.turkishMedia.manifest.sourceTranscript.utterances[0].words);
  assert.deepEqual(restored.turkishMedia.manifest.dubSegments[0].words,
    original.turkishMedia.manifest.dubSegments[0].words);
  const header = { ...prepareGame(original), video: undefined, dubAudio: undefined,
    videoSize: original.video.size, videoType: original.video.type, mixSize: original.dubAudio.size, mixType: 'text/html' };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length);
  await assert.rejects(importGame(new Blob(['VQGAME2\n', length, json, original.video, original.dubAudio])), /ses biçimi/);
  await assert.rejects(importGame(new Blob(['VQGAME2\n', length, json, original.video])), /boyutu/);
});

test('translation-only media stores canonical captions without falsely requiring a dub Blob', async () => {
  const input = fixture({ dubAudio: null });
  input.payload.analysis = null;
  input.payload.dialogue = null;
  input.turkishMedia.dubEnabled = false;
  input.turkishMedia.subtitleTrack = 'source_tr';
  input.turkishMedia.manifest.dubSegments = [];
  input.turkishMedia.manifest.voiceMapping = {};
  input.turkishMedia.manifest.subtitles.dub_tr = [];
  input.turkishMedia.manifest.assets = {};
  const restored = await importGame(exportGame(input));
  assert.equal(restored.dubAudio, null);
  assert.equal(restored.turkishMedia.subtitleTrack, 'source_tr');
  assert.equal(restored.turkishMedia.manifest.sourceTranscript.utterances[0].sourceText, 'Hello.');
});

databaseTest('v1 database upgrade leaves disk rows intact, returns source-only data and drops old audio on explicit save', async () => {
  const indexedDB = new IDBFactory(), database = 'videoquest-upgrade-test';
  const input = legacyFixture();
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => ['games', 'payloads', 'videos'].forEach(name => request.result.createObjectStore(name, { keyPath: 'id' }));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = old.transaction(['games', 'payloads', 'videos'], 'readwrite');
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    tx.objectStore('games').put({ version: 1, id: 'existing', title: input.title, fileName: input.fileName,
      sourceKind: 'url', duration: 90, createdAt: '2026-01-01', updatedAt: '2026-01-01', videoBytes: input.video.size,
      totalBytes: input.video.size + 4, dubCount: 1 });
    tx.objectStore('payloads').put({ id: 'existing', payload: input.payload });
    tx.objectStore('videos').put({ id: 'existing', video: input.video });
  });
  old.close();
  const store = createGameStore({ indexedDB, database });
  const [row] = await store.list();
  assert.equal(row.id, 'existing');
  assert.equal(row.dubReady, false);
  assert.equal(row.dubCount, 0);
  assert.equal(row.totalBytes, input.video.size);
  const restored = await store.load('existing');
  assert.deepEqual(await bytes(restored.video), await bytes(input.video));
  assertSourceOnlyPayload(restored.payload, input.payload);
  assert.equal(restored.dubAudio, null);
  assert.equal(restored.turkishMedia, null);
  await assert.rejects(store.updateLanguageSync('existing', 1), /Türkçe medya bulunamadı/);
  const inspect = await new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const diskPayload = () => new Promise((resolve, reject) => {
    const request = inspect.transaction(['payloads'], 'readonly').objectStore('payloads').get('existing');
    request.onsuccess = () => resolve(request.result.payload); request.onerror = () => reject(request.error);
  });
  assert.deepEqual((await diskPayload()).dubCache, input.payload.dubCache, 'read-only upgrade does not overwrite legacy source rows');
  await store.save(restored, 'existing');
  assertSourceOnlyPayload(await diskPayload(), input.payload);
  assert.deepEqual(await bytes((await store.load('existing')).video), await bytes(input.video));
  inspect.close();
  await store.close();
});
