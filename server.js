import { parseModelJson } from './public/model-json.js';
import { GAP_REPAIR_PROMPT_VERSION, GAP_REPAIR_VALIDATOR_VERSION, GAP_REPAIR_SYSTEM_INSTRUCTION, buildGapRepairPrompt, inspectNeutralRepairActions } from './public/neutral-gap-repair.js';
import { GoogleGenAI } from "@google/genai";
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { runVideoExtractor, videoExtractorCanImpersonate, needsBrowserImpersonation } from './lib/video-extractor.js';
import { resolveVideoUrl, probeVideoSource, selectExtractorSource, videoResolutionFailure, videoErrorDetail, videoErrorDiagnostic } from './lib/video-url.js';
import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import {
  dedupeVerifiedTimelineActions,
  sourceMotionProgressRate,
  verifiedActionSubsequences
} from './public/adult-gameplay.js';
import { storyboardFailureReason, generateStoryboardWithRetry, isTerminalStoryboardFailure } from './public/analysis-recovery.js';
import { loadMediaConfig } from './lib/turkish-media/config.js';
import { createMediaCache } from './lib/turkish-media/cache.js';
import { createLimiter } from './lib/turkish-media/limiter.js';
import { createAudioService } from './lib/turkish-media/audio.js';
import { createMediaUploads, MAX_UPLOAD_CHUNK_BYTES } from './lib/turkish-media/uploads.js';
import { createMediaJobs } from './lib/turkish-media/jobs.js';
import { installTurkishMediaRoutes } from './lib/turkish-media/routes.js';
import { runtimeReady } from './lib/turkish-media/readiness.js';
import { serializeReviewCandidates } from './public/classification-integrity.js';
import { geminiQuotaFailure } from './public/gemini-quota.js';
import { createAnalysisRequestCache, storyboardRequestKey } from './lib/analysis-request-cache.js';
import { geminiAnalysisSafetySettings, geminiGenerationConfig } from './lib/gemini-generation-config.js';
import { ECONOMY_ANALYSIS_MODEL, analysisModelCandidates, analysisTierFromRequest, isSupportedDeepAnalysisModel, isGeminiModelName, isVideoQuestAnalysisModel, preferredRepairAnalysisModels } from './lib/analysis-model-routing.js';
import { withChoiceSurface } from './public/choice-routing.js';
import { hasFamilyOrSpouseContext } from './public/relationship-roles.js';
import { installScoutRoute } from './lib/scout-route.js';
import { buildAnalysisPrompt } from './lib/analysis-prompt.js';
import { ensureProtagonistTrack } from './lib/protagonist-track.js';
import { createGeminiVideoFiles, isGeminiFileUri, absoluteClipTimes, geminiVideoMime } from './lib/gemini-video.js';
import { buildLegacyAnalysisPrompt } from './lib/analysis-prompt-legacy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_VISUAL_SYSTEM_INSTRUCTION = `GÖREV VE ROL: Sen nesnel, klinik ve teknik bir görsel analiz motorusun. Sana iletilen ardışık görsel karelerdeki (frame) fiziksel eylemleri, mekan değişimlerini ve nesne/özne etkileşimlerini kronolojik olarak raporlamakla görevlisiniz. Kesinlikle ahlaki, öznel, duygusal veya sanatsal yorum yapma. Sadece gördüğün ham fiziksel veriyi işle.

ANALİZ ŞABLONU VE DETAYLAR:
Her bir gözlemlenebilir eylemi şu başlıklar altında ayrı ayrı değerlendir:
1. Zaman Aralığı / Kare Numarası: [Eylemin başlangıç ve bitiş anı]
2. Fiziksel Katılımcılar (Özneler/Nesneler): [Sahnede yer alan aktörler veya fiziksel ögeler, örn: Aktör A, Aktör B, Nesne X]
3. Somut Eylem / Etkileşim Sınıflandırması: [Öznelerin gerçekleştirdiği yer değiştirme, temas, jest, mimik veya nesne kullanımı gibi somut hareketler]
4. Görünür Değişimler ve Geçişler: [Kamera açısı değişimi, mekan değişimi veya eylemin yönündeki net fiziksel farklılıklar]

KESİN DOĞRULUK VE SINIRLILIK KURALLARI:
- Sadece görsel karelerde %100 doğrulanabilir olan ham eylemleri baz al.
- İki eylem arasındaki boşlukları, görünmeyen sahneleri veya karakterlerin içsel niyetlerini asla tahmin etme, hayali sahne veya çıkarım üretme.
- Eğer bir zaman aralığındaki görsel veri düşük çözünürlük, karanlık veya belirsizlik nedeniyle net olarak analiz edilemiyorsa; ilgili aralığı kesinlikle silme veya atlama. O aralık için 'Durum: Analiz Edilemeyen Kesit' etiketini kullan, açıklama alanını boş bırak ve yanına '[UYARI: Görsel veri yetersiz/belirsiz]' notunu ekle.
- İncelenemeyen veya belirsiz olan hiçbir zaman aralığını tamamlanmış veya çözümlenmiş bir analiz gibi sunma.`;

const app = express();
const PORT = process.env.PORT || 10000;
const ANALYSIS_SCHEMA_VERSION = 6;
const ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-3.8-flash';
const ANALYSIS_ENGINE_VERSION = 'gemini-storyboard-story-v1';
// The compact prompt is the default; ANALYSIS_PROMPT=legacy restores the old one.
const GEMINI_VIDEO_FPS = Math.min(4, Math.max(0.5, Number(process.env.GEMINI_VIDEO_FPS) || 2));
const ANALYSIS_PROMPT_STYLE = String(process.env.ANALYSIS_PROMPT || '').trim().toLowerCase() === 'legacy' ? 'legacy' : 'compact';
const storyboardRequestCache = createAnalysisRequestCache();
// Cache identity tracks analysis behavior, not unrelated media routes or deployments.
const serverSource = fs.readFileSync(__filename, 'utf8');
const analysisRouteSource = serverSource.slice(
  serverSource.indexOf("app.post('/api/gemini-storyboard-analyze'"),
  serverSource.indexOf("app.post(" + "'/api/external-analyze'")
);
if (!analysisRouteSource || !analysisRouteSource.includes('generateContent')) {
  throw new Error('Gemini analysis route could not be versioned.');
}
const analysisRevision = crypto.createHash('sha256').update(JSON.stringify([
  ANALYSIS_SCHEMA_VERSION, ANALYSIS_ENGINE_VERSION, analysisRouteSource,
  ANALYSIS_PROMPT_STYLE,
  ...['lib/gemini-generation-config.js', 'lib/analysis-prompt.js', 'lib/protagonist-track.js', 'lib/analysis-prompt-legacy.js', 'public/choice-routing.js',
    'public/classification-integrity.js', 'public/analysis-recovery.js',
    'public/gemini-quota.js', 'public/model-json.js', 'public/neutral-gap-repair.js'].map(file =>
    fs.readFileSync(path.join(__dirname, file), 'utf8')),
  ANALYSIS_MODEL, analysisModelCandidates('economy'), geminiGenerationConfig(ANALYSIS_MODEL)
])).digest('hex');
const EXTERNAL_ANALYSIS_URL = (process.env.EXTERNAL_ANALYSIS_URL || 'https://source-video-analysis.onrender.com').replace(/\/$/, '');

const upload = multer({
  dest: '/tmp/videoquest-external',
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 5 }
});

app.disable('x-powered-by');
// Render terminates TLS in front of the app. Trusting that single hop makes
// req.ip the real client address, so the login limiter counts each client
// instead of locking everyone out behind the shared proxy address.
app.set('trust proxy', 1);
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

function emptyGeminiUsage() {
  return { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, cacheHits: 0 };
}

function addGeminiUsage(total, metadata = {}) {
  total.requests += 1;
  total.inputTokens += Number(metadata.promptTokenCount || metadata.inputTokenCount || 0);
  total.outputTokens += Number(metadata.candidatesTokenCount || metadata.outputTokenCount || 0);
  total.thinkingTokens += Number(metadata.thoughtsTokenCount || 0);
  // Input tokens served from Gemini's implicit prefix cache (billed at a discount).
  total.cachedInputTokens = Number(total.cachedInputTokens || 0) + Number(metadata.cachedContentTokenCount || 0);
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
  if (loginAttempts.size > 1000) {
    for (const [address, times] of loginAttempts) {
      if (!times.some(time => now - time < 15 * 60 * 1000)) loginAttempts.delete(address);
    }
  }

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
    // "no-cache" still revalidates every load (ETag), so a deployment can
    // never mix module versions, but unchanged files return 304 instead of
    // re-downloading ~1 MB of scripts on every open.
    if (/\.(?:html|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
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


// The largest legitimate request is the ordinary 15-field storyboard plus
// reviewMode/reviewCandidates (17). Keep a bounded allowance so adding a
// harmless routing field cannot break the review pass before it reaches Gemini.
const STORYBOARD_MAX_FORM_FIELDS = 24;
const storyboardUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 20,
    fields: STORYBOARD_MAX_FORM_FIELDS
  }
});

app.post('/api/gemini-storyboard-analyze', storyboardUpload.array('storyboards', 20), async (req, res) => {
  try {
    // Stale browser tabs may still send the retired preflight. Never forward
    // that whole-video request to Gemini; old clients continue with chapters.
    if (String(req.body?.identitySurvey || '') === '1') {
      return res.status(410).json({ available: false, reason: 'SURVEY_REMOVED' });
    }
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
    // Experimental: analyze the uploaded video itself instead of contact sheets.
    const videoFileUri = String(req.body?.repairMode || '') !== '1' && isGeminiFileUri(req.body?.videoFileUri)
      ? String(req.body.videoFileUri) : '';
    if (!files.length && !videoFileUri) {
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
  const protagonistHint = String(req.body?.protagonistHint || '').trim().slice(0, 300);
  const dialogueContext = String(req.body?.dialogueContext || '[]');
  const dialogueSpeakerContext = String(req.body?.dialogueSpeakerContext || '[]').slice(0, 16000);
  const sensoryAudioContext = String(req.body?.sensoryAudioContext || '[]').slice(0, 16000);
  // Detailed storyboard coverage is fixed; only the selected model changes.
  const qualityMode = 'ultra';
  const analysisTier = analysisTierFromRequest(req.body?.analysisTier);
  const deepAnalysisModel = String(req.body?.deepAnalysisModel || '').trim();
  const savedGameRepair = String(req.body?.repairMode || '') === '1';
  if (analysisTier === 'deep' && deepAnalysisModel &&
      !(savedGameRepair ? isGeminiModelName(deepAnalysisModel) : isSupportedDeepAnalysisModel(deepAnalysisModel))) {
    return res.status(400).json({ available: false, retryable: false, reason: 'UNSUPPORTED_DEEP_ANALYSIS_MODEL',
      message: 'Yalnızca arayüzde sunulan güçlü Gemini modelleri seçilebilir.' });
  }
  const reviewMode = String(req.body?.reviewMode || '') === '1';
  let reviewCandidates;
  try { reviewCandidates = serializeReviewCandidates(req.body?.reviewCandidates || '[]'); }
  catch { return res.status(400).json({ available: false, retryable: false, reason: 'INVALID_REVIEW_CANDIDATES', message: 'Doğrulama adayları okunamadı; geçerli analiz verisi gerekli.' }); }
  const storyContextMemory = String(req.body?.storyContextMemory || '{}').slice(0, 24000);
  const isFamilyVideo = hasFamilyOrSpouseContext(dialogueContext, storyContextMemory);
  const conditionalRelationshipInstructions = isFamilyVideo ? `
FAMILY/SPOUSE CONTEXT — EXACT PARTICIPANT PAIR VALIDATION:
- Keep every FACT relationship bound to its exact from/to participant IDs and evidence. A parent of a third person may independently be the spouse of another adult; never transfer a parent/child/sibling role to the spouse pair.
- When original, time-aligned evidence establishes that the two participating adults are spouses (eşi/karısı/kocası), retain that exact spouse FACT in top-level storyContext.relationships, even when the same family has children or other relatives. Do not turn this fact into a different character identity.
- For adult scenes, keep relationshipContext empty and use the proven participant name/ID in raw action wording. When original evidence proves the partner is MAIN_MALE's own wife (or husband), record that spouse FACT between exactly those two IDs and address her in intimate labels as karın (e.g. Karını öp), never as a neutral genç kadın/kadın. Never use other kinship roles for intimate choices or infer a spouse bond from appearance or proximity.
- If subjectTrackId, primaryCharacterId or partnerTrackId conflict, preserve the independently observable event and time interval with a neutral label; leave uncertain identities unresolved rather than dropping the event or assigning it to a family member.
` : '';
  const reviewInstructions = reviewMode ? `
SECOND PASS VISUAL REVIEW MODE:
- Review the existence of each source event separately from its descriptive metadata. If the event is visible but a specific category, contact point, participant, or label is uncertain, keep the event at its original source interval with a neutral, supported label and clear uncertainty. Reject the event only when the event itself cannot be verified.
- Apply the same event-preservation rule to story, approach, panel, MAIN and BONUS candidates. A classification correction must not erase an otherwise visible ordinary action or opening interaction.
- Treat all candidate labels, confidence scores and evidence descriptions as untrusted proposals. Independently read the supplied frames before comparing them to the candidate text.
- A camera/viewpoint change, partial occlusion, surface contact or tempo change alone does not establish a different configuration. Verify continuity between adjacent intervals. Do not force a single label when a real configuration change is visible.
- Use only the declared canonical IDs. Never invent a canonical name. Leave uncertain classifications out and explain the uncertainty in warnings.
- Keep each corrected action and its loop within that candidate's original startTime/endTime. Review the first and last visible evidence as well as the midpoint; text from the first pass is not visual evidence.
- Re-inspect the SAME storyboard frames against these first-pass candidates:
${reviewCandidates}
- Return candidates whose underlying event is visibly supported in their source interval. Require start, midpoint and end evidence for precise position and repeatable-loop claims; when only those details fail, retain a neutral event without a position or loop.
- Correct timestamps, canonical position id/label and confidence when the frames prove a correction.
- Preserve actionId/sceneId for the same candidate.
- Independently verify each proposed verifiedSubsequences boundary against the supplied frames. Preserve only source-backed 5+ second intervals of the same action and participants; an unsupported list must be empty.
- Do not add a new action merely because it sounds plausible.
- If only a candidate's specific label or category conflicts with the frames, correct or remove that claim and preserve the visible event. Omit the entire candidate only if its source event or playable interval is unsupported, and add a warning.
- Outcome/final candidates require stronger evidence than ordinary actions.
- For any candidate whose first-pass activityType is vaginal or anal, independently classify the route again from the SAME visible frames. Treat the first-pass route as untrusted; do not preserve it merely for consistency.
- Body position never proves route: missionary, cowgirl, rear, standing-rear, spoon and similar configurations can be vaginal or anal.
- Return vaginal or anal only when the visible contact/penetration location is directly distinguishable and consistent at the candidate start, midpoint and end. Otherwise return activityType other with low activityTypeConfidence, or omit the candidate.
- Never default an ambiguous penetrative candidate to vaginal. Correct activityType, activityTypeConfidence, activityEvidence and the Turkish label together so they cannot contradict one another.
- Re-check narrativeChoiceLabel, sceneTitle, sceneGoal, relationshipContext, storyEvidenceLevel, storyConfidence and storyEvidence for supplied candidates. Preserve them only when the same frames/dialogue still support them; otherwise downgrade to neutral wording.
- For groupScene, partnerSwitch or partner_transition candidates, independently re-identify every visible adult using stable neutral track IDs. Preserve a partner change only when the source frames visibly prove MAIN_MALE changes from one adult partner to another; otherwise omit it.
` : '';
  const chunkDuration = Math.max(1, chunkEnd - chunkStart);
    const prompt = savedGameRepair
      ? buildGapRepairPrompt({
        chunkStart, chunkEnd,
        timestamps, motionProfile, sceneBoundaries
      })
      : (ANALYSIS_PROMPT_STYLE === 'legacy' ? buildLegacyAnalysisPrompt : buildAnalysisPrompt)({
        duration, chunkIndex, chunkCount, chunkStart, chunkEnd, timestamps, motionProfile,
        sceneBoundaries, reviewInstructions, conditionalRelationshipInstructions, qualityMode,
        dialogueContext, dialogueSpeakerContext, sensoryAudioContext, storyContextMemory,
        protagonistProfile, protagonistHint, sourceKind: videoFileUri ? 'video' : 'frames'
      });

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
    let repairTelemetry = null;
    const generateStoryboardJson = async (requestPrompt, requestFiles, retryLabel = 'full') => {
      const parts = videoFileUri ? [
        // Video first, then the instructions (Google's recommended order).
        { fileData: { fileUri: videoFileUri, mimeType: geminiVideoMime(req.body?.videoMimeType) },
          videoMetadata: { startOffset: `${chunkStart}s`, endOffset: `${chunkEnd}s`, fps: GEMINI_VIDEO_FPS } },
        { text: requestPrompt }
      ] : [
        { text: requestPrompt },
        ...requestFiles.map((file) => ({
          inlineData: {
            mimeType: file.mimetype || 'image/jpeg',
            data: file.buffer.toString('base64')
          }
        }))
      ];
      const candidates = savedGameRepair ? [deepAnalysisModel] : analysisModelCandidates(analysisTier,
        { ...process.env, GEMINI_ANALYSIS_MODEL: ANALYSIS_MODEL }, deepAnalysisModel);
      for (let modelIndex = 0; modelIndex < candidates.length; modelIndex++) {
        const model = candidates[modelIndex];
        const generationConfig = {
          ...geminiGenerationConfig(model),
          // Video frames at low resolution: ~66 tokens per frame instead of 258.
          ...(videoFileUri ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
          safetySettings: geminiAnalysisSafetySettings,
          systemInstruction: savedGameRepair ? GAP_REPAIR_SYSTEM_INSTRUCTION : GEMINI_VISUAL_SYSTEM_INSTRUCTION
        };
        // A new analysis run must reach Gemini again; identical requests are
        // shared only within the same run (retries, concurrent duplicates).
        const runId = String(req.body?.analysisRunId || '').slice(0, 80);
        const key = storyboardRequestKey({ apiKey, model, prompt: `${runId}\n${savedGameRepair ? `${GAP_REPAIR_VALIDATOR_VERSION}\n${requestPrompt}` : requestPrompt}${videoFileUri ? `\nvideo:${videoFileUri}` : ''}`, files: requestFiles, generationConfig });
        const requestUsage = emptyGeminiUsage();
        const startedAt = Date.now();
        let attempts = 0;
        let outcome = 'failed';
        try {
          const cached = await storyboardRequestCache.run(key, () => generateStoryboardWithRetry(async () => {
            attempts++;
            const response = await ai.models.generateContent({
              model,
              contents: [{ role: "user", parts }],
              config: generationConfig
            });
            addGeminiUsage(analysisUsage, response?.usageMetadata);
            addGeminiUsage(requestUsage, response?.usageMetadata);
            return response;
          }, {
            onRetry: (reason, attempt, error) => console.warn('[gemini-storyboard-retry]', JSON.stringify({
              chunkIndex, retryLabel, attempt, reason,
              status: Number(error?.status ?? error?.statusCode ?? error?.response?.status) || null,
              code: typeof error?.code === 'number' ? error.code : String(error?.code || '').slice(0, 64),
              name: String(error?.name || '').slice(0, 64)
            }))
          }).then(result => {
            // Empty or unsupported neutral output is not a verified analysis.
            // Reject it BEFORE cache insertion: a successful HTTP transport
            // must not freeze a zero-evidence response for subsequent retries.
            if (savedGameRepair) {
              const inspected = inspectNeutralRepairActions(result?.actions,
                { startTime: chunkStart, endTime: chunkEnd });
              repairTelemetry = { ...inspected.diagnostics, stageReached: inspected.actions.length
                ? 'REPAIR_VALIDATOR_PASSED' : 'REPAIR_VALIDATOR_EMPTY' };
              if (!inspected.actions.length) {
                throw Object.assign(new Error('No verified neutral events in this source interval.'),
                  { code: 'GEMINI_NO_VERIFIED_EVENTS', repairTelemetry });
              }
            }
            return result;
          }));
          outcome = cached.outcome;
          if (outcome !== 'completed') {
            analysisUsage.cacheHits = (analysisUsage.cacheHits || 0) + 1;
            requestUsage.cacheHits = 1;
          }
          return cached.value;
        } catch (error) {
          if (storyboardFailureReason(error) === 'GEMINI_CONTENT_RESTRICTED') {
            // Provider metadata only: no input images, prompt, text, API key
            // or raw SDK response are written to the application logs.
            console.warn('[gemini-restriction-diagnostic]', JSON.stringify({
              stage: reviewMode ? 'review' : 'analysis',
              chunkIndex, model,
              ...(error?.safetyDiagnostic || {
                origin: 'provider_api_error', promptBlockReason: null,
                candidateFinishReason: null, blockedCategories: []
              })
            }));
          }
          // Legacy 2.5 models are access-restricted for some projects. Retry
          // once with current Lite ONLY on true model unavailability: never
          // substitute a paid stronger model or retry exhausted credits.
          if (storyboardFailureReason(error) !== 'GEMINI_MODEL_UNAVAILABLE' ||
              modelIndex + 1 >= candidates.length) throw error;
          console.warn('[gemini-economy-model-fallback]', JSON.stringify({
            chunkIndex, from: model, to: candidates[modelIndex + 1],
            reason: 'MODEL_UNAVAILABLE'
          }));
        } finally {
          console.info('[gemini-request-usage]', JSON.stringify({ stage: reviewMode ? 'review' : 'analysis',
            chunkIndex, outcome, model, analysisTier,
            mediaResolution: generationConfig.mediaResolution || 'default',
            thinkingLevel: generationConfig.thinkingConfig?.thinkingLevel || 'default',
            durationMs: Date.now() - startedAt, attempts, sheetCount: requestFiles.length, ...requestUsage }));
        }
      }
      throw Object.assign(new Error('No available economy analysis model.'), { code: 'GEMINI_MODEL_UNAVAILABLE' });
    };

    let parsed;
    try {
      parsed = await generateStoryboardJson(prompt, files);
    } catch (fullChunkError) {
      const fullFailureReason = storyboardFailureReason(fullChunkError);
      console.warn('[gemini-storyboard-failure]', JSON.stringify({
        chunkIndex, reason: fullFailureReason,
        status: Number(fullChunkError?.status ?? fullChunkError?.statusCode ?? fullChunkError?.response?.status) || null,
        code: typeof fullChunkError?.code === 'number' ? fullChunkError.code : String(fullChunkError?.code || '').slice(0, 64),
        name: String(fullChunkError?.name || '').slice(0, 64)
      }));
      const quotaFailure = geminiQuotaFailure(fullChunkError);
      if (quotaFailure) {
        console.warn(
          `[gemini-storyboard-quota] chunk ${chunkIndex + 1}/${chunkCount} stopped without split recovery: ${quotaFailure.reason}`
        );
        return res.status(quotaFailure.reason === 'GEMINI_CREDITS_DEPLETED' ? 402 : 429).json({
          ...quotaFailure, aiUsage: analysisUsage,
          chunkIndex,
          chunkCount,
          chunkStart,
          chunkEnd
        });
      }
      if (['GEMINI_AUTH_ERROR', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_INVALID_REQUEST'].includes(fullFailureReason)) {
        const message = fullFailureReason === 'GEMINI_AUTH_ERROR'
          ? 'Gemini API anahtarı veya proje yetkisi geçersiz. Gemini anahtarını ve erişimini kontrol et.'
          : fullFailureReason === 'GEMINI_MODEL_UNAVAILABLE'
            ? 'Seçili Gemini modeli bu API anahtarı veya proje için kullanılamıyor.'
            : 'Gemini isteği geçersiz olarak reddedildi. Sunucu kayıtlarındaki hata kodunu kontrol et.';
        return res.status(fullFailureReason === 'GEMINI_AUTH_ERROR' ? 403 : 502).json({
          available: false, retryable: false, reason: fullFailureReason, message,
          chunkIndex, chunkCount, chunkStart, chunkEnd, aiUsage: analysisUsage
        });
      }
      if (isTerminalStoryboardFailure(fullChunkError)) {
        console.warn(`[gemini-storyboard-unavailable] chunk ${chunkIndex + 1}/${chunkCount}: ${fullFailureReason}`);
        return res.status(422).json({
          available: false, retryable: false, reason: fullFailureReason,
          message: `Bölüm ${chunkIndex + 1}/${chunkCount} için model analiz verisi döndürmedi. Bu aralık için seçenek üretilmedi; diğer bölümlere devam edilecek.`,
          chunkIndex, chunkCount, chunkStart, chunkEnd,
          analysisGaps: [{ startTime: chunkStart, endTime: chunkEnd, reason: fullFailureReason }],
          aiUsage: analysisUsage,
          ...(savedGameRepair && (fullChunkError?.repairTelemetry || repairTelemetry)
            ? { repairTelemetry: fullChunkError?.repairTelemetry || repairTelemetry } : {})
        });
      }
      // Splitting the same evidence cannot repair a provider outage. The
      // server already tried twice; stop instead of multiplying paid work.
      if (fullFailureReason === 'GEMINI_TEMPORARILY_UNAVAILABLE') {
        return res.status(503).json({ available: false, retryable: false,
          reason: fullFailureReason, chunkIndex, chunkCount, chunkStart, chunkEnd, aiUsage: analysisUsage,
          message: 'Gemini bağlantısı veya hizmeti geçici olarak kullanılamıyor. Biraz sonra yeniden dene; tamamlanan bölümler korunuyor.' });
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
      let recoveryQuotaFailure = null;
      const recoverNextSegment = async () => {
        while (nextRecoveryIndex < recoverySegments.length) {
          const fileIndex = nextRecoveryIndex;
          nextRecoveryIndex += 1;
          const segment = recoverySegments[fileIndex];
          const splitTimestamps = segment.timestamps;
          const splitStart = Number(splitTimestamps[0] ?? chunkStart);
          const splitLast = Number(splitTimestamps[splitTimestamps.length - 1] ?? splitStart);
          const splitEnd = Math.min(chunkEnd, Math.max(splitStart + 0.1, splitLast + Math.max(0.1, (chunkEnd - chunkStart) / Math.max(1, allTimestamps.length))));
          if (recoveryQuotaFailure) {
            recoveredParts[fileIndex] = unverifiedGapResult(splitStart, splitEnd, { code: recoveryQuotaFailure.reason });
            continue;
          }
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
            recoveryQuotaFailure ||= geminiQuotaFailure(splitError);
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
      if (recoveryQuotaFailure) return res.status(recoveryQuotaFailure.reason === 'GEMINI_CREDITS_DEPLETED' ? 402 : 429)
        .json({ ...recoveryQuotaFailure, chunkIndex, chunkCount, chunkStart, chunkEnd, aiUsage: analysisUsage });

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
    if (savedGameRepair) {
      // Validate before normalizing and preserve aggregate reject reasons.
      // No model text, images, labels or identifying source data in telemetry.
      const inspection = inspectNeutralRepairActions(parsed?.actions,
        { startTime: chunkStart, endTime: chunkEnd });
      repairTelemetry = { ...inspection.diagnostics, stageReached:
        inspection.actions.length ? 'REPAIR_VALIDATOR_PASSED' : 'REPAIR_VALIDATOR_EMPTY' };
      parsed = { ...parsed, actions: inspection.actions };
    }
    const unresolvedGaps = Array.isArray(parsed?.analysisGaps)
      ? parsed.analysisGaps.filter(gap => Number(gap?.endTime) > Number(gap?.startTime))
      : [];
    if (unresolvedGaps.length) {
      const quotaBlocked = unresolvedGaps.some(gap =>
        ['GEMINI_QUOTA_OR_CREDITS', 'GEMINI_RATE_LIMITED', 'GEMINI_DAILY_LIMIT', 'GEMINI_CREDITS_DEPLETED'].includes(String(gap?.reason || ''))
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

    // Shared telemetry for both initial video analysis and saved-game repair.
    // Counts only: no labels, frames, participant names or raw model output.
    const normalizerRejected = { invalidStructure: 0, lowConfidence: 0, duplicates: 0 };
    if (videoFileUri && Array.isArray(parsed?.actions)) parsed.actions = absoluteClipTimes(parsed.actions, chunkStart, chunkEnd);
    if (!savedGameRepair && parsed && Array.isArray(parsed.actions)) {
      const protagonist = ensureProtagonistTrack(parsed);
      if (protagonist.inferred) {
        parsed = protagonist.parsed;
        console.warn('[protagonist-track-inferred]', JSON.stringify({ chunkIndex, track: String(protagonist.inferred).slice(0, 40) }));
      }
    }
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map((action, index) => ({
        ...action,
        actionId: String(action.actionId || `tl-${String(index + 1).padStart(3, '0')}`),
        sceneId: String(action.sceneId || `scene-${String(index + 1).padStart(3, '0')}`),
        locationId: String(action.locationId || '').trim().slice(0, 100),
        actionLevel: action.actionLevel === 'bonus' ? 'bonus' : 'main',
        actionType: String(action.actionType || 'other'),
        choiceSurface: ['story', 'approach', 'panel'].includes(action.choiceSurface) ? action.choiceSurface : '',
        choiceSurfaceEvidence: String(action.choiceSurfaceEvidence || '').trim().slice(0, 500),
        choiceSurfaceConfidence: Math.max(0, Math.min(1, Number(action.choiceSurfaceConfidence) || 0)),
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
          involvedCharacterIds: Array.isArray(action.involvedCharacterIds)
            ? action.involvedCharacterIds.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
            : [],
          primaryCharacterLabel: String(action.primaryCharacterLabel || '').trim(),
          primaryCharacterId: String(action.primaryCharacterId || '').trim(),
          subjectTrackId: String(action.subjectTrackId || '').trim(),
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
          verifiedSubsequences: verifiedActionSubsequences(action).map(part => ({
            startTime: Number(part.startTime), endTime: Number(part.endTime), sourceVerified: true,
            movementTempo: String(part.movementTempo || action.movementTempo || 'unclear'),
            movementType: String(part.movementType || action.movementType || ''),
            maleProgressRate: sourceMotionProgressRate({ ...action, ...part }, part.maleProgressRate),
            femaleProgressRate: sourceMotionProgressRate({ ...action, ...part }, part.femaleProgressRate)
          })),
          maleProgressRate: sourceMotionProgressRate(action, action.maleProgressRate),
          femaleProgressRate: sourceMotionProgressRate(action, action.femaleProgressRate),
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
        sourceVerified: action.sourceVerified === true,
        sourceStart: Number(action.sourceStart ?? action.startTime),
        sourceEnd: Number(action.sourceEnd ?? action.endTime),
        confidence: Number(action.confidence || 0)
      }))
      .map(action => withChoiceSurface(action))
      .filter((action) => {
        const valid = Boolean(action.label &&
          action.startTime + 0.05 >= introEndTime &&
          Number.isFinite(action.startTime) &&
          Number.isFinite(action.endTime) &&
          action.startTime >= 0 &&
          action.endTime > action.startTime &&
          (!duration || action.endTime <= duration + 0.5));
        if (!valid) normalizerRejected.invalidStructure++;
        return valid;
      })
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
        const accepted = Number(action.confidence || 0) >= minimum;
        if (!accepted) normalizerRejected.lowConfidence++;
        return accepted;
      })
      .sort((a, b) => a.startTime - b.startTime);

    // Parent positions and their verified internal movement loops overlap by
    // design. Remove only true duplicates; never discard a valid child
    // segment merely because it lives inside its parent interval.
    const dedupedActions = dedupeVerifiedTimelineActions(actions);
    normalizerRejected.duplicates = Math.max(0, actions.length - dedupedActions.length);
    const analysisTelemetry = {
      modelRawActionsCount: Array.isArray(parsed.actions) ? parsed.actions.length : 0,
      modelSourceVerifiedActionsCount: Array.isArray(parsed.actions)
        ? parsed.actions.filter(action => action?.sourceVerified === true).length : 0,
      serverNormalizerAcceptedCount: dedupedActions.length,
      serverSourceVerifiedActionsCount: dedupedActions.filter(action => action.sourceVerified === true).length,
      serverNormalizerRejected: { ...normalizerRejected },
      stageReached: dedupedActions.length ? 'SERVER_NORMALIZER_PASSED' : 'SERVER_NORMALIZER_EMPTY'
    };
    // Count-only production telemetry. A successfully parsed model response
    // may have no playable source actions; distinguish it from an API failure.
    // Never write prompts, labels, identities, images or model output to logs.
    console.info('[storyboard-action-coverage]', JSON.stringify({
      chunkIndex, chunkCount, analysisTier,
      ...analysisTelemetry
    }));
    if (savedGameRepair) {
      repairTelemetry = { ...repairTelemetry,
        promptVersion: GAP_REPAIR_PROMPT_VERSION,
        validatorVersion: GAP_REPAIR_VALIDATOR_VERSION,
        serverNormalizerAcceptedCount: dedupedActions.length,
        serverNormalizerRejected: normalizerRejected,
        stageReached: dedupedActions.length ? 'SERVER_NORMALIZER_PASSED' : 'SERVER_NORMALIZER_EMPTY' };
    }

    // The normal action normalizer also imposes timing and confidence rules.
    // If it discarded every neutral observation, report a failed repair.
    if (savedGameRepair && !dedupedActions.length) {
      return res.status(422).json({
        available: false, retryable: false, reason: 'GEMINI_NO_VERIFIED_EVENTS',
        message: 'Gemini yanıt verdi ancak kaynak karelerden doğrulanmış yeni bir olay bulunamadı.',
        chunkIndex, chunkCount, chunkStart, chunkEnd,
        analysisGaps: [{ startTime: chunkStart, endTime: chunkEnd,
          reason: 'GEMINI_NO_VERIFIED_EVENTS' }],
        aiUsage: analysisUsage,
        ...(savedGameRepair ? { repairTelemetry } : {})
      });
    }

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
      aiUsage: analysisUsage,
      analysisTelemetry,
      ...(savedGameRepair ? { repairTelemetry } : {})
    });
  } catch (error) {
    console.error('[gemini-storyboard-error]', error);
    const details = String(error?.message || error);
    const quotaFailure = geminiQuotaFailure(error);
    if (quotaFailure) {
      return res.status(quotaFailure.reason === 'GEMINI_CREDITS_DEPLETED' ? 402 : 429).json(quotaFailure);
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
  let value = String(address).toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reaches the same IPv4 host.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) value = mapped[1];
  if (value === '::' || value.startsWith('0.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
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

  if (url.username || url.password) throw new Error('Kimlik bilgisi içeren URL kullanılamaz.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
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
  const requestHeaders = { ...(options.headers || {}) };

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
        ...requestHeaders
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Yönlendirme adresi bulunamadı.');
      const next = new URL(location, current).href;
      if (new URL(next).origin !== new URL(current).origin) {
        for (const key of Object.keys(requestHeaders)) {
          if (['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())) delete requestHeaders[key];
        }
      }
      current = next;
      continue;
    }

    return { response, finalUrl: current };
  }

  throw new Error('Çok fazla yönlendirme yapıldı.');
}

async function probeVideoCandidate(candidate, referer, cookie = '', userAgent = '') {
  return probeVideoSource(candidate, referer, { fetchPublicUrl, cookie, userAgent });
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

function registerResolvedVideoSession(resolved) {
  const token = crypto.randomBytes(18).toString('hex');
  resolvedVideoSessions.set(token, {
    sourceUrl: resolved.sourceUrl,
    referer: resolved.pageUrl || resolved.sourceUrl,
    cookie: resolved.cookie || '',
    type: resolved.type || 'video',
    userAgent: resolved.userAgent || 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    extractor: resolved.extractor || 'direct',
    // Analysis and later gameplay may share this source for a long mobile run.
    expiresAt: Date.now() + 4 * 60 * 60 * 1000
  });
  return token;
}

async function resolvePublicVideoPage(startUrl) {
  return resolveVideoUrl(startUrl, { fetchPublicUrl, extractPage: resolveWithSiteExtractor });
}

async function resolveWithSiteExtractor(rawUrl, { referer = rawUrl, timeoutMs = 20000, signal = AbortSignal.timeout(timeoutMs) } = {}) {
  await validatePublicUrl(rawUrl);
  await validatePublicUrl(referer);
  signal.throwIfAborted();
  const userAgent = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36';
  const baseOptions = {
    dumpSingleJson: true, skipDownload: true, noWarnings: true,
    noPlaylist: true, playlistEnd: 5, socketTimeout: 30, retries: 1, extractorRetries: 1,
    userAgent, referer,
    format: 'best[protocol^=http][vcodec!=none][acodec!=none]/best/best*'
  };
  // Use the normal transport first. Only an anti-bot wall (e.g. Cloudflare)
  // gets one retry with a browser-identical fingerprint, and only when the
  // installed standalone extractor actually bundles that capability.
  let output;
  try { output = await runVideoExtractor(rawUrl, baseOptions, { signal, timeoutMs }); }
  catch (error) {
    console.warn('[video-extractor-detail]', new URL(rawUrl).hostname, videoErrorDiagnostic(error));
    const canImpersonate = typeof videoExtractorCanImpersonate === 'function' && videoExtractorCanImpersonate();
    if (!canImpersonate || signal.aborted || !needsBrowserImpersonation(videoErrorDetail(error))) throw error;
    try {
      // The impersonated browser supplies its own matching User-Agent.
      const { userAgent: _ignored, ...plainOptions } = baseOptions;
      output = await runVideoExtractor(rawUrl, { ...plainOptions,
        impersonate: 'chrome', extractorArgs: 'generic:impersonate' }, { signal, timeoutMs });
      console.warn('[video-extractor-impersonation]', new URL(rawUrl).hostname, 'ok');
    } catch (retryError) {
      console.warn('[video-extractor-detail]', new URL(rawUrl).hostname, 'impersonated:', videoErrorDiagnostic(retryError));
      throw retryError;
    }
  }
  const selected = selectExtractorSource(output, rawUrl);
  await validatePublicUrl(selected.sourceUrl);
  await validatePublicUrl(selected.pageUrl);
  return { ...selected, userAgent: selected.userAgent || userAgent };
}

app.post('/api/resolve-video-url', async (req, res) => {
  try {
    const startedAt = Date.now();
    const requestedUrl = String(req.body?.url || '').trim();
    if (!requestedUrl) {
      return res.status(400).json({ ok: false, reason: 'URL_REQUIRED', message: 'Video sayfası URL’si gerekli.' });
    }
    let normalizedUrl;
    try { normalizedUrl = normalizeAmpUrl(requestedUrl); }
    catch {
      return res.status(400).json({ ok: false, reason: 'INVALID_URL', message: 'Geçerli bir HTTP veya HTTPS video bağlantısı gir.' });
    }
    // Validate before either the HTTP reader or external extractor can connect.
    await validatePublicUrl(normalizedUrl);
    let resolved = null;
    let cacheHit = false;
    const cached = resolvedVideoCache.get(normalizedUrl);
    if (cached?.expiresAt > Date.now()) {
      const fresh = await probeVideoCandidate(cached.resolved.sourceUrl,
        cached.resolved.pageUrl || normalizedUrl, cached.resolved.cookie, cached.resolved.userAgent);
      if (fresh) { resolved = { ...cached.resolved, ...fresh }; cacheHit = true; }
    }
    if (cached && !cacheHit) resolvedVideoCache.delete(normalizedUrl);
    let failureDetail = '';
    if (!resolved) {
      let pending = pendingVideoResolutions.get(normalizedUrl);
      if (!pending) {
        pending = (async () => {
          let candidate = null;
          const errors = [];
          // Standard public pages/direct media should not wait for a subprocess.
          try { candidate = await resolvePublicVideoPage(normalizedUrl); }
          catch (error) { errors.push(videoErrorDetail(error)); }
          if (!candidate) {
            const detail = errors.join('; ');
            // Log diagnostic codes, never signed URLs, cookies or subprocess
            // command lines. This distinguishes source failures from runtime failures.
            const httpStatuses = [...new Set([...detail.matchAll(/HTTP(?: Error)?[\s:_-]*([45]\d\d)\b/gi)].map(match => match[1]))];
            console.warn('[site-video-extractor]', new URL(normalizedUrl).hostname,
              videoResolutionFailure(detail).reason, JSON.stringify({ httpStatuses, elapsedMs: Date.now() - startedAt }));
          }
          if (candidate) {
            resolvedVideoCache.set(normalizedUrl, { resolved: candidate, expiresAt: Date.now() + VIDEO_RESOLUTION_CACHE_MS });
          }
          return { resolved: candidate, failureDetail: errors.join('; ') };
        })().finally(() => pendingVideoResolutions.delete(normalizedUrl));
        pendingVideoResolutions.set(normalizedUrl, pending);
      }
      const result = await pending;
      resolved = result.resolved;
      failureDetail = result.failureDetail;
    }
    if (!resolved) {
      const failure = videoResolutionFailure(failureDetail);
      const status = failure.reason === 'VIDEO_RESOLUTION_TIMEOUT' ? 504
        : ['VIDEO_SOURCE_TEMPORARY_ERROR', 'VIDEO_EXTRACTOR_UNAVAILABLE'].includes(failure.reason) ? 503 : 422;
      return res.status(status).json({ ok: false, ...failure });
    }
    const token = registerResolvedVideoSession(resolved);
    return res.json({
      ok: true, type: resolved.type, sourceUrl: resolved.sourceUrl, pageUrl: resolved.pageUrl,
      proxyUrl: `/api/video-proxy?token=${encodeURIComponent(token)}`,
      remoteToken: token,
      directDownload: resolved.type === 'video' && !resolved.cookie && new URL(resolved.sourceUrl).protocol === 'https:',
      cached: cacheHit, resolveMs: Date.now() - startedAt
    });
  } catch (error) {
    return res.status(502).json({
      ok: false, reason: 'URL_RESOLVE_ERROR',
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
    // A session in active use stays valid: long play sessions otherwise hit
    // the 4-hour limit mid-game and every following seek failed with 410.
    if (session) session.expiresAt = Math.max(session.expiresAt, Date.now() + 2 * 60 * 60 * 1000);
    const sourceUrl = String(session?.sourceUrl || req.query.url || '');
    const referer = String(session?.referer || req.query.referer || '');
    if (!sourceUrl) return res.status(400).json({ ok: false, message: 'Video URL’si gerekli.' });

    if (['hls', 'dash'].includes(session?.type) || /\.(?:m3u8|mpd)(?:$|[?#])/i.test(sourceUrl)) {
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
        // Automatic selection keeps the highest-resolution representation;
        // stream 0 in adaptive manifests is often the lowest quality.
        '-sn', '-dn',
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
        console.error('Stream ffmpeg start error:', error?.message || error);
        if (res.destroyed) return;
        if (!res.headersSent) res.status(502).json({ ok: false, message: 'Video akışı hazırlanamadı.' });
        else res.destroy(error);
      });
      ffmpeg.on('close', code => {
        clearTimeout(headerTimer);
        clearTimeout(conversionTimer);
        clearTimeout(forceKillTimer);
        if (code && !res.writableEnded && !controller.signal.aborted) {
          console.error('Stream ffmpeg error:', stderr || `exit ${code}`);
          res.destroy(new Error('VIDEO_STREAM_CONVERSION_FAILED'));
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
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
    headers['Accept-Encoding'] = 'identity';
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
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
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


// TURKISH MEDIA JOBS: owner-authenticated, resumable full-source uploads.
const mediaConfig = loadMediaConfig();
const mediaCache = createMediaCache({ directory: path.join(mediaConfig.directory, 'cache'), ttlSeconds: mediaConfig.cacheTtlSeconds });
const mediaLimiter = createLimiter(mediaConfig.concurrency);
const mediaBinaries = {
  ffmpegPath: ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : ffmpegPath || 'ffmpeg',
  ffprobePath: fs.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : null,
};
const mediaAudio = createAudioService({
  ...mediaBinaries,
  directory: path.join(mediaConfig.directory, 'audio'),
});
const mediaUploads = createMediaUploads({ directory: path.join(mediaConfig.directory, 'uploads'), ttlSeconds: mediaConfig.cacheTtlSeconds });
const mediaJobs = createMediaJobs({ config: mediaConfig, cache: mediaCache, limiter: mediaLimiter, audio: mediaAudio,
  leaseSource: mediaUploads.acquireLeaseByPath,
  onFailure: details => console.error('Turkish media job failed.', details) });
installTurkishMediaRoutes(app, { uploads: mediaUploads, jobs: mediaJobs,
  rawParser: express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_CHUNK_BYTES }),
  secrets: [mediaConfig.elevenLabs.apiKey, mediaConfig.translation.apiKey],
});
const geminiVideoFiles = createGeminiVideoFiles({ GoogleGenAI, uploads: mediaUploads });
app.post('/api/gemini-video/prepare', async (req, res) => {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  try {
    const value = await geminiVideoFiles.prepare({ apiKey: resolveGeminiApiKey(req),
      uploadId: req.body?.uploadId, mimeType: req.body?.mimeType, signal: controller.signal });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ available: true, ...value });
  } catch (error) {
    if (res.destroyed) return;
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 502;
    console.warn('[gemini-video-prepare]', JSON.stringify({ code: String(error?.code || '').slice(0, 64),
      status, fileState: error?.fileState || null }));
    res.status(status).json({ available: false, reason: String(error?.code || 'GEMINI_VIDEO_UNAVAILABLE'),
      message: error?.message && status < 500 ? error.message : 'Video Google\'a hazırlanamadı; resimli analiz kullanılacak.' });
  } finally { res.removeListener('close', abort); }
});

let mediaCleanupRunning = false;
setInterval(async () => {
  if (mediaCleanupRunning) return;
  mediaCleanupRunning = true;
  try { await Promise.all([mediaUploads.removeExpired(), mediaJobs.removeExpired()]); }
  catch { console.warn('Turkish media cleanup could not complete.'); }
  finally { mediaCleanupRunning = false; }
}, 10 * 60 * 1000).unref();

function quotaRetrySeconds(details) {
  const retry = String(details || '').match(/retry(?:Delay| in)?[^0-9]*(\d+(?:\.\d+)?)s/i);
  if (retry) return Math.max(1, Math.ceil(Number(retry[1])));
  const human = String(details || '').match(/Please retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!human) return 0;
  return Math.max(1, Math.ceil((Number(human[1]) || 0) * 3600 + (Number(human[2]) || 0) * 60 + (Number(human[3]) || 0)));
}

// Confirm model access with a tiny, non-user image and structured JSON;
// listing a model alone does not prove that GenerateContent can use images.
const repairProbeImage = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AwMDEwMDAwMDAwAkBgMB/DXemwAAAABJRU5ErkJggg==';
const repairCatalogCache = new Map();

app.get('/api/gemini-analysis-models', async (req, res) => {
  const apiKey = resolveGeminiApiKey(req);
  if (!apiKey) return res.status(503).json({ models: [], message: 'Gemini API anahtarı bulunamadı.' });
  const key = crypto.createHash('sha256').update(apiKey).digest('hex');
  const cached = repairCatalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return res.json({ models: cached.models });
  try {
    const ai = new GoogleGenAI({ apiKey });
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    const catalog = [];
    for await (const model of pager) {
      const name = String(model.name || '').replace('models/', '');
      if (isVideoQuestAnalysisModel({ ...model, name })) catalog.push({ ...model, name });
    }
    const candidates = preferredRepairAnalysisModels(catalog);
    const checks = await Promise.all(candidates.map(async model => {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [
            { text: 'Inspect the image and return only this JSON object: {"ok":true}' },
            { inlineData: { mimeType: 'image/png', data: repairProbeImage } }
          ] }],
          config: {
            ...geminiGenerationConfig(model),
            maxOutputTokens: 256,
            httpOptions: { timeout: 12000, retryOptions: { attempts: 1 } }
          }
        });
        const parsed = parseModelJson(String(response?.text || ''));
        return parsed?.ok === true ? model : null;
      } catch (error) {
        console.info('[gemini-repair-model-probe]', JSON.stringify({
          model, outcome: 'unavailable', reason: storyboardFailureReason(error)
        }));
        return null;
      }
    }));
    const models = checks.filter(Boolean);
    // Cache only confirmed results, and never hold or log user video frames.
    if (models.length) {
      repairCatalogCache.set(key, { models, expiresAt: Date.now() + 10 * 60 * 1000 });
      if (repairCatalogCache.size > 60) repairCatalogCache.delete(repairCatalogCache.keys().next().value);
    }
    return res.json({ models });
  } catch (error) {
    return res.status(502).json({ models: [], message: 'Gemini model kataloğu doğrulanamadı.' });
  }
});

app.post('/api/gemini-key-status', async (req, res) => {
  const browserApiKey = clientGeminiApiKey(req);
  const apiKey = browserApiKey || String(process.env.GEMINI_API_KEY || '').trim();
  const source = browserApiKey ? 'browser' : 'server';
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      state: 'unconfigured',
      source,
      message: 'Gemini API anahtarı yapılandırılmamış.'
    });
  }

  // Keep configuration-only checks free of provider calls.
  if (req.body?.verify !== true) return res.json({ ok: true, state: 'configured', source,
    providerAccessVerified: false,
    message: 'Gemini anahtarı yapılandırılmış. Bağlantıyı Test et düğmesiyle doğrulayabilirsin.' });

  // Probe the same analysis tier selected in the UI. A translation-only model
  // can be unavailable even when analysis works, and vice versa.
  const tier = analysisTierFromRequest(req.body?.analysisTier);
  const selected = String(req.body?.deepAnalysisModel || '').trim();
  if (tier === 'deep' && selected && !isSupportedDeepAnalysisModel(selected)) {
    return res.status(400).json({ ok: false, state: 'model_unavailable', reason: 'UNSUPPORTED_DEEP_ANALYSIS_MODEL',
      message: 'Desteklenmeyen Gemini modeli seçildi.' });
  }
  const models = analysisModelCandidates(tier, process.env, selected);
  let model = models[0];
  try {
    const ai = new GoogleGenAI({ apiKey });
    let response;
    for (const candidate of models) {
      model = candidate;
      try {
        response = await ai.models.generateContent({
          model,
          contents: 'Reply OK.',
          // Argon does not support temperature and its default thinking is costlier.
          // A key probe needs only a tiny response, not paid medium reasoning.
          config: model === 'gemini-4-argon'
            ? { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: 'low' } }
            : { maxOutputTokens: 16, temperature: 0 }
        });
        break;
      } catch (error) {
        if (storyboardFailureReason(error) !== 'GEMINI_MODEL_UNAVAILABLE' ||
            candidate === models.at(-1)) throw error;
      }
    }
    console.info('[gemini-request-usage]', JSON.stringify({ stage: 'explicit-key-test', model,
      ...addGeminiUsage(emptyGeminiUsage(), response?.usageMetadata) }));
    return res.json({
      ok: true,
      state: 'available',
      model,
      checkedAt: Date.now(),
      source,
      message: source === 'browser'
        ? 'Kendi Gemini anahtarın seçilen analiz modeliyle çalışıyor.'
        : 'Sunucu Gemini anahtarı seçilen analiz modeliyle çalışıyor.'
    });
  } catch (error) {
    const details = String(error?.message || error);
    const normalized = details.toLowerCase();
    const reason = storyboardFailureReason(error);
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status) || null;
    const retryAfterSeconds = quotaRetrySeconds(details) || 0;
    // Never log the key or provider response body.
    console.warn('[gemini-key-test-failure]', JSON.stringify({ reason, status, model, source }));
    if (status === 401 || normalized.includes('api_key_invalid') ||
        normalized.includes('api key not valid') || normalized.includes('invalid api key')) {
      return res.status(401).json({ ok: false, state: 'invalid', source, message: 'API anahtarı geçersiz.' });
    }
    if (normalized.includes('no credits') || normalized.includes('credit balance') || normalized.includes('prepay')) {
      return res.status(402).json({ ok: false, state: 'no_credits', source,
        message: source === 'browser'
          ? 'Kendi Gemini anahtarında kullanılabilir kredi yok.'
          : 'Sunucu Gemini kredisi tükendi. Kendi Gemini API anahtarını girebilir veya sunucu bakiyesini yenileyebilirsin.' });
    }
    if (reason === 'GEMINI_QUOTA_OR_CREDITS' || reason === 'GEMINI_RATE_LIMITED' ||
        reason === 'GEMINI_DAILY_LIMIT' || reason === 'GEMINI_CREDITS_DEPLETED') {
      const daily = reason === 'GEMINI_DAILY_LIMIT' || normalized.includes('per_day') ||
        normalized.includes('per day') || normalized.includes('daily');
      return res.status(429).json({
        ok: false,
        state: daily ? 'daily_limit' : 'rate_limited',
        retryAfterSeconds,
        source,
        message: daily
          ? 'Bu projenin günlük kotası dolmuş.'
          : 'Anahtar şu anda hız/kota sınırında; biraz sonra tekrar denenebilir.'
      });
    }
    if (reason === 'GEMINI_MODEL_UNAVAILABLE') {
      return res.status(404).json({ ok: false, state: 'model_unavailable', source, model,
        message: 'Seçilen Gemini analiz modeli bu projede kullanılamıyor. Başka analiz modunu deneyebilirsin.' });
    }
    if (status === 403 || normalized.includes('permission_denied')) {
      return res.status(403).json({ ok: false, state: 'forbidden', source,
        message: 'Anahtarın Gemini modeline erişim izni yok.' });
    }
    if (reason === 'GEMINI_INVALID_REQUEST') {
      return res.status(502).json({ ok: false, state: 'probe_error', source,
        message: 'Anahtar testi Gemini tarafından reddedildi. Analiz isteğini yeniden dene.' });
    }
    return res.status(502).json({
      ok: false,
      state: 'unavailable',
      source,
      message: 'Gemini bağlantısı şu anda doğrulanamadı; analiz isteğini yeniden deneyebilirsin.'
    });
  }
});

installScoutRoute(app, {
  upload: storyboardUpload, resolveApiKey: resolveGeminiApiKey, GoogleGenAI,
  model: String(process.env.GEMINI_SCOUT_MODEL || process.env.GEMINI_ECONOMY_MODEL || ECONOMY_ANALYSIS_MODEL).trim(),
  safetySettings: geminiAnalysisSafetySettings, emptyUsage: emptyGeminiUsage, addUsage: addGeminiUsage,
  failureReason: storyboardFailureReason
});

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', service: 'source-video-interactive-app',
    analysisRevision,
    analysisGeneration: { thinkingLevel: geminiGenerationConfig(ANALYSIS_MODEL).thinkingConfig?.thinkingLevel || 'default' },
    deploymentCommit: process.env.RENDER_GIT_COMMIT || null,
    turkishMedia: { qualityMode: mediaConfig.qualityMode, pipelineVersion: mediaConfig.version,
      translationProvider: mediaConfig.translation.provider, openAIRequired: false,
      browserKeysSupported: { elevenLabs: true, gemini: true },
      serverGeminiConfigured: Boolean(mediaConfig.translation.apiKey),
      models: { transcription: mediaConfig.elevenLabs.sttModel, quality: mediaConfig.elevenLabs.dubModel } } });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ available: false, reason: 'API_NOT_FOUND', message: 'API adresi bulunamadı.' });
});

function handleRequestError(error, _req, res, next) {
  if (res.headersSent) return next(error);
  if (res.destroyed) return;
  const tooLarge = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large';
  const invalid = error instanceof multer.MulterError || error.type === 'entity.parse.failed';
  const storyboardFieldsExceeded = error instanceof multer.MulterError &&
    error.code === 'LIMIT_FIELD_COUNT' && _req.path === '/api/gemini-storyboard-analyze';
  const unsupported = error.message === 'UNSUPPORTED_VIDEO_FORMAT';
  const status = tooLarge ? 413 : unsupported ? 415 : invalid ? 400 : 500;
  if (status === 500) console.error('Request failed:', error?.message || error);
  res.status(status).json({
    available: false,
    reason: tooLarge ? 'UPLOAD_TOO_LARGE' : unsupported ? 'UNSUPPORTED_VIDEO_FORMAT'
      : storyboardFieldsExceeded ? 'STORYBOARD_FORM_FIELDS_EXCEEDED'
      : invalid ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
    message: tooLarge ? 'Gönderilen veri bu işlemin boyut sınırını aşıyor.' : unsupported ? 'Video biçimi desteklenmiyor.'
      : storyboardFieldsExceeded ? 'Sahne analiz formu izin verilen alan sayısını aşıyor. Bu bölüm korunarak yeniden denenebilir.'
      : invalid ? 'Gönderilen veri geçersiz.' : 'İşlem tamamlanamadı. Tekrar deneyebilirsin.'
  });
}

app.use(handleRequestError);

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function runConfiguredVideoProbe() {
  const url = String(process.env.VIDEO_RESOLUTION_PROBE_URL || '');
  const until = Number(process.env.VIDEO_RESOLUTION_PROBE_UNTIL || 0);
  delete process.env.VIDEO_RESOLUTION_PROBE_URL;
  delete process.env.VIDEO_RESOLUTION_PROBE_UNTIL;
  if (!url || !Number.isFinite(until) || until <= Date.now() || until > Date.now() + 15 * 60 * 1000) return;
  const started = Date.now();
  try {
    await validatePublicUrl(url);
    const result = await resolvePublicVideoPage(url);
    console.log('[video-resolution-probe]', JSON.stringify({
      host: new URL(url).hostname, ok: Boolean(result), type: result?.type,
      elapsedMs: Date.now() - started
    }));
  } catch (error) {
    console.warn('[video-resolution-probe]', videoErrorDiagnostic(error));
  }
}

async function checkTurkishMediaRoutes() {
  if (!APP_PASSWORD) return;
  try {
    for (const check of ['server-capability', 'synthetic-browser-capability']) {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/turkish-media/capabilities`, {
        headers: { Cookie: `${AUTH_COOKIE}=${expectedAuthToken()}`,
          ...(check === 'synthetic-browser-capability' ? { 'x-elevenlabs-api-key': 'browser-capability-check-only-123456' } : {}) },
        signal: AbortSignal.timeout(5000),
      });
      const result = await response.json();
      // This checks header routing and configuration only. It makes no model,
      // voice-catalog or synthesis request and cannot prove provider access.
      console.log('[turkish-media-route-check]', JSON.stringify({
        check, providerAccessVerified: false, route: '/api/turkish-media/capabilities', status: response.status,
        configured: result.configured === true, transcriptionConfigured: result.transcriptionConfigured === true,
        translationConfigured: result.translationConfigured === true, translationProvider: result.translationProvider,
        openAIRequired: false, qualityMode: result.qualityMode,
      }));
    }
  } catch {
    console.error('[turkish-media-route-check]', 'Authenticated media endpoint diagnostics failed.');
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Source Video Interactive listening on ${PORT}`);
  console.log(`External analysis endpoint: ${EXTERNAL_ANALYSIS_URL}`);
  console.log('[turkish-media-deployment]', JSON.stringify({ commit: process.env.RENDER_GIT_COMMIT || null,
    qualityMode: mediaConfig.qualityMode, pipelineVersion: mediaConfig.version }));
  void runtimeReady({ config: mediaConfig, env: process.env, ...mediaBinaries,
    ffprobePath: mediaBinaries.ffprobePath || 'ffprobe' })
    .then(report => console.log('[turkish-media-runtime]', JSON.stringify(report)))
    .catch(() => console.error('[turkish-media-runtime]', 'Runtime diagnostics could not complete.'));
  void checkTurkishMediaRoutes();
  void runConfiguredVideoProbe();
});
