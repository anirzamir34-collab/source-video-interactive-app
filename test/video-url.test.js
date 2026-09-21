import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverVideoSources, mediaResponseType, selectExtractorSource, videoResolutionFailure, videoErrorDetail, videoErrorDiagnostic, resolveVideoPage, resolveVideoUrl, probeVideoSource } from '../lib/video-url.js';

test('VK source-unavailable response is distinguished from a broken URL or extractor crash', () => {
  const result = videoResolutionFailure('VIDEO_EXTRACTOR_PROCESS_FAILED; ERROR VK_PLAYER_UNAVAILABLE');
  assert.equal(result.reason, 'VIDEO_SOURCE_UNAVAILABLE');
  assert.match(result.message, /VK/);
  assert.equal(videoResolutionFailure('VIDEO_EXTRACTOR_PROCESS_FAILED; VK_PLAYER_METADATA_MISSING').reason, 'VIDEO_EXTRACTOR_FAILED');
});

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

test('discovers lazy VK embeds, inline players and object sources ahead of canonical pages', () => {
  const found = discoverVideoSources(`
    <link rel="canonical" href="/watch">
    <iframe data-original="https://vk.com/video_ext.php?oid=-1&amp;id=2&amp;hash=abc"></iframe>
    <iframe srcdoc="&lt;video&gt;&lt;source src=&quot;/clip.ogv&quot;&gt;&lt;/video&gt;"></iframe>
    <object data="/player/42" type="text/html"></object>
    <embed src="/clip.3gp" type="video/3gpp">
    <source src="/manifest.mpd" type="application/dash+xml">
    <iframe src="javascript:alert(1)"></iframe>
  `, 'https://site.test/article');
  assert.deepEqual(found.pages, ['https://vk.com/video_ext.php?oid=-1&id=2&hash=abc', 'https://site.test/player/42', 'https://site.test/watch']);
  assert.deepEqual(found.media, ['https://site.test/clip.ogv', 'https://site.test/clip.3gp', 'https://site.test/manifest.mpd']);
});

test('finds signed extensionless player sources and VK quality fields without evaluating scripts', () => {
  const found = discoverVideoSources(`
    <script>window.player = { url720: "https:\\/\\/cdn.test/play?sig=x\\u0026q=720", hls: "/manifest?sig=y", src: "/app.js" };</script>
    <script type="application/json">{"player":{"sources":[{"src":"/signed?token=1","type":"video/mp4"}]}}</script>
    <script type="application/ld+json">{"@type":"VideoObject","embedUrl":"/embed/1"}</script>
  `, 'https://site.test/watch');
  assert.ok(found.media.includes('https://cdn.test/play?sig=x&q=720'));
  assert.ok(found.media.includes('https://site.test/manifest?sig=y'));
  assert.ok(found.media.includes('https://site.test/signed?token=1'));
  assert.ok(!found.media.some(url => url.endsWith('app.js')));
  assert.deepEqual(found.pages, ['https://site.test/embed/1']);
});

test('recognizes DASH MIME and XML but never mistakes an HTML error for DASH', () => {
  assert.equal(mediaResponseType('application/dash+xml', 'https://cdn.test/manifest'), 'dash');
  assert.equal(mediaResponseType('application/xml', 'https://cdn.test/manifest', '<?xml version="1.0"?><MPD/>'), 'dash');
  assert.equal(mediaResponseType('text/html', 'https://cdn.test/manifest.mpd', '<html>login</html>'), null);
  assert.equal(mediaResponseType('application/octet-stream', 'https://cdn.test/clip.3gp'), 'video');
});

test('explicit quality variants are tried from highest to lowest without dropping fallbacks', () => {
  const found = discoverVideoSources('<script>var p = {url240:"/low.mp4",url1080:"/high.mp4",url720:"/medium.mp4"}</script>', 'https://site.test/watch');
  assert.deepEqual(found.media, ['https://site.test/high.mp4', 'https://site.test/medium.mp4', 'https://site.test/low.mp4']);
});

test('extractor skips unavailable and audio-only entries to find playable video', () => {
  const selected = selectExtractorSource({ entries: [null, { url: 'https://cdn.test/song', vcodec: 'none' },
    { entries: [{ url: 'https://cdn.test/movie.mp4', vcodec: 'h264', acodec: 'aac' }] }
  ] }, 'https://site.test/watch');
  assert.equal(selected.sourceUrl, 'https://cdn.test/movie.mp4');
});

test('extractor selects a shared DASH manifest with both audio and video, not its segments', () => {
  const formats = [
    { url: 'https://cdn.test/chunk-v.m4s', manifest_url: 'https://cdn.test/manifest.mpd', protocol: 'http_dash_segments', vcodec: 'h264', acodec: 'none', height: 1080 },
    { url: 'https://cdn.test/chunk-a.m4s', manifest_url: 'https://cdn.test/manifest.mpd', protocol: 'http_dash_segments', vcodec: 'none', acodec: 'aac' }
  ];
  const selected = selectExtractorSource({ requested_formats: formats, formats }, 'https://site.test/watch');
  assert.equal(selected.type, 'dash');
  assert.equal(selected.sourceUrl, 'https://cdn.test/manifest.mpd');
  assert.throws(() => selectExtractorSource({ formats: [formats[0]] }, 'https://site.test/watch'), /VIDEO_FORMAT_UNSUPPORTED/);
  assert.throws(() => selectExtractorSource({ has_drm: true, formats }, 'https://site.test/watch'), /VIDEO_DRM_PROTECTED/);
});

function upstream(routes) {
  const calls = [];
  const fetchPublicUrl = async (url, options = {}) => {
    calls.push({ url, ...options });
    options.signal?.throwIfAborted();
    const route = routes[url];
    if (!route) throw Error(`Unexpected request: ${url}`);
    return { finalUrl: route.finalUrl || url, response: new Response(route.body || '', {
      status: route.status || 200, headers: { 'content-type': route.type || 'text/html', ...route.headers }
    }) };
  };
  return { fetchPublicUrl, calls };
}

test('nested player traversal survives failed siblings and cycles, retaining the player referer', async () => {
  const f = upstream({
    'https://site.test/watch': { body: '<iframe src="/broken"></iframe><iframe src="/one"></iframe>' },
    'https://site.test/broken': { status: 404 },
    'https://site.test/one': { body: '<iframe src="/two"></iframe><iframe src="/watch"></iframe>' },
    'https://site.test/two': { body: '<iframe src="/three"></iframe>' },
    'https://site.test/three': { body: '<video src="https://cdn.test/file"></video>' },
    'https://cdn.test/file': { type: 'video/mp4' }
  });
  const result = await resolveVideoPage('https://site.test/watch', f);
  assert.equal(result.sourceUrl, 'https://cdn.test/file');
  assert.equal(result.pageUrl, 'https://site.test/three');
  assert.equal(f.calls.filter(call => call.url === 'https://site.test/watch').length, 1);
});

test('site extraction runs on the embedded VK URL with parent referer, then verifies the result', async () => {
  const embed = 'https://vk.com/video_ext.php?oid=-1&id=2&hash=abc';
  const f = upstream({
    'https://site.test/watch': { body: `<iframe src="${embed}"></iframe>` },
    [embed]: { body: '<div id="player">Dynamic player</div>' },
    'https://cdn.test/v.mp4': { type: 'video/mp4' }
  });
  const calls = [];
  const result = await resolveVideoUrl('https://site.test/watch', { ...f, extractPage: async (url, options) => {
    calls.push({ url, options });
    return { sourceUrl: 'https://cdn.test/v.mp4', pageUrl: url, extractor: 'VK' };
  } });
  assert.equal(result.extractor, 'VK');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, embed);
  assert.equal(calls[0].options.referer, 'https://site.test/watch');
  assert.equal(f.calls.at(-1).headers.Referer, embed);
});

test('a stale extracted source cannot stop another embedded player from resolving', async () => {
  const f = upstream({
    'https://site.test/watch': { body: '<iframe src="/a"></iframe><iframe src="/b"></iframe>' },
    'https://site.test/a': {}, 'https://site.test/b': {},
    'https://cdn.test/expired.mp4': { status: 403 },
    'https://cdn.test/working.mp4': { type: 'video/mp4' }
  });
  const result = await resolveVideoUrl('https://site.test/watch', { ...f, extractPage: async url => ({
    sourceUrl: url.endsWith('/a') ? 'https://cdn.test/expired.mp4' : 'https://cdn.test/working.mp4', pageUrl: url
  }) });
  assert.equal(result.sourceUrl, 'https://cdn.test/working.mp4');
});

test('direct media avoids the extractor and probing does not forward page cookies to another host', async () => {
  const f = upstream({
    'https://site.test/watch': { body: '<video src="https://cdn.test/clip.mp4"></video>', headers: { 'set-cookie': 'site_session=private; Path=/' } },
    'https://cdn.test/clip.mp4': { type: 'video/mp4' }
  });
  await resolveVideoUrl('https://site.test/watch', { ...f, extractPage: () => assert.fail('unnecessary extractor') });
  assert.equal(f.calls.at(-1).headers.Cookie, undefined);
});

test('DASH probe reads a full manifest and rejects protection beyond the range probe', async () => {
  const f = upstream({ 'https://cdn.test/manifest.mpd': {
    type: 'application/dash+xml', body: '<MPD>' + ' '.repeat(3000) + '<ContentProtection schemeIdUri="urn:uuid:protected"/></MPD>'
  } });
  await assert.rejects(probeVideoSource('https://cdn.test/manifest.mpd', 'https://site.test/watch', f), /VIDEO_DRM_PROTECTED/);
  assert.equal(f.calls.at(-1).headers.Range, undefined);
});

test('an unavailable DASH candidate does not discard a working progressive sibling', async () => {
  const f = upstream({
    'https://site.test/watch': { body: '<source src="/manifest.mpd"><source src="/clip.mp4">' },
    'https://site.test/manifest.mpd': { type: 'application/dash+xml', body: '<MPD><ContentProtection/></MPD>' },
    'https://site.test/clip.mp4': { type: 'video/mp4' }
  });
  const result = await resolveVideoPage('https://site.test/watch', f);
  assert.equal(result.sourceUrl, 'https://site.test/clip.mp4');
});

test('cancellation stops resolution before a site extractor can start', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveVideoUrl('https://site.test/watch', {
    signal: controller.signal,
    fetchPublicUrl: () => assert.fail('must not fetch'), extractPage: () => assert.fail('must not extract')
  }), /abort/i);
});

test('mobile VK canonical links preserve the supplied list token only for the same video', () => {
  const result = discoverVideoSources(`
    <link rel="canonical" href="https://vkvideo.ru/video-1_2">
    <iframe src="https://vk.com/video-1_3"></iframe>
    <iframe src="https://unrelated.test/video-1_2"></iframe>
  `, 'https://m.vkvideo.ru/video-1_2?list=ln-ExactCase');
  assert.ok(result.pages.includes('https://vkvideo.ru/video-1_2?list=ln-ExactCase'));
  assert.ok(result.pages.includes('https://vk.com/video-1_3'));
  assert.ok(result.pages.includes('https://unrelated.test/video-1_2'));
});

test('VK extraction uses the complete original link once, with enough time for provider retries', async () => {
  const url = 'https://m.vkvideo.ru/video-1_2?list=ln-ExactCase';
  const f = upstream({
    [url]: { body: '<link rel="canonical" href="https://vkvideo.ru/video-1_2">' },
    'https://vkvideo.ru/video-1_2?list=ln-ExactCase': { status: 502 }
  });
  const attempts = [];
  await assert.rejects(resolveVideoUrl(url, { ...f, extractPage: async (page, options) => {
    attempts.push({ page, options });
    throw Object.assign(new Error('VIDEO_EXTRACTOR_PROCESS_FAILED'), { stderr: 'HTTP Error 502: Bad Gateway' });
  } }), error => {
    assert.equal(videoResolutionFailure(videoErrorDetail(error)).reason, 'VIDEO_SOURCE_TEMPORARY_ERROR');
    return true;
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].page, url);
  assert.equal(attempts[0].options.timeoutMs, 45000);
});

test('empty-stderr kills and missing Python are not classified as hidden video', () => {
  assert.equal(videoResolutionFailure(videoErrorDetail({ signalCode: 'SIGKILL', stderr: '' })).reason, 'VIDEO_RESOLUTION_TIMEOUT');
  assert.equal(videoResolutionFailure('/usr/bin/env: python3: No such file or directory').reason, 'VIDEO_EXTRACTOR_UNAVAILABLE');
  assert.equal(videoResolutionFailure('HTTP Error 503: Service Unavailable').reason, 'VIDEO_SOURCE_TEMPORARY_ERROR');
});

test('extractor diagnostics retain the cause without signed links or credential headers', () => {
  const diagnostic = videoErrorDiagnostic(Object.assign(new Error('VIDEO_EXTRACTOR_PROCESS_FAILED'), {
    stderr: 'ERROR: Unable to extract metadata from https://site.test/video?list=secret&token=private\nCookie: session=private-session\nAuthorization: Bearer private-bearer\nHTTP Error 502: Bad Gateway'
  }));
  assert.match(diagnostic, /HTTP Error 502/);
  assert.doesNotMatch(diagnostic, /site\.test|secret|private|Bearer|session=/);
});
