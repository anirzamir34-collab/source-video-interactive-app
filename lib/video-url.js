// Generic public-media discovery. Never execute scripts or guess site-specific URLs.
const MEDIA_EXT = /\.(?:mp4|webm|m4v|mov|m3u8)(?:$|[?#])/i;
const NON_MEDIA_EXT = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|vtt|srt|mp3|m4a)(?:$|[?#])/i;

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

export function discoverVideoSources(html, pageUrl) {
  const media = new Set();
  const pages = new Set();
  const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
  const base = decodeMediaUrl(baseTag && attributes(baseTag).href, pageUrl) || pageUrl;
  const addMedia = (value, allowUnknown = false) => {
    const url = decodeMediaUrl(value, base);
    if (url && !NON_MEDIA_EXT.test(url) && !/\.mpd(?:$|[?#])/i.test(url) &&
        (allowUnknown || MEDIA_EXT.test(url) || /[?&](?:mime|type)=[^&]*video/i.test(url))) media.add(url);
  };
  const addPage = value => {
    const url = decodeMediaUrl(value, base);
    if (url && url !== pageUrl && !NON_MEDIA_EXT.test(url)) pages.add(url);
  };
  for (const match of html.matchAll(/<(?:video|source|iframe|meta|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const attr = attributes(tag);
    if (/^<(?:video|source)\b/i.test(tag)) {
      if (attr.type && !/video|mpegurl/i.test(attr.type)) continue;
      addMedia(attr.src || attr['data-src'], true);
    } else if (/^<iframe\b/i.test(tag)) {
      addPage(attr.src || attr['data-src'] || attr['data-lazy-src']);
    } else if (/^<link\b/i.test(tag) && /^(?:amphtml|canonical)$/i.test(attr.rel || '')) {
      addPage(attr.href);
    } else if (/^<meta\b/i.test(tag)) {
      const key = (attr.property || attr.name || '').toLowerCase();
      if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
        addMedia(attr.content, true);
        if (!MEDIA_EXT.test(attr.content || '')) addPage(attr.content);
      } else if (key === 'twitter:player') addPage(attr.content);
    }
  }
  // Lazy media attributes and declarative player/JSON-LD configuration.
  for (const match of html.matchAll(/\bdata-(?:video|file|mp4|hls|stream)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) addMedia(match[1] || match[2], true);
  for (const match of html.matchAll(/(?:["']?\b(?:contentUrl|content_url|videoUrl|video_url|videoSource|video_source|playUrl|play_url|streamUrl|stream_url|file|src|hls|mp4)["']?)\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi)) addMedia(match[1] || match[2]);
  for (const match of html.matchAll(/["']?\bembedUrl["']?\s*:\s*["']([^"']+)["']/gi)) addPage(match[1]);
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+\.(?:mp4|webm|m4v|mov|m3u8)(?:\?[^"'<>\s]*)?/gi)) addMedia(match[0]);
  return { media: [...media].slice(0, 24), pages: [...pages].slice(0, 8) };
}

export function mediaResponseType(contentType, url, prefix = '') {
  const type = String(contentType || '').toLowerCase();
  // An HTML error/login page must never become a video because of its filename.
  if (/html|json|image\//.test(type) || /^\s*(?:<!doctype|<html)/i.test(prefix)) return null;
  if (/mpegurl/.test(type) || /^\s*#EXTM3U\b/.test(prefix)) return 'hls';
  if (type.startsWith('video/')) return 'video';
  if (!type || /octet-stream|text\/plain/.test(type)) {
    if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
    if (/\.(mp4|webm|m4v|mov)(?:$|[?#])/i.test(url) || /^.{4}ftyp/s.test(prefix)) return 'video';
  }
  return null;
}

export function selectExtractorSource(output, rawUrl) {
  const info = Array.isArray(output?.entries) ? output.entries.find(Boolean) : output;
  if (!info || typeof info !== 'object') throw new Error('SITE_EXTRACTOR_EMPTY_RESULT');
  if (info.has_drm) throw new Error('VIDEO_DRM_PROTECTED');
  const formats = [...(Array.isArray(info.formats) ? info.formats : [])]
    .sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
  const candidates = [...(info.requested_formats?.length > 1 ? [] : [info]), ...formats];
  const selected = candidates.find(item => item && !item.has_drm &&
    item.vcodec !== 'none' && item.acodec !== 'none' &&
    /^https?:\/\//i.test(item.url || '') &&
    !/dash|http_dash_segments/i.test(item.protocol || '') && !/\.mpd(?:$|[?#])/i.test(item.url));
  if (!selected) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
  const headers = Object.fromEntries(Object.entries({ ...info.http_headers, ...selected.http_headers })
    .map(([key, value]) => [key.toLowerCase(), String(value).replace(/[\r\n]/g, '')]));
  const sourceUrl = decodeMediaUrl(selected.url, rawUrl);
  if (!sourceUrl) throw new Error('VIDEO_FORMAT_UNSUPPORTED');
  return {
    sourceUrl,
    pageUrl: decodeMediaUrl(headers.referer || info.webpage_url, rawUrl) || rawUrl,
    type: /m3u8|hls/i.test(selected.protocol || '') || /\.m3u8(?:$|[?#])/i.test(sourceUrl) ? 'hls' : 'video',
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
  if (/\b404\b|\b410\b/.test(value)) return { reason: 'VIDEO_PAGE_NOT_FOUND', message: 'Video sayfası bulunamadı veya bağlantının süresi doldu.' };
  if (/timeout|timed.out|aborted/i.test(value)) return { reason: 'VIDEO_RESOLUTION_TIMEOUT', message: 'Kaynak site zamanında yanıt vermedi. Bağlantıyı yeniden deneyebilirsin.' };
  if (/VIDEO_FORMAT_UNSUPPORTED/.test(value)) return { reason: 'VIDEO_FORMAT_UNSUPPORTED', message: 'Video bulundu ancak sunulan akış bu oynatıcıya doğrudan aktarılamıyor. MP4, WebM veya HLS bağlantısı kullanabilirsin.' };
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
    return type ? { sourceUrl: fetched.finalUrl, type, contentType,
      cookie: sameOrigin(candidate, fetched.finalUrl) ? cookie : '' } : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally { await response?.body?.cancel().catch(() => {}); }
}

export async function resolveVideoPage(startUrl, { fetchPublicUrl, signal = AbortSignal.timeout(25000) } = {}) {
  const queue = [{ url: startUrl, depth: 0, referer: startUrl, cookie: '' }];
  const visited = new Set();
  const probed = new Set();
  const errors = [];
  while (queue.length && visited.size < 8) {
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
      if (type) return { sourceUrl: finalUrl, pageUrl: page.referer, type, cookie, contentType };
      const html = await readLimited(response, 2 * 1024 * 1024);
      type = mediaResponseType(contentType, finalUrl, html.slice(0, 2048));
      if (type) return { sourceUrl: finalUrl, pageUrl: page.referer, type, cookie, contentType };
      const found = discoverVideoSources(html, finalUrl);
      const candidates = found.media.filter(url => !probed.has(url)).slice(0, Math.max(0, 24 - probed.size));
      for (let i = 0; i < candidates.length; i += 3) {
        const batch = candidates.slice(i, i + 3);
        batch.forEach(url => probed.add(url));
        const results = await Promise.all(batch.map(url => probeVideoSource(url, finalUrl, {
          fetchPublicUrl, signal, cookie: sameOrigin(url, finalUrl) ? cookie : ''
        })));
        const match = results.find(Boolean);
        if (match) return { ...match, pageUrl: finalUrl };
      }
      if (page.depth < 2) {
        for (const url of found.pages) {
          queue.push({ url, depth: page.depth + 1, referer: finalUrl, cookie: sameOrigin(url, finalUrl) ? cookie : '' });
        }
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
