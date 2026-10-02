import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { createUrlVideoCache, URL_VIDEO_CACHE_TTL_MS } from '../public/url-video-cache.js';

test('URL video cache keeps the raw video and remote token for 24 hours then expires them', async t => {
  assert.equal(URL_VIDEO_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
  let now = 1000;
  const store = createUrlVideoCache({ indexedDB, now: () => now });
  t.after(() => store.close());
  const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4', lastModified: 1 });
  const saved = await store.put('https://example.com/watch/1', file, { remoteToken: 'remote-session-1',
    audioReuseToken: 'obsolete-input-token' });
  assert.equal(saved.expiresAt - saved.createdAt, URL_VIDEO_CACHE_TTL_MS);
  assert.equal(Object.hasOwn(saved, 'audioReuseToken'), false);
  let cached = await store.get('https://example.com/watch/1');
  assert.equal(await cached.file.text(), 'video-bytes');
  assert.equal(cached.file.name, 'clip.mp4');
  assert.equal(cached.remoteToken, 'remote-session-1');
  await store.update('https://example.com/watch/1', { audioReuseToken: 'ignored-obsolete-token' });
  await store.update('https://example.com/watch/1', { remoteToken: 'remote-session-2' });
  cached = await store.get('https://example.com/watch/1');
  assert.equal(Object.hasOwn(cached, 'audioReuseToken'), false);
  assert.equal(cached.remoteToken, 'remote-session-2');
  assert.equal(await cached.file.text(), 'video-bytes');
  now = saved.expiresAt - 1;
  assert.equal(await (await store.get('https://example.com/watch/1')).file.text(), 'video-bytes');
  now = saved.expiresAt;
  assert.equal(await store.get('https://example.com/watch/1'), null);
});

test('legacy persisted audio tokens are ignored while the original video and remote token remain reusable', async t => {
  const now = 5000;
  const key = 'https://example.com/watch/legacy';
  const cache = createUrlVideoCache({ indexedDB, now: () => now });
  t.after(() => cache.close());
  const file = new File(['legacy-original-video'], 'legacy.mp4', { type: 'video/mp4' });
  const row = await cache.put(key, file, { remoteToken: 'retained-video-token' });
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('videoquest-url-video-cache', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('videos', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore('videos').put({ ...row, audioReuseToken: 'old-gemini-upload-token' });
    });
  } finally { database.close(); }
  const cached = await cache.get(key);
  assert.equal(await cached.file.text(), 'legacy-original-video');
  assert.equal(cached.file.name, 'legacy.mp4');
  assert.equal(cached.remoteToken, 'retained-video-token');
  assert.equal(Object.hasOwn(cached, 'audioReuseToken'), false);
  await cache.update(key, { remoteToken: 'refreshed-video-token', audioReuseToken: 'ignored-new-token' });
  const refreshed = await cache.get(key);
  assert.equal(refreshed.remoteToken, 'refreshed-video-token');
  assert.equal(await refreshed.file.text(), 'legacy-original-video');
  assert.equal(Object.hasOwn(refreshed, 'audioReuseToken'), false);
  assert.equal(refreshed.expiresAt, row.expiresAt, 'updating metadata does not extend the source TTL');
});
