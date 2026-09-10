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
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });

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
