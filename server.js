import { GoogleGenAI } from "@google/genai";
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const EXTERNAL_ANALYSIS_URL = (process.env.EXTERNAL_ANALYSIS_URL || 'https://source-video-analysis.onrender.com').replace(/\/$/, '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readJsonSafe(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

app.get('/api/external-health', async (_req, res) => {
  const startedAt = Date.now();
  try {
    const upstream = await fetch(`${EXTERNAL_ANALYSIS_URL}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(65000)
    });
    const body = await readJsonSafe(upstream);
    res.status(upstream.ok ? 200 : 502).json({
      connected: upstream.ok && body?.status === 'ok',
      upstreamStatus: upstream.status,
      latencyMs: Date.now() - startedAt,
      endpoint: EXTERNAL_ANALYSIS_URL,
      body
    });
  } catch (error) {
    res.status(503).json({
      connected: false,
      endpoint: EXTERNAL_ANALYSIS_URL,
      latencyMs: Date.now() - startedAt,
      error: error?.message || String(error)
    });
  }
});

app.get('/api/external-capabilities', async (_req, res) => {
  try {
    const upstream = await fetch(`${EXTERNAL_ANALYSIS_URL}/capabilities`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(65000)
    });
    const body = await readJsonSafe(upstream);
    res.status(upstream.status).json(body ?? {});
  } catch (error) {
    res.status(503).json({ available: false, reason: 'UPSTREAM_UNAVAILABLE', error: error?.message || String(error) });
  }
});


const storyboardUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 20,
    fields: 10
  }
});

app.post('/api/gemini-storyboard-analyze', storyboardUpload.array('storyboards', 20), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        available: false,
        reason: 'GEMINI_NOT_CONFIGURED',
        message: 'Gemini API anahtarı yapılandırılmamış.'
      });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({
        available: false,
        reason: 'STORYBOARD_REQUIRED',
        message: 'Analiz için storyboard görselleri gerekli.'
      });
    }

    const duration = Math.max(0, Number(req.body?.duration || 0));
    const timestamps = String(req.body?.timestamps || '[]');

    const prompt = `
SOURCE VIDEO IS THE SINGLE SOURCE OF TRUTH.

You receive chronological contact-sheet images sampled from one local video.
Each tile contains its source timestamp. Analyze only directly visible evidence.
Never invent people, actions, dialogue, objects, contact, movement or outcomes.

Identify the recurring male protagonist. Describe only his directly visible
actions in chronological order. Create a new action when visible movement,
tempo, direction, posture, body orientation, contact point, interaction or
scene changes. Never invent alternatives.

Video duration: ${duration} seconds
Timestamp metadata: ${timestamps}

Return ONLY valid JSON with this exact shape:
{
  "available": true,
  "videoDuration": number,
  "videoPrompt": "concise chronological Turkish scenario",
  "actions": [
    {
      "actionId": "tl-001",
      "label": "short Turkish imperative",
      "startTime": number,
      "endTime": number,
      "choiceKey": "stable-semantic-key",
      "movementType": "string",
      "movementVariant": "string",
      "movementTempo": "still|slow|moderate|fast|changing|unclear",
      "bodyPart": "string",
      "direction": "string",
      "posture": "string",
      "contactPoint": "string",
      "interaction": "string",
      "sourceVerified": true,
      "confidence": number
    }
  ],
  "warnings": []
}

Rules:
- timestamps must be within 0 and ${duration}
- startTime must be smaller than endTime
- no overlaps, duplicates or invented actions
- sort actions chronologically
- if evidence is insufficient, omit the action
- Turkish labels must be short and directly describe the male action
`;

    const parts = [
      { text: prompt },
      ...files.map((file) => ({
        inlineData: {
          mimeType: file.mimetype || 'image/jpeg',
          data: file.buffer.toString('base64')
        }
      }))
    ];

    const ai = new GoogleGenAI({ apiKey });
  let response;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.1 }
      });
      break;
    } catch (error) {
      const details = String(error?.message || error);
      const retryable = details.includes("503") || details.includes("UNAVAILABLE") || details.includes("high demand");
      if (!retryable || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 5000));
    }
  }

    const raw = String(response.text || '').trim();
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, ''));

    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map((action, index) => ({
        ...action,
        actionId: String(action.actionId || `tl-${String(index + 1).padStart(3, '0')}`),
        label: String(action.label || '').trim(),
        startTime: Number(action.startTime),
        endTime: Number(action.endTime),
        sourceVerified: action.sourceVerified === true,
        confidence: Number(action.confidence || 0)
      }))
      .filter((action) =>
        action.label &&
        action.sourceVerified &&
        Number.isFinite(action.startTime) &&
        Number.isFinite(action.endTime) &&
        action.startTime >= 0 &&
        action.endTime > action.startTime &&
        (!duration || action.endTime <= duration + 0.5)
      )
      .sort((a, b) => a.startTime - b.startTime)
      .filter((action, index, list) =>
        index === 0 || action.startTime >= list[index - 1].endTime
      );

    return res.json({
      available: true,
      videoDuration: duration || Number(parsed.videoDuration || 0),
      videoPrompt: String(parsed.videoPrompt || ''),
      actions,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    });
  } catch (error) {
    console.error('[gemini-storyboard-error]', error);
    return res.status(502).json({
      available: false,
      reason: 'GEMINI_STORYBOARD_ERROR',
      message: 'Storyboard analizi sırasında hata oluştu.',
      error: error?.message || String(error)
    });
  }
});

app.post('/api/external-analyze', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ available: false, reason: 'VIDEO_REQUIRED' });
  }

  try {
    const form = new FormData();
    form.append('video', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname || 'video.mp4');

    const upstream = await fetch(`${EXTERNAL_ANALYSIS_URL}/analyze`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(900000)
    });

    const body = await readJsonSafe(upstream);
    return res.status(upstream.status).json(body ?? {});
  } catch (error) {
    return res.status(503).json({
      available: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      error: error?.message || String(error)
    });
  }
});

app.post('/api/external-analyze-segment', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ available: false, reason: 'VIDEO_REQUIRED' });
  }

  try {
    const form = new FormData();
    form.append('video', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname || 'segment.mp4');
    if (req.body?.startTime) form.append('startTime', String(req.body.startTime));
    if (req.body?.endTime) form.append('endTime', String(req.body.endTime));

    const upstream = await fetch(`${EXTERNAL_ANALYSIS_URL}/analyze-segment`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(900000)
    });
    const body = await readJsonSafe(upstream);
    return res.status(upstream.status).json(body ?? {});
  } catch (error) {
    return res.status(503).json({ available: false, reason: 'UPSTREAM_UNAVAILABLE', error: error?.message || String(error) });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      available: false,
      reason: 'VIDEO_TOO_LARGE',
      message: 'Video 250 MB yükleme sınırını aşıyor.'
    });
  }

  return next(error);
});


// PUBLIC VIDEO URL RESOLVER
function normalizeAmpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname.endsWith('.cdn.ampproject.org')) {
    const secure = url.pathname.match(/^\/c\/s\/(.+)$/);
    const plain = url.pathname.match(/^\/c\/(.+)$/);
    if (secure) return `https://${secure[1]}${url.search}`;
    if (plain) return `http://${plain[1]}${url.search}`;
  }
  return url.href;
}

function isPrivateAddress(address) {
  const value = String(address).toLowerCase();
  return value === '::1' ||
    value === '0.0.0.0' ||
    value.startsWith('10.') ||
    value.startsWith('127.') ||
    value.startsWith('169.254.') ||
    value.startsWith('192.168.') ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

async function validatePublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Yalnızca HTTP veya HTTPS adresleri desteklenir.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Yerel ağ adresleri kullanılamaz.');
  }

  const dns = await import('node:dns/promises');
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length || records.some(record => isPrivateAddress(record.address))) {
    throw new Error('Bu ağ adresine erişim engellendi.');
  }

  return url;
}

async function fetchPublicUrl(rawUrl, options = {}) {
  let current = normalizeAmpUrl(rawUrl);

  for (let redirect = 0; redirect < 5; redirect++) {
    await validatePublicUrl(current);
    const response = await fetch(current, {
      ...options,
      redirect: 'manual',
      signal: options.timeoutMs === 0 ? undefined : AbortSignal.timeout(options.timeoutMs || 25000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': '*/*',
        ...(options.headers || {})
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Yönlendirme adresi bulunamadı.');
      current = new URL(location, current).href;
      continue;
    }

    return { response, finalUrl: current };
  }

  throw new Error('Çok fazla yönlendirme yapıldı.');
}

function decodeMediaUrl(value, baseUrl) {
  if (!value) return null;

  const decoded = String(value)
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;|&#038;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .trim();

  try {
    return new URL(decoded, baseUrl).href;
  } catch {
    return null;
  }
}

function findVideoCandidates(html, baseUrl) {
  const candidates = [];
  const add = value => {
    const resolved = decodeMediaUrl(value, baseUrl);
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  };

  for (const match of html.matchAll(/<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) add(match[1]);
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<> ]+\.(?:mp4|webm|m4v|mov|m3u8)(?:\?[^"'<> ]*)?/gi)) add(match[0]);

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    if (content && ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
      add(content);
    }
  }

  return candidates;
}

app.post('/api/resolve-video-url', async (req, res) => {
  try {
    const requestedUrl = String(req.body?.url || '').trim();
    if (!requestedUrl) {
      return res.status(400).json({ ok: false, reason: 'URL_REQUIRED', message: 'Video sayfası URL’si gerekli.' });
    }

    const normalizedUrl = normalizeAmpUrl(requestedUrl);
    const pathname = new URL(normalizedUrl).pathname.toLowerCase();

    if (/\.(mp4|webm|m4v|mov|m3u8)$/.test(pathname)) {
      await validatePublicUrl(normalizedUrl);
      return res.json({
        ok: true,
        type: pathname.endsWith('.m3u8') ? 'hls' : 'video',
        sourceUrl: normalizedUrl,
        proxyUrl: `/api/video-proxy?url=${encodeURIComponent(normalizedUrl)}`
      });
    }

    const { response, finalUrl } = await fetchPublicUrl(normalizedUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml,video/*;q=0.8' }
    });

    if (!response.ok) {
      throw new Error(`Sayfa ${response.status} yanıtı verdi.`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.startsWith('video/')) {
      return res.json({
        ok: true,
        type: 'video',
        sourceUrl: finalUrl,
        proxyUrl: `/api/video-proxy?url=${encodeURIComponent(finalUrl)}`
      });
    }

    const html = (await response.text()).slice(0, 3000000);
    const candidates = findVideoCandidates(html, finalUrl);
    const sourceUrl = candidates.find(url => /\.(mp4|webm|m4v|mov|m3u8)(?:$|\?)/i.test(url));

    if (!sourceUrl) {
      return res.status(422).json({
        ok: false,
        reason: 'VIDEO_SOURCE_HIDDEN',
        message: 'Bu sayfa video kaynağını gizliyor veya özel oynatıcı kullanıyor.'
      });
    }

    res.json({
      ok: true,
      type: /\.m3u8(?:$|\?)/i.test(sourceUrl) ? 'hls' : 'video',
      sourceUrl,
      pageUrl: finalUrl,
      proxyUrl: `/api/video-proxy?url=${encodeURIComponent(sourceUrl)}&referer=${encodeURIComponent(finalUrl)}`
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      reason: 'URL_RESOLVE_ERROR',
      message: error?.message || 'Video sayfası çözümlenemedi.'
    });
  }
});

app.get('/api/video-proxy', async (req, res) => {
  try {
    const sourceUrl = String(req.query.url || '');
    const referer = String(req.query.referer || '');
    if (!sourceUrl) return res.status(400).json({ ok: false, message: 'Video URL’si gerekli.' });

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (referer) {
      await validatePublicUrl(referer);
      headers.Referer = referer;
    }

    const { response } = await fetchPublicUrl(sourceUrl, { headers, timeoutMs: 0 });
    if (!response.ok && response.status !== 206) {
      return res.status(response.status).json({ ok: false, message: `Video sunucusu ${response.status} yanıtı verdi.` });
    }

    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    res.status(response.status);
    const { Readable } = await import('node:stream');
    const stream = Readable.fromWeb(response.body);
    stream.on('error', error => {
      console.error('Video proxy stream error:', error?.message || error);
      if (!res.destroyed) res.destroy(error);
    });
    req.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    res.status(502).json({ ok: false, reason: 'VIDEO_PROXY_ERROR', message: error?.message || 'Video aktarılamadı.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'source-video-interactive-app' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Source Video Interactive listening on ${PORT}`);
  console.log(`External analysis endpoint: ${EXTERNAL_ANALYSIS_URL}`);
});
