import { GoogleGenAI } from "@google/genai";
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import youtubedl from 'youtube-dl-exec';
import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import { dedupeVerifiedTimelineActions } from './public/adult-gameplay.js';
import { storyboardFailureReason, generateStoryboardWithRetry, isTerminalStoryboardFailure } from './public/analysis-recovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const ANALYSIS_SCHEMA_VERSION = 5;
const ANALYSIS_ENGINE_VERSION = 'gemini-storyboard-story-v1';
const EXTERNAL_ANALYSIS_URL = (process.env.EXTERNAL_ANALYSIS_URL || 'https://source-video-analysis.onrender.com').replace(/\/$/, '');

const upload = multer({
  dest: '/tmp/videoquest-external',
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 5 }
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
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); }
      catch { return ''; }
    }
  }
  return '';
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return false;
  return secureEqual(readCookie(req, AUTH_COOKIE), expectedAuthToken());
}

function clientGeminiApiKey(req) {
  const value = String(req.get('x-gemini-api-key') || '').trim();
  if (!value || value.length < 20 || value.length > 256 || /\s/.test(value)) return '';
  return value;
}

function resolveGeminiApiKey(req) {
  return clientGeminiApiKey(req) || String(process.env.GEMINI_API_KEY || '').trim();
}

function clientElevenLabsApiKey(req) {
  const value = String(req.get('x-elevenlabs-key') || '').trim();
  if (!value || value.length < 20 || value.length > 256 || /\s/.test(value)) return '';
  return value;
}

function emptyGeminiUsage() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
}

function addGeminiUsage(total, metadata = {}) {
  total.requests += 1;
  total.inputTokens += Number(metadata.promptTokenCount || metadata.inputTokenCount || 0);
  total.outputTokens += Number(metadata.candidatesTokenCount || metadata.outputTokenCount || 0);
  total.thinkingTokens += Number(metadata.thoughtsTokenCount || 0);
  total.totalTokens += Number(metadata.totalTokenCount || 0);
  return total;
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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The app is deployed as one coherent ES-module graph. Caching an old
    // entry module across a deployment can make a later module request point
    // at a different release, so HTML/JS must always be revalidated together.
    if (/\.(?:html|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

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
    fields: 16
  }
});

app.post('/api/gemini-storyboard-analyze', storyboardUpload.array('storyboards', 20), async (req, res) => {
  try {
    const analysisUsage = emptyGeminiUsage();
    const apiKey = resolveGeminiApiKey(req);
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
    const sceneBoundaries = String(req.body?.sceneBoundaries || '[]').slice(0, 12000);
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
  const sensoryAudioContext = String(req.body?.sensoryAudioContext || '[]').slice(0, 16000);
  const qualityMode = String(req.body?.qualityMode || 'ultra');
  const reviewMode = String(req.body?.reviewMode || '') === '1';
  const reviewCandidates = String(req.body?.reviewCandidates || '[]').slice(0, 18000);
  const storyContextMemory = String(req.body?.storyContextMemory || '{}').slice(0, 24000);
  const reviewInstructions = reviewMode ? `
SECOND PASS VISUAL REVIEW MODE:
- Re-inspect the SAME storyboard frames against these first-pass candidates:
${reviewCandidates}
- Return only candidates that are visibly re-verified at start, midpoint and end.
- Correct timestamps, canonical position id/label and confidence when the frames prove a correction.
- Preserve actionId/sceneId for the same candidate.
- Do not add a new action merely because it sounds plausible.
- If a candidate conflicts with the frames, another position label, scene chronology, or its parent range, OMIT it and add a warning.
- Outcome/final candidates require stronger evidence than ordinary actions.
- For any candidate whose first-pass activityType is vaginal or anal, independently classify the route again from the SAME visible frames. Treat the first-pass route as untrusted; do not preserve it merely for consistency.
- Body position never proves route: missionary, cowgirl, rear, standing-rear, spoon and similar configurations can be vaginal or anal.
- Return vaginal or anal only when the visible contact/penetration location is directly distinguishable and consistent at the candidate start, midpoint and end. Otherwise return activityType other with low activityTypeConfidence, or omit the candidate.
- Never default an ambiguous penetrative candidate to vaginal. Correct activityType, activityTypeConfidence, activityEvidence and the Turkish label together so they cannot contradict one another.
- Re-check narrativeChoiceLabel, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence for supplied candidates. Preserve them only when the same frames/dialogue still support them; otherwise downgrade to neutral wording.
- For groupScene, partnerSwitch or partner_transition candidates, independently re-identify every visible adult using stable neutral track IDs. Preserve a partner change only when the source frames visibly prove MAIN_MALE changes from one adult partner to another; otherwise omit it.
` : '';
  const chunkDuration = Math.max(1, chunkEnd - chunkStart);
  const targetActionCount = Math.max(
    5,
    Math.min(22, Math.round(chunkDuration / 12))
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
Detected visual scene boundaries for this chunk: ${sceneBoundaries}
- Treat boundary timestamps as navigation hints, not proof of an action.
- Prefer starting or ending an action near a boundary only when the adjacent frames visibly confirm the change.
Current analysis chunk: ${chunkIndex + 1} of ${chunkCount}
${reviewInstructions}
DIALOGUE AND SCENE CONTEXT:
Quality mode: ${qualityMode}
Time-aligned dialogue segments:
${dialogueContext}
Time-aligned non-speech audio observations:
${sensoryAudioContext}

- Use dialogue only when its timestamp overlaps the visible scene.
- Use verified spoken meaning to improve scene understanding and Turkish choice wording.
- Dialogue never overrides contradictory visual evidence.
- Non-speech audio may support intensity only when its timestamp overlaps the action. Audio alone never proves pain, pleasure, consent, a relationship or an internal feeling.
- Never invent speech, responses or outcomes.
- Connect dialogue choices only to matching visible MAIN_MALE actions.

STORY ENGINE V1 — EVIDENCE-AWARE NARRATIVE UNDERSTANDING:
Prior verified story memory from earlier chunks:
${storyContextMemory}

- Understand the scene as a story, not merely a motion list: identify setting, immediate scene purpose, emotional tone, character roles, relationship clues, goals, conflict/tension and meaningful narrative progression.
- Build story continuity across chunks, but PRIOR MEMORY NEVER OVERRIDES current source frames or current time-aligned dialogue.
- Separate knowledge into three levels only: fact, inference, unknown.
- FACT means directly visible or explicitly stated in time-aligned dialogue. Include a short evidence string and confidence.
- INFERENCE means strongly suggested but not explicit. It must remain phrased as an inference and include evidence/confidence.
- UNKNOWN means the source does not establish it. Never silently promote unknown information into a fact.
- Sensitive relationship/background labels such as ex-partner, spouse, step-parent, parent, sibling, relative, boss, employee, teacher, landlord or neighbor may be FACT only when dialogue explicitly states it or unmistakable source evidence proves it. Mere age difference, familiarity, location, clothing, intimacy or body language is never enough.
- Example: two familiar people meeting at a house does NOT prove 'ex-girlfriend' or 'stepfather'. If dialogue explicitly says they broke up, 'ex-partner' may be a fact. Otherwise keep the exact relationship unknown or as a cautious inference.
- Give each recurring adult a stable character entry with participantTrackId, displayName, sourceRole, evidenceLevel, confidence and evidence. Preserve an explicitly spoken proper name exactly; otherwise use the most specific non-sensitive source-grounded story role instead of repeatedly reducing a known character to generic age/gender wording.
- Carry verified character names and non-sensitive story roles into sceneTitle, sceneGoal and narrativeChoiceLabel whenever that makes the real action clearer. Keep the same wording across chunks and never rename a recurring character.
- Never infer age, kinship or another sensitive relationship from appearance. If dialogue explicitly establishes a sensitive family relationship, retain it only as neutral factual story context; do not turn that relationship label into sexualized choice wording, a reward, or invented motivation.
- Return top-level storyContext with synopsisTr, currentSceneTitle, currentSceneGoal, setting, emotionalTone, characters[], relationships[], facts[], inferences[], unknowns[].
- Every relationship entry must contain from, to, relation, evidenceLevel, confidence and evidence.
- Every returned action must additionally contain narrativeChoiceLabel, narrativeReason, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence.
- narrativeChoiceLabel is the player-facing Turkish story choice. It must describe the meaning of the REAL playable action in context, not invent a branch.
- narrativeChoiceLabel must still map to that action's exact startTime/endTime. Never write a choice whose promised consequence is absent from that exact source segment.
- If relationship/background context is uncertain, use neutral story wording such as 'Onunla konuşmaya devam et', 'Neden geldiğini sor' or another source-grounded action instead of asserting an unsupported relationship.
- Prefer story-aware wording over mechanical wording when evidence supports it: scene intention + interaction + verified action. Do not replace precise sexual-position controls with fictional dialogue or outcomes.

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
      "actionType": "position|tempo_change|kiss|touch|clothing|body_transition|partner_transition|camera_transition|outcome|aftermath|other",
      "adultScene": false,
      "adultSceneId": "",
      "adultSceneStartTime": 0,
      "adultSceneEndTime": 0,
      "postSceneTime": 0,
      "positionId": "",
      "positionOccurrenceId": "",
      "receiverBodyOrientation": "on_top_facing|on_top_away|face_down_flat|on_back|side_lying|hands_knees|bent_over|standing|seated|unclear",
      "receiverSupport": "straddling|torso_flat|back_flat|hands_knees|side|seated|standing|unclear",
      "positionConfigurationConfidence": 0.0,
      "positionEvidence": "direct visible body-configuration evidence or empty string",
      "groupScene": false,
      "adultParticipantCount": 2,
      "participantTrackIds": [],
      "partnerTrackId": "",
      "partnerLabel": "",
      "partnerEvidence": "",
      "partnerSwitch": false,
      "previousPartnerTrackId": "",
      "activityType": "oral|manual|vaginal|anal|other",
      "activityTypeConfidence": 0.0,
      "activityEvidence": "brief directly visible evidence or empty string",
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
      "audioIntensity": "none|low|moderate|high|unclear",
      "nonSpeechAudio": "none|breathing|moan|laughter|crying|vocal_reaction|mixed|unclear",
      "gazeIntensity": "none|brief|sustained|mutual|unclear",
      "observedAffect": "neutral|relaxed|tense|happy|sad|fearful|excited|distressed|unclear",
      "bodyResponse": "relaxed|tense|recoil|rhythmic|still|changing|unclear",
      "sensoryEvidence": "brief directly observed audio/visual cues",
      "sensoryConfidence": 0.0,
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
- Every UI-facing string must be natural Turkish: label, narrativeChoiceLabel, sceneTitle, sceneGoal, positionLabel, movementType and outcomeLabel. Preserve proper names. Translate only what the supplied source evidence supports; never add meaning while translating.
- Detect every verified adult scene boundary and mark adultScene true only inside that real scene.
- Set one stable adultSceneId for every action belonging to the same adult scene.
- Every action whose time interval falls inside a verified adult scene must keep adultScene true and the same adultSceneId, including conversation, pauses, transitions and camera changes. Never emit a generic non-adult timeline choice from inside that interval.
- Treat one continuous consensual intimate encounter as one adultScene across foreplay, oral/manual activity, position changes, climax and aftermath. Do not create a new adultSceneId merely because the interaction changes from touching/undressing to a sexual position or from one position to another.
- Start a new adultSceneId only after a clear narrative, location, participant or substantial time break.
- A verified partner switch inside one continuous group encounter is not a new adultSceneId; keep the encounter together and separate it with partnerTrackId plus a new positionOccurrenceId.
- Detect a position only when the source visibly shows a stable adult-act body configuration sustained over time; then use actionType "position".
- Never classify undressing, dressing, walking, approaching, preparation, conversation, camera changes, pauses or generic standing/sitting as positions.
- Foreplay and non-position actions may remain chronological main/bonus actions, but must not receive a positionId or appear in position tabs.
- Merge duplicate detections only when they describe the same continuous occurrence and their time ranges overlap; never bridge separate appearances of the same position into one long range.
- Give every verified position a stable positionId, exact Turkish positionLabel, positionStartTime and positionEndTime.
- Keep positionId as the canonical semantic position family. Give each uninterrupted occurrence of that family a stable positionOccurrenceId; if the same position returns later after another position, transition, cut, or real time gap, it must have a different positionOccurrenceId.
- GROUP/SWINGER SCENES: When three or more clearly adult participants are visibly present in the same consensual encounter, set groupScene true and adultParticipantCount to the directly verified count. Otherwise keep groupScene false; never infer off-screen participants.
- Give every visible adult a stable neutral participantTrackId such as MAIN_MALE, PARTNER_A, PARTNER_B. Reuse the same ID from face, hair, body, clothing and scene continuity; never use a real-world identity or infer a relationship.
- participantTrackIds must list only adults directly involved in that exact action interval. partnerTrackId is the one adult directly paired with MAIN_MALE in that interval; partnerLabel must be a neutral Turkish UI label such as Partner A or Partner B.
- If one exact position interval visibly involves MAIN_MALE with multiple partners simultaneously, use partnerTrackId MULTI_PARTNER, list every involved adult in participantTrackIds and use the neutral partnerLabel Birden fazla partner. Do this only from direct interval evidence.
- When the same canonical position occurs with a different partnerTrackId, end the previous position occurrence and create a new positionOccurrenceId. They are separate playable positions and must never be merged merely because positionId is the same.
- Set partnerSwitch true only when the frames visibly show MAIN_MALE ending interaction with previousPartnerTrackId and beginning interaction with partnerTrackId. Emit the visible transition as actionType partner_transition with a direct Turkish label such as Partner B'ye geç only when the transition itself has a valid playable interval.
- A partner_transition is chronology metadata, never foreplay and never a Lust-building opening choice. It may connect an already-started partner-specific occurrence to the next verified partner-specific position, but it must never be offered before the first verified position in the encounter.
- Every partner_transition must contain two different non-empty IDs: previousPartnerTrackId for the directly preceding partner and partnerTrackId for the directly following partner. If either identity or the handoff interval is uncertain, do not emit partner_transition.
- If the edit cuts directly to a different partner without showing the transition, do not invent a partner_transition clip. Start the new partner-specific position at its first verified frame instead.
- Set activityType to oral, manual, vaginal, anal, or other only from direct visible evidence; never guess when evidence is unclear.
- CRITICAL: positionId never determines penetration route. Missionary, cowgirl, rear, standing-rear, standing, spoon and any other body position can be vaginal or anal. Never default a penetrative position to vaginal.
- Classify vaginal only when the source frames directly verify vaginal penetration; classify anal only when the source frames directly verify anal penetration. Body angle, position name, dialogue, prior activity, or statistical likelihood are not sufficient by themselves.
- For vaginal or anal, require the route to remain visually supported at the action start, midpoint and end. If the exact penetration route is occluded, ambiguous, changes off-camera, or cannot be directly distinguished, set activityType to other rather than guessing.
- Set activityTypeConfidence from 0.0 to 1.0 for the penetration-route classification specifically, independent of general action confidence. Be conservative. A vaginal/anal claim should reach 0.90 only when direct visual evidence is clear and consistent.
- Set activityEvidence to a brief description of the directly visible evidence supporting activityType. Leave it empty for other/uncertain route. Never use dialogue alone as activityEvidence.
- The Turkish label may say "vajinal" only when activityType is vaginal with activityTypeConfidence >= 0.90 and direct activityEvidence. It may say "anal" only when activityType is anal with the same evidence standard. Otherwise the label must name only the verified position/action without claiming penetration route.
- If the visible route changes between vaginal and anal while the body position stays the same, end the previous action at the verified transition and create a new action with a new positionOccurrenceId. Never carry the previous activityType across that transition.
- Verify every position and internal movement against its exact start frame, midpoint frame and end frame from the source video.
- For every position, independently return receiverBodyOrientation, receiverSupport, positionConfigurationConfidence and positionEvidence from the visible body arrangement at start, midpoint and end. Never copy these fields from positionId or positionLabel.
- Cowgirl requires the receiving partner to be visibly above MAIN_MALE and straddling him. Prone-bone requires the receiving partner's face-down torso/abdomen to remain visibly supported flat with low hips while MAIN_MALE is behind. These configurations are mutually exclusive.
- If a clip changes between straddling-on-top and face-down-flat, split it exactly at the visible transition. The transition interval must not be an internal movement of either position.
- The Turkish label must directly describe what is visibly happening at the midpoint timestamp; if the midpoint does not visibly prove that label, omit the item.
- A position movement must describe a visible change while the same canonical body configuration is maintained. Do not attach kissing, caressing, breast touching, clothing adjustment, transition, dialogue or generic excitement to a penetrative position; emit it as a separate warm-up action or omit it.
- Do not use penetration-route words (vaginal/anal/penetration), position-transition words (turning, guiding, changing position) or a different position name as a movement label. Those belong to a separately verified occurrence; otherwise omit the action.
- All returned times are absolute source-video seconds, never scene-relative or chunk-relative seconds.
- Never attach a label detected in one part of the video to an earlier or later segment.
- Position and movement choices must seek to their own verified visible segment, not merely to the parent adult-scene start.
- When evidence conflicts between sampled frames, prefer omission and add a warning instead of guessing.
- Inside each position, detect every meaningful real change in tempo, movement, body angle, pause, intensity, emotion or interaction.
- For every action, fuse only time-aligned evidence: audible non-speech intensity, visible gaze duration, facial expression, posture and body response. Report observable cues, not hidden mental states.
- Never claim pain, pleasure, happiness, fear, consent or climax from one ambiguous facial expression, sound or body movement. Use observedAffect unclear unless multiple consistent cues support a cautious visible description.
- Use canonical positionId values consistently: oral, manual, reverse-cowgirl, seated-facing, prone-bone, legs-up, missionary, cowgirl, spoon, reverse-spoon, standing-rear, rear, seated, standing, or other-stable-N.
- A furniture or direction word is never position evidence by itself: "koltuğun arkasına", "arkaya yönlendir", "ağzından öp" and ordinary hand contact must not become rear, oral or manual position families.
- rear requires a clearly visible from-behind body configuration; standing-rear additionally requires both partners to be visibly upright. If those body arrangements are not clear at start, midpoint and end, omit the position.
- Use prone-bone only when the receiving partner is visibly lying face-down/flat with hips low while penetration is from behind. Do not collapse prone-bone into rear/doggy, missionary, spoon or a generic lying position.
- positionId, positionLabel and the visible body configuration described by label must agree. If they conflict, omit the position instead of guessing.
- Use missionary only when the receiving partner is visibly below/on their back and MAIN_MALE is visibly above/front-facing in that configuration.
- Use cowgirl only when the partner is visibly on top/straddling MAIN_MALE. Never reuse missionary for a cowgirl segment or cowgirl for a missionary segment.
- Use reverse-cowgirl only when the partner is visibly on top/straddling MAIN_MALE while facing away from him. Never collapse reverse-cowgirl into cowgirl.
- Use seated-facing only when partners are visibly seated/lap-positioned and facing each other. Use seated only for other clearly seated sexual configurations.
- Use legs-up only when legs are visibly raised in a sustained stable configuration. Do not use it for a brief transition.
- Use reverse-spoon only when side-lying orientation is visibly the reverse/back-facing spoon configuration. Do not collapse it into spoon.
- When the visible body configuration changes from one canonical position to another, end the previous occurrence before the change and start a new occurrence at the first clearly verified frame of the new position.
- Two labels describing the same visible body configuration must reuse one canonical positionId; wording, tempo, camera angle, or minor pose variation must never create another position.
- Oral activity, manual activity, undressing, and transitions are separate position families and must never appear beneath missionary, rear, standing-rear, cowgirl, spoon, or another penetrative position.
- A movement may belong to a position only when its entire loopStartTime-loopEndTime interval is visibly contained inside that exact positionStartTime-positionEndTime range.
- Reject any position or movement when the claimed body configuration is not visibly present at its start, midpoint, and end timestamps.
- Every internal change must reuse its parent positionId and have a concise movementType and Turkish label.
- Internal movement labels must name only the directly visible change, for example hızlı hareket, ritmik hareket, sert hareket, derin hareket, öpme, okşama, tutuş or a similarly concrete interaction actually visible in that interval.
- Never put timestamps, duration, sequence numbers, "gerçek kesit", breathing, moaning, gaze, emotion, appearance or confidence text inside an internal movement label. Those belong only to metadata.
- Set movementTempo from directly visible cadence only. Use slow, moderate or fast for stable segments; split a changing cadence into separate 10+ second verified segments whenever the source duration permits. Use unclear when speed cannot be verified.
- Use fast only when repeated motion is visibly and consistently fast across the complete interval. Put words such as sert, derin or güçlü in movementType/label only when that exact quality is directly visible throughout the same time-aligned segment; never infer it from dialogue, audio alone or the surrounding adult scene.
- These explicit movementTempo and movementType observations control the optional on-screen sex interaction button. If no source-verified fast, hard or deep interval exists, do not manufacture one and allow the button to remain unavailable for the entire video.
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

    const ai = new GoogleGenAI({ apiKey });
    const unverifiedGapResult = (startTime, endTime, reason) => ({
      available: true,
      videoDuration: duration,
      introEndTime: chunkIndex === 0 ? Math.max(0, startTime) : chunkStart,
      playStartTime: chunkIndex === 0 ? Math.max(0, startTime) : chunkStart,
      protagonistProfile,
      videoPrompt: '',
      storyContext: {},
      actions: [],
      analysisGaps: [{
        startTime: Math.max(0, Number(startTime) || 0),
        endTime: Math.min(duration, Math.max(Number(startTime) || 0, Number(endTime) || 0)),
        reason: storyboardFailureReason(reason)
      }],
      warnings: ['Bu aralık modelden doğrulanabilir sonuç alınamadığı için seçenek üretilmeden geçildi.']
    });
    const generateStoryboardJson = async (requestPrompt, requestFiles, retryLabel = 'full') => {
      const parts = [
        { text: requestPrompt },
        ...requestFiles.map((file) => ({
          inlineData: {
            mimeType: file.mimetype || 'image/jpeg',
            data: file.buffer.toString('base64')
          }
        }))
      ];
      return generateStoryboardWithRetry(async () => {
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
          contents: [{ role: "user", parts }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.1,
            maxOutputTokens: 16384
          }
        });
        addGeminiUsage(analysisUsage, response?.usageMetadata);
        return response;
      }, {
        onRetry: (reason, attempt) => console.warn(
          `[gemini-storyboard-retry:${retryLabel}] attempt ${attempt}/2: ${reason}`
        )
      });
    };

    let parsed;
    try {
      parsed = await generateStoryboardJson(prompt, files);
    } catch (fullChunkError) {
      const fullFailureReason = storyboardFailureReason(fullChunkError);
      if (fullFailureReason === 'GEMINI_QUOTA_OR_CREDITS') {
        console.warn(
          `[gemini-storyboard-quota] chunk ${chunkIndex + 1}/${chunkCount} stopped without split recovery`
        );
        return res.status(429).json({
          available: false,
          retryable: false,
          reason: 'GEMINI_CREDITS_DEPLETED',
          message: 'Gemini API kredisi veya proje kotası kullanılamıyor. Aynı istek otomatik tekrarlanmadı.',
          chunkIndex,
          chunkCount,
          chunkStart,
          chunkEnd
        });
      }
      if (isTerminalStoryboardFailure(fullChunkError)) {
        console.warn(`[gemini-storyboard-unavailable] chunk ${chunkIndex + 1}/${chunkCount}: ${fullFailureReason}`);
        return res.status(422).json({
          available: false, retryable: false, reason: fullFailureReason,
          message: `Bölüm ${chunkIndex + 1}/${chunkCount} için model analiz verisi döndürmedi. Bu aralık için seçenek üretilmedi; diğer bölümlere devam edilecek.`,
          chunkIndex, chunkCount, chunkStart, chunkEnd,
          analysisGaps: [{ startTime: chunkStart, endTime: chunkEnd, reason: fullFailureReason }],
          aiUsage: analysisUsage
        });
      }
      const allTimestamps = (() => {
        try {
          const value = JSON.parse(timestamps);
          return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
        } catch {
          return [];
        }
      })();
      const framesPerSheet = Math.max(1, Math.ceil(allTimestamps.length / files.length));
      const recoverySegments = files.map((file, fileIndex) => ({
        file,
        timestamps: allTimestamps.slice(
          fileIndex * framesPerSheet,
          (fileIndex + 1) * framesPerSheet
        )
      }));

      if (recoverySegments.length <= 1) {
        console.warn(`[gemini-storyboard-gap] chunk ${chunkIndex + 1}/${chunkCount}: ${fullFailureReason}`);
        parsed = unverifiedGapResult(chunkStart, chunkEnd, fullChunkError);
      } else {
      const recoveredParts = new Array(recoverySegments.length);
      console.warn(`[gemini-storyboard-split-recovery] chunk ${chunkIndex + 1}/${chunkCount} split into ${recoverySegments.length} smaller requests`);

      let nextRecoveryIndex = 0;
      const recoverNextSegment = async () => {
        while (nextRecoveryIndex < recoverySegments.length) {
          const fileIndex = nextRecoveryIndex;
          nextRecoveryIndex += 1;
          const segment = recoverySegments[fileIndex];
          const splitTimestamps = segment.timestamps;
          const splitStart = Number(splitTimestamps[0] ?? chunkStart);
          const splitLast = Number(splitTimestamps[splitTimestamps.length - 1] ?? splitStart);
          const splitEnd = Math.min(chunkEnd, Math.max(splitStart + 0.1, splitLast + Math.max(0.1, (chunkEnd - chunkStart) / Math.max(1, allTimestamps.length))));
          const splitPrompt = prompt
            .replace(`Timestamp metadata for this chunk: ${timestamps}`, `Timestamp metadata for this recovery segment: ${JSON.stringify(splitTimestamps)}`)
            .replace(`Analyze ONLY the interval ${chunkStart} to ${chunkEnd} seconds.`, `Analyze ONLY the interval ${splitStart} to ${splitEnd} seconds.`)
            .replace('Examine this short interval deeply instead of summarizing the whole video.', 'This is one smaller recovery segment. Examine only these supplied frames and timestamps.');
          try {
            recoveredParts[fileIndex] = await generateStoryboardJson(
              splitPrompt,
              [segment.file],
              `split-${fileIndex + 1}`
            );
          } catch (splitError) {
            const splitReasonCode = storyboardFailureReason(splitError);
            console.warn(
              `[gemini-storyboard-gap] split ${fileIndex + 1}/${recoverySegments.length} ` +
              `in chunk ${chunkIndex + 1} kept non-playable: ${splitReasonCode}`
            );
            recoveredParts[fileIndex] = unverifiedGapResult(splitStart, splitEnd, splitError);
          }
        }
      };
      const recoveryConcurrency = Math.min(2, recoverySegments.length);
      await Promise.all(
        Array.from({ length: recoveryConcurrency }, () => recoverNextSegment())
      );

      parsed = {
        ...recoveredParts[0],
        available: true,
        videoDuration: duration,
        protagonistProfile: String(
          [...recoveredParts].reverse().find(item => item?.protagonistProfile)?.protagonistProfile ||
          protagonistProfile
        ),
        videoPrompt: recoveredParts.map(item => String(item?.videoPrompt || '').trim()).filter(Boolean).join('\n\n'),
        actions: recoveredParts.flatMap(item => Array.isArray(item?.actions) ? item.actions : []),
        analysisGaps: recoveredParts.flatMap(item => Array.isArray(item?.analysisGaps) ? item.analysisGaps : []),
        restrictedRanges: recoveredParts.flatMap(item => Array.isArray(item?.restrictedRanges) ? item.restrictedRanges : []),
        warnings: [
          ...recoveredParts.flatMap(item => Array.isArray(item?.warnings) ? item.warnings : []),
          `Chunk ${chunkIndex + 1} recovered from ${recoverySegments.length} smaller verified segments.`
        ]
      };
      }
    }
    const unresolvedGaps = Array.isArray(parsed?.analysisGaps)
      ? parsed.analysisGaps.filter(gap => Number(gap?.endTime) > Number(gap?.startTime))
      : [];
    if (unresolvedGaps.length) {
      const quotaBlocked = unresolvedGaps.some(gap =>
        String(gap?.reason || '') === 'GEMINI_QUOTA_OR_CREDITS'
      );
      const contentRestricted = unresolvedGaps.some(gap =>
        String(gap?.reason || '') === 'GEMINI_CONTENT_RESTRICTED'
      );
      const unstructured = unresolvedGaps.some(gap => gap.reason === 'MODEL_UNSTRUCTURED_RESPONSE');
      return res.status(quotaBlocked ? 429 : contentRestricted || unstructured ? 422 : 503).json({
        available: false,
        retryable: !(quotaBlocked || contentRestricted || unstructured),
        reason: quotaBlocked
          ? 'GEMINI_CREDITS_DEPLETED'
          : contentRestricted
            ? 'GEMINI_CONTENT_RESTRICTED'
            : unstructured ? 'MODEL_UNSTRUCTURED_RESPONSE' : 'CHUNK_ANALYSIS_GAP',
        message: quotaBlocked
          ? 'Gemini API kredisi veya proje kotası kullanılamıyor. Aynı istek otomatik tekrarlanmadı.'
          : contentRestricted
            ? `Bölüm ${chunkIndex + 1}/${chunkCount} Gemini tarafından içerik kısıtlaması nedeniyle okunamadı. ` +
              'Bu aralık için seçenek üretilmedi; diğer bölümlere devam edilecek.'
            : `Bölüm ${chunkIndex + 1}/${chunkCount} modelden eksiksiz okunamadı. ` +
              'Bu aralık doğrulanmadı; diğer bölümler korunuyor.',
        chunkIndex,
        chunkCount,
        chunkStart,
        chunkEnd,
        analysisGaps: unresolvedGaps,
        aiUsage: analysisUsage
      });
    }

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
          receiverBodyOrientation: ['on_top_facing', 'on_top_away', 'face_down_flat', 'on_back', 'side_lying', 'hands_knees', 'bent_over', 'standing', 'seated', 'unclear'].includes(String(action.receiverBodyOrientation || '').toLowerCase())
            ? String(action.receiverBodyOrientation).toLowerCase() : 'unclear',
          receiverSupport: ['straddling', 'torso_flat', 'back_flat', 'hands_knees', 'side', 'seated', 'standing', 'unclear'].includes(String(action.receiverSupport || '').toLowerCase())
            ? String(action.receiverSupport).toLowerCase() : 'unclear',
          positionConfigurationConfidence: Math.max(0, Math.min(1, Number(action.positionConfigurationConfidence) || 0)),
          positionEvidence: String(action.positionEvidence || '').trim(),
          groupScene: action.groupScene === true,
          adultParticipantCount: Math.max(0, Math.floor(Number(action.adultParticipantCount) || 0)),
          participantTrackIds: Array.isArray(action.participantTrackIds)
            ? action.participantTrackIds.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
            : [],
          partnerTrackId: String(action.partnerTrackId || '').trim(),
          partnerLabel: String(action.partnerLabel || '').trim(),
          partnerEvidence: String(action.partnerEvidence || '').trim(),
          partnerSwitch: action.partnerSwitch === true,
          previousPartnerTrackId: String(action.previousPartnerTrackId || '').trim(),
          activityType: ['oral', 'manual', 'vaginal', 'anal'].includes(
            String(action.activityType || '').toLowerCase()
          )
            ? String(action.activityType).toLowerCase()
            : 'other',
          activityTypeConfidence: Math.max(0, Math.min(1, Number(action.activityTypeConfidence) || 0)),
          activityEvidence: String(action.activityEvidence || '').trim(),
          positionLabel: String(action.positionLabel || ''),
          positionStartTime: Number(action.positionStartTime ?? action.startTime),
          positionEndTime: Number(action.positionEndTime ?? action.endTime),
          movementType: String(action.movementType || action.actionType || ''),
          movementTempo: ['still', 'slow', 'moderate', 'fast', 'changing', 'unclear'].includes(
            String(action.movementTempo || '').toLowerCase()
          ) ? String(action.movementTempo).toLowerCase() : 'unclear',
          audioIntensity: ['none', 'low', 'moderate', 'high', 'unclear'].includes(String(action.audioIntensity || '').toLowerCase()) ? String(action.audioIntensity).toLowerCase() : 'unclear',
          nonSpeechAudio: ['none', 'breathing', 'moan', 'laughter', 'crying', 'vocal_reaction', 'mixed', 'unclear'].includes(String(action.nonSpeechAudio || '').toLowerCase()) ? String(action.nonSpeechAudio).toLowerCase() : 'unclear',
          gazeIntensity: ['none', 'brief', 'sustained', 'mutual', 'unclear'].includes(String(action.gazeIntensity || '').toLowerCase()) ? String(action.gazeIntensity).toLowerCase() : 'unclear',
          observedAffect: ['neutral', 'relaxed', 'tense', 'happy', 'sad', 'fearful', 'excited', 'distressed', 'unclear'].includes(String(action.observedAffect || '').toLowerCase()) ? String(action.observedAffect).toLowerCase() : 'unclear',
          bodyResponse: ['relaxed', 'tense', 'recoil', 'rhythmic', 'still', 'changing', 'unclear'].includes(String(action.bodyResponse || '').toLowerCase()) ? String(action.bodyResponse).toLowerCase() : 'unclear',
          sensoryEvidence: String(action.sensoryEvidence || '').trim(),
          sensoryConfidence: Math.max(0, Math.min(1, Number(action.sensoryConfidence) || 0)),
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
        narrativeChoiceLabel: String(action.narrativeChoiceLabel || '').trim(),
        narrativeReason: String(action.narrativeReason || '').trim(),
        sceneTitle: String(action.sceneTitle || '').trim(),
        sceneGoal: String(action.sceneGoal || '').trim(),
        relationshipContext: String(action.relationshipContext || '').trim(),
        storyEvidenceLevel: ['fact', 'inference', 'unknown'].includes(String(action.storyEvidenceLevel || '').toLowerCase())
          ? String(action.storyEvidenceLevel).toLowerCase()
          : 'unknown',
        storyConfidence: Math.max(0, Math.min(1, Number(action.storyConfidence) || 0)),
        storyEvidence: String(action.storyEvidence || '').trim(),
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
      .filter((action) => {
        const type = String(action.actionType || '').toLowerCase();
        const outcome = String(action.outcomeType || '').toLowerCase();
        const strictMinimum =
          type === 'outcome' || type === 'aftermath' || outcome === 'climax' || outcome === 'aftermath'
            ? 0.82
            : action.positionId || action.positionLabel || type === 'position'
              ? 0.72
              : action.adultScene
                ? 0.64
                : 0.52;
        // First pass is deliberately permissive enough to preserve uncertain
        // candidates for the visual review pass. Review mode applies the full
        // confidence threshold before a candidate can reach gameplay.
        const minimum = reviewMode
          ? strictMinimum
          : Math.max(0.4, strictMinimum - 0.18);
        return Number(action.confidence || 0) >= minimum;
      })
      .sort((a, b) => a.startTime - b.startTime);

    // Parent positions and their verified internal movement loops overlap by
    // design. Remove only true duplicates; never discard a valid child
    // segment merely because it lives inside its parent interval.
    const dedupedActions = dedupeVerifiedTimelineActions(actions);

    return res.json({
      available: true,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      engineVersion: ANALYSIS_ENGINE_VERSION,
      reviewPass: reviewMode ? 'visual-second-pass' : 'first-pass',
      videoDuration: resolvedDuration,
      introEndTime,
      playStartTime: introEndTime,
      protagonistProfile: String(parsed.protagonistProfile || protagonistProfile || ''),
      videoPrompt: String(parsed.videoPrompt || ''),
      storyContext: parsed.storyContext && typeof parsed.storyContext === 'object' ? parsed.storyContext : {},
      actions: dedupedActions,
      analysisGaps: Array.isArray(parsed.analysisGaps) ? parsed.analysisGaps : [],
      restrictedRanges: Array.isArray(parsed.restrictedRanges) ? parsed.restrictedRanges : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      aiUsage: analysisUsage
    });
  } catch (error) {
    console.error('[gemini-storyboard-error]', error);
    const details = String(error?.message || error);
    const creditsDepleted =
      details.includes('prepayment credits are depleted') ||
      (details.includes('RESOURCE_EXHAUSTED') && details.includes('429'));

    if (creditsDepleted) {
      return res.status(429).json({
        available: false,
        reason: 'GEMINI_CREDITS_DEPLETED',
        message: 'Gemini API kredisi tükendi. Analiz başlatılamadı. AI Studio proje faturalandırmasını veya API anahtarını kontrol et.',
        retryable: false,
        error: details
      });
    }

    return res.status(502).json({
      available: false,
      reason: 'GEMINI_STORYBOARD_ERROR',
      message: 'Storyboard analizi sırasında hata oluştu.',
      retryable: true,
      error: details
    });
  }
});

app.post('/api/external-analyze', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ available: false, reason: 'VIDEO_REQUIRED' });
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
    const form = new FormData();
    const videoBlob = await fs.openAsBlob(req.file.path, { type: req.file.mimetype || 'application/octet-stream' });
    form.append('video', videoBlob, req.file.originalname || 'video.mp4');

    const upstream = await fetch(`${EXTERNAL_ANALYSIS_URL}/analyze`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(900000)])
    });

    const body = await readJsonSafe(upstream);
    if (res.destroyed) return;
    return res.status(upstream.status).json(body ?? {});
  } catch (error) {
    if (res.destroyed) return;
    return res.status(503).json({
      available: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      error: error?.message || String(error)
    });
  } finally {
    res.removeListener('close', onClose);
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
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
  const signals = [options.signal];
  if (options.timeoutMs !== 0) signals.push(AbortSignal.timeout(options.timeoutMs || 25000));
  const signal = signals.filter(Boolean).length ? AbortSignal.any(signals.filter(Boolean)) : undefined;

  for (let redirect = 0; redirect < 5; redirect++) {
    signal?.throwIfAborted();
    await validatePublicUrl(current);
    signal?.throwIfAborted();
    const response = await fetch(current, {
      ...options,
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': '*/*',
        ...(options.headers || {})
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
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
    .replace(/&#x2f;/gi, '/')
    .replace(/&#x3a;/gi, ':')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
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

  for (const match of html.matchAll(/<(?:video|source)\b[^>]*\b(?:src|data-src)=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/\b(?:src|file|data-src|data-video|data-url|data-file|data-mp4|data-hls|data-stream)=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/["'](?:contentUrl|content_url|videoUrl|video_url|videoSource|video_source|playUrl|play_url|streamUrl|stream_url|file|src)["']\s*[:=]\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+(?:\.(?:mp4|webm|m4v|mov|m3u8|mpd)(?:\?[^"'<>\s]*)?|[?&](?:mime|type)=video(?:%2F|\/)[^"'<>\s&]+)/gi)) add(match[0]);

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    if (content && ['og:video', 'og:video:url', 'og:video:secure_url', 'og:video:secure_url', 'twitter:player:stream', 'twitter:player'].includes(key)) {
      add(content);
    }
  }

  return candidates;
}

function findEmbeddedPageCandidates(html, baseUrl) {
  const pages = [];
  const add = value => {
    const resolved = decodeMediaUrl(value, baseUrl);
    if (resolved && !pages.includes(resolved)) pages.push(resolved);
  };
  for (const match of html.matchAll(/<iframe\b[^>]*\b(?:src|data-src)=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*\brel=["'](?:amphtml|canonical)["'][^>]*\bhref=["']([^"']+)["']/gi)) add(match[1]);
  return pages.slice(0, 8);
}

function collectSetCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map(value => String(value).split(';')[0]).filter(Boolean).join('; ');
}

async function probeVideoCandidate(candidate, referer, cookie = '') {
  try {
    const headers = {
      Range: 'bytes=0-1',
      Referer: referer,
      Origin: new URL(referer).origin,
      Accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL;q=0.9,*/*;q=0.5'
    };
    if (cookie) headers.Cookie = cookie;
    const { response, finalUrl } = await fetchPublicUrl(candidate, { headers, timeoutMs: 18000 });
    if (!response.ok && response.status !== 206) return null;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const mediaLike = contentType.startsWith('video/') ||
      /mpegurl|application\/octet-stream/.test(contentType) ||
      /\.(mp4|webm|m4v|mov|m3u8)(?:$|\?)/i.test(finalUrl);
    try { await response.body?.cancel(); } catch {}
    if (!mediaLike) return null;
    return {
      sourceUrl: finalUrl,
      type: /mpegurl|\.m3u8(?:$|\?)/i.test(`${contentType} ${finalUrl}`) ? 'hls' : 'video',
      contentType
    };
  } catch {
    return null;
  }
}

const resolvedVideoSessions = new Map();
const resolvedVideoCache = new Map();
const pendingVideoResolutions = new Map();
const VIDEO_RESOLUTION_CACHE_MS = 20 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of resolvedVideoSessions) {
    if (session.expiresAt <= now) resolvedVideoSessions.delete(token);
  }
  for (const [url, cached] of resolvedVideoCache) {
    if (cached.expiresAt <= now) resolvedVideoCache.delete(url);
  }
}, 10 * 60 * 1000).unref();

async function resolvePublicVideoPage(startUrl) {
  const queue = [{ url: startUrl, depth: 0, referer: startUrl, cookie: '' }];
  const visited = new Set();
  const found = [];

  while (queue.length && visited.size < 10) {
    const page = queue.shift();
    if (visited.has(page.url)) continue;
    visited.add(page.url);

    const { response, finalUrl } = await fetchPublicUrl(page.url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,video/*;q=0.9,*/*;q=0.6',
        Referer: page.referer,
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    if (!response.ok) continue;

    const responseCookie = collectSetCookies(response) || page.cookie;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('video/')) {
      return { sourceUrl: finalUrl, pageUrl: page.referer, type: 'video', cookie: responseCookie };
    }

    const html = (await response.text()).slice(0, 6000000);
    for (const candidate of findVideoCandidates(html, finalUrl)) {
      found.push({ url: candidate, referer: finalUrl, cookie: responseCookie });
    }
    if (page.depth < 2) {
      for (const embedded of findEmbeddedPageCandidates(html, finalUrl)) {
        queue.push({ url: embedded, depth: page.depth + 1, referer: finalUrl, cookie: responseCookie });
      }
    }
  }

  const preferred = found.sort((left, right) => {
    const score = value => /\.(mp4|webm|m4v|mov)(?:$|\?)/i.test(value) ? 0 : /\.m3u8(?:$|\?)/i.test(value) ? 2 : 1;
    return score(left.url) - score(right.url);
  }).slice(0, 30);

  // Candidate probes are independent. Small parallel batches avoid waiting up
  // to 18 seconds for every dead source while keeping traffic bounded.
  const probeConcurrency = 4;
  for (let offset = 0; offset < preferred.length; offset += probeConcurrency) {
    const batch = preferred.slice(offset, offset + probeConcurrency);
    const results = await Promise.all(batch.map(async item => ({
      item,
      verified: await probeVideoCandidate(item.url, item.referer, item.cookie)
    })));
    const match = results.find(result => result.verified);
    if (match) {
      return {
        ...match.verified,
        pageUrl: match.item.referer,
        cookie: match.item.cookie
      };
    }
  }
  return null;
}

async function resolveWithSiteExtractor(rawUrl) {
  const userAgent = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36';
  const baseOptions = {
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noPlaylist: true,
    noCheckCertificates: true,
    socketTimeout: 25,
    userAgent,
    referer: rawUrl,
    format: 'best[protocol^=http][vcodec!=none][acodec!=none]/best[ext=mp4]/best'
  };
  const runtimeOptions = {
    timeout: 90000,
    maxBuffer: 16 * 1024 * 1024
  };

  let output;
  let browserImpersonation = false;
  let impersonationError = '';
  try {
    output = await youtubedl(rawUrl, {
      ...baseOptions,
      impersonate: 'chrome'
    }, runtimeOptions);
    browserImpersonation = true;
  } catch (error) {
    impersonationError = String(error?.stderr || error?.message || error).slice(0, 500);
    // Unsupported URLs fail before browser impersonation matters. Repeating
    // the same extractor call without impersonation only doubles the wait.
    if (/unsupported url/i.test(impersonationError)) throw error;
    output = await youtubedl(rawUrl, baseOptions, runtimeOptions);
  }

  const info = Array.isArray(output?.entries) ? output.entries[0] : output;
  if (!info || typeof info !== 'object') {
    throw new Error('SITE_EXTRACTOR_EMPTY_RESULT');
  }

  const candidates = [
    info.url,
    ...(Array.isArray(info.requested_formats) ? info.requested_formats.map(item => item?.url) : []),
    ...(Array.isArray(info.formats) ? info.formats
      .filter(item => item?.url && item?.vcodec !== 'none' && item?.acodec !== 'none')
      .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
      .map(item => item.url) : [])
  ].filter(Boolean);

  const sourceUrl = candidates.find(value => /^https?:\/\//i.test(String(value)));
  if (!sourceUrl) throw new Error('SITE_EXTRACTOR_NO_PROGRESSIVE_SOURCE');
  await validatePublicUrl(sourceUrl);

  const protocol = String(info.protocol || '').toLowerCase();
  const ext = String(info.ext || '').toLowerCase();
  const type = /m3u8|hls/.test(protocol) || ext === 'm3u8' || /\.m3u8(?:$|\?)/i.test(sourceUrl)
    ? 'hls'
    : 'video';
  const httpHeaders = info.http_headers && typeof info.http_headers === 'object'
    ? info.http_headers
    : {};

  return {
    sourceUrl,
    pageUrl: String(info.webpage_url || rawUrl),
    type,
    cookie: String(httpHeaders.Cookie || httpHeaders.cookie || ''),
    userAgent: String(httpHeaders['User-Agent'] || httpHeaders['user-agent'] || userAgent),
    extractor: String(info.extractor_key || info.extractor || 'yt-dlp'),
    browserImpersonation,
    extractorFallbackUsed: !browserImpersonation,
    impersonationError: browserImpersonation ? '' : impersonationError
  };
}

app.post('/api/resolve-video-url', async (req, res) => {
  try {
    const startedAt = Date.now();
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

    let resolved = null;
    let extractorError = '';
    const cached = resolvedVideoCache.get(normalizedUrl);
    const cacheHit = Boolean(cached?.expiresAt > Date.now());
    if (cacheHit) {
      resolved = cached.resolved;
    } else {
      if (cached) resolvedVideoCache.delete(normalizedUrl);
      let pending = pendingVideoResolutions.get(normalizedUrl);
      if (!pending) {
        pending = (async () => {
          let candidate = null;
          let candidateError = '';
          try {
            candidate = await resolveWithSiteExtractor(normalizedUrl);
          } catch (error) {
            candidateError = String(error?.stderr || error?.message || error).slice(0, 900);
            console.warn('[site-video-extractor]', new URL(normalizedUrl).hostname, candidateError);
          }
          if (!candidate) candidate = await resolvePublicVideoPage(normalizedUrl);
          if (candidate) {
            resolvedVideoCache.set(normalizedUrl, {
              resolved: candidate,
              expiresAt: Date.now() + VIDEO_RESOLUTION_CACHE_MS
            });
          }
          return { resolved: candidate, extractorError: candidateError };
        })().finally(() => pendingVideoResolutions.delete(normalizedUrl));
        pendingVideoResolutions.set(normalizedUrl, pending);
      }
      const resolution = await pending;
      resolved = resolution.resolved;
      extractorError = resolution.extractorError;
    }
    if (!resolved) {
      const protectedSite = /captcha|sign in|login|cookies|forbidden|403|unsupported url|drm/i.test(extractorError);
      return res.status(422).json({
        ok: false,
        reason: protectedSite ? 'SITE_ACCESS_BLOCKED' : 'VIDEO_SOURCE_HIDDEN',
        message: protectedSite
          ? 'Site oynatıcı erişimini engelledi. Giriş, CAPTCHA, bölge veya bot koruması olabilir.'
          : 'Dinamik oynatıcı ve sayfa kaynağı tarandı ancak indirilebilir video bulunamadı.',
        technicalDetail: extractorError
          ? extractorError.replace(/https?:\/\/\S+/g, '[adres]').slice(0, 280)
          : 'Extractor ve HTML taraması sonuç vermedi.'
      });
    }

    const token = crypto.randomBytes(18).toString('hex');
    resolvedVideoSessions.set(token, {
      sourceUrl: resolved.sourceUrl,
      referer: resolved.pageUrl,
      cookie: resolved.cookie,
      type: resolved.type,
      userAgent: resolved.userAgent,
      extractor: resolved.extractor,
      // Stream-first analysis seeks through this proxy throughout analysis and
      // later gameplay, so the source session must outlive a long mobile run.
      expiresAt: Date.now() + 4 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      type: resolved.type,
      sourceUrl: resolved.sourceUrl,
      pageUrl: resolved.pageUrl,
      proxyUrl: `/api/video-proxy?token=${encodeURIComponent(token)}`,
      cached: cacheHit,
      resolveMs: Date.now() - startedAt
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
  const controller = new AbortController();
  let upstreamStream;
  let transcoder;
  let forceKillTimer;
  let conversionTimer;
  const headerTimer = setTimeout(() => controller.abort(new Error('VIDEO_SOURCE_TIMEOUT')), 30000);
  const stopUpstream = () => {
    upstreamStream?.destroy();
    if (transcoder && transcoder.exitCode === null && transcoder.signalCode === null) {
      transcoder.kill('SIGTERM');
      forceKillTimer = setTimeout(() => transcoder.kill('SIGKILL'), 5000);
      forceKillTimer.unref();
    }
  };
  controller.signal.addEventListener('abort', stopUpstream, { once: true });
  res.once('close', () => {
    clearTimeout(headerTimer);
    clearTimeout(conversionTimer);
    controller.abort();
  });
  try {
    const token = String(req.query.token || '');
    const session = token ? resolvedVideoSessions.get(token) : null;
    if (token && (!session || session.expiresAt <= Date.now())) {
      resolvedVideoSessions.delete(token);
      return res.status(410).json({ ok: false, reason: 'VIDEO_SESSION_EXPIRED', message: 'Video bağlantısının süresi doldu. Bağlantıyı yeniden aç.' });
    }
    const sourceUrl = String(session?.sourceUrl || req.query.url || '');
    const referer = String(session?.referer || req.query.referer || '');
    if (!sourceUrl) return res.status(400).json({ ok: false, message: 'Video URL’si gerekli.' });

    if (session?.type === 'hls' || /\.m3u8(?:$|\?)/i.test(sourceUrl)) {
      await validatePublicUrl(sourceUrl);
      if (referer) await validatePublicUrl(referer);
      controller.signal.throwIfAborted();
      const headerLines = [
        `User-Agent: ${session?.userAgent || 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36'}`,
        referer ? `Referer: ${referer}` : '',
        referer ? `Origin: ${new URL(referer).origin}` : '',
        session?.cookie ? `Cookie: ${session.cookie}` : ''
      ].filter(Boolean).join('\r\n') + '\r\n';
      const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-rw_timeout', '45000000',
        '-headers', headerLines,
        '-i', sourceUrl,
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4', 'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      transcoder = ffmpeg;
      // The response owns this process. Completing the incoming GET request
      // does not mean that its video response has finished.
      ffmpeg.stdout.once('data', () => clearTimeout(headerTimer));
      ffmpeg.stdout.on('error', error => {
        if (!res.destroyed) res.destroy(error);
      });

      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      ffmpeg.on('error', error => {
        console.error('HLS ffmpeg start error:', error?.message || error);
        if (res.destroyed) return;
        if (!res.headersSent) res.status(502).json({ ok: false, message: 'HLS dönüştürücü başlatılamadı.' });
        else res.destroy(error);
      });
      ffmpeg.on('close', code => {
        clearTimeout(headerTimer);
        clearTimeout(conversionTimer);
        clearTimeout(forceKillTimer);
        if (code && !res.writableEnded && !controller.signal.aborted) {
          console.error('HLS ffmpeg error:', stderr || `exit ${code}`);
          res.destroy(new Error('HLS_VIDEO_CONVERSION_FAILED'));
        }
      });
      conversionTimer = setTimeout(() => { controller.abort(); res.destroy(); }, 30 * 60 * 1000);
      controller.signal.addEventListener('abort', () => {
        if (!res.destroyed) res.destroy();
      }, { once: true });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'private, no-store');
      ffmpeg.stdout.pipe(res);
      return;
    }

    const headers = {
      'User-Agent': session?.userAgent || 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36'
    };
    if (req.headers.range) headers.Range = req.headers.range;
    if (referer) {
      await validatePublicUrl(referer);
      headers.Referer = referer;
      headers.Origin = new URL(referer).origin;
    }
    if (session?.cookie) headers.Cookie = session.cookie;

    const { response } = await fetchPublicUrl(sourceUrl, { headers, timeoutMs: 0, signal: controller.signal });
    clearTimeout(headerTimer);
    if (controller.signal.aborted || res.destroyed) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel();
      return res.status(response.status).json({ ok: false, message: `Video sunucusu ${response.status} yanıtı verdi.` });
    }
    if (!response.body) throw new Error('Video kaynağı boş yanıt verdi.');

    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    res.status(response.status);
    const stream = Readable.fromWeb(response.body);
    upstreamStream = stream;
    // Preserve long video transfers while bounding a source that stops sending.
    res.setTimeout(45000, () => { controller.abort(); res.destroy(); });
    stream.on('error', error => {
      if (!controller.signal.aborted) {
        console.error('Video proxy stream error:', error?.message || error);
      }
    });
    pipeline(stream, res, () => {});
  } catch (error) {
    clearTimeout(headerTimer);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy(error);
    const timedOut = controller.signal.reason?.message === 'VIDEO_SOURCE_TIMEOUT';
    res.status(timedOut ? 504 : 502).json({ ok: false, reason: timedOut ? 'VIDEO_SOURCE_TIMEOUT' : 'VIDEO_PROXY_ERROR', message: timedOut ? 'Video kaynağı zamanında yanıt vermedi. Tekrar deneyebilirsin.' : error?.message || 'Video aktarılamadı.' });
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
  limit: '10mb'
});

app.post('/api/dialogue-upload/start', async (req, res) => {
  try {
    const totalSize = Number(req.body?.totalSize || 0);
    const fileName = String(req.body?.fileName || 'dialogue.wav')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const mimeType = String(req.body?.mimeType || 'audio/wav');

    if (
      !Number.isSafeInteger(totalSize) ||
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

    if (session.writing) {
      return res.status(409).json({ available: false, reason: 'CHUNK_WRITE_IN_PROGRESS', retryable: true });
    }

    if (chunkIndex < session.nextChunk) {
      return res.json({
        available: true,
        duplicate: true,
        receivedSize: session.receivedSize,
        nextChunk: session.nextChunk
      });
    }

    if (chunkIndex !== session.nextChunk || !Buffer.isBuffer(req.body) || !req.body.length) {
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

    session.writing = true;
    session.updatedAt = Date.now();
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
      // appendFile can fail after writing some bytes. Remove that partial tail
      // before accepting a retry of the same index.
      try { await fs.promises.truncate(session.filePath, session.receivedSize); }
      catch {
        dialogueUploadSessions.delete(uploadId);
        await fs.promises.unlink(session.filePath).catch(() => {});
      }
      return res.status(500).json({
        available: false,
        reason: 'CHUNK_WRITE_FAILED',
        message: error.message || String(error)
      });
    } finally {
      session.writing = false;
      session.updatedAt = Date.now();
    }
  }
);

setInterval(() => {
  const expiry = Date.now() - 60 * 60 * 1000;

  for (const [uploadId, session] of dialogueUploadSessions) {
    if (session.writing || session.updatedAt >= expiry) continue;

    dialogueUploadSessions.delete(uploadId);
    fs.promises.unlink(session.filePath).catch(() => {});
  }
}, 10 * 60 * 1000).unref();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));


function parseGeminiOffsetSeconds(value) {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  return match ? Number(match[1]) : 0;
}

function extractTranscribeWordAnnotations(interaction) {
  const words = [];
  for (const step of interaction?.steps ?? []) {
    for (const content of step?.content ?? []) {
      for (const annotation of content?.annotations ?? []) {
        if (annotation?.type !== 'word_info') continue;
        const text = String(annotation.text || '').trim();
        if (!text) continue;
        words.push({ text, speakerId: String(annotation.speaker || 'spk_unknown'), startTime: parseGeminiOffsetSeconds(annotation.start_offset), endTime: parseGeminiOffsetSeconds(annotation.end_offset) });
      }
    }
  }
  return words.sort((a, b) => a.startTime - b.startTime);
}

function groupTranscribeWords(words) {
  const groups = [];
  for (const word of words) {
    const last = groups.at(-1);
    const speakerChanged = last && last.speakerId !== word.speakerId;
    const gap = last ? Math.max(0, word.startTime - last.endTime) : 0;
    const tooLong = last ? word.endTime - last.startTime >= 7 : false;
    if (!last || speakerChanged || gap > 1.15 || tooLong) {
      groups.push({ speakerId: word.speakerId, startTime: word.startTime, endTime: word.endTime, words: [word.text] });
    } else {
      last.endTime = Math.max(last.endTime, word.endTime);
      last.words.push(word.text);
    }
  }
  return groups.map((group, index) => ({
    segmentId: `asr-${String(index + 1).padStart(3, '0')}`,
    speakerId: group.speakerId,
    startTime: group.startTime,
    endTime: group.endTime,
    originalText: group.words.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
  }));
}

async function transcribeDialogueGemini35(ai, remoteFile) {
  const interaction = await ai.interactions.create({
    model: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
    input: [{ type: 'audio', uri: remoteFile.uri, mime_type: remoteFile.mimeType }],
    generation_config: {
      transcription_config: {
        language_codes: [],
        mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] }
      }
    }
  });
  const words = extractTranscribeWordAnnotations(interaction);
  return { transcriptText: String(interaction?.output_text || '').trim(), words, segments: groupTranscribeWords(words) };
}

app.post(
  '/api/gemini-dialogue-analyze',
  dialogueUpload.single('video'),
  async (req, res) => {
    const dialogueUsage = emptyGeminiUsage();
    const uploadId = String(req.body?.uploadId || '');
    const uploadSession = dialogueUploadSessions.get(uploadId);

    if (!req.file && uploadSession) {
      if (uploadSession.writing || uploadSession.receivedSize !== uploadSession.totalSize) {
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

    const apiKey = resolveGeminiApiKey(req);
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
Analyze audible dialogue and separately observe non-speech human vocal reactions in this video.

VOICE IDENTITY CONTEXT:
- Use voice continuity and diarization to keep every audible speaker distinct.
- This is an audio-first subtitle pass. Do not guess family relationships or character identities.

LANGUAGE DETECTION AND TURKISH TRANSLATION:
- Automatically identify the actual spoken source language from the audio; never assume it is English.
- Support every detectable language and dialect, including multilingual conversations and speakers switching languages inside the same video.
- Treat clear non-English speech as valid dialogue, never as silence or unintelligible audio merely because of its language.
- Transcribe each clearly audible line faithfully in its original language into originalText.
- Perform a second careful listening pass for low-volume speech: whispers, murmured words, breathy speech, short replies, overlapping dialogue and off-screen speakers. If words are intelligible, include them even when much quieter than music or other vocal sounds.
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
      "speakerName": "Kadın sesi A|Kadın sesi B|Erkek sesi A|Erkek sesi B|Ses A",
      "relationshipRole": "unknown",
      "roleConfidence": 0.0,
      "roleEvidence": "brief visible or spoken evidence",
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
      "speakerName": "same stable name used for this speaker",
      "gender": "female|male|uncertain",
      "originalText": "exact spoken dialogue",
      "turkishText": "natural Turkish translation",
      "emotion": "neutral|happy|sad|angry|afraid|excited|whispering|uncertain",
      "confidence": 0.0
    }
  ],
  "nonSpeechEvents": [
    {
      "eventId": "snd-001",
      "startTime": 0.0,
      "endTime": 2.5,
      "speakerId": "speaker-01|unknown",
      "soundType": "breathing|moan|laughter|crying|vocal_reaction|mixed|unclear",
      "intensity": "low|moderate|high|unclear",
      "confidence": 0.0,
      "evidence": "short audible observation without interpreting an internal state"
    }
  ],
  "warnings": []
}

Rules:
- Use seconds as numbers for startTime and endTime.
- Preserve chronological order.
- Identify and consistently separate different speakers.
- Give every distinct speaker one stable Turkish speakerName and reuse it in every segment.
- Keep people distinct with stable voice labels such as "Kadın sesi A", "Kadın sesi B", "Erkek sesi A" and "Erkek sesi B".
- Never guess personal names or family roles from voice alone.
- Do not reuse one speakerName for two different voices and do not change a person's name between segments.
- Detect speaker gender only from audible and visible evidence; otherwise use uncertain.
- Transcribe speech faithfully without inventing words.
- Transcribe and translate every intelligible spoken word without censorship, sanitization, euphemism, summarization, or omission, including quiet, whispered, breathy, overlapping and sexually explicit speech.
- Preserve profanity, slang, sexual or adult vocabulary, commands, reactions, and intensity exactly in natural Turkish.
- Never replace words with asterisks, softened expressions, generic summaries, or skipped segments.
- Treat every speaker equally and include every intelligible spoken line regardless of its subject.
- Preserve the meaning, tone and emotion of the original dialogue.
- Split long speech into readable subtitle segments, normally 1 to 7 seconds.
- Do not include music, breathing, moans, sound effects or silence as dialogue. Put only clearly audible human breathing, moans, laughter, crying or vocal reactions in nonSpeechEvents without transcribing them as words.
- Measure non-speech intensity from relative loudness, repetition and audible change over time. Never infer pain, pleasure, consent or identity from a sound alone.
- If there is no intelligible speech, return hasDialogue false and an empty segments array.
- Never add dialogue that is not audible in the source video.
`;

      const audioMime = String(remoteFile.mimeType || req.file.mimetype || '').toLowerCase();
      let asr = null;
      if (audioMime.startsWith('audio/')) {
        try {
          asr = await transcribeDialogueGemini35(ai, remoteFile);
        } catch (error) {
          // Interactions/transcribe may be unavailable for an account, region or
          // model rollout. It is an enhancement, not a hard dependency: the
          // multimodal dialogue request below can still produce timed Turkish
          // subtitles directly from the uploaded audio.
          console.warn(
            '[gemini-transcribe-fallback] dedicated transcription unavailable:',
            error?.message || error
          );
        }
      }

      const transcriptGrounding = asr?.segments?.length
        ? `\nGEMINI 3.5 TRANSCRIBE GROUND TRUTH:\n${JSON.stringify(asr.segments)}\n\n- Preserve every supplied segmentId, speakerId, startTime and endTime exactly.\n- originalText comes from the dedicated transcription model; do not paraphrase it.\n- Translate originalText into natural Turkish and infer gender/emotion conservatively from the audio.\n- Do not merge, split, reorder or retime these grounded segments.\n`
        : '';

      let parsed = null;
      let lastDialogueError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await ai.models.generateContent({
            model: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.1-flash-lite',
            contents: [{
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: remoteFile.uri,
                    mimeType: remoteFile.mimeType || req.file.mimetype
                  }
                },
                { text: prompt + transcriptGrounding }
              ]
            }],
            config: {
              responseMimeType: 'application/json',
              temperature: 0.05,
              maxOutputTokens: 16384
            }
          });
          addGeminiUsage(dialogueUsage, response?.usageMetadata);
          const raw = String(response.text || '').trim();
          if (!raw) throw new Error('GEMINI_EMPTY_JSON_RESPONSE');
          parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
          break;
        } catch (error) {
          lastDialogueError = error;
          const details = String(error?.message || error);
          const retryable = details.includes('Unexpected end of JSON input') || details.includes('GEMINI_EMPTY_JSON_RESPONSE') || details.includes('503') || details.includes('UNAVAILABLE') || details.includes('high demand');
          if (!retryable || attempt === 3) break;
          console.warn(`[gemini-dialogue-retry] attempt ${attempt}/3: ${details}`);
          await wait(attempt * 1400);
        }
      }

      // If multimodal enrichment returns empty/truncated output but dedicated ASR succeeded,
      // translate in bounded batches so a long response cannot silently lose later lines.
      if (!parsed && asr?.segments?.length) {
        console.warn('[gemini-dialogue-fallback] switching to text-only Turkish translation');
        const translationInput = asr.segments.map(({ segmentId, originalText }) => ({ segmentId, originalText }));
        const translatedSegments = [];
        for (let offset = 0; offset < translationInput.length; offset += 30) {
          const batch = translationInput.slice(offset, offset + 30);
          let translatedBatch = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const translationResponse = await ai.models.generateContent({
                model: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.1-flash-lite',
                contents: [{ role: 'user', parts: [{ text: `Translate every supplied dialogue segment into natural Turkish. Preserve segmentId exactly. Do not omit, censor, summarize, merge, split or reorder lines. Return JSON only as {\"segments\":[{\"segmentId\":\"...\",\"turkishText\":\"...\",\"gender\":\"male|female|uncertain\",\"emotion\":\"...\",\"confidence\":0.0}]}\n\nSEGMENTS:\n${JSON.stringify(batch)}` }] }],
                config: { responseMimeType: 'application/json', temperature: 0.05, maxOutputTokens: 8192 }
              });
              addGeminiUsage(dialogueUsage, translationResponse?.usageMetadata);
              const raw = String(translationResponse.text || '').trim();
              if (!raw) throw new Error('GEMINI_EMPTY_TEXT_TRANSLATION');
              translatedBatch = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
              break;
            } catch (error) {
              lastDialogueError = error;
              console.warn(`[gemini-dialogue-text-fallback-retry] batch ${offset / 30 + 1}, attempt ${attempt}/3: ${error?.message || error}`);
              if (attempt < 3) await wait(attempt * 1200);
            }
          }
          if (!translatedBatch?.segments?.length) throw lastDialogueError || new Error('GEMINI_TRANSLATION_BATCH_FAILED');
          translatedSegments.push(...translatedBatch.segments);
        }
        parsed = { hasDialogue: true, segments: translatedSegments, fallbackMode: 'asr-text-translation' };
      }

      if (!parsed && asr?.segments?.length) {
        throw lastDialogueError || new Error('GEMINI_TURKISH_TRANSLATION_REQUIRED');
      }

      if (!parsed) throw lastDialogueError || new Error('GEMINI_DIALOGUE_JSON_PARSE_FAILED');

      if (asr?.segments?.length) {
        const enriched = new Map((Array.isArray(parsed.segments) ? parsed.segments : []).map(item => [String(item.segmentId || ''), item]));
        const missingTranslations = asr.segments.filter(item =>
          !String(enriched.get(item.segmentId)?.turkishText || '').trim()
        );

        // Translate omitted ASR lines in small batches. This prevents a long
        // JSON response from silently dropping speech near the end of a video.
        for (let offset = 0; offset < missingTranslations.length; offset += 40) {
          const batch = missingTranslations.slice(offset, offset + 40)
            .map(({ segmentId, originalText }) => ({ segmentId, originalText }));
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const response = await ai.models.generateContent({
                model: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.1-flash-lite',
                contents: [{ role: 'user', parts: [{ text: `Translate ALL supplied speech lines into natural Turkish. Preserve every segmentId. Preserve profanity, slang and sexually explicit wording literally and naturally; never soften it. Never omit, merge, censor, summarize or reorder a line. Return JSON only as {"segments":[{"segmentId":"...","turkishText":"...","gender":"male|female|uncertain","emotion":"...","confidence":0.0}]}\n\nSEGMENTS:\n${JSON.stringify(batch)}` }] }],
                config: { responseMimeType: 'application/json', temperature: 0.02, maxOutputTokens: 8192 }
              });
              addGeminiUsage(dialogueUsage, response?.usageMetadata);
              const recovered = JSON.parse(String(response.text || '').trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
              for (const item of recovered.segments || []) {
                const id = String(item.segmentId || '');
                if (id) enriched.set(id, { ...(enriched.get(id) || {}), ...item });
              }
              break;
            } catch (error) {
              console.warn(`[missing-subtitle-translation-retry] batch ${offset / 40 + 1}, attempt ${attempt}: ${error?.message || error}`);
              if (attempt < 3) await wait(attempt * 900);
            }
          }
        }

        const untranslated = asr.segments.filter(grounded =>
          !String(enriched.get(grounded.segmentId)?.turkishText || '').trim()
        );
        if (untranslated.length) {
          throw new Error(`GEMINI_TRANSLATION_INCOMPLETE:${untranslated.length}/${asr.segments.length}`);
        }

        const groundedSegments = asr.segments.map(grounded => {
          const item = enriched.get(grounded.segmentId) || {};
          return { ...item, segmentId: grounded.segmentId, speakerId: grounded.speakerId, startTime: grounded.startTime, endTime: grounded.endTime, originalText: grounded.originalText, turkishText: String(item.turkishText).trim() };
        });

        // The multimodal pass can recover whispers and overlapping lines missed
        // by dedicated ASR. Preserve unique timed lines from both passes.
        const groundedIds = new Set(asr.segments.map(item => String(item.segmentId || '')));
        const supplementalSegments = (Array.isArray(parsed.segments) ? parsed.segments : [])
          .filter(item => !groundedIds.has(String(item.segmentId || '')))
          .filter(item => {
            const start = Number(item.startTime);
            const end = Number(item.endTime);
            const text = String(item.originalText || item.turkishText || '').trim();
            if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
            return !groundedSegments.some(grounded => {
              const overlap = Math.max(
                0,
                Math.min(end, grounded.endTime) - Math.max(start, grounded.startTime)
              );
              const shortest = Math.max(
                0.05,
                Math.min(end - start, grounded.endTime - grounded.startTime)
              );
              return overlap / shortest >= 0.72;
            });
          })
          .map((item, index) => ({
            ...item,
            segmentId: String(item.segmentId || `quiet-${String(index + 1).padStart(3, '0')}`),
            originalText: String(item.originalText || item.turkishText || '').trim(),
            turkishText: String(item.turkishText || item.originalText || '').trim()
          }));

        parsed.segments = [...groundedSegments, ...supplementalSegments]
          .sort((a, b) => Number(a.startTime) - Number(b.startTime));
        parsed.transcriptionEngine = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe';
      }

      const duration = Math.max(0, Number(req.body?.duration || 0));
      const parsedSpeakers = Array.isArray(parsed.speakers) ? parsed.speakers : [];
      const speakerProfiles = new Map();
      let neutralFemaleCount = 0;
      let neutralMaleCount = 0;
      let neutralUnknownCount = 0;

      for (const item of parsedSpeakers) {
        const speakerId = String(item?.speakerId || '').trim();
        if (!speakerId) continue;
        const gender = ['female', 'male'].includes(item.gender) ? item.gender : 'uncertain';
        let speakerName = String(item.speakerName || item.displayName || '').trim();
        if (!speakerName) {
          if (gender === 'female') speakerName = `Kadın sesi ${String.fromCharCode(64 + ++neutralFemaleCount)}`;
          else if (gender === 'male') speakerName = `Erkek sesi ${String.fromCharCode(64 + ++neutralMaleCount)}`;
          else speakerName = `Ses ${String.fromCharCode(64 + ++neutralUnknownCount)}`;
        }
        speakerProfiles.set(speakerId, { ...item, speakerId, gender, speakerName });
      }

      const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
        .map((segment, index) => {
          const speakerId = String(segment.speakerId || 'speaker-uncertain');
          const gender = ['female', 'male'].includes(segment.gender)
            ? segment.gender
            : (speakerProfiles.get(speakerId)?.gender || 'uncertain');
          let profile = speakerProfiles.get(speakerId);
          if (!profile) {
            let speakerName = String(segment.speakerName || '').trim();
            if (!speakerName) {
              if (gender === 'female') speakerName = `Kadın sesi ${String.fromCharCode(64 + ++neutralFemaleCount)}`;
              else if (gender === 'male') speakerName = `Erkek sesi ${String.fromCharCode(64 + ++neutralMaleCount)}`;
              else speakerName = `Ses ${String.fromCharCode(64 + ++neutralUnknownCount)}`;
            }
            profile = { speakerId, gender, speakerName, relationshipRole: 'unknown', roleConfidence: 0 };
            speakerProfiles.set(speakerId, profile);
          }
          return ({
          segmentId: `dlg-${String(index + 1).padStart(3, '0')}`,
          startTime: Math.max(0, Number(segment.startTime || 0)),
          endTime: Math.max(0, Number(segment.endTime || 0)),
          speakerId,
          speakerName: profile.speakerName,
          gender,
          originalText: String(segment.originalText || segment.turkishText || '').trim(),
          turkishText: String(segment.turkishText || segment.originalText || '').trim(),
          emotion: String(segment.emotion || 'uncertain'),
          confidence: Math.max(0, Math.min(1, Number(segment.confidence || 0)))
        });})
        .filter(segment =>
          segment.originalText &&
          segment.turkishText &&
          segment.endTime > segment.startTime &&
          (!duration || segment.startTime <= duration)
        )
        .sort((a, b) => a.startTime - b.startTime);

      const nonSpeechEvents = (Array.isArray(parsed.nonSpeechEvents) ? parsed.nonSpeechEvents : [])
        .map((event, index) => ({
          eventId: String(event.eventId || `snd-${String(index + 1).padStart(3, '0')}`),
          startTime: Math.max(0, Number(event.startTime || 0)),
          endTime: Math.max(0, Number(event.endTime || 0)),
          speakerId: String(event.speakerId || 'unknown'),
          soundType: ['breathing', 'moan', 'laughter', 'crying', 'vocal_reaction', 'mixed'].includes(String(event.soundType || '').toLowerCase()) ? String(event.soundType).toLowerCase() : 'unclear',
          intensity: ['low', 'moderate', 'high'].includes(String(event.intensity || '').toLowerCase()) ? String(event.intensity).toLowerCase() : 'unclear',
          confidence: Math.max(0, Math.min(1, Number(event.confidence || 0))),
          evidence: String(event.evidence || '').trim()
        }))
        .filter(event => event.endTime > event.startTime && event.confidence >= 0.55 && (!duration || event.startTime <= duration))
        .sort((a, b) => a.startTime - b.startTime);

      dialogueLastSuccessAt = Date.now();
      dialogueQuotaBlockedUntil = 0;
      return res.json({
        available: true,
        hasDialogue: segments.length > 0,
        sourceLanguage: String(parsed.sourceLanguage || 'unknown'),
        summaryTr: String(parsed.summaryTr || ''),
        speakers: [...speakerProfiles.values()],
        segments,
        nonSpeechEvents,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        transcriptionEngine: String(parsed.transcriptionEngine || 'gemini-3.8-flash-fallback'),
        translationEngine: process.env.GEMINI_DIALOGUE_MODEL || 'gemini-3.1-flash-lite',
        dubbingEngine: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        aiUsage: dialogueUsage
      });
    } catch (error) {
      console.error('Dialogue analysis failed:', error);
      const details = String(error?.message || error);
      if (details.includes('RESOURCE_EXHAUSTED') || details.includes('429') || details.includes('quota')) {
        dialogueQuotaBlockedUntil = Date.now() + (ttsQuotaRetrySeconds(details) || 3600) * 1000;
      }
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
          const cleanupAi = new GoogleGenAI({ apiKey });
          await cleanupAi.files.delete({ name: uploadedFile.name });
        } catch (cleanupError) {
          console.error('Gemini file cleanup failed:', cleanupError);
        }
      }
    }
  }
);



let ttsQuotaBlockedUntil = 0;
let ttsLastSuccessAt = 0;
let dialogueLastSuccessAt = 0;
let dialogueQuotaBlockedUntil = 0;

function ttsQuotaRetrySeconds(details) {
  const retry = String(details || '').match(/retry(?:Delay| in)?[^0-9]*(\d+(?:\.\d+)?)s/i);
  if (retry) return Math.max(1, Math.ceil(Number(retry[1])));
  const human = String(details || '').match(/Please retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!human) return 0;
  return Math.max(1, Math.ceil((Number(human[1]) || 0) * 3600 + (Number(human[2]) || 0) * 60 + (Number(human[3]) || 0)));
}

function isTtsDailyQuotaError(details) {
  const text = String(details || '');
  return text.includes('generate_requests_per_model_per_day') ||
    (text.includes('RESOURCE_EXHAUSTED') && /gemini-[\w.-]+-tts/i.test(text));
}

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


app.post('/api/gemini-dub-segment', async (req, res) => {
  try {
    const customApiKey = clientGeminiApiKey(req);
    if (!customApiKey && ttsQuotaBlockedUntil > Date.now()) {
      return res.status(429).json({
        available: false,
        reason: 'GEMINI_TTS_DAILY_LIMIT',
        message: 'Gemini TTS günlük kotası doldu. Kota yenilendiğinde dublaj otomatik tekrar kullanılabilir.',
        retryAfterSeconds: Math.max(1, Math.ceil((ttsQuotaBlockedUntil - Date.now()) / 1000)),
        retryable: false
      });
    }
    const apiKey = customApiKey || String(process.env.GEMINI_API_KEY || '').trim();
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
      model: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
      contents: [{
        role: 'user',
        parts: [{
          text:
            `Read the following Turkish line exactly as written, including any ` +
            `profanity, slang or sexually explicit wording without censoring, softening or skipping it. ` +
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
    const aiUsage = addGeminiUsage(emptyGeminiUsage(), response?.usageMetadata);

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

    ttsLastSuccessAt = Date.now();
    ttsQuotaBlockedUntil = 0;
    return res.json({
      available: true,
      speakerId,
      gender,
      voiceName,
      aiUsage,
      mimeType: isRawPcm ? 'audio/wav' : sourceMime,
      audioBase64: finalData
    });
  } catch (error) {
    console.error('Gemini dub generation failed:', error);
    const details = String(error?.message || error);
    if (isTtsDailyQuotaError(details)) {
      const retryAfterSeconds = ttsQuotaRetrySeconds(details) || 3600;
      if (!customApiKey) ttsQuotaBlockedUntil = Date.now() + retryAfterSeconds * 1000;
      return res.status(429).json({
        available: false,
        reason: 'GEMINI_TTS_DAILY_LIMIT',
        message: 'Gemini 3.1 Flash TTS günlük 100 istek kotası doldu.',
        retryAfterSeconds,
        retryable: false
      });
    }
    return res.status(502).json({
      available: false,
      reason: 'GEMINI_DUB_ERROR',
      message: 'Türkçe dublaj sesi üretilemedi.',
      error: details
    });
  }
});

const elevenLabsVoiceCache = new Map();

async function elevenLabsRequest(apiKey, path, options = {}) {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(60000), options.signal].filter(Boolean)),
    headers: {
      'xi-api-key': apiKey,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const error = new Error(`ELEVENLABS_${response.status}: ${details.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function elevenVoiceGender(voice) {
  const labels = voice?.labels || voice?.sharing?.labels || {};
  const text = [labels.gender, voice?.description, voice?.name].filter(Boolean).join(' ').toLowerCase();
  if (/female|woman|kadın/.test(text)) return 'female';
  if (/male|man|erkek/.test(text)) return 'male';
  return 'uncertain';
}

function scoreElevenVoice(voice, gender) {
  const name = String(voice?.name || '').toLowerCase();
  const description = String(voice?.description || '').toLowerCase();
  const labels = voice?.labels || voice?.sharing?.labels || {};
  const verifiedLanguages = Array.isArray(voice?.verified_languages)
    ? voice.verified_languages
    : [];
  const languageEvidence = [
    description,
    name,
    ...Object.values(labels),
    voice?.fine_tuning?.language,
    voice?.fine_tuning?.locale,
    ...verifiedLanguages.flatMap(item => [
      item?.language,
      item?.locale,
      item?.accent
    ])
  ].filter(Boolean).join(' ').toLowerCase();
  const detected = elevenVoiceGender(voice);
  let score = detected === gender ? 100 : detected === 'uncertain' ? 10 : -100;
  // Prefer a voice explicitly verified for Turkish. The old selector ignored
  // verified_languages/fine_tuning metadata and fell back to Bella/George.
  if (/\b(?:tr-tr|turkish|türkçe|türk)\b/.test(languageEvidence)) score += 1200;
  if (verifiedLanguages.some(item => /^(?:tr|tr-tr)$/i.test(String(item?.language || item?.locale || '')))) score += 500;
  if (/conversational|natural|warm|soft|calm|professional/.test(description)) score += 18;
  if (/narration|news|storyteller/.test(description)) score -= 8;
  if (/^(?:bella|george)$/.test(name)) score -= 250;
  if (voice?.is_owner === true) score += 20;
  return score;
}

async function elevenLabsVoices(apiKey, force = false) {
  const cacheKey = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 20);
  const cached = elevenLabsVoiceCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await elevenLabsRequest(apiKey, '/v2/voices?page_size=100');
  const body = await response.json();
  const voices = Array.isArray(body?.voices) ? body.voices.filter(item => item?.voice_id) : [];
  const pick = (gender, excludedVoiceId = '') => {
    const candidates = [...voices]
      .filter(voice => voice.voice_id !== excludedVoiceId)
      .filter(voice => elevenVoiceGender(voice) !== (gender === 'male' ? 'female' : 'male'));
    const withoutLegacy = candidates.filter(voice => !/^(?:bella|george)$/i.test(String(voice?.name || '')));
    return (withoutLegacy.length ? withoutLegacy : candidates)
      .sort((a, b) => scoreElevenVoice(b, gender) - scoreElevenVoice(a, gender))[0] || null;
  };
  const female = pick('female');
  const male = pick('male', female?.voice_id);
  const value = { voices, female, male };
  elevenLabsVoiceCache.set(cacheKey, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
  return value;
}

async function elevenLabsSubscription(apiKey) {
  const response = await elevenLabsRequest(apiKey, '/v1/user/subscription');
  return response.json();
}

async function elevenLabsSynthesize({ apiKey, text, gender, voiceId = '', seed, previousText = '', nextText = '' }) {
  const voiceSet = await elevenLabsVoices(apiKey);
  const requested = String(voiceId || '').trim();
  const voice = voiceSet.voices.find(item => item.voice_id === requested) ||
    (gender === 'male' ? voiceSet.male : voiceSet.female || voiceSet.male);
  if (!voice?.voice_id) throw new Error('ELEVENLABS_VOICE_MISSING');
  const response = await elevenLabsRequest(
    apiKey,
    `/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        language_code: 'tr',
        seed: Number.isInteger(Number(seed)) ? Number(seed) : undefined,
        previous_text: String(previousText || '').slice(-600) || undefined,
        next_text: String(nextText || '').slice(0, 600) || undefined,
        voice_settings: {
          stability: 0.95,
          similarity_boost: 0.9,
          style: 0,
          use_speaker_boost: false,
          speed: 1
        }
      })
    }
  );
  return {
    voiceId: voice.voice_id,
    voiceName: voice.name || (gender === 'male' ? 'Erkek sesi' : 'Kadın sesi'),
    audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64')
  };
}

function elevenLabsErrorResponse(error, fallbackMessage) {
  const status = Number(error?.status) || 502;
  const text = String(error?.message || error).toLowerCase();
  const quota = status === 402 || /insufficient credits|credits? (?:are )?(?:depleted|exhausted)|character limit (?:reached|exceeded)/.test(text);
  const rateLimited = status === 429 && !quota;
  const forbidden = status === 401 || status === 403;
  return {
    status: quota ? 402 : rateLimited ? 429 : forbidden ? status : 502,
    body: {
      available: false,
      state: quota ? 'no_credits' : rateLimited ? 'rate_limited' : forbidden ? 'forbidden' : 'unavailable',
      reason: quota ? 'ELEVENLABS_QUOTA_LIMIT' : rateLimited ? 'ELEVENLABS_RATE_LIMIT' : forbidden ? 'ELEVENLABS_AUTH_ERROR' : 'ELEVENLABS_ERROR',
      retryAfterSeconds: rateLimited ? 3 : undefined,
      message: quota ? 'ElevenLabs kredisi tükendi.' : rateLimited ? 'ElevenLabs hız sınırı; kısa süre sonra yeniden denenecek.' : forbidden ? 'ElevenLabs anahtarı ya da izinleri geçersiz.' : fallbackMessage
    }
  };
}

app.post('/api/elevenlabs-status', async (req, res) => {
  const apiKey = clientElevenLabsApiKey(req);
  if (!apiKey) return res.status(400).json({ ok: false, state: 'invalid', message: 'Geçerli ElevenLabs anahtarı gönderilmedi.' });
  try {
    const [subscription, voices] = await Promise.all([
      elevenLabsSubscription(apiKey),
      elevenLabsVoices(apiKey, true)
    ]);
    if (!voices.female || !voices.male) {
      return res.status(422).json({ ok: false, state: 'unavailable', message: 'Kadın ve erkek için kullanılabilir iki ayrı ses bulunamadı.' });
    }
    const used = Math.max(0, Number(subscription?.character_count) || 0);
    const limit = Math.max(0, Number(subscription?.character_limit) || 0);
    const remaining = Math.max(0, limit - used);
    return res.json({
      ok: true,
      state: remaining > 0 ? 'available' : 'no_credits',
      remaining,
      limit,
      used,
      femaleVoice: voices.female.name,
      maleVoice: voices.male.name,
      femaleVoiceId: voices.female.voice_id,
      maleVoiceId: voices.male.voice_id,
      message: `ElevenLabs çalışıyor · ${remaining.toLocaleString('tr-TR')} kredi kaldı · Kadın: ${voices.female.name} · Erkek: ${voices.male.name}`
    });
  } catch (error) {
    const normalized = elevenLabsErrorResponse(error, 'ElevenLabs bağlantısı doğrulanamadı.');
    return res.status(normalized.status).json({ ok: false, ...normalized.body });
  }
});

app.post('/api/elevenlabs-dub-segment', async (req, res) => {
  const apiKey = clientElevenLabsApiKey(req);
  if (!apiKey) return res.status(400).json({ available: false, reason: 'ELEVENLABS_NOT_CONFIGURED' });
  const text = String(req.body?.text || '').trim();
  const gender = String(req.body?.gender || 'uncertain');
  const speakerId = String(req.body?.speakerId || 'speaker');
  const voiceId = String(req.body?.voiceId || '').trim();
  if (!text || text.length > 1200) return res.status(400).json({ available: false, reason: 'INVALID_DUB_TEXT' });
  try {
    const audio = await elevenLabsSynthesize({
      apiKey, text, gender, voiceId,
      seed: req.body?.seed,
      previousText: req.body?.previousText,
      nextText: req.body?.nextText
    });
    console.info('[elevenlabs-dub-ok]', JSON.stringify({
      speakerId: speakerId.slice(0, 80),
      gender,
      characters: text.length,
      voiceId: audio.voiceId
    }));
    return res.json({
      available: true,
      provider: 'elevenlabs',
      speakerId,
      gender,
      voiceId: audio.voiceId,
      voiceName: audio.voiceName,
      mimeType: 'audio/mpeg',
      audioBase64: audio.audioBase64
    });
  } catch (error) {
    console.warn('[elevenlabs-dub-error]', Number(error?.status) || 502, String(error?.message || error).slice(0, 700));
    const normalized = elevenLabsErrorResponse(error, 'ElevenLabs Türkçe dublaj sesi üretilemedi.');
    return res.status(normalized.status).json(normalized.body);
  }
});

app.post('/api/gemini-key-status', async (req, res) => {
  const apiKey = clientGeminiApiKey(req);
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      state: 'invalid',
      message: 'Geçerli bir Gemini API anahtarı gönderilmedi.'
    });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  try {
    const ai = new GoogleGenAI({ apiKey });
    await ai.models.generateContent({
      model,
      contents: 'Reply OK.',
      config: { maxOutputTokens: 1, temperature: 0 }
    });
    return res.json({
      ok: true,
      state: 'available',
      model,
      checkedAt: Date.now(),
      message: 'Anahtar çalışıyor ve analiz kotası kullanılabilir.'
    });
  } catch (error) {
    const details = String(error?.message || error);
    const normalized = details.toLowerCase();
    const retryAfterSeconds = ttsQuotaRetrySeconds(details) || 0;
    if (normalized.includes('api_key_invalid') || normalized.includes('api key not valid') || normalized.includes('invalid api key')) {
      return res.status(401).json({ ok: false, state: 'invalid', message: 'API anahtarı geçersiz.' });
    }
    if (normalized.includes('no credits') || normalized.includes('credit balance') || normalized.includes('prepay')) {
      return res.status(402).json({ ok: false, state: 'no_credits', message: 'Bu anahtara bağlı hesapta kullanılabilir kredi yok.' });
    }
    if (normalized.includes('resource_exhausted') || normalized.includes('429') || normalized.includes('quota')) {
      const daily = normalized.includes('per_day') || normalized.includes('per day') || normalized.includes('daily');
      return res.status(429).json({
        ok: false,
        state: daily ? 'daily_limit' : 'rate_limited',
        retryAfterSeconds,
        message: daily
          ? 'Bu projenin günlük ücretsiz kotası dolmuş.'
          : 'Anahtar şu anda hız/kota sınırında; biraz sonra tekrar denenebilir.'
      });
    }
    if (normalized.includes('permission_denied') || normalized.includes('403')) {
      return res.status(403).json({ ok: false, state: 'forbidden', message: 'Anahtarın Gemini modeline erişim izni yok.' });
    }
    return res.status(502).json({
      ok: false,
      state: 'unavailable',
      message: 'Anahtar şu anda doğrulanamadı; daha sonra tekrar dene.'
    });
  }
});

app.get('/api/ai-usage-status', (req, res) => {
  const now = Date.now();
  const customApiKey = clientGeminiApiKey(req);
  const configured = Boolean(customApiKey || process.env.GEMINI_API_KEY);
  const statusFor = (blockedUntil, lastSuccessAt, label) => {
    if (!configured) {
      return { state: 'unconfigured', available: false, message: `${label} için Gemini API anahtarı yapılandırılmamış.` };
    }
    if (blockedUntil > now) {
      return {
        state: 'blocked',
        available: false,
        retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000),
        lastSuccessAt: lastSuccessAt || null,
        remainingKnown: false,
        message: `${label} kotası şu anda engelli. Kalan kesin kredi miktarı Gemini tarafından paylaşılmıyor.`
      };
    }
    return {
      state: 'available',
      available: true,
      lastSuccessAt: lastSuccessAt || null,
      remainingKnown: false,
      message: lastSuccessAt
        ? `${label} son kullanımda çalıştı. Kalan kesin kredi miktarı Gemini tarafından paylaşılmıyor.`
        : `${label} yapılandırılmış. Kalan kesin kredi miktarı ilk istekten önce Gemini tarafından paylaşılmıyor.`
    };
  };

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    checkedAt: now,
    keySource: customApiKey ? 'browser_session' : 'server',
    subtitles: statusFor(customApiKey ? 0 : dialogueQuotaBlockedUntil, dialogueLastSuccessAt, 'Türkçe altyazı'),
    dubbing: statusFor(customApiKey ? 0 : ttsQuotaBlockedUntil, ttsLastSuccessAt, 'Türkçe dublaj')
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'source-video-interactive-app' });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ available: false, reason: 'API_NOT_FOUND', message: 'API adresi bulunamadı.' });
});

function handleRequestError(error, _req, res, next) {
  if (res.headersSent) return next(error);
  if (res.destroyed) return;
  const tooLarge = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large';
  const invalid = error instanceof multer.MulterError || error.type === 'entity.parse.failed';
  const unsupported = error.message === 'UNSUPPORTED_VIDEO_FORMAT';
  const status = tooLarge ? 413 : unsupported ? 415 : invalid ? 400 : 500;
  if (status === 500) console.error('Request failed:', error?.message || error);
  res.status(status).json({
    available: false,
    reason: tooLarge ? 'UPLOAD_TOO_LARGE' : unsupported ? 'UNSUPPORTED_VIDEO_FORMAT' : invalid ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
    message: tooLarge ? 'Gönderilen veri bu işlemin boyut sınırını aşıyor.' : unsupported ? 'Video biçimi desteklenmiyor.' : invalid ? 'Gönderilen veri geçersiz.' : 'İşlem tamamlanamadı. Tekrar deneyebilirsin.'
  });
}

app.use(handleRequestError);

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Source Video Interactive listening on ${PORT}`);
  console.log(`External analysis endpoint: ${EXTERNAL_ANALYSIS_URL}`);
});
