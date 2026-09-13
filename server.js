import { GoogleGenAI } from "@google/genai";
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';

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
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const APP_PASSWORD = String(process.env.APP_PASSWORD || '');
const AUTH_COOKIE = 'videoquest_owner';
const AUTH_MAX_AGE = 60 * 60 * 24 * 30;
const loginAttempts = new Map();

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function expectedAuthToken() {
  return crypto
    .createHmac('sha256', APP_PASSWORD)
    .update('videoquest-owner-session-v1')
    .digest('hex');
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return false;
  return secureEqual(readCookie(req, AUTH_COOKIE), expectedAuthToken());
}

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  const failed = req.query.error === '1';
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#05070b">
  <title>VIDEOQUEST AI · Özel Giriş</title>
  <style>
    *{box-sizing:border-box}html{color-scheme:dark}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:22px;color:#f7fbff;background:radial-gradient(circle at 15% 0,rgba(34,230,168,.18),transparent 34rem),#05070b;font-family:Inter,system-ui,sans-serif}
    .card{width:min(100%,430px);padding:30px 24px;border:1px solid rgba(255,255,255,.12);border-radius:26px;background:rgba(15,21,30,.92);box-shadow:0 28px 80px rgba(0,0,0,.52)}
    .mark{width:58px;height:58px;display:grid;place-items:center;margin-bottom:22px;border-radius:18px;color:#03130e;background:linear-gradient(135deg,#22e6a8,#56ffd0);font-size:25px;font-weight:900}
    .eyebrow{color:#22e6a8;font-size:12px;font-weight:900;letter-spacing:.16em}h1{margin:8px 0 10px;font-size:32px;letter-spacing:-.05em}p{margin:0 0 22px;color:#9eabba}
    input{width:100%;height:56px;padding:0 16px;border:1px solid rgba(255,255,255,.14);border-radius:16px;color:#fff;background:#080c12;font-size:17px;outline:none}
    input:focus{border-color:#22e6a8;box-shadow:0 0 0 4px rgba(34,230,168,.12)}
    button{width:100%;height:56px;margin-top:13px;border:0;border-radius:16px;color:#03130e;background:linear-gradient(135deg,#22e6a8,#56ffd0);font-size:17px;font-weight:900}
    .error{margin:0 0 14px;padding:11px 13px;border:1px solid rgba(255,85,105,.3);border-radius:13px;color:#ffb6c0;background:rgba(255,68,92,.09)}
    .private{margin-top:18px;color:#6f7d8e;font-size:12px;text-align:center}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">VQ</div>
    <div class="eyebrow">PRIVATE ACCESS</div>
    <h1>VIDEOQUEST AI</h1>
    <p>Kişisel çalışma alanına devam etmek için parolanı gir.</p>
    ${failed ? '<div class="error">Parola yanlış. Tekrar deneyebilirsin.</div>' : ''}
    <form method="post" action="/login">
      <input name="password" type="password" autocomplete="current-password" placeholder="Kişisel parola" required autofocus>
      <button type="submit">Güvenli giriş yap</button>
    </form>
    <div class="private">Şifreli bağlantı · Yalnızca yetkili kullanıcı</div>
  </main>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (!APP_PASSWORD) return res.status(503).send('APP_PASSWORD yapılandırılmamış.');
  const key = req.ip || 'unknown';
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);

  if (recent.length >= 5) {
    loginAttempts.set(key, recent);
    return res.status(429).send('Çok fazla deneme. 15 dakika sonra tekrar dene.');
  }

  if (!secureEqual(req.body?.password || '', APP_PASSWORD)) {
    recent.push(now);
    loginAttempts.set(key, recent);
    return res.redirect('/login?error=1');
  }

  loginAttempts.delete(key);
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${expectedAuthToken()}; Max-Age=${AUTH_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Strict`
  );
  return res.redirect('/');
});

app.post('/logout', (_req, res) => {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`
  );
  res.redirect('/login');
});

app.use((req, res, next) => {
  // Render ve uptime kontrolleri parola oturumu taşımaz.
  if (req.path === '/health') return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      available: false,
      reason: 'AUTH_REQUIRED',
      message: 'Bu işlem için giriş gerekli.'
    });
  }
  return res.redirect('/login');
});

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
    const motionProfile = String(req.body?.motionProfile || '[]');
    const chunkStart = Math.max(0, Number(req.body?.chunkStart || 0));
    const chunkEnd = Math.min(
      duration,
      Math.max(chunkStart, Number(req.body?.chunkEnd || duration))
    );
    const chunkIndex = Math.max(0, Number(req.body?.chunkIndex || 0));
    const chunkCount = Math.max(1, Number(req.body?.chunkCount || 1));
  const protagonistProfile = String(
    req.body?.protagonistProfile || ''
  ).trim();
  const dialogueContext = String(req.body?.dialogueContext || '[]');
  const qualityMode = String(req.body?.qualityMode || 'ultra');
  const chunkDuration = Math.max(1, chunkEnd - chunkStart);
  const targetActionCount = Math.max(
    5,
    Math.min(16, Math.round(chunkDuration / 12))
  );

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
Timestamp metadata for this chunk: ${timestamps}
Local visual-change profile for this chunk: ${motionProfile}
Current analysis chunk: ${chunkIndex + 1} of ${chunkCount}

DIALOGUE AND SCENE CONTEXT:
Quality mode: ${qualityMode}
Time-aligned dialogue segments:
${dialogueContext}

- Use dialogue only when its timestamp overlaps the visible scene.
- Use verified spoken meaning to improve scene understanding and Turkish choice wording.
- Dialogue never overrides contradictory visual evidence.
- Never invent speech, responses or outcomes.
- Connect dialogue choices only to matching visible MAIN_MALE actions.

PROTAGONIST IDENTITY LOCK:
Current locked profile:
${protagonistProfile || 'NOT_LOCKED. In this chunk, identify one clearly visible adult male with the strongest narrative continuity and label him MAIN_MALE.'}

- Select exactly one adult male as MAIN_MALE.
- If a locked profile exists, preserve that same identity across clothing, pose, distance and camera-angle changes.
- Distinguish all other males as OTHER_MALE and never convert their actions into player choices.
- Use face, hair, facial hair, skin tone, body build, clothing, accessories, position and scene continuity together.
- Never switch MAIN_MALE merely because another male becomes larger or more central in the frame.
- If identity is uncertain, omit the action instead of assigning another male's action to MAIN_MALE.
- Return a short stable protagonistProfile describing MAIN_MALE with persistent visible identity anchors.
- Every returned action must belong to MAIN_MALE or to the male-POV camera controlled by MAIN_MALE.
Analyze ONLY the interval ${chunkStart} to ${chunkEnd} seconds.

CHUNK RULES:
- Return actions only when startTime and endTime are inside this chunk.
- Examine this short interval deeply instead of summarizing the whole video.
- Prefer atomic visible actions and meaningful changes over broad multi-minute descriptions.
- A MAIN action marks a major scene, position, location, or interaction change.
- BONUS actions capture visible tempo, touch, clothing, posture, body, or camera changes inside the scene.
- Consecutive atomic actions may touch at their boundaries.
- MAIN and BONUS evidence may belong to the same scene, but every returned action must have its own playable time segment.
- ADULT SCENE CHOICES: When a clearly consensual sexual interaction between visible adults is actually shown, write the label field in explicit, direct and natural Turkish, naming that exact verified sexual action without euphemism.
- Name the visibly verified roles, position, contact, direction and tempo when they distinguish one real action from another.
- Do not censor, soften, euphemize or replace verified adult actions with vague labels such as "devam et", "yakınlaş", "pozisyonu değiştir" or "hareketi sürdür".
- Each adult choice must distinguish a genuinely different playable action or variation that exists inside this chunk and must seek to its exact startTime.
- Never invent an adult action, body contact, position, participant, consent, intensity or outcome that is not clearly visible in the source video.
- If adulthood or the visible action is uncertain, keep the description neutral and limited to the clearly observable movement.
- For chunks after the first one, introEndTime and playStartTime must equal chunkStart.
- Never create filler merely to reach a target count.

TWO-LEVEL DEEP ANALYSIS:
- MAIN actions are real scene, position, body-arrangement or major interaction changes.
- BONUS actions are meaningful visible changes inside the same main scene: pace/rhythm change, acceleration, slowing, pause, kiss, touch, hand placement, posture, body transition, clothing removal or another clearly visible male action.
- Do not represent a several-minute scene with one broad action when meaningful changes occur inside it.
- Keep the same sceneId for BONUS actions until a new MAIN action begins.
- Target ${targetActionCount} distinct, visible MAIN_MALE actions in this chunk when evidence supports them.
- Prefer approximately one meaningful action every 8-18 seconds.
- Split long continuous scenes whenever pose, direction, contact, position, tempo, partner interaction or camera relationship visibly changes.
- Do not invent actions merely to reach the target.
- Actions must be chronological, forward-moving and non-overlapping.

INTRO:
- Detect logos, title cards, advertisements, previews, static openings and other non-story material.
- introEndTime is the first real main scene.
- Create no action before introEndTime.
- playStartTime must equal introEndTime.

CAMERA:
- third_person: male protagonist is externally visible.
- male_pov: viewpoint is reliably from the male protagonist.
- mixed: visible transition between both.
- uncertain: insufficient evidence.
- Do not discard male POV merely because his full body is absent. Use visible hands, arms, camera movement, body position and continuity.
- Never infer an invisible action without evidence.

Return ONLY valid JSON with this exact shape:
{
  "available": true,
  "videoDuration": number,
  "introEndTime": number,
  "playStartTime": number,
"protagonistProfile": "stable visible identity description of MAIN_MALE",
  "videoPrompt": "concise chronological Turkish scenario",
  "actions": [
    {
      "actionId": "tl-001",
      "sceneId": "scene-001",
      "actionLevel": "main|bonus",
      "actionType": "position|tempo_change|kiss|touch|clothing|body_transition|camera_transition|outcome|aftermath|other",
      "adultScene": false,
      "adultSceneId": "",
      "adultSceneStartTime": 0,
      "adultSceneEndTime": 0,
      "postSceneTime": 0,
      "positionId": "",
      "positionOccurrenceId": "",
      "activityType": "oral|manual|vaginal|anal|other",
      "positionLabel": "",
      "positionStartTime": 0,
      "positionEndTime": 0,
      "movementType": "",
      "loopStartTime": 0,
      "loopEndTime": 0,
      "maleProgressRate": 1,
      "femaleProgressRate": 1,
      "outcomeType": "none|climax|aftermath",
      "outcomeLabel": "",
      "outcomeStartTime": 0,
      "outcomeEndTime": 0,
      "outcomeUnlockProgress": 82,
      "cameraMode": "third_person|male_pov|mixed|uncertain",
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
- no duplicate or invented actions; return separate chronological atomic segments
- sort actions chronologically
- if evidence is insufficient, omit the action
- no action may begin before introEndTime
- playStartTime must equal introEndTime
- MAIN and BONUS actions must reflect visible evidence
- Turkish labels must be short and directly describe the male action
- Detect every verified adult scene boundary and mark adultScene true only inside that real scene.
- Set one stable adultSceneId for every action belonging to the same adult scene.
- Detect a position only when the source visibly shows a stable adult-act body configuration sustained over time; then use actionType "position".
- Never classify undressing, dressing, walking, approaching, preparation, conversation, camera changes, pauses or generic standing/sitting as positions.
- Foreplay and non-position actions may remain chronological main/bonus actions, but must not receive a positionId or appear in position tabs.
- Merge duplicate detections only when they describe the same continuous occurrence and their time ranges overlap; never bridge separate appearances of the same position into one long range.
- Give every verified position a stable positionId, exact Turkish positionLabel, positionStartTime and positionEndTime.
- Keep positionId as the canonical semantic position family. Give each uninterrupted occurrence of that family a stable positionOccurrenceId; if the same position returns later after another position, transition, cut, or real time gap, it must have a different positionOccurrenceId.
- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.
- Verify every position and internal movement against its exact start frame, midpoint frame and end frame from the source video.
- The Turkish label must directly describe what is visibly happening at the midpoint timestamp; if the midpoint does not visibly prove that label, omit the item.
- All returned times are absolute source-video seconds, never scene-relative or chunk-relative seconds.
- Never attach a label detected in one part of the video to an earlier or later segment.
- Position and movement choices must seek to their own verified visible segment, not merely to the parent adult-scene start.
- When evidence conflicts between sampled frames, prefer omission and add a warning instead of guessing.
- Inside each position, detect every meaningful real change in tempo, movement, body angle, pause, intensity, emotion or interaction.
- Use canonical positionId values consistently: oral, manual, missionary, cowgirl, spoon, standing-rear, rear, standing, or other-stable-N.
- Two labels describing the same visible body configuration must reuse one canonical positionId; wording, tempo, camera angle, or minor pose variation must never create another position.
- Oral activity, manual activity, undressing, and transitions are separate position families and must never appear beneath missionary, rear, standing-rear, cowgirl, spoon, or another penetrative position.
- A movement may belong to a position only when its entire loopStartTime-loopEndTime interval is visibly contained inside that exact positionStartTime-positionEndTime range.
- Reject any position or movement when the claimed body configuration is not visibly present at its start, midpoint, and end timestamps.
- Every internal change must reuse its parent positionId and have a concise movementType and Turkish label.
- Do not force a fixed number of internal changes. Return exactly as many distinct changes as the source visibly contains.
- Do not split tiny repetitions into fake choices and do not merge genuinely different changes.
- loopStartTime and loopEndTime must define a naturally repeatable real interval inside the action and position.
- A position and every selectable movement loop must each be at least 10.0 seconds long; omit anything shorter. It may be extended only across visibly continuous footage of the same movement and position; otherwise omit that internal choice.
- Never return one-frame, frozen-frame, transition, cut, camera-change or seek-unstable loops.
- adultSceneStartTime and adultSceneEndTime must cover the real scene; postSceneTime must point to its first real continuation.
- maleProgressRate and femaleProgressRate are game pacing weights from 0.25 to 2.5 based on visible motion intensity and duration.
- When the source visibly contains a real climax/final segment inside the adult scene, emit it as actionType "outcome", outcomeType "climax", with exact outcomeStartTime/outcomeEndTime and a short outcomeLabel. Do not assign positionId to an outcome.
- When the source visibly contains a distinct post-final continuation inside the same adult scene, emit it as actionType "aftermath", outcomeType "aftermath", with exact outcomeStartTime/outcomeEndTime. Do not convert aftermath into a position or movement loop.
- outcomeUnlockProgress is a gameplay hint only; use 82 by default and never use it to invent or extend footage. If no verified outcome or aftermath exists, keep outcomeType "none" and do not fabricate one.
- Outcome and aftermath boundaries must be directly source-verified and must never overlap a selectable movement loop.
- Never invent any position, movement, transition, outcome or label absent from the source frames.
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
    const resolvedDuration = Math.max(0, duration || Number(parsed.videoDuration || 0));
    const introEndTime = Math.min(
      resolvedDuration,
      Math.max(0, Number(parsed.introEndTime ?? parsed.playStartTime ?? 0))
    );

    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map((action, index) => ({
        ...action,
        actionId: String(action.actionId || `tl-${String(index + 1).padStart(3, '0')}`),
        sceneId: String(action.sceneId || `scene-${String(index + 1).padStart(3, '0')}`),
        actionLevel: action.actionLevel === 'bonus' ? 'bonus' : 'main',
        actionType: String(action.actionType || 'other'),
          adultScene: Boolean(action.adultScene),
          adultSceneId: String(action.adultSceneId || ''),
          adultSceneStartTime: Number(action.adultSceneStartTime ?? action.startTime),
          adultSceneEndTime: Number(action.adultSceneEndTime ?? action.endTime),
          postSceneTime: Number(action.postSceneTime ?? action.adultSceneEndTime ?? action.endTime),
          positionId: String(action.positionId || ''),
          positionOccurrenceId: String(action.positionOccurrenceId || ''),
          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(
            String(action.activityType || '').toLowerCase()
          )
            ? String(action.activityType).toLowerCase()
            : 'other',
          positionLabel: String(action.positionLabel || ''),
          positionStartTime: Number(action.positionStartTime ?? action.startTime),
          positionEndTime: Number(action.positionEndTime ?? action.endTime),
          movementType: String(action.movementType || action.actionType || ''),
          loopStartTime: Number(action.loopStartTime ?? action.startTime),
          loopEndTime: Number(action.loopEndTime ?? action.endTime),
          maleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.maleProgressRate) || 1)),
          femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.femaleProgressRate) || 1)),
          outcomeType: ['climax', 'aftermath'].includes(String(action.outcomeType || '').toLowerCase())
            ? String(action.outcomeType).toLowerCase()
            : 'none',
          outcomeLabel: String(action.outcomeLabel || ''),
          outcomeStartTime: Number(action.outcomeStartTime ?? action.startTime),
          outcomeEndTime: Number(action.outcomeEndTime ?? action.endTime),
          outcomeUnlockProgress: Math.min(100, Math.max(60, Number(action.outcomeUnlockProgress) || 82)),
        cameraMode: ['third_person', 'male_pov', 'mixed', 'uncertain'].includes(action.cameraMode)
          ? action.cameraMode
          : 'uncertain',
        label: String(action.label || '').trim(),
        startTime: Number(action.startTime),
        endTime: Number(action.endTime),
        sourceVerified: action.sourceVerified !== false,
        sourceStart: Number(action.sourceStart ?? action.startTime),
        sourceEnd: Number(action.sourceEnd ?? action.endTime),
        confidence: Number(action.confidence || 0)
      }))
      .filter((action) =>
        action.label &&
        action.startTime + 0.05 >= introEndTime &&
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
      videoDuration: resolvedDuration,
      introEndTime,
      playStartTime: introEndTime,
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
    res.on('close', () => {
      if (!res.writableEnded && !stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    res.status(502).json({ ok: false, reason: 'VIDEO_PROXY_ERROR', message: error?.message || 'Video aktarılamadı.' });
  }
});


const dialogueUpload = multer({
  dest: '/tmp/videoquest-dialogue',
  limits: {
    fileSize: 600 * 1024 * 1024,
    files: 1,
    fields: 5
  },
  fileFilter: (_req, file, callback) => {
    const allowed = /^video\/(mp4|quicktime|webm|x-m4v)$/i.test(file.mimetype);
    callback(allowed ? null : new Error('UNSUPPORTED_VIDEO_FORMAT'), allowed);
  }
});

const dialogueUploadSessions = new Map();
const dialogueChunkParser = express.raw({
  type: 'application/octet-stream',
  limit: '2mb'
});

app.post('/api/dialogue-upload/start', async (req, res) => {
  try {
    const totalSize = Number(req.body?.totalSize || 0);
    const fileName = String(req.body?.fileName || 'dialogue.wav')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const mimeType = String(req.body?.mimeType || 'audio/wav');

    if (
      !Number.isFinite(totalSize) ||
      totalSize <= 0 ||
      totalSize > 250 * 1024 * 1024
    ) {
      return res.status(400).json({
        available: false,
        reason: 'INVALID_AUDIO_SIZE',
        message: 'Ses dosyası boyutu geçersiz.'
      });
    }

    const uploadId = crypto.randomUUID();
    const filePath = `/tmp/videoquest-dialogue/${uploadId}.part`;

    await fs.promises.mkdir('/tmp/videoquest-dialogue', {
      recursive: true
    });
    await fs.promises.writeFile(filePath, Buffer.alloc(0));

    dialogueUploadSessions.set(uploadId, {
      filePath,
      fileName,
      mimeType,
      totalSize,
      receivedSize: 0,
      nextChunk: 0,
      updatedAt: Date.now()
    });

    return res.json({
      available: true,
      uploadId,
      receivedSize: 0,
      nextChunk: 0
    });
  } catch (error) {
    return res.status(500).json({
      available: false,
      reason: 'UPLOAD_START_FAILED',
      message: error.message || String(error)
    });
  }
});

app.post(
  '/api/dialogue-upload/:uploadId/chunk',
  dialogueChunkParser,
  async (req, res) => {
    const uploadId = String(req.params.uploadId || '');
    const session = dialogueUploadSessions.get(uploadId);

    if (!session) {
      return res.status(404).json({
        available: false,
        reason: 'UPLOAD_SESSION_NOT_FOUND'
      });
    }

    const chunkIndex = Number(req.headers['x-chunk-index']);

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return res.status(400).json({
        available: false,
        reason: 'INVALID_CHUNK_INDEX'
      });
    }

    if (chunkIndex < session.nextChunk) {
      return res.json({
        available: true,
        duplicate: true,
        receivedSize: session.receivedSize,
        nextChunk: session.nextChunk
      });
    }

    if (chunkIndex !== session.nextChunk || !Buffer.isBuffer(req.body)) {
      return res.status(409).json({
        available: false,
        reason: 'CHUNK_ORDER_MISMATCH',
        receivedSize: session.receivedSize,
        nextChunk: session.nextChunk
      });
    }

    if (session.receivedSize + req.body.length > session.totalSize) {
      return res.status(400).json({
        available: false,
        reason: 'UPLOAD_SIZE_EXCEEDED'
      });
    }

    try {
      await fs.promises.appendFile(session.filePath, req.body);
      session.receivedSize += req.body.length;
      session.nextChunk += 1;
      session.updatedAt = Date.now();

      return res.json({
        available: true,
        receivedSize: session.receivedSize,
        nextChunk: session.nextChunk,
        complete: session.receivedSize === session.totalSize
      });
    } catch (error) {
      return res.status(500).json({
        available: false,
        reason: 'CHUNK_WRITE_FAILED',
        message: error.message || String(error)
      });
    }
  }
);

setInterval(() => {
  const expiry = Date.now() - 60 * 60 * 1000;

  for (const [uploadId, session] of dialogueUploadSessions) {
    if (session.updatedAt >= expiry) continue;

    dialogueUploadSessions.delete(uploadId);
    fs.promises.unlink(session.filePath).catch(() => {});
  }
}, 10 * 60 * 1000).unref();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.post(
  '/api/gemini-dialogue-analyze',
  dialogueUpload.single('video'),
  async (req, res) => {
    const uploadId = String(req.body?.uploadId || '');
    const uploadSession = dialogueUploadSessions.get(uploadId);

    if (!req.file && uploadSession) {
      if (uploadSession.receivedSize !== uploadSession.totalSize) {
        return res.status(409).json({
          available: false,
          reason: 'UPLOAD_INCOMPLETE',
          message: 'Ses yüklemesi henüz tamamlanmadı.'
        });
      }

      req.file = {
        path: uploadSession.filePath,
        originalname: uploadSession.fileName,
        mimetype: uploadSession.mimeType,
        size: uploadSession.totalSize
      };

      dialogueUploadSessions.delete(uploadId);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const tempPath = req.file?.path;
    let uploadedFile = null;

    try {
      if (!apiKey) {
        return res.status(503).json({
          available: false,
          reason: 'GEMINI_NOT_CONFIGURED',
          message: 'Gemini API anahtarı yapılandırılmamış.'
        });
      }

      if (!req.file || !tempPath) {
        return res.status(400).json({
          available: false,
          reason: 'VIDEO_REQUIRED',
          message: 'Diyalog analizi için video gerekli.'
        });
      }

      const ai = new GoogleGenAI({ apiKey });

      uploadedFile = await ai.files.upload({
        file: tempPath,
        config: {
          mimeType: req.file.mimetype,
          displayName: req.file.originalname || 'videoquest-dialogue-video'
        }
      });

      let remoteFile = uploadedFile;
      const processingDeadline = Date.now() + 20 * 60 * 1000;

      while (
        remoteFile?.state === 'PROCESSING' &&
        Date.now() < processingDeadline
      ) {
        await wait(4000);
        remoteFile = await ai.files.get({ name: remoteFile.name });
      }

      if (!remoteFile || remoteFile.state === 'FAILED') {
        throw new Error('GEMINI_VIDEO_PROCESSING_FAILED');
      }

      if (remoteFile.state === 'PROCESSING') {
        throw new Error('GEMINI_VIDEO_PROCESSING_TIMEOUT');
      }

      const prompt = `
Analyze only the audible dialogue and speech in this video.

LANGUAGE DETECTION AND TURKISH TRANSLATION:
- Automatically identify the actual spoken source language from the audio; never assume it is English.
- Support every detectable language and dialect, including multilingual conversations and speakers switching languages inside the same video.
- Treat clear non-English speech as valid dialogue, never as silence or unintelligible audio merely because of its language.
- Transcribe each clearly audible line faithfully in its original language into originalText.
- Translate every detected non-Turkish line into natural, complete Turkish in turkishText.
- If a line is already Turkish, preserve its meaning faithfully in turkishText without translating it into another language.
- Set sourceLanguage to the detected language name; use "multilingual" when multiple source languages are present.
- Preserve names, profanity, slang, sexual or adult vocabulary, commands, reactions, tone and intensity without censorship or omission in every supported language.
- Never skip a speaker or segment because the source language changes or is not English.

Return valid JSON only, with this exact structure:
{
  "available": true,
  "hasDialogue": true,
  "sourceLanguage": "string",
  "summaryTr": "short Turkish summary",
  "speakers": [
    {
      "speakerId": "speaker-01",
      "gender": "female|male|uncertain",
      "description": "short stable Turkish description"
    }
  ],
  "segments": [
    {
      "segmentId": "dlg-001",
      "startTime": 0.0,
      "endTime": 2.5,
      "speakerId": "speaker-01",
      "gender": "female|male|uncertain",
      "originalText": "exact spoken dialogue",
      "turkishText": "natural Turkish translation",
      "emotion": "neutral|happy|sad|angry|afraid|excited|whispering|uncertain",
      "confidence": 0.0
    }
  ],
  "warnings": []
}

Rules:
- Use seconds as numbers for startTime and endTime.
- Preserve chronological order.
- Identify and consistently separate different speakers.
- Detect speaker gender only from audible and visible evidence; otherwise use uncertain.
- Transcribe speech faithfully without inventing words.
- Transcribe and translate every clearly audible spoken word without censorship, sanitization, euphemism, summarization, or omission.
- Preserve profanity, slang, sexual or adult vocabulary, commands, reactions, and intensity exactly in natural Turkish.
- Never replace words with asterisks, softened expressions, generic summaries, or skipped segments.
- Treat every speaker equally and include every intelligible spoken line regardless of its subject.
- Preserve the meaning, tone and emotion of the original dialogue.
- Split long speech into readable subtitle segments, normally 1 to 7 seconds.
- Do not include music, breathing, moans, sound effects or silence as dialogue.
- If there is no intelligible speech, return hasDialogue false and an empty segments array.
- Never add dialogue that is not audible in the source video.
`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [{
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: remoteFile.uri,
                mimeType: remoteFile.mimeType || req.file.mimetype
              }
            },
            { text: prompt }
          ]
        }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const raw = String(response.text || '').trim();
      const parsed = JSON.parse(
        raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '')
      );

      const duration = Math.max(0, Number(req.body?.duration || 0));
      const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
        .map((segment, index) => ({
          segmentId: `dlg-${String(index + 1).padStart(3, '0')}`,
          startTime: Math.max(0, Number(segment.startTime || 0)),
          endTime: Math.max(0, Number(segment.endTime || 0)),
          speakerId: String(segment.speakerId || 'speaker-uncertain'),
          gender: ['female', 'male'].includes(segment.gender)
            ? segment.gender
            : 'uncertain',
          originalText: String(segment.originalText || '').trim(),
          turkishText: String(segment.turkishText || '').trim(),
          emotion: String(segment.emotion || 'uncertain'),
          confidence: Math.max(0, Math.min(1, Number(segment.confidence || 0)))
        }))
        .filter(segment =>
          segment.originalText &&
          segment.turkishText &&
          segment.endTime > segment.startTime &&
          (!duration || segment.startTime <= duration)
        )
        .sort((a, b) => a.startTime - b.startTime);

      return res.json({
        available: true,
        hasDialogue: segments.length > 0,
        sourceLanguage: String(parsed.sourceLanguage || 'unknown'),
        summaryTr: String(parsed.summaryTr || ''),
        speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
        segments,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
      });
    } catch (error) {
      console.error('Dialogue analysis failed:', error);
      return res.status(502).json({
        available: false,
        reason: 'GEMINI_DIALOGUE_ERROR',
        message: 'Video diyaloğu analiz edilirken hata oluştu.',
        error: error?.message || String(error)
      });
    } finally {
      if (tempPath) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (cleanupError) {
          console.error('Temporary dialogue video cleanup failed:', cleanupError);
        }
      }

      if (uploadedFile?.name && process.env.KEEP_GEMINI_FILES !== 'true') {
        try {
          const cleanupAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          await cleanupAi.files.delete({ name: uploadedFile.name });
        } catch (cleanupError) {
          console.error('Gemini file cleanup failed:', cleanupError);
        }
      }
    }
  }
);


function pcmBase64ToWavBase64(pcmBase64, sampleRate = 24000) {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const wav = Buffer.alloc(44 + pcm.length);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  return wav.toString('base64');
}


app.post('/api/gemini-dub-block', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ available: false, reason: 'GEMINI_NOT_CONFIGURED' });
    }

    const blockStart = Math.max(0, Number(req.body?.blockStart) || 0);
    const blockEnd = Math.max(blockStart + 1, Number(req.body?.blockEnd) || blockStart + 120);
    const segments = (Array.isArray(req.body?.segments) ? req.body.segments : [])
      .map((segment, index) => ({
        speaker: String(segment?.gender || '').toLowerCase() === 'female' ? 'KADIN' : 'ERKEK',
        text: String(segment?.turkishText || '').trim(),
        startTime: Math.max(blockStart, Number(segment?.startTime) || blockStart),
        endTime: Math.min(blockEnd, Math.max(Number(segment?.endTime) || blockStart, Number(segment?.startTime) || blockStart)),
        index
      }))
      .filter(segment => segment.text && segment.startTime < blockEnd)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 100);

    if (!segments.length) {
      return res.status(400).json({ available: false, reason: 'EMPTY_DUB_BLOCK' });
    }

    let cursor = blockStart;
    const script = [];
    for (const segment of segments) {
      const pause = Math.max(0, segment.startTime - cursor);
      if (pause >= 0.25) script.push(`[${pause.toFixed(2)} saniye sessizlik]`);
      script.push(`${segment.speaker}: ${segment.text}`);
      cursor = Math.max(cursor, segment.endTime);
    }
    const tailPause = Math.max(0, blockEnd - cursor);
    if (tailPause >= 0.25) script.push(`[${tailPause.toFixed(2)} saniye sessizlik]`);

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{
        role: 'user',
        parts: [{
          text:
            'Aşağıdaki zaman sıralı Türkçe dublaj metnini aynen seslendir. ' +
            'ERKEK satırlarını yalnızca ERKEK, KADIN satırlarını yalnızca KADIN konuşsun. ' +
            'Köşeli parantez içindeki sessizlik sürelerini konuşma; belirtilen süre kadar sessiz kal. ' +
            'Hiçbir kelime ekleme, çıkarma, açıklama veya tekrar yapma.\n\n' +
            script.join('\n')
        }]
      }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: 'ERKEK',
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Orus' } }
              },
              {
                speaker: 'KADIN',
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
              }
            ]
          }
        }
      }
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(part => part?.inlineData?.data);
    const audioData = audioPart?.inlineData?.data;
    const sourceMime = String(audioPart?.inlineData?.mimeType || 'audio/L16;rate=24000');

    if (!audioData) throw new Error('GEMINI_TTS_BLOCK_AUDIO_MISSING');

    const isRawPcm = /L16|pcm|raw/i.test(sourceMime) || !/wav|mpeg|ogg|webm/i.test(sourceMime);
    const finalData = isRawPcm ? pcmBase64ToWavBase64(audioData, 24000) : audioData;

    return res.json({
      available: true,
      blockStart,
      blockEnd,
      mimeType: isRawPcm ? 'audio/wav' : sourceMime,
      audioBase64: finalData
    });
  } catch (error) {
    console.error('Gemini dub block generation failed:', error);
    return res.status(502).json({
      available: false,
      message: 'Toplu dublaj sesi üretilemedi.',
      error: error?.message || String(error)
    });
  }
});

app.post('/api/gemini-dub-segment', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        available: false,
        reason: 'GEMINI_NOT_CONFIGURED'
      });
    }

    const text = String(req.body?.text || '').trim();
    const gender = String(req.body?.gender || 'uncertain');
    const emotion = String(req.body?.emotion || 'neutral');
    const speakerId = String(req.body?.speakerId || 'speaker');

    if (!text || text.length > 1200) {
      return res.status(400).json({
        available: false,
        reason: 'INVALID_DUB_TEXT'
      });
    }

    const voiceName =
      gender === 'female'
        ? 'Kore'
        : gender === 'male'
          ? 'Orus'
          : 'Charon';

    const voiceStyle =
      gender === 'female'
        ? 'an adult Turkish woman'
        : gender === 'male'
          ? 'an adult Turkish man'
          : 'a natural adult Turkish speaker';

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{
        role: 'user',
        parts: [{
          text:
            `Read the following Turkish line exactly as written. ` +
            `Use ${voiceStyle}. Preserve a natural ${emotion} emotion, ` +
            `realistic conversational pace and clear pronunciation. ` +
            `Do not add, remove or explain any words.\n\n${text}`
        }]
      }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName
            }
          }
        }
      }
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(part => part.inlineData?.data);
    const audioData = audioPart?.inlineData?.data;
    const sourceMime = String(
      audioPart?.inlineData?.mimeType || 'audio/L16;rate=24000'
    );

    if (!audioData) {
      throw new Error('GEMINI_TTS_AUDIO_MISSING');
    }

    const isRawPcm =
      /L16|pcm|raw/i.test(sourceMime) ||
      !/wav|mpeg|mp3|ogg|webm/i.test(sourceMime);

    const finalData = isRawPcm
      ? pcmBase64ToWavBase64(audioData, 24000)
      : audioData;

    return res.json({
      available: true,
      speakerId,
      gender,
      voiceName,
      mimeType: isRawPcm ? 'audio/wav' : sourceMime,
      audioBase64: finalData
    });
  } catch (error) {
    console.error('Gemini dub generation failed:', error);
    return res.status(502).json({
      available: false,
      reason: 'GEMINI_DUB_ERROR',
      message: 'Türkçe dublaj sesi üretilemedi.',
      error: error?.message || String(error)
    });
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
