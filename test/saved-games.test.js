import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createGameStore, prepareGame, exportGame, importGame, storageError } from '../public/saved-games.js';

const fixture = (overrides = {}) => ({
  title: 'Park gezisi', fileName: 'park.mp4', sourceKind: 'url', duration: 90,
  video: new Blob([new Uint8Array([0, 1, 2, 3, 255])], { type: 'video/mp4' }),
  payload: {
    analysis: { schemaVersion: 5, actions: [{ id: 'walk', startTime: 0, endTime: 10, label: 'Parkta yürü', sourceVerified: true }] },
    dialogue: { segments: [{ id: 'hello', start: 1, end: 2, turkishText: 'Merhaba' }] },
    dubCache: [['hello', 'data:audio/wav;base64,AQIDBA==']], dubStableSpeakerGenders: [['narrator', 'female']],
    dubbingEnabled: true, subtitlesEnabled: true, keepOriginalAudioEnabled: false
  }, ...overrides
});
const bytes = async blob => [...new Uint8Array(await blob.arrayBuffer())];

test('reopening the database restores URL video bytes, analysis, dialogue and audio without URLs', async () => {
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
  const loaded = await reopened.load(row.id);
  assert.deepEqual(await bytes(loaded.video), await bytes(source.video));
  assert.deepEqual(loaded.payload.analysis, source.payload.analysis);
  assert.deepEqual(loaded.payload.dubCache, source.payload.dubCache);
  assert.equal(loaded.sourceKind, 'url');
  assert.equal(loaded.payload.keepOriginalAudioEnabled, false);
  await reopened.close();
});

test('device files and dialogue-only analyses can be saved and replayed', async () => {
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

test('updates keep the same ID; explicit deletion affects only the chosen record', async () => {
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

test('quota failure rolls back metadata and video, preserving previous saves', async () => {
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const original = await store.save(fixture());
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'videos') throw new DOMException('disk full', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try {
    await assert.rejects(store.save(fixture({ title: 'Kaydedilmemeli' }), original.id), { name: 'QuotaExceededError' });
    await assert.rejects(store.save(fixture({ title: 'Yarım kayıt' })), { name: 'QuotaExceededError' });
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load(original.id)).title, 'Park gezisi');
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
  assert.notEqual(restored.id, original.id);
  const store = createGameStore({ indexedDB: new IDBFactory() });
  await store.save(original);
  await store.save(restored);
  assert.equal((await store.list()).length, 2);
  await store.close();
});

test('credentials and temporary links never enter the record or exported backup', async () => {
  const input = fixture();
  input.geminiApiKey = 'secret';
  input.sourceUrl = 'https://source.test/expiring';
  input.payload.password = 'secret';
  input.payload.dialogue.authorization = 'secret';
  input.payload.analysis.proxyUrl = '/proxy?token=secret';
  input.payload.analysis.api_key = 'secret';
  const game = prepareGame(input);
  const json = JSON.stringify(game);
  assert.doesNotMatch(json, /secret|expiring|proxy/);
  assert.doesNotMatch(await exportGame(game).text(), /secret|expiring|proxy/);
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

test('missing media, malformed dub entries and unavailable storage fail explicitly', async () => {
  assert.throws(() => prepareGame(fixture({ video: new Blob([]) })), /video/);
  const bad = fixture();
  bad.payload.dubCache = [['hello', 'https://expiring.example/audio']];
  assert.throws(() => prepareGame(bad), /dublaj/);
  await assert.rejects(createGameStore({ indexedDB: null }).list(), /desteklemiyor/);
});

test('four speaker voice assignments survive saving, reopening and backup without being merged', async () => {
  const input = fixture();
  input.payload.dialogue.segments = ['one', 'two', 'three', 'four'].map((speakerId, index) => ({
    speakerId, startTime: index, endTime: index + 1, turkishText: 'Merhaba'
  }));
  input.payload.dubSpeakerVoices = input.payload.dialogue.segments.map((row, index) => ({
    speakerId: row.speakerId, voiceId: `voice-${index}`, voiceName: `Ses ${index}`, gender: 'uncertain'
  }));
  const store = createGameStore({ indexedDB: new IDBFactory() });
  const saved = await store.save(input);
  const loaded = await store.load(saved.id);
  assert.deepEqual(loaded.payload.dubSpeakerVoices, input.payload.dubSpeakerVoices);
  const imported = await importGame(exportGame(loaded));
  assert.deepEqual(imported.payload.dubSpeakerVoices, input.payload.dubSpeakerVoices);
  input.payload.dubSpeakerVoices[1].voiceId = 'voice-0';
  assert.throws(() => prepareGame(input), /ayrı ve sabit/);
  await store.close();
});
