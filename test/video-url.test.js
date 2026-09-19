import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverVideoSources, mediaResponseType, selectExtractorSource, videoResolutionFailure } from '../lib/video-url.js';

test('video discovery keeps media sources and embedded player pages separate', () => {
  const result = discoverVideoSources(`
    <video><source src="/media/clip.mp4" type="video/mp4"></video>
    <video data-file="https:\\/\\/cdn.example.test/live.m3u8"></video>
    <iframe data-src="/embed/123"></iframe>
    <meta property="og:video" content="/media/clip.mp4">
    <script>const config = { file: "https:\\/\\/cdn.example.test/second.webm" };</script>
  `, 'https://site.example.test/watch/page');
  assert.deepEqual(result.media, [
    'https://site.example.test/media/clip.mp4',
    'https://cdn.example.test/live.m3u8',
    'https://cdn.example.test/second.webm'
  ]);
  assert.deepEqual(result.pages, ['https://site.example.test/embed/123']);
});

test('media type rejects HTML login pages and recognizes extensionless HLS', () => {
  assert.equal(mediaResponseType('text/html', 'https://cdn.test/video.mp4', '<html>login</html>'), null);
  assert.equal(mediaResponseType('application/vnd.apple.mpegurl', 'https://cdn.test/stream'), 'hls');
  assert.equal(mediaResponseType('application/octet-stream', 'https://cdn.test/stream', '#EXTM3U\n'), 'hls');
  assert.equal(mediaResponseType('video/mp4', 'https://cdn.test/file'), 'video');
});

test('extractor selection keeps progressive audio and video together', () => {
  const result = selectExtractorSource({
    extractor_key: 'Generic', webpage_url: 'https://site.test/watch',
    formats: [
      { url: 'https://cdn.test/video-only', vcodec: 'h264', acodec: 'none', height: 1080 },
      { url: 'https://cdn.test/video-audio', vcodec: 'h264', acodec: 'aac', height: 720,
        protocol: 'https', http_headers: { Referer: 'https://site.test/watch' } }
    ]
  }, 'https://site.test/watch');
  assert.equal(result.sourceUrl, 'https://cdn.test/video-audio');
  assert.equal(result.type, 'video');
  assert.equal(result.pageUrl, 'https://site.test/watch');
});

test('resolution failures explain access blocks separately from hidden sources', () => {
  assert.equal(videoResolutionFailure('HTTP 403 Cloudflare challenge').reason, 'SITE_ACCESS_BLOCKED');
  assert.equal(videoResolutionFailure('VIDEO_DRM_PROTECTED').reason, 'VIDEO_DRM_PROTECTED');
  assert.equal(videoResolutionFailure('no media candidate').reason, 'VIDEO_SOURCE_HIDDEN');
});
