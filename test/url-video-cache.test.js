import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { createUrlVideoCache } from '../public/url-video-cache.js';

test('URL video cache keeps raw video and audio reuse token for 24 hours then expires it', async () => {
  let now = 1000;
  const store = createUrlVideoCache({ indexedDB, now: () => now, ttlMs: 24 * 60 * 60 * 1000 });
  const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4', lastModified: 1 });
  await store.put('https://example.com/watch/1', file, { remoteToken: 'remote-session-1' });
  let cached = await store.get('https://example.com/watch/1');
  assert.equal(await cached.file.text(), 'video-bytes');
  assert.equal(cached.file.name, 'clip.mp4');
  assert.equal(cached.remoteToken, 'remote-session-1');
  await store.update('https://example.com/watch/1', { audioReuseToken: 'files/audio-1' });
  await store.update('https://example.com/watch/1', { remoteToken: 'remote-session-2' });
  cached = await store.get('https://example.com/watch/1');
  assert.equal(cached.audioReuseToken, 'files/audio-1');
  assert.equal(cached.remoteToken, 'remote-session-2');
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await store.get('https://example.com/watch/1'), null);
  await store.close();
});
