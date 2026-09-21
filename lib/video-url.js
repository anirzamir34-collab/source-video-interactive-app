// Generic public-media discovery. Never execute scripts or guess site-specific URLs.
const MEDIA_EXT = /\.(?:mp4|webm|m4v|mov|m3u8|mpd|ogv|3gp|3g2)(?:$|[?#])/i;
const NON_MEDIA_EXT = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|vtt|srt|mp3|m4a)(?:$|[?#])/i;

function vkVideoIdentity(value) {
  try {
    const url = new URL(value);
    if (!/^(?:(?:m|new|vksport)\.)?vk(?:video\.ru|\.ru|\.com)$/.test(url.hostname)) return null;
    const id = url.pathname.match(/^\/(?:video|clip)(-?\d+_\d+)\/?$/)?.[1] ||
      url.searchParams.get('z')?.match(/^(?:video|clip)(-?\d+_\d+)(?:\/|$)/)?.[1];
    return id ? { id, list: url.searchParams.get('list') || '' } : null;
  } catch { return null; }
}

function preserveVkVideoContext(target, source) {
  const from = vkVideoIdentity(source);
  const to = vkVideoIdentity(target);
  if (!from?.list || from.id !== to?.id || to.list) return target;
  const url = new URL(target);
  url.searchParams.set('list', from.list);
  return url.href;
}

export function videoErrorDetail(error) {
  if (typeof error === 'string') return error;
  // Keep termination metadata even when stderr is empty; the old wrapper
  // discarded it, incorrectly reporting source-hidden on 20-second kills.
  return [error?.message, error?.code, error?.signalCode,
    error?.name === 'TimeoutError' ? 'VIDEO_RESOLUTION_TIMEOUT' : '',
    String(error?.stderr || '').slice(-2400)].filter(Boolean).join('; ') || String(error);
}

export function videoErrorDiagnostic(error) {
  // Operational diagnostics must not expose a signed source URL or credentials.
  return videoErrorDetail(error)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|api[-_]?key)\s*[:=][^\r\n]*/gi, '[REDACTED]')
    .replace(/\b(?:list|hash|token|access_key|signature)=[^\s;&"']+/gi, '[REDACTED]')
    .split('\n').filter(line => !/^\s*File |^\s*at /.test(line)).join(' ').slice(-1600);
}

export function decodeMediaUrl(value, baseUrl) {
  if (!value) return null;
  const decoded = String(value)
    .replace(/\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, a, b) => String.fromCharCode(parseInt(a || b, 16)))
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).trim();
  if (/[\r\n\0]/.test(decoded)) return null;
  try {
    const url = new URL(decoded, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return result;
}

export function discoverVideoSources(html, pageUrl, inlineDepth = 0) {
  const media = new Set();
  const quality = new Map();
  const pages = new Set();
  const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
  const base = decodeMediaUrl(baseTag && attributes(baseTag).href, pageUrl) || pageUrl;
  const addMedia = (value, allowUnknown = false, height = 0) => {
    const url = decodeMediaUrl(value, base);
    if (url && !NON_MEDIA_EXT.test(url) &&
        (allowUnknown || MEDIA_EXT.test(url) || /[?&](?:mime|type)=[^&]*video/i.test(url))) {
      media.add(url);
      quality.set(url, Math.max(quality.get(url) || 0, Number.parseInt(height, 10) || 0));
    }
  };
  const addPage = value => {
    const decoded = decodeMediaUrl(value, base);
    const url = decoded && preserveVkVideoContext(decoded, pageUrl);
    if (url && url !== pageUrl && !NON_MEDIA_EXT.test(url)) pages.add(url);
  };
  const alternates = [];
  for (const match of html.matchAll(/<(?:video|source|iframe|embed|object|param|meta|link)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tag = match[0];
    const attr = attributes(tag);
    if (/^<(?:video|source)\b/i.test(tag)) {
      if (attr.type && !/video|mpegurl|dash\+xml/i.test(attr.type)) continue;
      addMedia(attr.src || attr['data-src'], true, attr.res || attr['data-res'] || attr.label);
    } else if (/^<iframe\b/i.test(tag)) {
      addPage(attr.src || attr['data-src'] || attr['data-lazy-src'] || attr['data-original']);
      if (attr.srcdoc && inlineDepth < 2) {
        const inline = attr.srcdoc.replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
        const nested = discoverVideoSources(inline, base, inlineDepth + 1);
        nested.media.forEach(url => addMedia(url, true));
        nested.pages.forEach(addPage);
      }
    } else if (/^<(?:embed|object)\b/i.test(tag)) {
      const value = attr.src || attr.data || attr['data-src'];
      if (MEDIA_EXT.test(value || '') || /video|mpegurl|dash\+xml/i.test(attr.type || '')) addMedia(value, true);
      else if (!/shockwave|flash/i.test(attr.type || '')) addPage(value);
    } else if (/^<param\b/i.test(tag) && /^(?:movie|src|url)$/i.test(attr.name || '')) {
      if (MEDIA_EXT.test(attr.value || '')) addMedia(attr.value);
    } else if (/^<link\b/i.test(tag) && /^(?:amphtml|canonical)$/i.test(attr.rel || '')) {
      alternates.push(attr.href);
    } else if (/^<meta\b/i.test(tag)) {
      const key = (attr.property || attr.name || '').toLowerCase();
      if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
        addMedia(attr.content, true);
        if (!MEDIA_EXT.test(attr.content || '')) addPage(attr.content);
      } else if (key === 'twitter:player') addPage(attr.content);
    }
  }
  // Lazy media attributes and declarative player/JSON-LD configuration.
  for (const match of html.matchAll(/\bdata-(?:video|file|mp4|hls|dash|stream)(?:-url|-src)?\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) addMedia(match[1] || match[2], true);
  for (const match of html.matchAll(/(?:["']?\b(contentUrl|content_url|videoUrl|video_url|videoSource|video_source|playUrl|play_url|streamUrl|stream_url|file|src|hls|dash|mp4|url\d{3,4})["']?)\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi)) {
    // Generic src is often an image or script; dedicated player fields may
    // legitimately contain a signed, extensionless media endpoint.
    addMedia(match[2] || match[3], match[1].toLowerCase() !== 'src', match[1].match(/^url(\d+)$/i)?.[1]);
  }
  for (const match of html.matchAll(/["']?\b(?:embedUrl|embed_url|iframeUrl|iframe_url|playerUrl|player_url)["']?\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi)) addPage(match[1] || match[2]);
  // Parse declarative data, never evaluate the page's JavaScript.
  let nodes = 0;
  const visit = (value, context = '', depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || ++nodes > 2000) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, context, depth + 1); return; }
    const sourceObject = /sources?|videos?|playlist/i.test(context) || /video|mpegurl|dash\+xml/i.test(String(value.type || value['@type'] || ''));
    if (sourceObject) addMedia(value.src || value.file || value.url, true, value.height || value.res || value.label);
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:contentUrl|content_url|file|hls|dash|mp4|url\d{3,4})$/i.test(key) && typeof child === 'string') addMedia(child, true, key.match(/^url(\d+)$/i)?.[1]);
      else if (/^(?:embedUrl|embed_url|iframeUrl|iframe_url)$/i.test(key) && typeof child === 'string') addPage(child);
      else visit(child, key, depth + 1);
    }
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/application\/(?:ld\+)?json/i.test(attributes(match[1]).type || '')) continue;
    try { visit(JSON.parse(match[2])); } catch { /* Site extractors handle non-JSON scripts. */ }
  }
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+\.(?:mp4|webm|m4v|mov|m3u8|mpd|ogv|3gp|3g2)(?:\?[^"'<>\s]*)?/gi)) addMedia(match[0]);
  alternates.forEach(addPage);
  return { media: [...media].sort((a, b) => quality.get(b) - quality.get(a)).slice(0, 32), pages: [...pages].slice(0, 12) };
}

export function mediaResponseType(contentType, url, prefix = '') {
  const type = String(contentType || '').toLowerCase();
  // An HTML error/login page must never become a video because of its filename.
  if (/html|json|image\//.test(type) || /^\s*(?:<!doctype|<html)/i.test(prefix)) return null;
  if (/mpegurl/.test(type) || /^\s*#EXTM3U\b/.test(prefix)) return 'hls';
  if (/dash\+xml/.test(type) || /^\s*(?:<\?xml[^>]*>\s*)?<MPD\b/i.test(prefix)) return 'dash';
  if (type.startsWith('video/')) return 'video';
  if (!type || /octet-stream|text\/plain/.test(type)) {
    if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
    if (/\.mpd(?:$|[?#])/i.test(url)) return 'dash';
    if (/\.(mp4|webm|m4v|mov|ogv|3gp|3g2)(?:$|[?#])/i.test(url) || /^.{4}ftyp/s.test(prefix)) return 'video';
  }
  return null;
}

export function selectExtractorSource(output, rawUrl) {
  // An embed can produce a playlist whose first entry is unavailable/audio-only.
  const queue = [output];
  let drm = false;
  for (let count = 0; queue.length && count < 30; count++) {
    const info = queue.shift();
    if (!info || typeof info !== 'object') continue;
    if (Array.isArray(info.entries)) { queue.push(...info.entries.slice(0, 20)); continue; }
    try { return selectSingleExtractorSource(info, rawUrl); }
    catch (error) { if (error.message === 'VIDEO_DRM_PROTECTED') drm = true; }
  }
  throw new Error(drm ? 'VIDEO_DRM_PROTECTED' : 'VIDEO_FORMAT_UNSUPPORTED');
}

function selectSingleExtractorSource(info, rawUrl) {
  if (!info || typeof info !== 'object') throw new Error('SITE_EXTRACTOR_EMPTY_RESULT');
  if (info.has_drm) throw new Error('VIDEO_DRM_PROTECTED');
  const formats = [...(Array.isArray(info.formats) ? info.formats : [])]
    .sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
  const candidates = [...(info.requested_formats?.length > 1 || /url/.test(info._type || '') ? [] : [info]), ...formats];
  let selected = candidates.find(item => item && !item.has_drm &&
    item.vcodec !== 'none' && item.acodec !== 'none' &&
    /^https?:\/\//i.test(item.url || '') &&
    !/dash|http_dash_segments/i.test(item.protocol || '') && !/\.mpd(?:$|[?#])/i.test(item.url));
  if (!selected) {
    // DASH and some HLS providers list audio/video separately. Feed the shared
    // manifest to ffmpeg, not an individual silent representation or segment.
    for (const item of formats) {
      if (item.has_drm || item.vcodec === 'none' || !item.vcodec) continue;
      const manifest = item.manifest_url || (/\.(?:mpd|m3u8)(?:$|[?#])/i.test(item.url || '') ? item.url : '');
      if (!/^https?:\/\//i.test(manifest)) continue;
      const group = formats.filter(other => (other.manifest_url || other.url) === manifest);
      if (group.some(other => other.has_drm) || !group.some(other => other.acodec && other.acodec !== 'none')) continue;
      selected = { ...item, url: manifest, protocol: /dash/i.test(item.protocol || '') || /\.mpd(?:$|[?#])/i.test(manifest) ? 'dash' : 'm3u8' };
      break;
    }
  }
  if (!selected) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
  const headers = Object.fromEntries(Object.entries({ ...info.http_headers, ...selected.http_headers })
    .map(([key, value]) => [key.toLowerCase(), String(value).replace(/[\r\n]/g, '')]));
  const sourceUrl = decodeMediaUrl(selected.url, rawUrl);
  if (!sourceUrl) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
  return {
    sourceUrl,
    pageUrl: decodeMediaUrl(headers.referer || info.webpage_url, rawUrl) || rawUrl,
    type: /dash/i.test(selected.protocol || '') || /\.mpd(?:$|[?#])/i.test(sourceUrl) ? 'dash'
      : /m3u8|hls/i.test(selected.protocol || '') || /\.m3u8(?:$|[?#])/i.test(sourceUrl) ? 'hls' : 'video',
    cookie: headers.cookie || '', userAgent: headers['user-agent'] || '',
    extractor: String(info.extractor_key || info.extractor || 'yt-dlp')
  };
}

export function videoResolutionFailure(detail) {
  const value = String(detail || '');
  if (/DRM/i.test(value)) return { reason: 'VIDEO_DRM_PROTECTED', message: 'Kaynak DRM korumalı. Bu oynatıcıya aktarılamıyor.' };
  if (/captcha|cloudflare|anti.bot|forbidden|\b403\b|\b401\b|sign.in|log.?in|authentication|cookies.*required/i.test(value)) {
    return { reason: 'SITE_ACCESS_BLOCKED', message: 'Kaynak site sunucudan erişimi reddetti. Oturum veya site doğrulaması gerekebilir; desteklenen bir doğrudan video bağlantısı ya da cihazdan dosya kullanabilirsin.' };
  }
  if (/VIDEO_EXTRACTOR_UNAVAILABLE|ENOENT|EACCES|python.*(?:not found|not supported|unsupported)|\/usr\/bin\/env:.*python|unsupported.*python/i.test(value)) {
    return { reason: 'VIDEO_EXTRACTOR_UNAVAILABLE', message: 'Sunucudaki video çıkarıcısı başlatılamadı. Bu sunucu kaynaklı bir hata; bağlantının yanlış olduğu anlamına gelmez.' };
  }
  if (/HTTP(?: Error)?[\s:_-]*5\d\d\b|bad gateway|service unavailable|gateway timeout/i.test(value)) {
    return { reason: 'VIDEO_SOURCE_TEMPORARY_ERROR', retryable: true, message: 'Kaynak sitenin video bilgi servisi geçici bir hata verdi. Biraz sonra aynı bağlantıyı yeniden dene.' };
  }
  if (/\b404\b|\b410\b/.test(value)) return { reason: 'VIDEO_PAGE_NOT_FOUND', message: 'Video sayfası bulunamadı veya bağlantının süresi doldu.' };
  if (/timeout|timed.out|aborted|SIGKILL|VIDEO_RESOLUTION_CANCELLED/i.test(value)) return { reason: 'VIDEO_RESOLUTION_TIMEOUT', retryable: true, message: 'Video kaynağını çözme işlemi süre sınırına ulaştı. Bu, videonun bulunmadığı anlamına gelmez; bağlantıyı yeniden deneyebilirsin.' };
  if (/VIDEO_EXTRACTOR_(?:PROCESS_FAILED|OUTPUT_LIMIT|INVALID_RESPONSE)/.test(value)) return { reason: 'VIDEO_EXTRACTOR_FAILED', message: 'Video çıkarıcısı bu bağlantıyı işlerken hata verdi. Tam video bağlantısını kontrol ederek yeniden dene.' };
  if (/VIDEO_FORMAT_UNSUPPORTED/.test(value)) return { reason: 'VIDEO_FORMAT_UNSUPPORTED', message: 'Video bulundu ancak sunulan ses ve görüntü akışı bu oynatıcıya aktarılamıyor. MP4, WebM, HLS veya korumasız DASH bağlantısı kullanabilirsin.' };
  return { reason: 'VIDEO_SOURCE_HIDDEN', message: 'Sayfa ve gömülü oynatıcılar kontrol edildi ancak aktarılabilir video bulunamadı. Oynatıcı yalnızca tarayıcı içinde dinamik olarak yükleniyor olabilir.' };
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, maxBytes - size);
      chunks.push(part); size += part.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function checkDashManifest(response) {
  const xml = await readLimited(response, 1024 * 1024);
  if (!/<MPD\b/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
  if (/<(?:[\w-]+:)?ContentProtection\b/i.test(xml)) throw new Error('VIDEO_DRM_PROTECTED');
}

export async function probeVideoSource(candidate, referer, { fetchPublicUrl, signal, cookie = '', userAgent = '' } = {}) {
  let response;
  try {
    const headers = { Range: 'bytes=0-2047', Referer: referer, Origin: new URL(referer).origin, Accept: '*/*' };
    if (cookie) headers.Cookie = cookie;
    if (userAgent) headers['User-Agent'] = userAgent;
    let fetched = await fetchPublicUrl(candidate, { headers, timeoutMs: 8000, signal });
    response = fetched.response;
    // Some otherwise playable servers reject a Range probe.
    if ([405, 416].includes(response.status)) {
      await response.body?.cancel();
      delete headers.Range;
      fetched = await fetchPublicUrl(candidate, { headers, timeoutMs: 8000, signal });
      response = fetched.response;
    }
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    let type = mediaResponseType(contentType, fetched.finalUrl);
    if (!type && !/html|json|image\//i.test(contentType)) {
      type = mediaResponseType(contentType, fetched.finalUrl, await readLimited(response, 2048));
    }
    if (type === 'dash') {
      // A partial manifest can hide ContentProtection later in the document.
      await response.body?.cancel().catch(() => {});
      delete headers.Range;
      fetched = await fetchPublicUrl(candidate, { headers, timeoutMs: 8000, signal });
      response = fetched.response;
      if (!response.ok) return null;
      await checkDashManifest(response);
    }
    return type ? { sourceUrl: fetched.finalUrl, type, contentType,
      cookie: sameOrigin(candidate, fetched.finalUrl) ? cookie : '' } : null;
  } catch (error) {
    if (signal?.aborted || error?.message === 'VIDEO_DRM_PROTECTED') throw error;
    return null;
  } finally { await response?.body?.cancel().catch(() => {}); }
}

export async function resolveVideoPage(startUrl, { fetchPublicUrl, signal = AbortSignal.timeout(25000), onPage = () => {} } = {}) {
  const queue = [{ url: startUrl, depth: 0, referer: startUrl, cookie: '' }];
  const visited = new Set();
  const probed = new Set();
  const errors = [];
  onPage(queue[0]);
  while (queue.length && visited.size < 12) {
    signal.throwIfAborted();
    const page = queue.shift();
    if (visited.has(page.url)) continue;
    visited.add(page.url);
    let response;
    try {
      const headers = { Accept: 'text/html,video/*,application/vnd.apple.mpegurl,*/*;q=0.5', Referer: page.referer };
      if (page.cookie) headers.Cookie = page.cookie;
      const fetched = await fetchPublicUrl(page.url, { headers, timeoutMs: 8000, signal });
      response = fetched.response;
      const finalUrl = fetched.finalUrl;
      if (finalUrl !== page.url) onPage({ ...page, url: finalUrl });
      if (!response.ok) { errors.push(`HTTP ${response.status}`); continue; }
      const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
      const pairs = new Map();
      for (const raw of [...(sameOrigin(page.url, finalUrl) ? page.cookie.split(';') : []), ...cookies]) {
        const pair = String(raw).split(';')[0].trim();
        const equal = pair.indexOf('=');
        if (equal > 0) pairs.set(pair.slice(0, equal), pair);
      }
      const cookie = [...pairs.values()].join('; ');
      const contentType = response.headers.get('content-type') || '';
      let type = mediaResponseType(contentType, finalUrl);
      if (type === 'dash') await checkDashManifest(response);
      if (type) return { sourceUrl: finalUrl, pageUrl: page.referer, type, cookie, contentType };
      const html = await readLimited(response, 2 * 1024 * 1024);
      type = mediaResponseType(contentType, finalUrl, html.slice(0, 2048));
      if (type === 'dash') {
        if (/<(?:[\w-]+:)?ContentProtection\b/i.test(html)) throw new Error('VIDEO_DRM_PROTECTED');
        if (/<!DOCTYPE|<!ENTITY/i.test(html)) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
      }
      if (type) return { sourceUrl: finalUrl, pageUrl: page.referer, type, cookie, contentType };
      const found = discoverVideoSources(html, finalUrl);
      if (page.depth < 4) {
        for (const url of found.pages) {
          const nested = { url, depth: page.depth + 1, referer: finalUrl, cookie: sameOrigin(url, finalUrl) ? cookie : '' };
          onPage(nested);
          if (!visited.has(url) && !queue.some(item => item.url === url) && queue.length < 24) queue.push(nested);
        }
      }
      const candidates = found.media.filter(url => !probed.has(url)).slice(0, Math.max(0, 24 - probed.size));
      for (let i = 0; i < candidates.length; i += 3) {
        const batch = candidates.slice(i, i + 3);
        batch.forEach(url => probed.add(url));
        const results = await Promise.allSettled(batch.map(url => probeVideoSource(url, finalUrl, {
          fetchPublicUrl, signal, cookie: sameOrigin(url, finalUrl) ? cookie : ''
        })));
        signal.throwIfAborted();
        for (const result of results) if (result.status === 'rejected') errors.push(String(result.reason?.message || result.reason));
        const match = results.find(result => result.status === 'fulfilled' && result.value)?.value;
        if (match) return { ...match, pageUrl: finalUrl };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(error?.message || String(error));
      // A failed iframe cannot discard its siblings or the parent video's source.
    } finally { await response?.body?.cancel().catch(() => {}); }
  }
  if (errors.length) throw new Error(errors.join('; ').slice(0, 500));
  return null;
}

export async function resolveVideoUrl(startUrl, {
  fetchPublicUrl, extractPage, signal = AbortSignal.timeout(85000)
} = {}) {
  const pages = new Map([[startUrl, { url: startUrl, referer: startUrl, depth: 0 }]]);
  const errors = [];
  try {
    const direct = await resolveVideoPage(startUrl, {
      fetchPublicUrl, signal: AbortSignal.any([signal, AbortSignal.timeout(vkVideoIdentity(startUrl) ? 12000 : 20000)]),
      onPage: page => { if (!pages.has(page.url) && pages.size < 24) pages.set(page.url, page); }
    });
    if (direct) return direct;
  } catch (error) { errors.push(videoErrorDetail(error)); }
  signal.throwIfAborted();
  if (extractPage) {
    // Real player hosts first, then nested players; always reserve an attempt
    // for the original page. Do not let ad frames consume an unbounded budget.
    const provider = url => /(?:^|\.)(?:vk\.com|vk\.ru|vkvideo\.ru|vimeo\.com|youtube\.com|youtu\.be|dailymotion\.com|ok\.ru)$/.test(new URL(url).hostname);
    const nested = [...pages.values()].filter(page => page.url !== startUrl)
      .sort((a, b) => Number(provider(b.url)) - Number(provider(a.url)) || b.depth - a.depth).slice(0, 2);
    const attempts = vkVideoIdentity(startUrl) ? [pages.get(startUrl), ...nested] : [...nested, pages.get(startUrl)];
    const extracted = new Set();
    for (const page of attempts) {
      const vk = vkVideoIdentity(page.url);
      const key = vk ? `vk:${vk.id}:${vk.list}` : page.url;
      if (extracted.has(key)) continue;
      extracted.add(key);
      signal.throwIfAborted();
      try {
        const timeoutMs = vk ? 45000 : 20000;
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        const candidate = await extractPage(page.url, { referer: page.referer, signal: attemptSignal, timeoutMs });
        if (!candidate) continue;
        const verified = await probeVideoSource(candidate.sourceUrl, candidate.pageUrl || page.url, {
          fetchPublicUrl, signal: attemptSignal, cookie: candidate.cookie, userAgent: candidate.userAgent
        });
        if (verified) return { ...candidate, ...verified };
        errors.push('SITE_EXTRACTOR_SOURCE_UNAVAILABLE');
      } catch (error) { errors.push(videoErrorDetail(error)); }
    }
  }
  signal.throwIfAborted();
  if (errors.length) throw new Error(errors.join('; ').slice(0, 4000));
  return null;
}
