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
  limits: { fileSize: 100 * 1024 * 1024 }
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
