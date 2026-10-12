import { createGameplayGraph, normalizeGameplayEvidence } from './gameplay-evidence.js';
import { createGameplayPlayer } from './gameplay-player.js';
import { renderGameplay } from './gameplay-view.js';
import { availableChoices, activeSurface, progression } from './gameplay-state.js';
import { toggleFullscreen, revealFullscreenChoices } from './fullscreen.js';
import { mergeUnownedIntervals, partitionProtagonistActions } from './protagonist-ownership.js';
import { createAnalysisProgress } from './analysis-progress.js';
import { isGeminiTranslationQuota, canResumePreparedTurkishMedia } from './media-stage-recovery.js';
import { repairSavedAudio } from './saved-audio.js';
import { requestWithUploadProgress } from './progress-request.js';
import { createServerRevisionReader } from './server-revision.js';
import { adultPositionFamily, assignAdultSceneOccurrenceIds, buildVerifiedMovementChoices, splitSparseMovementChoiceCards, consolidateVerifiedPositions, expandVerifiedMovementVariants, exclusiveControlClipIds, isPlayableVerifiedPositionDuration, initialWarmupBeforeFirstPosition, positionOccurrenceGroups, normalizeSourceActionTimes, playableAdultPanelFamily, movementBelongsToVerifiedPosition, normalizeOutcomeUnlockProgress, positionUnlockProgress, resolveVerifiedAdultPosition, summarizeAdultSceneGraph, verifiedAdultPositionFamily, verifiedPartnerTransition } from './adult-gameplay.js';
import { isCompleteChunkAnalysis } from './playback-logic.js';
import { ANALYSIS_SCHEMA_VERSION, ENGINE_VERSION, activityOccurrenceNamespace, analysisFingerprint, appendEngineEvent, mergeSecondPassReview, normalizeChunkActionTimes, reviewAndHardenAnalysis, secondPassReviewCandidates } from './engine-hardening.js';
import { mergeStoryContexts, normalizeStoryContext, storyChoiceLabelForAction } from './story-engine.js';
import { bindActionCharacter, canonicalizeActionTrackIds } from './character-identity.js';
import { adaptiveAnalysisChunkPlan, extractStoryboard } from './storyboard.js';
import { canContinuePastChunkFailure, chunkGapResult } from './analysis-recovery.js';
import { recoverVerifiedChunksOnCreditExhaustion } from './partial-analysis-recovery.js';
import { runContextualAnalysisChunks } from './analysis-scheduler.js';
import { repairableAnalysisGaps, mergeRepairedAnalysis } from './analysis-gap-repair.js';


import { mountSavedGames } from './saved-games-ui.js';
import { validateGame } from './saved-games.js';
import { attachTactileSurface, createTactileEngine } from './tactile-controls.js';

import { createTurkishMediaClient } from './turkish-media-client.js';
import { sourceContextAdapter, sourceSpeechOverlaps } from './source-transcript.js';
import { createVideoDownloader } from './video-download.js';
import { createUrlVideoCache } from './url-video-cache.js';
import { analysisRequestKey, analysisCheckpointKey, createAnalysisResponseCache } from './analysis-response-cache.js';
import { matchSceneIntroductions, verifiedOpeningCast } from './scene-entry.js';
import { sourceIdentityLabel, sourceDisplayLabel } from './choice-groups.js';
import { withChoiceSurface } from './choice-routing.js';
import { isAdultSocialRelationshipRole } from './relationship-roles.js';

import { interactionEntryGuard } from './interaction-timeline.js';

import { assignVerifiedOpeningRoles } from './verified-scene-continuity.js';

import { mountInteractionPanel } from './interaction-panel.js';

const videoDownloads = createVideoDownloader();
const urlVideoCache = createUrlVideoCache();
const cleanExpiredUrlVideos = () =>
  urlVideoCache.removeExpired().catch(error => console.warn('24 saatlik video önbelleği temizlenemedi:', error));
void cleanExpiredUrlVideos();
setInterval(() => { void cleanExpiredUrlVideos(); }, 15 * 60 * 1000);
let savedGames;

const $ = (id) => document.getElementById(id);

const state = {
  serviceConnected: false,
  serviceCapabilities: null,
  selectedFile: null,
  selectedSourceKind: 'file',
  activeSavedGameId: null,
  savedGameReady: false,
  savedGameBusy: false,
  savedPlaybackOnly: false,
  selectedRemoteVideo: null,
  selectedRemoteToken: '',
  urlCacheKey: '',
  urlCacheSavePromise: null,
  remoteFileDownload: null,
  videoObjectUrl: '',
  analysisSession: null,
  analysisInProgress: false,
  urlResolutionInProgress: false,
  analysis: null,
  sourceTranscript: null,
  sourceContext: null,
  turkishMediaStatus: null,
  mediaRevoice: null,
  voiceMappingGeneration: 0,
  voiceCatalog: null,
  voiceCatalogPromise: null,
  voiceMappingManualRequested: false,
  mediaCredentialGeneration: 0,
  geminiProviderStatus: null,
  subtitlesEnabled: false,
  dubbingEnabled: false,
  languageSyncOffset: 0,
  aiUsage: {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  },
  gameState: 'IDLE',
  gameCursorTime: 0,
  currentActionIndex: -1,
  consumedActionIds: new Set(),
  activeAction: null,
  stopListener: null,
  adultScene: null,
  adultMode: false,
  activePositionId: null,
  activeMovementId: null,
  adultScenes: [],
  adultAnalysisTrace: null,
  completedAdultSceneIds: new Set(),
  adultLoopSeeking: false,
  adultSeekController: null,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultPreludePlayCounts: new Map(),
  adultUnlockedOutcomeIds: new Set(),
  adultRevealedPositionIds: new Set(),
  activeInteractionSurface: 'none',
  navigationSeeking: false,
  navigationSeekController: null,
  manualSeeking: false,
  adultPhaseMachine: 'foreplay',
  engineEvents: [],
  integrityReport: null,
  analysisFingerprint: '',
  lastRuntimeSaveAt: 0,
};

const els = {
  serviceStatus: $('serviceStatus'),
  serviceMeta: $('serviceMeta'),
  healthBtn: $('healthBtn'),
  videoInput: $('videoInput'),
  fileMeta: $('fileMeta'),
  analyzeBtn: $('analyzeBtn'),
  deepAnalysisMode: $('deepAnalysisMode'),
  dubQualityMode: $('dubQualityMode'),
  dubbingProvider: $('dubbingProvider'),
  subtitleTrack: $('subtitleTrack'),
  mediaJobStatus: $('mediaJobStatus'),
  mediaJobMessage: $('mediaJobMessage'),
  mediaJobProgress: $('mediaJobProgress'),
  mediaJobSummary: $('mediaJobSummary'),
  mediaJobDetail: $('mediaJobDetail'),
  analysisStepList: $('analysisStepList'),
  mediaJobCancelBtn: $('mediaJobCancelBtn'),
  mediaJobRetryBtn: $('mediaJobRetryBtn'),
  mediaExports: $('mediaExports'),
  voiceMappingPanel: $('voiceMappingPanel'),
  voiceMappingRows: $('voiceMappingRows'),
  voiceMappingMessage: $('voiceMappingMessage'),
  voiceMappingApplyBtn: $('voiceMappingApplyBtn'),
  geminiApiKeyInput: $('geminiApiKeyInput'),
  saveGeminiApiKeyBtn: $('saveGeminiApiKeyBtn'),
  testGeminiApiKeyBtn: $('testGeminiApiKeyBtn'),
  clearGeminiApiKeyBtn: $('clearGeminiApiKeyBtn'),
  apiKeyStatus: $('apiKeyStatus'),
  elevenLabsApiKeyInput: $('elevenLabsApiKeyInput'),
  saveElevenLabsApiKeyBtn: $('saveElevenLabsApiKeyBtn'),
  testElevenLabsApiKeyBtn: $('testElevenLabsApiKeyBtn'),
  clearElevenLabsApiKeyBtn: $('clearElevenLabsApiKeyBtn'),
  elevenLabsApiKeyStatus: $('elevenLabsApiKeyStatus'),
  motionMode: $('motionMode'),
  subtitleMode: $('subtitleMode'),
  dubMode: $('dubMode'),
  subtitleQuotaStatus: $('subtitleQuotaStatus'),
  dubQuotaStatus: $('dubQuotaStatus'),
  selectedModesSummary: $('selectedModesSummary'),
  protagonistInput: $('protagonistInput'),
  analysisCard: $('analysisCard'),
  analysisTitle: $('analysisTitle'),
  analysisState: $('analysisState'),
  analysisOutput: $('analysisOutput'),
  playerSection: $('playerSection'),
  video: $('video'),
  subtitleOverlay: $('subtitleOverlay'),
  subtitleSpeaker: $('subtitleSpeaker'),
  subtitleText: $('subtitleText'),
  dubToggleBtn: $('dubToggleBtn'),
  dubBufferStatus: $('dubBufferStatus'),
  dubBufferMessage: $('dubBufferMessage'),
  dubRetryBtn: $('dubRetryBtn'),
  dubContinueOriginalBtn: $('dubContinueOriginalBtn'),
  gameState: $('gameState'),
  cursorText: $('cursorText'),
  choices: $('choices'),
  prevChoiceBtn: $('prevChoiceBtn'),
  nextChoiceBtn: $('nextChoiceBtn'),
  timelineList: $('timelineList'),
  adultTraceToggleBtn: $('adultTraceToggleBtn'),
  adultTraceDownloadBtn: $('adultTraceDownloadBtn'),
  adultTraceOutput: $('adultTraceOutput'),
  videoPrompt: $('videoPrompt'),
  debugOutput: $('debugOutput'),
  adultInteractionPanel: $('adultInteractionPanel'),
  approachChoices: $('approachChoices'),
  adultPanelToggleBtn: $('adultPanelToggleBtn'),
  adultDockPhase: $('adultDockPhase'),
  adultDockTitle: $('adultDockTitle'),
  adultDockLustValue: $('adultDockLustValue'),
  adultDockMaleValue: $('adultDockMaleValue'),
  adultQuickChoices: $('adultQuickChoices'),
  adultFeelToggle: $('adultFeelToggle'),
  adultDockMoreBtn: $('adultDockMoreBtn'),
  adultSceneTitle: $('adultSceneTitle'),
  adultSceneTime: $('adultSceneTime'),
  adultPhaseBadge: $('adultPhaseBadge'),
  adultPhaseTitle: $('adultPhaseTitle'),
  adultPhaseHint: $('adultPhaseHint'),
  discoveryGate: $('discoveryGate'),
  discoveryGateText: $('discoveryGateText'),
  discoveryGateMeta: $('discoveryGateMeta'),
  foreplaySection: $('foreplaySection'),
  foreplayCount: $('foreplayCount'),
  foreplayChoices: $('foreplayChoices'),
  categorySection: $('categorySection'),
  groupPartnerSection: $('groupPartnerSection'),
  groupPartnerTabs: $('groupPartnerTabs'),
  positionSection: $('positionSection'),
  movementSection: $('movementSection'),
  positionCount: $('positionCount'),
  categoryCount: $('categoryCount'),
  categoryTabs: $('categoryTabs'),
  positionTabs: $('positionTabs'),
  movementHeading: $('movementHeading'),
  movementCount: $('movementCount'),
  movementChoices: $('movementChoices'),
  maleProgressText: $('maleProgressText'),
  maleProgressBar: $('maleProgressBar'),
  femaleProgressText: $('femaleProgressText'),
  femaleProgressBar: $('femaleProgressBar'),
  orgasmDecision: $('orgasmDecision'),
  orgasmDecisionTitle: $('orgasmDecisionTitle'),
  orgasmDecisionMeta: $('orgasmDecisionMeta'),
  orgasmContinueBtn: $('orgasmContinueBtn'),
  orgasmFinishBtn: $('orgasmFinishBtn'),
  adultFlowStatus: $('adultFlowStatus'),
  nextVariantBtn: $('nextVariantBtn'),
  rhythmControl: $('rhythmControl'),
  rhythmTapBtn: $('rhythmTapBtn'),
  rhythmTapLabel: $('rhythmTapLabel'),
  rhythmTapStatus: $('rhythmTapStatus'),
  outcomeSection: $('outcomeSection'),
  outcomeCount: $('outcomeCount'),
  outcomeChoices: $('outcomeChoices'),
  finishAdultSceneBtn: $('finishAdultSceneBtn'),
};

const tactile = createTactileEngine();

function renderTactileToggle() {
  if (!els.adultFeelToggle) return;
  const enabled = tactile.enabled;
  els.adultFeelToggle.classList.toggle('active', enabled);
  els.adultFeelToggle.setAttribute('aria-pressed', String(enabled));
  els.adultFeelToggle.setAttribute('aria-label', `Dokunsal geri bildirim ${enabled ? 'açık' : 'kapalı'}`);
  els.adultFeelToggle.title = tactile.supported
    ? `Dokunsal geri bildirim ${enabled ? 'açık' : 'kapalı'}`
    : 'Bu tarayıcı titreşimi desteklemiyor; görsel geri bildirim açık';
}

function setServiceStatus(kind, label, meta = '') {
  els.serviceStatus.className = `status ${kind}`;
  els.serviceStatus.textContent = label;
  els.serviceMeta.textContent = meta;
}

// Earlier runtime snapshots can contain completed scene IDs and position tabs
// from the old routing graph. A new analysis still uses its verified source
// actions, but playback starts with a fresh progression state.
const RUNTIME_SAVE_KEY = 'videoquest:runtime-state-v3';

function logEngineEvent(type, data = {}) {
  appendEngineEvent(state.engineEvents, type, data);
}

function removeStoredValue(storageName, key) {
  // Storage can be disabled even when its global property exists.
  try { globalThis[storageName]?.removeItem(key); } catch {}
}

let analysisWakeLock = null;

async function acquireAnalysisWakeLock() {
  if (
    !('wakeLock' in navigator) ||
    document.visibilityState !== 'visible' ||
    state.gameState !== 'ANALYZING' ||
    analysisWakeLock
  ) {
    return;
  }

  try {
    analysisWakeLock = await navigator.wakeLock.request('screen');

    analysisWakeLock.addEventListener(
      'release',
      () => {
        analysisWakeLock = null;
      },
      { once: true }
    );
  } catch (error) {
    console.warn('Ekran uyanık tutma kilidi alınamadı:', error);
  }
}

async function releaseAnalysisWakeLock() {
  const wakeLock = analysisWakeLock;
  analysisWakeLock = null;

  if (wakeLock) {
    await wakeLock.release().catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    state.gameState === 'ANALYZING'
  ) {
    acquireAnalysisWakeLock();
  }
});

function setGameState(next) {
  const previous = state.gameState;
  state.gameState = next;
  els.gameState.textContent = next;
  if (previous !== next) {
    logEngineEvent('GAME_STATE_CHANGED', { from: previous, to: next });
  }

  if (next === 'ANALYZING') {
    acquireAnalysisWakeLock();
  } else {
    releaseAnalysisWakeLock();
  }

  const stage = document.querySelector('.video-stage');
  if (stage) {
    stage.dataset.state = next;
  }

  renderDebug();
}

function renderDebug(extra = {}) {
  const payload = {
    serviceConnected: state.serviceConnected,
    serviceCapabilities: state.serviceCapabilities,
    gameState: state.gameState,
    gameCursorTime: Number(state.gameCursorTime.toFixed(3)),
    currentActionIndex: state.currentActionIndex,
    activeActionId: state.activeAction?.actionId ?? null,
    consumedActionIds: [...state.consumedActionIds],
    videoCurrentTime: Number((els.video.currentTime || 0).toFixed(3)),
    schemaVersion: state.analysis?.schemaVersion ?? null,
    engineVersion: state.analysis?.engineVersion ?? ENGINE_VERSION,
    integrityReport: state.integrityReport,
    storyContext: state.analysis?.storyContext ?? null,
    adultPhaseMachine: state.adultPhaseMachine,
    recentEngineEvents: state.engineEvents.slice(-30),
    ...extra,
  };
  els.debugOutput.textContent = JSON.stringify(payload, null, 2);
}

async function checkHealth() {
  setServiceStatus('status-checking', 'CHECKING…');
  try {
    const [healthResp, capsResp] = await Promise.all([
      fetch('/api/external-health'),
      fetch('/api/external-capabilities')
    ]);
    const health = await healthResp.json();
    const caps = await capsResp.json();
    state.serviceConnected = Boolean(health.connected);
    state.serviceCapabilities = caps;
    if (state.serviceConnected) {
      setServiceStatus('status-ok', 'CONNECTED', `${health.endpoint} • ${health.latencyMs} ms`);
    } else {
      setServiceStatus('status-bad', 'UNAVAILABLE', health.error || `upstream ${health.upstreamStatus ?? '?'}`);
    }
  } catch (error) {
    state.serviceConnected = false;
    setServiceStatus('status-bad', 'UNAVAILABLE', error.message);
  }
  updateAnalyzeAvailability();
  renderDebug();
}

function renderQuotaBadge(element, status) {
  if (!element) return;
  const stateName = String(status?.state || 'unknown');
  element.className = `quota-status ${stateName}`;
  if (stateName === 'blocked') {
    const retry = Math.max(1, Math.ceil(Number(status.retryAfterSeconds) || 0));
    element.textContent = retry >= 3600
      ? `Limit dolu · ${Math.ceil(retry / 3600)} sa.`
      : `Limit dolu · ${Math.ceil(retry / 60)} dk.`;
  } else if (stateName === 'checking') {
    element.textContent = 'Kontrol ediliyor';
  } else if (stateName === 'available') {
    element.textContent = 'Servis hazır';
  } else if (stateName === 'no_credits') {
    element.textContent = 'Gemini kredisi yok';
  } else if (stateName === 'daily_limit') {
    element.textContent = 'Gemini kota dolu';
  } else if (stateName === 'rate_limited') {
    element.textContent = 'Gemini limitte';
  } else if (stateName === 'invalid') {
    element.textContent = 'Gemini anahtarı geçersiz';
  } else if (stateName === 'forbidden') {
    element.textContent = 'Gemini erişimi yok';
  } else if (stateName === 'unconfigured') {
    element.textContent = 'Kullanılamıyor';
  } else {
    element.textContent = 'Kalan miktar bilinmiyor';
  }
  element.title = status?.message || '';
}

const GEMINI_SESSION_KEY = 'videoquest_gemini_api_key';
// ElevenLabs credentials live only in the password control or this module's
// memory. They are deliberately excluded from the serializable game state.
let browserElevenLabsApiKey = '';
let mediaCapabilitiesRefreshTimer = null;

function normalizedProviderKey(value, assignmentName = '') {
  return String(value || '')
    .trim()
    .replace(assignmentName ? new RegExp(`^${assignmentName}\\s*=\\s*`, 'i') : /^$/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function activeElevenLabsApiKey() {
  return normalizedProviderKey(els.elevenLabsApiKeyInput?.value || browserElevenLabsApiKey || '', 'ELEVENLABS_API_KEY');
}

function renderElevenLabsApiKeyState() {
  const active = Boolean(activeElevenLabsApiKey());
  if (els.elevenLabsApiKeyStatus) els.elevenLabsApiKeyStatus.textContent = active
    ? 'Bu sekmede kendi anahtarın kullanılıyor' : 'Sunucu anahtarı kullanılıyor';
  els.clearElevenLabsApiKeyBtn?.classList.toggle('hidden', !active);
  els.testElevenLabsApiKeyBtn?.classList.toggle('hidden', !active);
}

function invalidateTurkishMediaCredentials(refreshDelay = 0, { preservePreparedMedia = false } = {}) {
  const keepReadyMedia = preservePreparedMedia && Boolean(state.analysisSession?.mediaManifest?.version === 1);
  // A new account cannot reuse an earlier account's prepared package or
  // catalogue. Source bytes, grounded speech, frames and gameplay stay intact.
  state.mediaCredentialGeneration = (Number(state.mediaCredentialGeneration) || 0) + 1;
  state.voiceMappingGeneration = (Number(state.voiceMappingGeneration) || 0) + 1;
  state.voiceCatalog = null;
  state.voiceCatalogPromise = null;
  state.mediaRevoice = null;
  if (!keepReadyMedia) {
    if (state.analysisSession) {
      state.analysisSession.mediaManifest = null;
      state.analysisSession.mediaModeKey = '';
    }
    mediaClient.reset();
    state.turkishMediaStatus = null;
  }
  // A Gemini key change only affects future paid requests. It must not discard
  // an already generated MP3 or the verified source/visual analysis.
  state.geminiProviderStatus = null;
  els.voiceMappingRows?.replaceChildren?.();
  if (els.voiceMappingPanel) els.voiceMappingPanel.open = false;
  els.mediaJobStatus?.classList.add('hidden');
  els.mediaJobRetryBtn?.classList.toggle('hidden', !state.analysisSession?.pendingTurkishMedia);
  els.dubBufferStatus?.classList.add('hidden');
  renderMediaControls();
  renderElevenLabsApiKeyState();
  for (const badge of [els.subtitleQuotaStatus, els.dubQuotaStatus]) {
    renderQuotaBadge(badge, { state: 'checking', message: 'Girilen anahtarlarla servis durumu kontrol ediliyor.' });
  }
  updateAnalyzeAvailability();
  clearTimeout(mediaCapabilitiesRefreshTimer);
  mediaCapabilitiesRefreshTimer = setTimeout(() => {
    mediaCapabilitiesRefreshTimer = null;
    void checkTurkishMediaCapabilities();
  }, refreshDelay);
}

function saveElevenLabsApiKey() {
  if (state.analysisInProgress || state.savedGameBusy) return;
  const key = activeElevenLabsApiKey();
  if (key.length < 20 || key.length > 1024 || /\s/.test(key)) {
    if (els.elevenLabsApiKeyStatus) els.elevenLabsApiKeyStatus.textContent = 'Anahtar eksik veya boşluk içeriyor';
    return;
  }
  browserElevenLabsApiKey = key;
  if (els.elevenLabsApiKeyInput) els.elevenLabsApiKeyInput.value = '';
  invalidateTurkishMediaCredentials();
}

function clearElevenLabsApiKey() {
  if (state.analysisInProgress || state.savedGameBusy) return;
  browserElevenLabsApiKey = '';
  if (els.elevenLabsApiKeyInput) els.elevenLabsApiKeyInput.value = '';
  invalidateTurkishMediaCredentials();
}

async function testElevenLabsApiKey() {
  if (!activeElevenLabsApiKey() || state.analysisInProgress || state.savedGameBusy) return;
  const generation = state.mediaCredentialGeneration;
  if (els.testElevenLabsApiKeyBtn) els.testElevenLabsApiKeyBtn.disabled = true;
  if (els.elevenLabsApiKeyStatus) els.elevenLabsApiKeyStatus.textContent = 'Anahtar kontrol ediliyor';
  try {
    const voices = await mediaClient.getVoices();
    if (generation !== state.mediaCredentialGeneration) return;
    state.voiceCatalog = voices;
    renderVoiceMappingPanel();
    if (els.elevenLabsApiKeyStatus) els.elevenLabsApiKeyStatus.textContent = 'ElevenLabs anahtarı çalışıyor';
  } catch (error) {
    if (generation === state.mediaCredentialGeneration && els.elevenLabsApiKeyStatus) {
      els.elevenLabsApiKeyStatus.textContent = error?.name === 'AbortError' ? 'Anahtar kontrolü iptal edildi' : 'Anahtar doğrulanamadı; tekrar dene';
    }
  } finally {
    if (els.testElevenLabsApiKeyBtn) els.testElevenLabsApiKeyBtn.disabled = Boolean(state.analysisInProgress || state.savedGameBusy);
  }
}

function activeGeminiApiKey() {
  try { return String(sessionStorage.getItem(GEMINI_SESSION_KEY) || '').trim(); }
  catch { return ''; }
}

function geminiRequestHeaders(base = {}) {
  const key = activeGeminiApiKey();
  return key ? { ...base, 'X-Gemini-Api-Key': key } : { ...base };
}

function renderGeminiApiKeyState() {
  const active = Boolean(activeGeminiApiKey());
  const provider = state.geminiProviderStatus;
  if (els.apiKeyStatus) {
    els.apiKeyStatus.textContent = active
      ? (provider?.state === 'no_credits'
          ? 'Kendi Gemini anahtarında kredi yok'
          : provider?.state === 'available'
            ? 'Kendi Gemini anahtarın hazır'
            : 'Bu oturumda kendi anahtarın kullanılıyor')
      : (provider?.source === 'server' && provider?.state === 'no_credits'
          ? 'Sunucu Gemini kredisi tükendi'
          : provider?.source === 'server' && provider?.state === 'available'
            ? 'Sunucu Gemini anahtarı hazır'
            : 'Sunucu anahtarı kullanılıyor');
  }
  els.clearGeminiApiKeyBtn?.classList.toggle('hidden', !active);
  els.testGeminiApiKeyBtn?.classList.toggle('hidden', !active);
  if (active && els.geminiApiKeyInput) els.geminiApiKeyInput.value = '';
}

function saveGeminiApiKey() {
  if (state.analysisInProgress || state.savedGameBusy) return;
  const key = normalizedProviderKey(els.geminiApiKeyInput?.value || '', 'GEMINI_API_KEY');
  if (key.length < 20 || key.length > 512 || /\s/.test(key)) {
    if (els.apiKeyStatus) els.apiKeyStatus.textContent = 'Anahtar eksik veya boşluk içeriyor';
    return;
  }
  try { sessionStorage.setItem(GEMINI_SESSION_KEY, key); } catch {}
  renderGeminiApiKeyState();
  invalidateTurkishMediaCredentials(0, { preservePreparedMedia: true });
  // Saving a replacement credential must not burn another Gemini request.
  // The dedicated "Test et" button remains available for an explicit test.
}

async function testGeminiApiKey() {
  if (!activeGeminiApiKey()) return;
  if (els.testGeminiApiKeyBtn) {
    els.testGeminiApiKeyBtn.disabled = true;
    els.testGeminiApiKeyBtn.textContent = 'Test...';
  }
  if (els.apiKeyStatus) {
    els.apiKeyStatus.className = 'checking';
    els.apiKeyStatus.textContent = 'Anahtar ve kota kontrol ediliyor';
  }
  try {
    const response = await fetch('/api/gemini-key-status', {
      method: 'POST',
      headers: geminiRequestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ verify: true })
    });
    const body = await response.json().catch(() => ({}));
    state.geminiProviderStatus = { ...body, state: String(body.state || (response.ok ? 'available' : 'unavailable')) };
    renderGeminiApiKeyState();
    if (els.apiKeyStatus) {
      els.apiKeyStatus.className = String(body.state || 'unavailable');
      els.apiKeyStatus.textContent = body.message || (response.ok ? 'Anahtar çalışıyor' : 'Anahtar kullanılamıyor');
    }
    updateAnalyzeAvailability();
  } catch {
    if (els.apiKeyStatus) {
      els.apiKeyStatus.className = 'unavailable';
      els.apiKeyStatus.textContent = 'Bağlantı kurulamadı; tekrar dene';
    }
  } finally {
    if (els.testGeminiApiKeyBtn) {
      els.testGeminiApiKeyBtn.disabled = false;
      els.testGeminiApiKeyBtn.textContent = 'Test et';
    }
  }
}

function clearGeminiApiKey() {
  if (state.analysisInProgress || state.savedGameBusy) return;
  try { sessionStorage.removeItem(GEMINI_SESSION_KEY); } catch {}
  if (els.geminiApiKeyInput) els.geminiApiKeyInput.value = '';
  renderGeminiApiKeyState();
  invalidateTurkishMediaCredentials(0, { preservePreparedMedia: true });
}

async function checkTurkishMediaCapabilities() {
  const generation = state.mediaCredentialGeneration;
  try {
    const capabilities = await mediaClient.getCapabilities();
    if (generation !== state.mediaCredentialGeneration) return;

    let available = Boolean(capabilities.configured);
    let stateName = available ? 'available' : 'unconfigured';
    let message = capabilities.transcriptionConfigured === false
      ? 'Türkçe dublaj için ElevenLabs anahtarını gir.'
      : capabilities.translationConfigured === false
        ? 'Türkçe çeviri için Gemini anahtarı gerekiyor. Kendi anahtarını girebilirsin.'
        : available
          ? 'Türkçe medya servisi hazır.'
          : 'Türkçe medya servisi şu an kullanılamıyor.';

    // Capabilities are configuration checks, not paid inference. Only the
    // user's explicit key test calls Gemini; periodic refresh stays local.

    renderQuotaBadge(els.subtitleQuotaStatus, { state: available ? 'available' : stateName, message });
    renderQuotaBadge(els.dubQuotaStatus, { state: available ? 'available' : stateName, message });
    updateAnalyzeAvailability();
  } catch {
    if (generation !== state.mediaCredentialGeneration) return;
    renderQuotaBadge(els.subtitleQuotaStatus, { state: 'unknown' });
    renderQuotaBadge(els.dubQuotaStatus, { state: 'unknown' });
    updateAnalyzeAvailability();
  }
}

function selectedAnalysisModes() {
  return {
    motion: Boolean(els.motionMode?.checked),
    subtitles: Boolean(els.subtitleMode?.checked),
    dubbing: Boolean(els.dubMode?.checked),
    dubQuality: String(els.dubQualityMode?.value || 'quality'),
    dubbingProvider: 'classic',
    quality: 'ultra',
    analysisTier: els.deepAnalysisMode?.checked ? 'deep' : 'economy'
  };
}

function updateAnalysisModesUI() {
  const modes = selectedAnalysisModes();
  const analysisModelLabel = modes.analysisTier === 'deep'
    ? 'Derin Analiz · güçlü Gemini' : 'Ayrıntılı analiz · ekonomik Gemini';

  const active = [];
  if (modes.motion) active.push('hareket ve seçim');
  if (modes.subtitles) active.push('Türkçe altyazı');
  if (modes.dubbing) active.push('Türkçe dublaj');

  if (els.selectedModesSummary) {
    els.selectedModesSummary.textContent = active.length
      ? `${analysisModelLabel} · ${active.join(' + ')}`
      : 'En az bir analiz modu seçmelisin.';
  }

  return active.length > 0;
}

function updateAnalyzeAvailability() {
  const hasMode = updateAnalysisModesUI();
  const busy = state.analysisInProgress || state.urlResolutionInProgress || state.savedGameBusy;
  const needsGemini = Boolean(els.motionMode?.checked || els.dubMode?.checked || els.subtitleMode?.checked);
  const geminiBlocked = needsGemini &&
    ['no_credits', 'daily_limit', 'rate_limited', 'invalid', 'forbidden', 'unconfigured']
      .includes(String(state.geminiProviderStatus?.state || ''));
  els.analyzeBtn.disabled = busy || geminiBlocked || !(state.selectedFile || state.selectedRemoteVideo) || !hasMode;
  els.videoInput.disabled = busy;
  $('videoUrl').disabled = busy;
  $('resolveUrlBtn').disabled = busy;
  [els.deepAnalysisMode, els.dubQualityMode, els.dubbingProvider, els.motionMode, els.subtitleMode, els.dubMode]
    .forEach(control => { if (control) control.disabled = busy; });
  [els.elevenLabsApiKeyInput, els.saveElevenLabsApiKeyBtn, els.testElevenLabsApiKeyBtn,
    els.clearElevenLabsApiKeyBtn, els.geminiApiKeyInput, els.saveGeminiApiKeyBtn,
    els.testGeminiApiKeyBtn, els.clearGeminiApiKeyBtn]
    .forEach(control => { if (control) control.disabled = busy; });
  if (els.mediaJobRetryBtn) els.mediaJobRetryBtn.disabled = busy;
  if (els.voiceMappingApplyBtn) els.voiceMappingApplyBtn.disabled = busy || !els.dubMode.checked;
  els.voiceMappingRows?.querySelectorAll?.('select').forEach(select => { select.disabled = busy; });
  savedGames?.refreshControls();
}

[
  els.deepAnalysisMode,
  els.motionMode,
  els.subtitleMode,
  els.dubMode,
  els.dubQualityMode,
  els.dubbingProvider
].forEach(control => {
  control?.addEventListener('change', updateAnalyzeAvailability);
});

els.healthBtn.addEventListener('click', checkHealth);
els.saveGeminiApiKeyBtn?.addEventListener('click', saveGeminiApiKey);
els.testGeminiApiKeyBtn?.addEventListener('click', testGeminiApiKey);
els.clearGeminiApiKeyBtn?.addEventListener('click', clearGeminiApiKey);
els.geminiApiKeyInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') saveGeminiApiKey();
});
els.elevenLabsApiKeyInput?.addEventListener('input', () => {
  if (state.analysisInProgress || state.savedGameBusy) return;
  invalidateTurkishMediaCredentials(300);
});
els.elevenLabsApiKeyInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') saveElevenLabsApiKey();
});
els.saveElevenLabsApiKeyBtn?.addEventListener('click', saveElevenLabsApiKey);
els.testElevenLabsApiKeyBtn?.addEventListener('click', testElevenLabsApiKey);
els.clearElevenLabsApiKeyBtn?.addEventListener('click', clearElevenLabsApiKey);
renderGeminiApiKeyState();
renderElevenLabsApiKeyState();
removeStoredValue('sessionStorage', 'videoquest_elevenlabs_api_key');

function releaseVideoObjectUrl() {
  if (!state.videoObjectUrl) return;
  URL.revokeObjectURL(state.videoObjectUrl);
  state.videoObjectUrl = '';
}

els.videoInput.addEventListener('change', () => {
  if (state.analysisInProgress || state.urlResolutionInProgress || state.savedGameBusy) return;
  const file = els.videoInput.files?.[0] || null;
  clearPreviousGameResidue();
  state.selectedFile = file;
  state.selectedSourceKind = 'file';
  state.selectedRemoteVideo = null;
  state.selectedRemoteToken = '';
  state.urlCacheKey = '';
  state.urlCacheSavePromise = null;
  state.analysisSession = null;
  if (file) {
    hideBrowserDownloadHelp();
    els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • ${file.type || 'video'}`;
    state.videoObjectUrl = URL.createObjectURL(file);
    els.video.src = state.videoObjectUrl;
  } else {
    els.fileMeta.textContent = '';
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  updateAnalyzeAvailability();
  renderDebug();
});

function recordAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'thinkingTokens', 'totalTokens', 'cacheHits']) {
    state.aiUsage[key] = (state.aiUsage[key] || 0) + Math.max(0, Number(usage[key]) || 0);
  }
  logEngineEvent('AI_USAGE', { ...state.aiUsage });
}

const analysisProgress = createAnalysisProgress({ list: els.analysisStepList, summary: els.mediaJobSummary,
  detail: els.mediaJobDetail, message: els.mediaJobMessage, bar: els.mediaJobProgress, container: els.mediaJobStatus });
let analysisAbortController = null;

function storyboardProgress(progress, detail) {
  analysisProgress.update('frames', { loaded: detail?.captured, total: detail?.total, unit: 'kare',
    detail: detail?.retrying ? 'Okunamayan kare yeniden deneniyor.' : 'Kareler cihazdan okunuyor.' });
}

const analysisResponseCache = createAnalysisResponseCache();
const readServerRevision = createServerRevisionReader();

async function postAnalysisForm(path, form, options = {}) {
  if (path !== '/api/gemini-storyboard-analyze') return sendAnalysisForm(path, form, options);
  const signal = analysisAbortController?.signal;
  signal?.throwIfAborted();
  let key = null;
  try {
    const revision = await readServerRevision({ signal });
    key = await analysisRequestKey({ revision, path, form, headers: options.headers });
  } catch { signal?.throwIfAborted(); }
  const result = await analysisResponseCache.run(key, async () => {
    const response = await sendAnalysisForm(path, form, options);
    return { status: response.status, body: await response.json() };
  }, { signal });
  if (result.outcome) analysisProgress.update(options.stage || 'analysis', {
    status: 'done', detail: (options.label || 'Analiz') + ' · Önceki doğrulanmış yanıt kullanıldı; Gemini çağrılmadı.' });
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}

async function sendAnalysisForm(path, form, { stage = 'analysis', timeoutMs = 240000, headers = {}, label = '' } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = analysisAbortController ? AbortSignal.any([timeout, analysisAbortController.signal]) : timeout;
  analysisProgress.update(stage, { status: 'working', detail: label + ' · Görüntüler gönderiliyor.' });
  if (typeof globalThis.XMLHttpRequest !== 'function') {
    analysisProgress.update(stage, { status: 'waiting', detail: label + ' · Sunucu yanıtı bekleniyor.' });
    return fetch(path, { method: 'POST', headers, body: form, signal });
  }
  return requestWithUploadProgress(path, { headers, body: form, signal, timeoutMs,
    onProgress: transfer => {
      analysisProgress.update('frameUpload', { status: transfer.phase === 'waiting' ? 'done' : 'working',
        loaded: transfer.loaded, total: transfer.total, unit: 'bytes', detail: label +
          (transfer.phase === 'waiting' ? ' · Görüntüler gönderildi.' : ' · Görüntüler gönderiliyor.') });
      if (transfer.phase === 'waiting') analysisProgress.update(stage, {
        status: 'waiting', detail: label + ' · Gemini analiz yanıtı bekleniyor.' });
    } });
}

const mediaClient = createTurkishMediaClient({
  video: els.video,
  getElevenLabsApiKey: activeElevenLabsApiKey,
  getGeminiApiKey: activeGeminiApiKey,
  captionElements: { overlay: els.subtitleOverlay, speaker: els.subtitleSpeaker, text: els.subtitleText },
  onStatus: onTurkishMediaStatus
});

function updateSourceTranscript(transcript) {
  state.sourceTranscript = transcript || null;
  state.sourceContext = sourceContextAdapter(transcript);
  const session = state.analysisSession;
  if (session) {
    session.sourceTranscript = state.sourceTranscript;
    session.audioContextStatus = transcript
      ? (state.sourceContext?.segments.length ? 'ready' : 'no_speech') : 'unavailable';
  }
}

function onTurkishMediaStatus(status) {
  state.turkishMediaStatus = status;
  if (status.state === 'FAILED' && status.error?.code === 'VOICE_PROFILE_UNVERIFIED') {
    state.voiceMappingManualRequested = true;
  }
  if (status.sourceTranscript) { updateSourceTranscript(status.sourceTranscript); renderVoiceMappingPanel(); }
  logEngineEvent('TURKISH_MEDIA_STATUS', { state: status.state, jobId: status.jobId || null });
  if (status.state === 'PLAYBACK_READY') { els.dubBufferStatus.classList.add('hidden'); return; }
  if (['PLAYBACK_BLOCKED', 'PLAYBACK_FAILED'].includes(status.state)) {
    els.dubBufferMessage.textContent = status.message || 'Türkçe ses oynatılamadı.';
    els.dubBufferStatus.classList.remove('hidden');
    return;
  }
  els.mediaJobStatus?.classList.remove('hidden');
  analysisProgress.observe(status);
  if (els.mediaJobMessage) els.mediaJobMessage.textContent = status.message || 'Türkçe medya hazırlanıyor.';
  const terminal = ['FAILED', 'CANCELLED'].includes(status.state) ||
    (status.state === 'READY' && !state.analysisInProgress);
  if (['FAILED', 'CANCELLED'].includes(status.state)) {
    els.analysisState.textContent = status.error?.code || status.state;
    els.analysisTitle.textContent = status.state === 'CANCELLED' ? 'İşlem iptal edildi' : 'İşlem tamamlanamadı';
  }
  els.mediaJobCancelBtn?.classList.toggle('hidden', terminal);
  els.mediaJobRetryBtn?.classList.toggle('hidden', status.state !== 'FAILED');
  if (status.state === 'FAILED' && status.error?.code) {
    if (status.error.code === 'GEMINI_CREDITS_EXHAUSTED') {
      state.geminiProviderStatus = {
        state: 'no_credits',
        source: activeGeminiApiKey() ? 'browser' : 'server',
        message: status.error.message
      };
      renderGeminiApiKeyState();
      renderQuotaBadge(els.subtitleQuotaStatus, state.geminiProviderStatus);
      renderQuotaBadge(els.dubQuotaStatus, state.geminiProviderStatus);
      updateAnalyzeAvailability();
    }
    if (state.analysisInProgress) {
      els.analysisState.textContent = status.error.code;
      els.analysisTitle.textContent = status.error.code === 'GEMINI_CREDITS_EXHAUSTED'
        ? 'Gemini API kredisi tükendi'
        : 'Türkçe medya hazırlanamadı';
      els.analysisOutput.textContent = status.error.message || status.message || 'Türkçe medya işlemi tamamlanamadı.';
    }
  } else if (state.analysisInProgress && !terminal) {
    els.analysisState.textContent = status.state;
    els.analysisTitle.textContent = status.message || 'Türkçe medya hazırlanıyor';
  }
}

function renderMediaControls() {
  const captured = mediaClient.capture();
  state.dubbingEnabled = Boolean(captured?.dubEnabled);
  state.subtitlesEnabled = Boolean(captured && captured.subtitleTrack !== 'off');
  state.languageSyncOffset = Number(captured?.syncOffset) || 0;
  const hasCues = track => Boolean((Array.isArray(track) ? track : track?.cues)?.length);
  const subtitles = captured?.manifest.subtitles;
  if (els.subtitleTrack) {
    els.subtitleTrack.classList.toggle('hidden', !hasCues(subtitles?.source_tr) && !hasCues(subtitles?.dub_tr));
    els.subtitleTrack.value = captured?.subtitleTrack || 'off';
    for (const option of els.subtitleTrack.options) {
      option.disabled = option.value !== 'off' && !hasCues(subtitles?.[option.value]);
      option.hidden = option.disabled || (option.value === 'source_tr' && hasCues(subtitles?.dub_tr));
    }
  }
  els.dubToggleBtn.classList.toggle('hidden', !captured?.manifest.assets?.mix);
  els.dubToggleBtn.textContent = `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;
  els.dubToggleBtn.setAttribute('aria-pressed', String(state.dubbingEnabled));
  if (els.mediaExports) {
    let available = false;
    for (const link of els.mediaExports.querySelectorAll('[data-media-asset]')) {
      const url = captured?.manifest.assets?.[link.dataset.mediaAsset]?.url;
      link.classList.toggle('hidden', !url);
      if (url) {
        link.href = url; available = true;
        if (link.dataset.mediaAsset === 'mix') link.download = captured.manifest.assets.mix.mimeType === 'audio/mpeg' ? 'dublaj-tr.mp3' : 'dublaj-tr.wav';
      }
      else link.removeAttribute('href');
    }
    els.mediaExports.classList.toggle('hidden', !available);
  }
  renderVoiceMappingPanel();
}

// Gameplay hooks follow the finished mix. They create no requests and never
// extend a source clip to accommodate generated speech.
function renderSubtitle() { mediaClient.sync(); }
function primeLanguageTracksAt() { mediaClient.sync(); }
function primeAdultPositionLanguage() { mediaClient.sync(); }
function resyncLanguageTracks() { mediaClient.sync(); }
function turkishMediaDebugReport() {
  const media = mediaClient.capture();
  return { dubbingEnabled: state.dubbingEnabled, subtitleTrack: media?.subtitleTrack || 'off',
    qualityReport: media?.manifest.qualityReport || null, jobState: state.turkishMediaStatus?.state || null };
}

els.subtitleTrack?.addEventListener('change', () => {
  mediaClient.setSubtitleTrack(els.subtitleTrack.value);
  renderMediaControls();
});
els.dubToggleBtn?.addEventListener('click', () => {
  mediaClient.setDubEnabled(!state.dubbingEnabled);
  els.dubBufferStatus.classList.add('hidden');
  renderMediaControls();
});
els.dubRetryBtn?.addEventListener('click', () => {
  els.dubBufferStatus.classList.add('hidden');
  mediaClient.retryPlayback();
});
els.dubContinueOriginalBtn?.addEventListener('click', () => {
  mediaClient.setDubEnabled(false);
  els.dubBufferStatus.classList.add('hidden');
  renderMediaControls();
});
els.mediaJobCancelBtn?.addEventListener('click', () => {
  analysisAbortController?.abort(new DOMException('Analiz iptal edildi.', 'AbortError'));
  if (analysisAbortController) state.remoteFileDownload?.controller.abort();
  const revoice = state.mediaRevoice;
  if (revoice) revoice.cancelled = true;
  void mediaClient.cancel();
  if (revoice) {
    restorePreviousVoices(revoice);
    state.mediaRevoice = null;
  }
  onTurkishMediaStatus({ state: 'CANCELLED', message: 'Türkçe medya işlemi iptal edildi.' });
  renderMediaControls();
});
els.mediaJobRetryBtn?.addEventListener('click', async () => {
  if (state.analysisInProgress || state.savedGameBusy) return;
  if (state.mediaRevoice) { await regenerateTurkishVoices(state.mediaRevoice, true); return; }
  if (hasPendingTurkishMediaRecovery()) { await resumePreparedTurkishMedia(); return; }
  const session = state.analysisSession;
  if (!session) return;
  state.analysisInProgress = true; updateAnalyzeAvailability();
  setGameState('ANALYZING');
  let completed = false, cancelled = false;
  try {
    const result = await mediaClient.retry();
    if (state.analysisSession !== session) return;
    session.mediaManifest = result;
    updateSourceTranscript(result.sourceTranscript);
    renderMediaControls(); completed = true;
  } catch (error) {
    cancelled = error.name === 'AbortError';
    if (error.name !== 'AbortError') els.mediaJobMessage.textContent = error.message;
  } finally {
    state.analysisInProgress = false; updateAnalyzeAvailability();
    if (!completed) setGameState(cancelled ? 'IDLE' : 'ERROR');
  }
  if (completed) els.analyzeBtn.click();
});

function renderVoiceMappingPanel() {
  const speakers = state.sourceTranscript?.speakers || [];
  if (!els.voiceMappingPanel || !els.voiceMappingRows) return;
  // Voice selection stays automatic. The optional editor is collapsed by
  // default and must not imply that an unknown source voice blocks a ready dub.
  const manual = state.voiceMappingManualRequested === true || Boolean(
    mediaClient.capture()?.manifest?.assets?.mix && speakers.length);
  els.voiceMappingPanel.classList.toggle('hidden', !manual || !speakers.length);
  if (manual && els.voiceMappingPanel.querySelector?.('summary')) {
    els.voiceMappingPanel.querySelector('summary').textContent =
      state.turkishMediaStatus?.error?.code === 'VOICE_PROFILE_UNVERIFIED'
        ? 'Dublaj için kaynak sesleri seç' : 'Sesleri düzenle · isteğe bağlı';
  }
  if (!manual) {
    els.voiceMappingPanel.open = false;
    els.voiceMappingRows.replaceChildren();
    els.voiceMappingApplyBtn.disabled = true;
    return;
  }
  if (!els.voiceMappingPanel.open || !state.voiceCatalog) {
    els.voiceMappingApplyBtn.disabled = true;
    return;
  }
  const previous = mediaClient.capture()?.manifest.voiceMapping || {};
  const draft = new Map([...els.voiceMappingRows.querySelectorAll('select')]
    .map(select => [select.dataset.speakerId, select.value]));
  const genderLabel = gender => gender === 'male' ? 'Erkek' : gender === 'female' ? 'Kadın' : 'Belirsiz';
  const rows = speakers.map((speaker, index) => {
    const label = document.createElement('label');
    const title = document.createElement('span');
    title.textContent = `Kaynak ses ${index + 1} · ${genderLabel(speaker.gender)}`;
    const select = document.createElement('select');
    select.dataset.speakerId = speaker.speakerId;
    select.setAttribute('aria-label', `${title.textContent} için Türkçe ses`);
    const automatic = document.createElement('option');
    automatic.value = ''; automatic.textContent = 'Otomatik ses seçimi'; select.append(automatic);
    for (const voice of state.voiceCatalog) {
      const option = document.createElement('option'); option.value = voice.voiceId;
      option.textContent = `${voice.name} · ${genderLabel(voice.gender)}${voice.language ? ` · ${voice.language}` : ''}`;
      select.append(option);
    }
    const selected = draft.get(speaker.speakerId) ??
      (['male', 'female'].includes(speaker.gender) ? previous[speaker.speakerId] : '') ?? '';
    if (selected && !state.voiceCatalog.some(voice => voice.voiceId === selected)) {
      const unavailable = document.createElement('option');
      unavailable.value = selected; unavailable.disabled = true;
      unavailable.textContent = 'Önceki ses · şu an erişilemiyor'; select.append(unavailable);
    }
    select.value = selected;
    select.disabled = state.analysisInProgress || state.savedGameBusy;
    label.append(title, select); return label;
  });
  els.voiceMappingRows.replaceChildren(...rows);
  els.voiceMappingApplyBtn.disabled = state.analysisInProgress || state.savedGameBusy || !els.dubMode.checked;
}

async function loadVoiceCatalog() {
  if (state.voiceCatalog) return state.voiceCatalog;
  if (!state.voiceCatalogPromise) {
    const generation = state.voiceMappingGeneration;
    const pending = mediaClient.getVoices().then(voices => {
      if (generation !== state.voiceMappingGeneration) throw new DOMException('Ses listesi iptal edildi.', 'AbortError');
      state.voiceCatalog = voices; return voices;
    }).finally(() => { if (state.voiceCatalogPromise === pending) state.voiceCatalogPromise = null; });
    state.voiceCatalogPromise = pending;
  }
  return state.voiceCatalogPromise;
}

function verifiedMediaSceneContext() {
  return (state.analysis?.actions || []).filter(action => action.sourceVerified === true &&
    Number.isFinite(action.startTime) && action.startTime >= 0 &&
    Number.isFinite(action.endTime) && action.endTime > action.startTime)
    .slice(0, 64).map(action => ({ startTime: action.startTime, endTime: action.endTime,
      description: String(typeof action.sourceEvidence === 'string' ? action.sourceEvidence : action.label || '').slice(0, 400) }));
}

function verifiedSpeakerVoiceHints(analysis = state.analysis) {
  const story = analysis?.storyContext || {};
  const characters = Array.isArray(story.characters) ? story.characters : [];
  const proposals = new Map();
  const genderFrom = character => {
    if (['male', 'female'].includes(character?.gender)) return character.gender;
    const role = String(character?.sourceRole || character?.role || '').toLocaleLowerCase('tr-TR');
    const male = /(?:^|\s)(?:erkek|adam|male|man)(?:\s|$)/iu.test(role);
    const female = /(?:^|\s)(?:kadın|kadin|female|woman)(?:\s|$)/iu.test(role);
    return male && !female ? 'male' : female && !male ? 'female' : undefined;
  };
  for (const character of characters) {
    const speakerIds = Array.isArray(character?.speakerIds)
      ? character.speakerIds.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    if (!speakerIds.length || character?.evidenceLevel !== 'fact') continue;
    const characterId = String(character.id || character.participantTrackId || '').trim();
    if (!characterId) continue;
    const gender = genderFrom(character);
    const emotion = String(character.voiceEmotion || character.emotion || character.emotionalTone || '').trim();
    const tone = String(character.voiceTone || character.tone || story.emotionalTone || '').trim();
    for (const speakerId of speakerIds) {
      if (!proposals.has(speakerId)) proposals.set(speakerId, []);
      proposals.get(speakerId).push({
        characterId,
        ...(gender ? { gender } : {}),
        ...(emotion ? { emotion: emotion.slice(0, 80) } : {}),
        ...(tone ? { tone: tone.slice(0, 80) } : {}),
      });
    }
  }

  const hints = {};
  for (const [speakerId, rows] of proposals) {
    const characterIds = [...new Set(rows.map(row => row.characterId))];
    // One Scribe ID matched to two visible people is ambiguous evidence. Do not
    // force a voice identity from it; keep the raw speaker separate.
    if (characterIds.length !== 1) continue;
    const genders = [...new Set(rows.map(row => row.gender).filter(Boolean))];
    const emotions = [...new Set(rows.map(row => row.emotion).filter(Boolean))];
    const tones = [...new Set(rows.map(row => row.tone).filter(Boolean))];
    hints[speakerId] = {
      characterId: characterIds[0],
      ...(genders.length === 1 ? { gender: genders[0] } : {}),
      ...(emotions.length ? { emotion: emotions[0] } : {}),
      ...(tones.length ? { tone: tones[0] } : {}),
    };
  }
  return hints;
}

function restorePreviousVoices(plan, preserveJob = false) {
  if (!plan.previous) return;
  mediaClient.loadResult(plan.previous.manifest, { ...plan.previous, audioBlob: plan.audioBlob, preserveJob });
  updateSourceTranscript(plan.previous.manifest.sourceTranscript);
  renderMediaControls();
}

async function regenerateTurkishVoices(plan, retry = false) {
  if (state.analysisInProgress || state.savedGameBusy) return;
  const generation = state.voiceMappingGeneration;
  state.mediaRevoice = plan;
  state.analysisInProgress = true;
  updateAnalyzeAvailability();
  // Pause the existing source range while its soundtrack is replaced. Its
  // current time, selected occurrence, choices and progress remain untouched.
  els.video.pause();
  let completed = false;
  try {
    if (plan.previous?.manifest.assets?.mix && !plan.audioBlob) {
      onTurkishMediaStatus({ state: 'UPLOADING', message: 'Önceki Türkçe ses korunuyor.' });
      plan.audioBlob = await mediaClient.materializeAudio();
    }
    if (plan.cancelled || state.mediaRevoice !== plan) throw new DOMException('Ses değişimi iptal edildi.', 'AbortError');
    const resume = retry && plan.started;
    plan.started = true;
    const result = resume ? await mediaClient.retry() : await mediaClient.start(plan.source, plan.options);
    if (plan.cancelled || state.mediaRevoice !== plan) return;
    if (plan.previous) {
      mediaClient.setDubEnabled(plan.previous.dubEnabled);
      mediaClient.setSubtitleTrack(plan.previous.subtitleTrack);
      mediaClient.setSyncOffset(plan.previous.syncOffset);
    }
    updateSourceTranscript(result.sourceTranscript);
    if (plan.session && state.analysisSession === plan.session) {
      plan.session.mediaManifest = result;
      plan.session.mediaModeKey = JSON.stringify({ dub: plan.options.outputs.dub,
        subtitles: plan.options.outputs.subtitles, quality: plan.options.qualityMode });
    }
    state.mediaRevoice = null;
    els.voiceMappingRows.replaceChildren();
    renderMediaControls();
    els.voiceMappingMessage.textContent = 'Konuşmacı sesleri hazır. Video seçili kaynak konumunda bekliyor.';
    completed = true;
    if (state.savedGameReady) await savedGames?.saveCurrent(true);
  } catch (error) {
    if (state.mediaRevoice !== plan) return;
    const cancelled = error.name === 'AbortError';
    restorePreviousVoices(plan, !cancelled && plan.started);
    if (cancelled) state.mediaRevoice = null;
    onTurkishMediaStatus({ state: cancelled ? 'CANCELLED' : 'FAILED', message: error.message });
    els.voiceMappingMessage.textContent = `${error.message}${plan.previous ? ' Önceki Türkçe ses korundu.' : ''}`;
  } finally {
    if (generation === state.voiceMappingGeneration && (!state.mediaRevoice || state.mediaRevoice === plan)) {
      state.analysisInProgress = false;
      updateAnalyzeAvailability();
    }
  }
  // A manual assignment can recover an initial unknown-speaker failure. The
  // existing prepared frames and this new result continue that same analysis.
  if (completed && generation === state.voiceMappingGeneration && !state.savedGameReady) els.analyzeBtn.click();
}

els.voiceMappingPanel?.addEventListener('toggle', async () => {
  if (!els.voiceMappingPanel.open) return;
  const generation = state.voiceMappingGeneration;
  els.voiceMappingMessage.textContent = 'Kullanılabilir konuşmacı sesleri yükleniyor.';
  try {
    const voices = await loadVoiceCatalog();
    if (generation !== state.voiceMappingGeneration || !els.voiceMappingPanel.open) return;
    els.voiceMappingMessage.textContent = voices.length
      ? `${state.turkishMediaStatus?.error?.code === 'VOICE_PROFILE_UNVERIFIED'
        ? 'Kaynak seslerin uygun Türkçe seslerini seç; yanlış cinsiyette varsayılan ses üretilmedi.'
        : 'Dublaj hazır. Kaynak ses grupları farklı kişiler anlamına gelmeyebilir. İstersen sesleri değiştirebilirsin.'}${els.dubMode.checked ? '' : ' Sesleri uygulamak için Türkçe dublaj modunu seç.'}`
      : 'Bu hesapta kullanılabilir ses bulunamadı.';
    renderVoiceMappingPanel();
  } catch (error) {
    if (generation === state.voiceMappingGeneration) {
      els.voiceMappingApplyBtn.disabled = true;
      els.voiceMappingMessage.textContent = 'Sesleri değiştirmek için API ayarlarına ElevenLabs anahtarını gir. Hazır dublaj kullanılabilir.';
    }
  }
});
els.voiceMappingApplyBtn?.addEventListener('click', async () => {
  if (state.analysisInProgress || state.savedGameBusy || !els.dubMode.checked) return;
  const source = state.selectedFile || state.analysisSession?.file;
  if (!(source instanceof Blob) || !source.size) return;
  const values = [...els.voiceMappingRows.querySelectorAll('select')].filter(select => select.value);
  if (new Set(values.map(select => select.value)).size !== values.length) {
    els.voiceMappingMessage.textContent = 'Her konuşmacı için ayrı bir ses seç.'; return;
  }
  const modes = selectedAnalysisModes(), previous = mediaClient.capture();
  const options = { outputs: { dub: modes.dubbing, subtitles: modes.subtitles, ...(modes.dubbingProvider === 'elevenlabs_v1' ? { dubbingProvider: 'elevenlabs_v1' } : {}) }, qualityMode: modes.dubQuality,
    voiceMapping: Object.fromEntries(values.map(select => [select.dataset.speakerId, select.value])),
    previousVoiceMapping: previous?.manifest.voiceMapping || {}, sceneContext: verifiedMediaSceneContext() };
  await regenerateTurkishVoices({ source, options, previous, session: state.analysisSession, started: false });
});

function analysisSourceKey(file, remote) {
  if (state.urlCacheKey) return `url:${state.urlCacheKey}`;
  return remote
    ? `remote:${remote.sourceUrl || remote.proxyUrl || ''}`
    : `file:${file?.name}:${file?.size}:${file?.lastModified}`;
}

async function prepareStoryboardSource(session, file) {
  const remote = state.selectedRemoteVideo;
  let localFile = file || state.selectedFile || session.file;
  // Loading the local object URL resets video.duration until metadata arrives.
  session.sourceDuration = Number(els.video.duration) || Number(session.sourceDuration) || 0;
  if (!localFile && remote) {
    els.analysisState.textContent = 'DOWNLOADING_VIDEO';
    els.analysisTitle.textContent = 'Ses ve kare analizi için video telefona alınıyor';
    els.analysisOutput.textContent = 'Video bir kez indirilecek; ses, kareler ve oynatma aynı cihaz dosyasını kullanacak.';
    // Release the preview connection while the complete source is downloaded.
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
    const startedAt = performance.now();
    try {
      localFile = await ensureSelectedRemoteFile({ onProgress: ({ loaded, total, transport, connections }) => {
        const knownTotal = total || remote.size || 0;
        analysisProgress.update('source', { loaded, total: knownTotal, unit: 'bytes', detail: 'Video telefona indiriliyor.' });
        const elapsed = Math.max(0.1, (performance.now() - startedAt) / 1000);
        const percent = knownTotal ? ` · %${Math.min(100, Math.round(loaded / knownTotal * 100))}` : '';
        els.analysisTitle.textContent = `Video telefona alınıyor${percent}`;
        els.analysisOutput.textContent = [
          `${(loaded / 1024 / 1024).toFixed(1)}${knownTotal ? ` / ${(knownTotal / 1024 / 1024).toFixed(1)}` : ''} MB`,
          `${(loaded / 1024 / 1024 / elapsed).toFixed(2)} MB/sn · ${Math.round(elapsed)} sn geçti`,
          `${transport === 'direct' ? 'Doğrudan kaynaktan' : 'Sunucu üzerinden'} indiriliyor${connections > 1 ? ` · ${connections} paralel bağlantı` : ''}.`,
          'İndirme bitince ses ve kareler aynı dosyadan hazırlanacak.'
        ].join('\n');
      } });
      session.sourceDownloadMs = Math.round(performance.now() - startedAt);
    } catch (error) {
      if (state.selectedRemoteVideo === remote) {
        els.video.removeAttribute('src');
        els.video.load();
        if (error.code === 'DIRECT_VIDEO_BLOCKED') showBrowserDownloadHelp(remote.sourceUrl, remote.pageUrl);
      }
      throw error;
    }
  }
  if (!(localFile instanceof Blob) || !localFile.size) throw new Error('Analiz için video dosyası hazırlanamadı.');
  session.file = localFile;
  analysisProgress.done('source', 'Video dosyası cihazda hazır.');
  // Playback uses the same bytes too; later seeks need no remote range requests.
  if (remote && !state.videoObjectUrl) {
    state.videoObjectUrl = URL.createObjectURL(localFile);
    els.video.src = state.videoObjectUrl;
    els.video.load();
  }
  return localFile;
}

// A source-only or subtitle-only job never provides a dubbed soundtrack.
// Match the exact completed mode and real audio assets before replaying cache.
function canReuseTurkishMedia(session, modeKey, modes) {
  const manifest = session?.mediaManifest;
  if (!manifest || manifest.version !== 1 || session.mediaModeKey !== modeKey) return false;
  if (modes.dubbing && (!manifest.assets?.mix?.url || manifest.outputs?.dub === false)) return false;
  if (modes.subtitles && manifest.outputs?.subtitles === false) return false;
  return true;
}

// The media identity is separate from the scene-analysis identity. Changing
// an API key must never invalidate already reviewed video chapters.
function requestedTurkishMediaModeKey(modes) {
  return JSON.stringify({ dub: modes.dubbing, subtitles: modes.subtitles, quality: modes.dubQuality,
    ...(modes.dubbingProvider === 'elevenlabs_v1' ? { provider: 'elevenlabs_v1' } : {}) });
}

function hasPendingTurkishMediaRecovery() {
  const modes = selectedAnalysisModes();
  return canResumePreparedTurkishMedia({
    session: state.analysisSession, analysis: state.analysis,
    sourceKey: analysisSourceKey(state.selectedFile, state.selectedRemoteVideo),
    mediaModeKey: requestedTurkishMediaModeKey(modes)
  });
}

// A paid Gemini translation/voice failure is not a failure of the reviewed
// game. Restart ONLY the incomplete Turkish-media job with the current key;
// never invoke the storyboard extractor or any visual Gemini request here.
async function resumePreparedTurkishMedia() {
  if (state.analysisInProgress || state.savedGameBusy || !hasPendingTurkishMediaRecovery()) return false;
  const session = state.analysisSession;
  const modes = selectedAnalysisModes();
  const source = state.selectedFile || session.file;
  if (!(source instanceof Blob) || !source.size) {
    els.mediaJobMessage.textContent = 'Kaynak video cihazda bulunamadı. Kaydı tekrar aç veya aynı videoyu seç.';
    return false;
  }
  state.analysisInProgress = true;
  updateAnalyzeAvailability();
  analysisProgress.begin({ motion: false, dubbing: modes.dubbing, subtitles: modes.subtitles });
  analysisProgress.update('analysis', { status: 'reused',
    detail: 'Doğrulanmış video analizi korundu; yeniden Gemini görsel analizi yapılmıyor.' });
  els.analysisCard.classList.remove('hidden');
  els.analysisState.textContent = 'RESUMING_TURKISH_MEDIA';
  els.analysisTitle.textContent = 'Yalnız eksik Türkçe medya tamamlanıyor';
  els.analysisOutput.textContent = 'Sahne analizi, oyun seçenekleri ve kayıtlar korunuyor. Yeni API anahtarıyla yalnız Türkçe çeviri/dublaj hazırlanıyor.';
  let completed = false;
  try {
    const finalMedia = await mediaClient.start(source, {
      outputs: { dub: modes.dubbing, subtitles: modes.subtitles,
        ...(modes.dubbingProvider === 'elevenlabs_v1' ? { dubbingProvider: 'elevenlabs_v1' } : {}) },
      qualityMode: modes.dubQuality,
      sceneContext: verifiedMediaSceneContext(),
      speakerHints: verifiedSpeakerVoiceHints(state.analysis)
    });
    if (state.analysisSession !== session) return false;
    session.mediaManifest = finalMedia;
    session.mediaModeKey = requestedTurkishMediaModeKey(modes);
    session.pendingTurkishMedia = null;
    recordAiUsage(finalMedia?.qualityReport?.geminiUsage);
    updateSourceTranscript(finalMedia.sourceTranscript);
    renderMediaControls();
    state.savedGameReady = true;
    const saved = await savedGames?.saveCurrent(true);
    analysisProgress.done('save', saved ? 'Hazır Türkçe medya kaydedildi.' : 'Türkçe medya hazır; kayıt yeniden denenebilir.');
    els.analysisState.textContent = 'TIMELINE_READY';
    els.analysisTitle.textContent = 'Türkçe dublaj ve mevcut oyun hazır';
    els.analysisOutput.textContent = 'Önceden tamamlanan video analizi yeniden çalıştırılmadı. Türkçe medya hazır.';
    analysisProgress.finish();
    completed = true;
  } catch (error) {
    if (state.analysisSession === session) {
      // Keep the complete visual game playable even if another media retry fails.
      session.pendingTurkishMedia = { modeKey: requestedTurkishMediaModeKey(modes) };
      els.analysisState.textContent = isGeminiTranslationQuota(error)
        ? 'TURKISH_TRANSLATION_QUOTA' : 'TURKISH_MEDIA_RETRY_FAILED';
      els.analysisTitle.textContent = isGeminiTranslationQuota(error)
        ? 'Türkçe çeviri kotası dolu; video analizi hazır'
        : 'Türkçe medya tamamlanamadı; video analizi hazır';
      els.analysisOutput.textContent = String(error?.message || error) +
        '\nVideo analizi tekrar yapılmayacak. Türkçe medya için Yeniden dene kullanılabilir.';
    }
    analysisProgress.finish('failed', els.analysisOutput.textContent);
  } finally {
    state.analysisInProgress = false;
    els.mediaJobRetryBtn?.classList.toggle('hidden', !session.pendingTurkishMedia);
    updateAnalyzeAvailability();
  }
  return completed;
}

els.analyzeBtn.addEventListener('click', async () => {
  if (state.analysisInProgress || state.urlResolutionInProgress || state.savedGameBusy) return;
  if (!state.selectedFile && !state.selectedRemoteVideo) return;
  // Most starts have no media retry. Guard the recovery lookup so the
  // ordinary entry path remains independently testable and never evaluates
  // media-only state on a fresh analysis.
  if (state.analysisSession?.pendingTurkishMedia && hasPendingTurkishMediaRecovery()) {
    await resumePreparedTurkishMedia();
    return;
  }
  state.analysisInProgress = true;
  state.aiUsage = { requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, cacheHits: 0 };
  state.savedGameReady = false;
  state.savedPlaybackOnly = false;
  analysisAbortController = new AbortController();
  const analysisOwner = analysisAbortController;
  let analysisSucceeded = false;
  const framesProgress = (progress, detail) => {
    if (analysisOwner.signal.aborted || analysisAbortController !== analysisOwner) return;
    storyboardProgress(progress, detail);
  };
  try {
  updateAnalyzeAvailability();
  els.analyzeBtn.disabled = true;
  els.videoInput.disabled = true;
  els.video.pause();
  if (videoUrlInput) videoUrlInput.disabled = true;
  if (resolveUrlBtn) resolveUrlBtn.disabled = true;
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Kaynak video konuşma ve görüntü analizi için hazırlanıyor…';
  setGameState('ANALYZING');

  let file = state.selectedFile;
  const modes = selectedAnalysisModes();
  analysisProgress.begin({ motion: modes.motion, dubbing: modes.dubbing, subtitles: modes.subtitles,
    remote: Boolean(state.selectedRemoteVideo && !file) });
  els.analysisCard.dataset.processing = 'true';
  delete els.analysisCard.dataset.compactError;
  els.mediaJobCancelBtn?.classList.remove('hidden');
  els.mediaJobRetryBtn?.classList.add('hidden');
  const sourceKey = analysisSourceKey(file, state.selectedRemoteVideo);
  const requestedProtagonist = String(els.protagonistInput?.value || '').trim();
  let analysisModeKey = '';
  const reusableSession = state.analysisSession?.sourceKey === sourceKey;
  const session = reusableSession ? state.analysisSession : {
    sourceKey, file: file || null, sourceTranscript: null, mediaManifest: null, storyboard: null,
    analysisModeKey: '', chunkResults: [], protagonistProfile: '', storyContextMemory: null
  };
  state.analysisSession = session;

  mediaClient.reset();
  updateSourceTranscript(session.sourceTranscript);
  removeStoredValue('localStorage', RUNTIME_SAVE_KEY);
  state.analysisFingerprint = '';
  state.engineEvents = [];
  state.integrityReport = null;
  state.adultAnalysisTrace = null;
  if (els.adultTraceOutput) {
    els.adultTraceOutput.classList.add('hidden');
    els.adultTraceOutput.textContent = '';
  }
  renderAdultAnalysisTrace();
  renderMediaControls();
  els.dubBufferStatus.classList.add('hidden');

  // The URL cache supplies one complete local source to both independent
  // pipelines. Frame preparation runs while the server processes source audio.
  file = await prepareStoryboardSource(session, file);
  const fastStoryboardPreparation = modes.motion && !session.storyboard
    ? extractStoryboard(file, framesProgress, analysisOwner.signal, { remoteSampling: Boolean(state.selectedRemoteVideo) })
      .then(value => {
        if (!analysisOwner.signal.aborted && analysisAbortController === analysisOwner)
          analysisProgress.done('frames', value.timestamps.length + ' kare hazır.');
        return value;
      })
    : null;
  // Attach a handler immediately; await below still surfaces the frame error.
  fastStoryboardPreparation?.catch(() => {});
  session.audioContextStatus = 'pending';
  const mediaModeKey = requestedTurkishMediaModeKey(modes);
  const contextualMedia = modes.motion && (modes.dubbing || modes.subtitles);
  const reusableMedia = !contextualMedia && canReuseTurkishMedia(session, mediaModeKey, modes);
  // Do not stamp a previous media manifest with the newly requested mode.
  // Contextual dubbing only becomes reusable after the finished mix exists.
  let result;
  try {
    if (contextualMedia) {
      if (session.sourceTranscript) {
        for (const id of ['extract', 'encode', 'hash', 'upload', 'serverAudio', 'transcript', 'speakers'])
          analysisProgress.update(id, { status: 'reused', detail: 'Önceki konuşma çözümlemesi kullanılıyor.' });
      }
      // First pass is source-only: Scribe establishes real words/timestamps.
      // Final translation/voice selection waits for the visual analysis so
      // verified speaker↔character matches can collapse diarization fragments
      // and choose the correct stable voice automatically.
      result = session.sourceTranscript
        ? { sourceTranscript: session.sourceTranscript }
        : await mediaClient.start(file, { outputs: { dub: false, subtitles: false, transcriptOnly: true },
          qualityMode: modes.dubQuality, sceneContext: [] });
      session.transcriptManifest = result;
    } else {
      result = reusableMedia
        ? mediaClient.loadResult(session.mediaManifest, { dubEnabled: modes.dubbing,
          subtitleTrack: modes.subtitles ? (modes.dubbing ? 'dub_tr' : 'source_tr') : 'off' })
        : await mediaClient.start(file, { outputs: { dub: modes.dubbing, subtitles: modes.subtitles,
          transcriptOnly: !modes.dubbing && !modes.subtitles, ...(modes.dubbingProvider === 'elevenlabs_v1' ? { dubbingProvider: 'elevenlabs_v1' } : {}) }, qualityMode: modes.dubQuality, sceneContext: [] });
      session.mediaManifest = result;
      session.mediaModeKey = mediaModeKey;
    }
    updateSourceTranscript(result.sourceTranscript);
    if (reusableMedia) onTurkishMediaStatus({ state: 'READY', sourceTranscript: result.sourceTranscript });
    renderMediaControls();
  } catch (error) {
    if (!contextualMedia) session.mediaManifest = null;
    session.audioContextStatus = 'unavailable';
    logEngineEvent('SOURCE_TRANSCRIPT_UNAVAILABLE', { message: String(error.message || error).slice(0, 300) });
    if (fastStoryboardPreparation) {
      session.storyboard = await fastStoryboardPreparation.catch(() => null);
    }
    if (error?.name === 'AbortError' || !modes.motion || modes.dubbing || modes.subtitles) throw error;
    // Visual-only analysis may continue without speech evidence, including a
    // genuinely silent source or an unavailable ASR service. Requested Turkish
    // media still fails explicitly above; no alternate speech model is used.
    updateSourceTranscript(null);
    els.analysisOutput.textContent = 'Kaynak konuşma verisi kullanılamıyor. Görsel analiz yalnız kaynak video kareleriyle devam ediyor.';
  }
  if (!modes.motion) {
    state.analysis = null;
    els.playerSection.classList.remove('hidden');
    els.analysisState.textContent = 'DIALOGUE_READY';
    els.analysisTitle.textContent = 'Türkçe medya hazır';
    els.analysisOutput.textContent = [
      `${state.sourceContext?.segments.length || 0} kaynak konuşma bölümü ve ${state.sourceContext?.speakers.length || 0} konuşmacı algılandı.`,
      modes.dubbing ? 'Türkçe ses ve kaynak arka planı tek ses dosyasında hazır.' : 'Türkçe altyazılar kaynak zamanlarına bağlı.',
      'Altyazı menüsünden kaynak konuşma veya dublaj zamanlarını seçebilirsin.'
    ].join('\n');
    setGameState('DIALOGUE_READY');
    state.savedGameReady = true;
    analysisProgress.update('save', { detail: 'Hazır medya kaydediliyor.' });
    await savedGames?.saveCurrent(true);
    analysisProgress.done('save', 'Hazır medya kaydedildi.'); analysisSucceeded = true;
    analysisProgress.finish();
    return;
  }
  const remoteStoryboardSource = state.selectedRemoteVideo;
  const storyboardSource = session.storyboard ? null : await prepareStoryboardSource(session, file);
  els.analysisTitle.textContent = 'Video cihazdan işleniyor';
  els.analysisState.textContent = 'LOCAL_PROCESSING';
  const storyboard = session.storyboard || await (fastStoryboardPreparation || extractStoryboard(storyboardSource, (progress, detail) => {
    framesProgress(progress, detail);
    const count = detail ? `${detail.captured}/${detail.total} kare · ` : '';
    els.analysisTitle.textContent = `Cihazdan kareler hazırlanıyor: ${count}%${Math.round(progress)}`;
    if (!detail) return;
    els.analysisOutput.textContent = [
      Number.isFinite(detail.time) ? `Videodaki konum: ${detail.time.toFixed(1)} sn${detail.retrying ? ' · yeniden deneniyor' : ''}` : 'Kareler analiz için birleştiriliyor…',
      `${Math.round(detail.elapsedSeconds)} sn geçti`
    ].join('\n');
  }, analysisOwner.signal, {
    // Preserve every original sample, including focused motion probes, even
    // though the URL video's bytes are now local.
    remoteSampling: Boolean(remoteStoryboardSource)
  }));
  session.storyboard = storyboard;
  analysisProgress.done('frames', storyboard.timestamps.length + ' kare hazır.');
  if (storyboard.performance) logEngineEvent('STORYBOARD_PREPARED', {
    ...storyboard.performance, downloadMs: session.sourceDownloadMs || 0
  });

  const skippedFrameCount = Array.isArray(storyboard.skippedTimestamps)
    ? storyboard.skippedTimestamps.length
    : 0;

  const storyboardMB = (storyboard.totalBytes / 1024 / 1024).toFixed(1);
  const sourceSize = file?.size || state.selectedRemoteVideo?.size || 0;
  const sourceSizeText = sourceSize
    ? `${(sourceSize / 1024 / 1024).toFixed(1)} MB yerine `
    : '';
  els.analysisTitle.textContent =
    `${storyboard.timestamps.length} kare hazır • ${sourceSizeText}${storyboardMB} MB gönderiliyor`;
  els.analysisState.textContent = 'UPLOADING_STORYBOARD';

    const analysisPlan = adaptiveAnalysisChunkPlan(storyboard.sheets.length, storyboard.duration, modes.quality);
    const framesPerSheet = 12;
    const chunkCount = analysisPlan.chunkCount;

    const dialogueRows = state.sourceContext?.segments || [];
    const dialogueSample = [
      dialogueRows.length,
      ...dialogueRows.slice(0, 4).map(row => `${row.segmentId}:${row.startTime}:${row.gender}`),
      ...dialogueRows.slice(-4).map(row => `${row.segmentId}:${row.startTime}:${row.gender}`)
    ].join('|');
    analysisModeKey = JSON.stringify({
      pipelineVersion: 'canonical-source-context-4',
      analysisTier: modes.analysisTier,
      chunks: analysisPlan.chunks,
      motion: modes.motion,
      quality: modes.quality,
      subtitles: modes.subtitles,
      dubbing: modes.dubbing,
      protagonist: requestedProtagonist,
      dialogue: dialogueSample
    });

    if (session.analysisModeKey !== analysisModeKey || session.chunkCount !== chunkCount) {
      session.analysisModeKey = analysisModeKey;
      session.chunkCount = chunkCount;
      session.chunkResults = [];
      session.firstPassResults = {};
      session.protagonistProfile = '';
      session.storyContextMemory = null;
    }
    // A key rotation (or reopening the same video after a browser refresh)
    // must not re-bill the 15 already verified scene chapters. The persistent
    // identity includes every actual storyboard image, its timing, and the
    // source-context analysis settings; it never includes an API credential.
    const checkpointOptions = {
      sheets: storyboard.sheets, timestamps: storyboard.timestamps,
      duration: storyboard.duration, mode: analysisModeKey
    };
    // Key verified chapters by the original video's actual bytes, not by
    // JPEG output that changes with mobile decoder/encoder initialization.
    // The old JPEG checkpoint is also read once to recover pre-upgrade jobs.
    const checkpointPrefix = await analysisCheckpointKey({ ...checkpointOptions, source: file });
    const legacyCheckpointPrefix = await analysisCheckpointKey(checkpointOptions);
    let restoredChapters = 0;
    for (let index = 0; index < chunkCount; index++) {
      if (session.chunkResults[index]?.available === true) continue;
      const previous = await analysisResponseCache.readCheckpoint(checkpointPrefix, index) ||
        (legacyCheckpointPrefix !== checkpointPrefix
          ? await analysisResponseCache.readCheckpoint(legacyCheckpointPrefix, index) : null);
      if (previous?.available === true) {
        session.chunkResults[index] = previous;
        restoredChapters++;
        // Promote legacy checkpoints so subsequent retries do not need the
        // old rendered JPEGs or another Gemini request.
        await analysisResponseCache.saveCheckpoint(checkpointPrefix, index, previous);
      }
    }
    if (restoredChapters) analysisProgress.update('analysis', {
      loaded: session.chunkResults.filter(result => result?.available).length,
      total: chunkCount, unit: 'bölüm',
      detail: `${restoredChapters} doğrulanmış bölüm cihazdan geri alındı; tekrar Gemini'ye gönderilmeyecek.`
    });
    const chunkResults = session.chunkResults;
    session.firstPassResults ||= {};
    let failureBody = null;
    let failedChunk = null;
    let body = null;

    let protagonistProfile = session.protagonistProfile || requestedProtagonist;
    let storyContextMemory = session.storyContextMemory || normalizeStoryContext({});

  const analyzeChunk = async (chunkIndex, contextSnapshot) => {
      let response = null;
      let chunkBody = null;
      let chunkFailure = null;
      analysisOwner.signal.throwIfAborted();
      // A restored verified chapter requires NO uploads, Gemini calls or
      // second-pass reviews. Do not misleadingly show 1/15 as a fresh run.
      if (chunkResults[chunkIndex]?.available === true) {
        analysisProgress.update('analysis', { status: 'reused',
          loaded: chunkResults.filter(result => result?.available).length,
          total: chunkCount, unit: 'bölüm',
          detail: 'Bölüm ' + (chunkIndex + 1) + '/' + chunkCount + ' önceden doğrulandı; Gemini çağrılmadı.' });
        return { chunkIndex, result: chunkResults[chunkIndex] };
      }
      analysisProgress.update('analysis', { loaded: chunkResults.filter(result => result?.available).length,
        total: chunkCount, unit: 'bölüm', detail: 'Eksik bölüm ' + (chunkIndex + 1) + '/' + chunkCount + ' hazırlanıyor.' });
      if (chunkResults[chunkIndex]?.retryable === false)
        return { chunkIndex, result: chunkResults[chunkIndex] };
      const { firstSheet, sheetCount } = analysisPlan.chunks[chunkIndex];
      const chunkSheets = storyboard.sheets.slice(
        firstSheet,
        firstSheet + sheetCount
      );

      const firstFrame = firstSheet * framesPerSheet;
      const chunkTimestamps = storyboard.timestamps.slice(
        firstFrame,
        firstFrame + chunkSheets.length * framesPerSheet
      );

      const chunkStart = chunkIndex === 0 ? 0 : Number(chunkTimestamps[0] ?? 0);
      // Adjacent chapters share a boundary even when focused samples are
      // unevenly spaced; an average frame interval left gaps or overlaps.
      const nextFrame = (firstSheet + sheetCount) * framesPerSheet;
      const chunkEnd = Number(storyboard.timestamps[nextFrame] ?? storyboard.duration);

      const chunkMotionProfile = (
        storyboard.motionProfile || []
      ).filter(entry =>
        Number(entry.time) >= chunkStart &&
        Number(entry.time) <= chunkEnd
      );
      const chunkSceneBoundaries = (
        storyboard.sceneBoundaries || []
      ).filter(entry =>
        Number(entry.time) >= chunkStart &&
        Number(entry.time) <= chunkEnd
      );

      const form = new FormData();

      chunkSheets.forEach((blob, index) => {
        form.append(
          'storyboards',
          blob,
          `chunk-${String(chunkIndex + 1).padStart(2, '0')}-sheet-${String(index + 1).padStart(2, '0')}.jpg`
        );
      });

      form.append('duration', String(storyboard.duration));
      form.append('timestamps', JSON.stringify(chunkTimestamps));
      form.append('motionProfile', JSON.stringify(chunkMotionProfile));
      form.append('sceneBoundaries', JSON.stringify(chunkSceneBoundaries));
      form.append('chunkStart', String(chunkStart));
      form.append('chunkEnd', String(chunkEnd));
      form.append('chunkIndex', String(chunkIndex));
      form.append('chunkCount', String(chunkCount));

    const chunkDialogue = (state.sourceContext?.segments || []).filter(segment =>
      Number(segment.endTime) >= chunkStart &&
      Number(segment.startTime) <= chunkEnd
    );

    form.append('dialogueContext', JSON.stringify(chunkDialogue));
    form.append('dialogueSpeakerContext', JSON.stringify((state.sourceContext?.speakers || []).map(speaker => ({
      speakerId: speaker.speakerId, speakerName: speaker.speakerName,
      gender: speaker.gender, emotion: speaker.emotion
    }))));
    const chunkSensoryAudio = (state.sourceContext?.nonSpeechEvents || []).filter(event =>
      Number(event.endTime) >= chunkStart && Number(event.startTime) <= chunkEnd
    );
    form.append('sensoryAudioContext', JSON.stringify(chunkSensoryAudio));
    form.append('qualityMode', 'ultra');
    form.append('analysisTier', modes.analysisTier);
      form.append('protagonistProfile', contextSnapshot.protagonistProfile);
      form.append('storyContextMemory', JSON.stringify(contextSnapshot.storyContextMemory));

      const freshChunkForm = () => {
        const next = new FormData();
        form.forEach((value, key) => {
          if (typeof value === 'string') next.append(key, value);
          else next.append(key, value, value.name || 'storyboard.jpg');
        });
        return next;
      };

      els.analysisTitle.textContent =
        `Ayrıntılı sahne analizi: bölüm ${chunkIndex + 1}/${chunkCount}`;

      els.analysisState.textContent = 'DETAILED_CHUNK_ANALYSIS';

      els.analysisOutput.textContent =
        `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...`;

      let chunkSucceeded = false;
      let firstPassBody = session.firstPassResults[chunkIndex] || null;
      chunkFailure = null;

      // The server already retries a transient Gemini response twice. Bound
      // client retries so one bad chapter cannot consume the entire session.
      const maxChunkAttempts = 2;
      for (let attempt = 1; attempt <= maxChunkAttempts && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\n` +
          `Deneme ${attempt}/${maxChunkAttempts} · tamamlanan ${chunkResults.filter(result => result?.available).length}/${chunkCount}`;

        // Keep a completed first pass when only its review needs retrying.
        form.delete('reviewMode');
        form.delete('reviewCandidates');

        try {
          if (firstPassBody) {
            chunkBody = firstPassBody;
            response = { ok: true };
          } else {
            response = await postAnalysisForm('/api/gemini-storyboard-analyze', freshChunkForm(), {
              headers: geminiRequestHeaders(),
              stage: 'analysis', label: 'Bölüm ' + (chunkIndex + 1) + '/' + chunkCount
            });

            chunkBody = await response.json();
            recordAiUsage(chunkBody?.aiUsage);

            if (response.ok && chunkBody?.available) {
              const normalizedChunk = normalizeChunkActionTimes(
                chunkBody.actions,
                chunkStart,
                chunkEnd
              );
              chunkBody = {
                ...chunkBody,
                actions: normalizedChunk.actions,
                chunkStart,
                chunkEnd,
                chunkTimeRebased: normalizedChunk.rebased
              };
              firstPassBody = chunkBody;
              session.firstPassResults[chunkIndex] = chunkBody;
            }
          }

          if (!response.ok || !chunkBody?.available) {
            chunkFailure = chunkBody || {
              available: false,
              reason: 'CHUNK_ANALYSIS_FAILED',
              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
            };
            if (chunkFailure?.retryable === false || chunkFailure?.reason === 'GEMINI_CREDITS_DEPLETED') {
              break;
            }
          } else {
            const criticalReviewCandidates = secondPassReviewCandidates(chunkBody);
            if (criticalReviewCandidates.length) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(criticalReviewCandidates));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye · ${criticalReviewCandidates.length} bulgu ikinci kez doğrulanıyor...\nHazır kareler yeniden kullanılıyor; videodan tekrar kare çıkarılmıyor.`;
              const reviewResponse = await postAnalysisForm('/api/gemini-storyboard-analyze', freshChunkForm(), {
                headers: geminiRequestHeaders(),
                stage: 'review', label: 'Bölüm ' + (chunkIndex + 1) + ' · ' + criticalReviewCandidates.length + ' bulgu'
              });
              let reviewBody = await reviewResponse.json();
              recordAiUsage(reviewBody?.aiUsage);
              if (reviewResponse.ok && reviewBody?.available) {
                const normalizedReview = normalizeChunkActionTimes(
                  reviewBody.actions,
                  chunkStart,
                  chunkEnd
                );
                reviewBody = {
                  ...reviewBody,
                  actions: normalizedReview.actions,
                  chunkStart,
                  chunkEnd,
                  chunkTimeRebased: normalizedReview.rebased
                };
              }
              if (!reviewResponse.ok || !reviewBody?.available) {
                chunkFailure = reviewBody || {
                  available: false,
                  reason: 'SECOND_PASS_REVIEW_FAILED',
                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`
                };
                if (chunkFailure?.retryable === false || chunkFailure?.reason === 'GEMINI_CREDITS_DEPLETED') {
                  break;
                }
                // Apply the same retry delay to failed review requests as to
                // failed initial requests; preserve the provider's reason.
                throw Object.assign(new Error(chunkFailure.message || 'Doğrulama isteği başarısız.'), {
                  analysisFailure: chunkFailure
                });
              }
              chunkBody = mergeSecondPassReview(chunkBody, reviewBody, criticalReviewCandidates);
            }
            chunkResults[chunkIndex] = chunkBody;
            delete session.firstPassResults[chunkIndex];
            session.chunkResults = chunkResults;
            // Each successful chapter has its own atomic local checkpoint.
            // Concurrent chapters cannot overwrite one another's progress.
            await analysisResponseCache.saveCheckpoint(checkpointPrefix, chunkIndex, chunkBody);
            chunkSucceeded = true;
            analysisProgress.update('analysis', { loaded: chunkResults.filter(result => result?.available).length,
              total: chunkCount, unit: 'bölüm', detail: 'Bölüm ' + (chunkIndex + 1) + ' analiz edildi ve doğrulandı.' });
            chunkFailure = null;
            break;
          }
        } catch (error) {
          if (analysisOwner.signal.aborted || error?.name === 'AbortError') throw error;
          chunkFailure = error?.analysisFailure || {
            available: false,
            reason: 'NETWORK_ERROR',
            message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
            error: error?.message || String(error)
          };
        }

        if (chunkFailure?.retryable === false || chunkFailure?.reason === 'GEMINI_CREDITS_DEPLETED') {
          break;
        }

        if (attempt < maxChunkAttempts) {
          analysisProgress.update('analysis', { status: 'retrying', detail: 'Bölüm ' + (chunkIndex + 1) +
            ' geçici hata verdi; tamamlanan bölümler korunarak yeniden denenecek.' });
          const retryDelay = Math.min(12000, 1800 * (2 ** (attempt - 1)));
          els.analysisOutput.textContent =
            `Bölüm ${chunkIndex + 1}/${chunkCount} geçici olarak başarısız oldu.\n` +
            `${Math.ceil(retryDelay / 1000)} saniye sonra yalnız bu bölüm yeniden denenecek...\n` +
            `Tamamlanan bölümler korunuyor: ${chunkResults.filter(result => result?.available).length}/${chunkCount}`;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }

      if (!chunkSucceeded) {
        if (!canContinuePastChunkFailure(chunkFailure)) {
          return { chunkIndex, failureBody: chunkFailure, failedChunk: chunkIndex + 1 };
        }
        chunkResults[chunkIndex] = chunkGapResult(chunkFailure, chunkIndex, chunkStart, chunkEnd);
        session.chunkResults = chunkResults;
        els.analysisState.textContent = 'CONTINUING_WITH_GAP';
        els.analysisOutput.textContent = `Bölüm ${chunkIndex + 1} okunamadı; tamamlanan bölümler korunarak sıradaki bölüme geçiliyor.`;
        chunkFailure = null;
      }
      return { chunkIndex, result: chunkResults[chunkIndex] };
    };

    const stopped = await runContextualAnalysisChunks(chunkCount, {
      concurrency: 2,
      context: start => ({
        protagonistProfile,
        storyContextMemory: mergeStoryContexts(chunkResults.slice(0, start)
          .filter(result => result?.available))
      }),
      analyze: analyzeChunk,
      afterBatch: results => {
        storyContextMemory = mergeStoryContexts(chunkResults.filter(result => result?.available));
        protagonistProfile = [...results].reverse().find(item => item.result?.protagonistProfile)
          ?.result.protagonistProfile || protagonistProfile;
        session.storyContextMemory = storyContextMemory;
        session.protagonistProfile = protagonistProfile;
        session.chunkResults = chunkResults;
      }
    });
    failureBody = stopped?.failureBody || null;
    failedChunk = stopped?.failedChunk || null;

    // A depleted key must never force a completed, independently verified
    // chapter to be thrown away. Convert ONLY the unobserved source windows
    // into declared gaps; never ask Gemini to invent their contents.
    const creditRecovery = failureBody?.reason === 'GEMINI_CREDITS_DEPLETED'
      ? recoverVerifiedChunksOnCreditExhaustion({
          chunkResults, plan: analysisPlan.chunks, timestamps: storyboard.timestamps,
          duration: storyboard.duration, framesPerSheet
        })
      : { recovered: false, completed: 0, gapCount: 0 };
    if (creditRecovery.recovered) {
      session.chunkResults = chunkResults;
      failureBody = null;
      analysisProgress.update('analysis', {
        loaded: creditRecovery.completed, total: chunkCount, unit: 'bölüm',
        detail: `Gemini kredisi tükendi. ${creditRecovery.completed} doğrulanmış bölümle kısmi oyun hazırlanıyor.`
      });
    }

    const completeChunkAnalysis = isCompleteChunkAnalysis({
      completedChunkCount: chunkResults.filter(Boolean).length,
      expectedChunkCount: chunkCount,
      failed: Boolean(failureBody)
    });

    if (!completeChunkAnalysis) {
      if (failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
        body = {
          ...failureBody,
          available: false,
          completedChunkCount: chunkResults.filter(result => result?.available).length,
          expectedChunkCount: chunkCount,
          failedChunk
        };
      } else {
        body = {
          available: false,
          reason: 'INCOMPLETE_CHUNK_ANALYSIS',
          message:
            `Analiz durakladı: ${chunkResults.filter(result => result?.available).length}/${chunkCount} bölüm tamamlandı. ` +
            'Tamamlanan bölümler korunuyor; bağlantı veya servis sorunu düzeldiğinde kalan bölümler yeniden denenebilir.',
          completedChunkCount: chunkResults.filter(result => result?.available).length,
          expectedChunkCount: chunkCount,
          failedChunk,
          failure: failureBody
        };
      }
    } else {
      const completedResults = chunkResults.filter(result => result?.available);
      const analysisGaps = chunkResults.flatMap(result => result?.analysisGaps || []);
      const mergedActions = completedResults
        .flatMap(result =>
          Array.isArray(result.actions) ? result.actions : []
        )
        .sort((a, b) =>
          Number(a.startTime) - Number(b.startTime)
        )
        .map((action, index) => ({
          ...action,
          actionId: `tl-${String(index + 1).padStart(3, '0')}`,
          sceneId: action.sceneId ||
            `scene-${String(index + 1).padStart(3, '0')}`
        }));

      const prompts = completedResults
        .map(result => String(result.videoPrompt || '').trim())
        .filter(Boolean);
      const mergedStoryContext = mergeStoryContexts(completedResults);

      const firstResult = chunkResults[0] || {};

      body = {
        available: true,
        partial: analysisGaps.length > 0,
        ...(creditRecovery.recovered ? { recoveryReason: 'GEMINI_CREDITS_DEPLETED' } : {}),
        videoDuration: storyboard.duration,
        introEndTime: Number(firstResult.introEndTime || 0),
        playStartTime: Number(
          firstResult.playStartTime ??
          firstResult.introEndTime ??
          0
        ),
        videoPrompt: [
          mergedStoryContext.synopsisTr ? `HİKÂYE ÖZETİ: ${mergedStoryContext.synopsisTr}` : '',
          prompts.join('\n\n')
        ].filter(Boolean).join('\n\n'),
        storyContext: mergedStoryContext,
        actions: mergedActions,
        warnings: [...(session.audioContextStatus === 'unavailable'
          ? ['Konuşma analizi alınamadı; karakter bilgisi yalnızca görsel kanıta dayanıyor.'] : []), ...chunkResults.flatMap(result =>
          Array.isArray(result.warnings) ? result.warnings : []
        )],
        analysisGaps,
        analysisMode: 'MULTI_PASS_DEEP_HARDENED',
        chunkCount: completedResults.length,
        processedChunkCount: chunkResults.filter(Boolean).length,
        expectedChunkCount: chunkCount,
        analysisCoverage: chunkCount ? completedResults.length / chunkCount : 0,
        skippedFrameCount,
        secondPassChunkCount: chunkResults.filter(result => result.secondPassReviewed).length,
        rebasedChunkCount: chunkResults.filter(result => result.chunkTimeRebased).length,
        analyzedThroughTime: Math.max(0, ...mergedActions.map(action => Number(action.endTime) || 0)),
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION
      };
    }

  if (
    body?.available && !body?.partial &&
    (!Array.isArray(body.actions) || !body.actions.length) &&
    (state.selectedFile || state.selectedRemoteVideo)
  ) {
    els.analysisState.textContent = 'EXTERNAL_FALLBACK';
    els.analysisTitle.textContent = 'Hareket motoru devreye giriyor';

    try {
      const fallbackFile = state.selectedFile || await ensureSelectedRemoteFile();
      const fallbackForm = new FormData();
      fallbackForm.append('video', fallbackFile, fallbackFile.name);
      const fallbackResponse = await postAnalysisForm('/api/external-analyze', fallbackForm, {
        timeoutMs: 900000, stage: 'analysis', label: 'Ek hareket analizi'
      });
      const fallbackBody = await fallbackResponse.json();
      if (fallbackResponse.ok && fallbackBody?.available) {
        body = { ...fallbackBody, storyContext: mergeStoryContexts([body, fallbackBody]), analysisMode: 'EXTERNAL_FALLBACK' };
      }
    } catch (error) {
      console.warn('External fallback analysis failed:', error);
    }
  }

  if (!body?.available) {
    const creditsDepleted = body?.reason === 'GEMINI_CREDITS_DEPLETED';
    const contentRestricted =
      body?.reason === 'GEMINI_CONTENT_RESTRICTED' ||
      body?.failure?.reason === 'GEMINI_CONTENT_RESTRICTED';
    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';
    els.analysisTitle.textContent = creditsDepleted
      ? 'Gemini API kredisi tükendi'
      : contentRestricted
        ? 'Gemini bu video bölümünü analiz etmedi'
        : 'Video analizi eksik kaldı';
    els.analysisOutput.textContent = creditsDepleted
      ? [
          'Gemini API kredisi tükendi. Analiz başlatılamadı.',
          'Yeni kredi ekle veya geçerli bakiyesi olan başka bir Gemini API anahtarı kullan.',
          'Bu hata için otomatik tekrar deneme yapılmadı.'
        ].join('\n')
      : contentRestricted
        ? [
            body?.failure?.message || body?.message || 'Gemini içerik kısıtlaması nedeniyle bu bölümü okuyamadı.',
            'Aynı bölüm boş sonuçla başarı sayılmadı ve oyun modu açılmadı.',
            'Bu bir Render, API anahtarı veya kota hatası değildir.'
          ].join('\n')
        : [
            body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.',
            body?.failure?.message || '',
            Number(body?.completedChunkCount) > 0
              ? 'Tamamlanan bölümler bu sekmede korunuyor. Aynı ayarlarla yeniden analiz et; eksik bölümden devam edilecek.'
              : ''
          ].filter(Boolean).join('\n');
    setGameState('ERROR');
    renderDebug({ lastAnalyzeBody: body });
    return;
  }

  analysisProgress.done('frameUpload', 'Analiz görüntüleri sunucu tarafından alındı.');
  analysisProgress.done('analysis', (body.completedChunkCount || body.chunkCount || chunkCount) + ' bölüm analiz edildi.');
  analysisProgress.done('review', (body.secondPassChunkCount || 0) + ' bölüm ikinci kontrolden geçti.');
  analysisProgress.update('integrity', { detail: 'Seçimler, sahneler ve kaynak zamanları kontrol ediliyor.' });
  let normalized = normalizeAnalysis(body);
  const hardened = reviewAndHardenAnalysis({
    ...body,
    ...normalized,
    chunkCount: Number(body.chunkCount || 0),
    expectedChunkCount: Number(body.expectedChunkCount || 0)
  });
  normalized = hardened.analysis;
  state.integrityReport = hardened.integrity;
  state.analysisFingerprint = analysisFingerprint(normalized);
  logEngineEvent('ANALYSIS_REVIEWED', {
    fatal: hardened.integrity.fatal,
    issues: hardened.integrity.issueCount,
    before: hardened.integrity.actionCountBefore,
    after: hardened.integrity.actionCountAfter
  });

  if (hardened.integrity.fatal) {
    analysisProgress.update('integrity', { status: 'failed', detail: 'Analiz bütünlük kontrolünden geçemedi.' });
    els.analysisState.textContent = 'INTEGRITY_FAILED';
    els.analysisTitle.textContent = 'Analiz bütünlük kontrolünden geçemedi';
    els.analysisOutput.textContent = 'Eksik veya tutarsız analiz oyun olarak açılmadı. Videoyu yeniden analiz et.';
    setGameState('ERROR');
    renderDebug({ integrity: hardened.integrity });
    return;
  }

  if (!normalized.actions.length) {
    els.analysisState.textContent = 'NO_ACTIONS';
    els.analysisTitle.textContent = 'Doğrulanmış action bulunmadı';
    els.analysisOutput.textContent = body.partial
      ? ['Modelden oynanabilir analiz verisi alınamadı. Okunamayan bölümler başarı sayılmadı.', ...(body.warnings || [])].join('\n')
      : 'Analiz edilen görüntülerde doğrulanmış seçenek bulunamadı.';
    setGameState('ERROR');
    renderDebug({ lastAnalyzeBody: body });
    return;
  }

  state.analysis = normalized;
  analysisProgress.done('integrity', normalized.actions.length + ' doğrulanmış aksiyon hazır.');
  try {
    // Analysis persistence intentionally disabled: refresh must start clean.
    localStorage.removeItem("videoquest:last-analysis");
  } catch (error) {
    console.warn("Analysis could not be saved locally:", error);
  }
  if (creditRecovery?.recovered && (modes.dubbing || modes.subtitles)) {
    // Do not make more paid translation/TTS calls after the credit failure.
    // The original video's audio and verified interactive options remain
    // playable; source transcription already obtained stays in this session.
    els.analysisOutput.textContent +=
      '\nTürkçe dublaj/çeviri, API kredisi yenilenene kadar ertelendi; kaynak ses korunuyor.';
  }
  let sourceAudioOnly = false;
  let deferredTranslationQuota = false;
  if (modes.motion && (modes.dubbing || modes.subtitles) && !creditRecovery.recovered) {
    analysisProgress.update('voices', { detail: 'Kaynak konuşmacılar görsel karakterlerle eşleştiriliyor.' });
    const speakerHints = verifiedSpeakerVoiceHints(normalized);
    els.analysisState.textContent = 'PREPARING_TURKISH_MEDIA';
    els.analysisTitle.textContent = 'Konuşmacılar eşleştiriliyor ve Türkçe medya hazırlanıyor';
    els.analysisOutput.textContent = [
      `${Object.keys(speakerHints).length} kaynak konuşmacı kimliği görsel karakterlerle doğrulandı.`,
      'Aynı kişiye ait parçalanmış konuşmacı kimlikleri tek sabit Türkçe sese bağlanıyor.',
      'Ses seçimi; doğrulanmış karakter profili, Türkçe desteği ve mevcut duygu/ton etiketleriyle otomatik yapılıyor.'
    ].join('\n');
    // A successful media retry has already completed the paid stages. Reuse
    // its manifest while rebuilding the game from saved visual chapters.
    try {
      const finalMedia = canReuseTurkishMedia(session, mediaModeKey, modes)
        ? mediaClient.loadResult(session.mediaManifest, { dubEnabled: modes.dubbing,
          subtitleTrack: modes.subtitles ? (modes.dubbing ? 'dub_tr' : 'source_tr') : 'off' })
        : await mediaClient.start(file, {
          outputs: { dub: modes.dubbing, subtitles: modes.subtitles, ...(modes.dubbingProvider === 'elevenlabs_v1' ? { dubbingProvider: 'elevenlabs_v1' } : {}) },
          qualityMode: modes.dubQuality,
          sceneContext: verifiedMediaSceneContext(),
          speakerHints
        });
      session.mediaManifest = finalMedia;
      recordAiUsage(finalMedia?.qualityReport?.geminiUsage);
      session.mediaModeKey = mediaModeKey;
      updateSourceTranscript(finalMedia.sourceTranscript);
      renderMediaControls();
    } catch (error) {
      if (isGeminiTranslationQuota(error)) {
        // The scene analysis has already succeeded. Never throw it away due
        // to the independent media provider's quota. A changed key may retry
        // this media stage without any visual Gemini request.
        deferredTranslationQuota = true;
        sourceAudioOnly = true;
        session.pendingTurkishMedia = { modeKey: mediaModeKey };
        session.mediaManifest = null;
        renderMediaControls();
        analysisProgress.update('translation', { status: 'failed',
          detail: 'Türkçe çeviri için Gemini kotası dolu. Görsel analiz ve oyun korunuyor.' });
        els.mediaJobRetryBtn?.classList.remove('hidden');
      } else {
        if (error?.code !== 'TRANSLATION_BLOCKED') throw error;
        // A content restriction is not a quota problem and may not be evaded
        // by rotating credentials or inventing translated dialogue.
        sourceAudioOnly = true;
        session.mediaManifest = null;
        session.pendingTurkishMedia = null;
        mediaClient.reset({ cancelJob: false });
        renderMediaControls();
        analysisProgress.update('translation', { status: 'skipped',
          detail: 'Gemini bu konuşmaların çevirisini engelledi; özgün kaynak ses korunuyor.' });
      }
    }
  }

  els.analysisState.textContent = body.partial ? 'PARTIAL_TIMELINE_READY' : 'TIMELINE_READY';
  els.analysisTitle.textContent = `${body.partial ? 'Kısmi analiz hazır · ' : ''}${normalized.actions.length} doğrulanmış aksiyon`;
  els.analysisOutput.textContent = [
    body.partial ? 'Analiz kısmen hazır. Okunamayan aralıklarda seçenek üretilmedi.' : 'Ayrıntılı analiz tamamlandı.',
    `${normalized.actions.length} doğrulanmış aksiyon hazır.`,
    `${Number(body.chunkCount || 0)}/${Number(body.expectedChunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,
    ...(body.analysisGaps || []).map(gap => `Bölüm ${gap.chunkIndex + 1}: ${gap.startTime.toFixed(1)}–${gap.endTime.toFixed(1)} sn doğrulanamadı.`),
    `${Number(body.secondPassChunkCount || 0)} bölüm görsel ikinci kontrolden geçti.`,
    `${Number(body.rebasedChunkCount || 0)} bölümün yerel zamanları video zamanına düzeltildi.`,
    Number(body.skippedFrameCount || 0)
      ? `${Number(body.skippedFrameCount)} okunamayan kare atlandı; analiz kalan doğrulanmış karelerle tamamlandı.`
      : 'Bütün örnek kareler başarıyla hazırlandı.',
    `Son doğrulanmış aksiyon ${Number(body.analyzedThroughTime || 0).toFixed(1)} saniyede bitiyor.`,
    `Bütünlük kontrolü: ${state.integrityReport?.issueCount || 0} uyarı · ${normalized.actions.length} güvenli aksiyon.`,
    `Bu çalıştırmada Gemini: ${state.aiUsage.requests} istek · ${state.aiUsage.cacheHits || 0} önbellekten yanıt · ${state.aiUsage.inputTokens} giriş · ${state.aiUsage.outputTokens + state.aiUsage.thinkingTokens} çıkış/düşünme tokenı.`,
    body.partial ? 'Doğrulanmış bölümlerle oynayabilirsin. Eksik bölgelerden seçenek uydurulmadı.' : 'Oyun modu kullanıma hazır.',
    creditRecovery?.recovered ? 'API kredisi tükendi: mevcut önceki analizler oyunlaştırıldı; eksik aralıklar kredi yenilendiğinde tamamlanabilir.' : '',
    deferredTranslationQuota
      ? 'Türkçe çeviri kotası doldu. Video analizi, oyun seçenekleri ve kaynak ses korundu. Yeni anahtarı girdikten sonra yalnız Türkçe medya yeniden denenecek.'
      : sourceAudioOnly ? 'Türkçe dublaj üretilemedi: Gemini konuşma çevirisini engelledi. Bu bir kota sorunu değildir. Oyun özgün video sesiyle açıldı.' : ''
  ].join('\n');
  initializeInteractive(normalized);
  if (session.pendingTurkishMedia) els.mediaJobRetryBtn?.classList.remove('hidden');
  state.savedGameReady = true;
  analysisProgress.update('save', { detail: 'Analiz, seçimler ve Türkçe medya kaydediliyor.' });
  const saveCompleted = await savedGames?.saveCurrent(true);
  analysisProgress.done('save', saveCompleted
    ? 'Oyun cihazına kaydedildi.'
    : 'Oyun oynatılabilir fakat otomatik kayıt tamamlanamadı; kaydetme alanını kontrol et.');
  analysisSucceeded = true;
  analysisProgress.finish();
  } catch (error) {
    console.error('Analysis failed:', error);
    els.analysisCard.dataset.compactError = 'true';
    els.analysisState.textContent = error?.name === 'AbortError' ? 'CANCELLED' : 'ANALYSIS_ERROR';
    els.analysisTitle.textContent = 'Analiz tamamlanamadı';
    const finishedChunks = state.analysisSession?.chunkResults?.filter(row => row?.available === true).length || 0;
    const quota = isGeminiTranslationQuota(error);
    if (quota && state.analysis?.actions?.length &&
        state.analysisSession?.sourceKey === analysisSourceKey(state.selectedFile, state.selectedRemoteVideo)) {
      state.analysisSession.pendingTurkishMedia = {
        modeKey: requestedTurkishMediaModeKey(selectedAnalysisModes())
      };
      state.savedGameReady = true;
      els.mediaJobRetryBtn?.classList.remove('hidden');
      els.analysisTitle.textContent = 'Oyun analizi hazır · Türkçe medya bekliyor';
    }
    els.analysisOutput.textContent = [
      error?.message || 'Beklenmeyen bir analiz hatası oluştu.',
      finishedChunks > 0
        ? finishedChunks + ' doğrulanmış görsel bölüm korundu; yeni anahtarla yalnız eksikler yeniden denenebilir.'
        : '',
      quota && state.analysis?.actions?.length
        ? 'Bu kota hatası video analizini geçersiz kılmaz. Yeniden dene ile yalnız Türkçe medyayı tamamla.'
        : '',
      state.aiUsage?.requests
        ? 'Bu denemede kayda geçen en az ' + state.aiUsage.requests + ' başarılı Gemini isteği · ' +
          (state.aiUsage.totalTokens || 0) + ' raporlanmış token. Reddedilen istekler bu sayıya dahil değildir.'
        : ''
    ].filter(Boolean).join('\n');
    setGameState(error?.name === 'AbortError' ? 'IDLE' : 'ERROR');
    renderDebug({ analysisError: error?.message || String(error) });
  } finally {
    if (!analysisSucceeded) analysisProgress.finish(els.analysisState.textContent === 'CANCELLED' ? 'cancelled' : 'failed',
      els.analysisOutput.textContent || els.analysisTitle.textContent);
    els.analysisCard.dataset.processing = 'false';
    els.mediaJobCancelBtn?.classList.add('hidden');
    if (analysisAbortController === analysisOwner) analysisAbortController = null;
    state.analysisInProgress = false;
    els.videoInput.disabled = false;
    if (videoUrlInput) videoUrlInput.disabled = false;
    if (resolveUrlBtn) resolveUrlBtn.disabled = false;
    updateAnalyzeAvailability();
  }
});

function assignPositionOccurrenceIds(actions) {
  const groups = new Map();

  actions.forEach((action, index) => {
    if (!action.adultScene || !action.positionId) return;

    const canonical = canonicalAdultPosition(action);
    const familyId = canonical.id || normalizeAdultLabel(action.positionId);
    if (!familyId) return;

    const sceneId = action.adultSceneId ||
      `adult-${Math.round(action.adultSceneStartTime || action.startTime)}`;
    const rawStart = Number(action.positionStartTime);
    const rawEnd = Number(action.positionEndTime);
    const startTime = Number.isFinite(rawStart)
      ? rawStart
      : Number(action.startTime) || 0;
    const endCandidate = Number.isFinite(rawEnd)
      ? rawEnd
      : Number(action.endTime) || startTime;
    const endTime = Math.max(startTime, endCandidate);
    const routeNamespace = activityOccurrenceNamespace(action);
    const partnerTrackId = String(action.partnerTrackId || '').trim();
    const key = `${sceneId}::${familyId}::${routeNamespace}::${partnerTrackId || 'partner-unknown'}`;

    if (!groups.has(key)) {
      groups.set(key, { sceneId, familyId, routeNamespace, partnerTrackId, entries: [] });
    }

    groups.get(key).entries.push({
      action,
      index,
      startTime,
      endTime
    });
  });

  groups.forEach(group => {
    const occurrences = [];

    group.entries.forEach(entry => {
      const explicitId = String(
        entry.action.positionOccurrenceId || ''
      ).trim();
      if (!explicitId) return;

      let occurrence = occurrences.find(item => item.id === explicitId);
      if (!occurrence) {
        occurrence = {
          id: explicitId,
          startTime: entry.startTime,
          endTime: entry.endTime
        };
        occurrences.push(occurrence);
      } else {
        occurrence.startTime = Math.min(occurrence.startTime, entry.startTime);
        occurrence.endTime = Math.max(occurrence.endTime, entry.endTime);
      }
    });

    let generatedCount = 0;
    const sortedEntries = [...group.entries]
      .sort((a, b) => a.startTime - b.startTime || a.index - b.index);

    sortedEntries.forEach(entry => {
      if (String(entry.action.positionOccurrenceId || '').trim()) return;

      const matching = occurrences
        .filter(occurrence =>
          entry.startTime <= occurrence.endTime + 0.15 &&
          entry.endTime >= occurrence.startTime - 0.15
        )
        .sort((a, b) =>
          Math.abs(a.startTime - entry.startTime) -
          Math.abs(b.startTime - entry.startTime)
        )[0];

      let occurrence = matching;
      if (!occurrence) {
        generatedCount += 1;
        const sceneSlug = normalizeAdultLabel(group.sceneId)
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'adult';
        const familySlug = normalizeAdultLabel(group.familyId)
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'position';
        const routeSlug = normalizeAdultLabel(group.routeNamespace || 'other')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'other';
        const partnerSlug = normalizeAdultLabel(group.partnerTrackId || 'partner')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'partner';
        occurrence = {
          id: `${sceneSlug}:${familySlug}:${routeSlug}:${partnerSlug}:occ-${String(generatedCount).padStart(2, '0')}-${Math.round(entry.startTime * 1000)}`,
          startTime: entry.startTime,
          endTime: entry.endTime
        };
        occurrences.push(occurrence);
      } else {
        occurrence.startTime = Math.min(occurrence.startTime, entry.startTime);
        occurrence.endTime = Math.max(occurrence.endTime, entry.endTime);
      }

      entry.action.positionOccurrenceId = occurrence.id;
    });
  });
}

function normalizeAnalysis(body) {
  const storyContext = mergeStoryContexts([{ storyContext: body?.storyContext || {} }]);
  const actions = Array.isArray(body?.actions) ? body.actions : [];
  const cleaned = actions
    .map((a, i) => ({
      gameplayEvidence: normalizeGameplayEvidence(a.gameplayEvidence),
      actionId: String(a.actionId ?? a.id ?? `ACTION_${String(i + 1).padStart(3, '0')}`),
      label: String(a.label ?? a.action ?? 'Unnamed action'),
      narrativeChoiceLabel: String(a.narrativeChoiceLabel || ''),
      characterSourceLabel: String(a.characterSourceLabel ?? a.label ?? a.action ?? 'Unnamed action'),
      characterSourceNarrativeLabel: String(a.characterSourceNarrativeLabel ?? a.narrativeChoiceLabel ?? ''),
      involvedCharacterIds: Array.isArray(a.involvedCharacterIds)
        ? a.involvedCharacterIds.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
        : [],
      primaryCharacterLabel: String(a.primaryCharacterLabel || ''),
      primaryCharacterId: String(a.primaryCharacterId || '').trim(),
      narrativeReason: String(a.narrativeReason || ''),
      sceneTitle: String(a.sceneTitle || ''),
      sceneGoal: String(a.sceneGoal || ''),
      relationshipContext: String(a.relationshipContext || ''),
      storyEvidenceLevel: String(a.storyEvidenceLevel || 'unknown'),
      storyConfidence: Math.max(0, Math.min(1, Number(a.storyConfidence) || 0)),
      storyEvidence: String(a.storyEvidence || ''),
      choiceKey: String(
        a.choiceKey ??
        a.afterState?.choiceKey ??
        a.label ??
        a.action ??
        `choice-${i}`
      ).trim().toLocaleLowerCase('tr-TR'),
      startTime: Number(a.startTime ?? a.start ?? 0),
      endTime: Number(a.endTime ?? a.end ?? 0),
      beforeState: a.beforeState ?? null,
      afterState: a.afterState ?? null,
      sourceVerified: a.sourceVerified === true,
      confidence: Number(a.confidence ?? 0),
      subjectTrackId: a.subjectTrackId ?? a.subject ?? null,
      actionLevel: a.actionLevel === "bonus" ? "bonus" : "main",
      actionType: String(a.actionType || "other"),
      choiceSurface: String(a.choiceSurface || ''),
      choiceSurfaceEvidence: String(a.choiceSurfaceEvidence || '').trim().slice(0, 500),
      choiceSurfaceConfidence: Math.max(0, Math.min(1, Number(a.choiceSurfaceConfidence) || 0)),
      cameraMode: String(a.cameraMode || "uncertain"),
      adultScene: Boolean(a.adultScene),
      adultSceneId: String(a.adultSceneId || ""),
      adultSceneStartTime: Number(a.adultSceneStartTime ?? a.startTime),
      adultSceneEndTime: Number(a.adultSceneEndTime ?? a.endTime),
      postSceneTime: Number(a.postSceneTime ?? a.endTime),
      positionId: String(a.positionId || ""),
      positionOccurrenceId: String(a.positionOccurrenceId || ""),
      receiverBodyOrientation: String(a.receiverBodyOrientation || 'unclear'),
      receiverSupport: String(a.receiverSupport || 'unclear'),
      positionConfigurationConfidence: Math.max(0, Math.min(1, Number(a.positionConfigurationConfidence) || 0)),
      positionEvidence: String(a.positionEvidence || ''),
      classificationReview: a.classificationReview === 'verified' ? 'verified' : 'pending',
      groupScene: a.groupScene === true,
      adultParticipantCount: Math.max(0, Math.floor(Number(a.adultParticipantCount) || 0)),
      participantTrackIds: Array.isArray(a.participantTrackIds)
        ? a.participantTrackIds.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
        : [],
      partnerTrackId: String(a.partnerTrackId || '').trim(),
      partnerLabel: String(a.partnerLabel || '').trim(),
      partnerEvidence: String(a.partnerEvidence || '').trim(),
      partnerSwitch: a.partnerSwitch === true,
      previousPartnerTrackId: String(a.previousPartnerTrackId || '').trim(),
      activityType: String(a.activityType || ""),
      activityTypeConfidence: Math.max(0, Math.min(1, Number(a.activityTypeConfidence) || 0)),
      activityEvidence: String(a.activityEvidence || ""),
      positionLabel: String(a.positionLabel || ""),
      positionStartTime: Number(a.positionStartTime ?? a.startTime),
      positionEndTime: Number(a.positionEndTime ?? a.endTime),
      movementType: String(a.movementType || a.actionType || ""),
      movementTempo: ['slow', 'moderate', 'fast'].includes(String(a.movementTempo || '').toLowerCase())
        ? String(a.movementTempo).toLowerCase()
        : 'unclear',
      audioIntensity: String(a.audioIntensity || 'unclear'),
      nonSpeechAudio: String(a.nonSpeechAudio || 'unclear'),
      gazeIntensity: String(a.gazeIntensity || 'unclear'),
      observedAffect: String(a.observedAffect || 'unclear'),
      bodyResponse: String(a.bodyResponse || 'unclear'),
      sensoryEvidence: String(a.sensoryEvidence || ''),
      sensoryConfidence: Math.max(0, Math.min(1, Number(a.sensoryConfidence) || 0)),
      loopStartTime: Number(a.loopStartTime ?? a.startTime),
      loopEndTime: Number(a.loopEndTime ?? a.endTime),
      maleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.maleProgressRate) || 1)),
      femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.femaleProgressRate) || 1)),
      outcomeType: ['climax', 'aftermath'].includes(String(a.outcomeType || '').toLowerCase())
        ? String(a.outcomeType).toLowerCase()
        : 'none',
      outcomeLabel: String(a.outcomeLabel || ''),
      outcomeStartTime: Number(a.outcomeStartTime ?? a.startTime),
      outcomeEndTime: Number(a.outcomeEndTime ?? a.endTime),
      outcomeUnlockProgress: normalizeOutcomeUnlockProgress(a.outcomeUnlockProgress),
    }))
    .filter(a => Number.isFinite(a.startTime) && Number.isFinite(a.endTime) && a.endTime > a.startTime && a.sourceVerified)
    .sort((a, b) => a.startTime - b.startTime)
    .map(action => bindActionCharacter(action, storyContext));

  const ownership = partitionProtagonistActions(cleaned, storyContext, body?.mainMaleTrackId);
  assignPositionOccurrenceIds(ownership.playable);

  return {
    schemaVersion: Number(body?.schemaVersion || ANALYSIS_SCHEMA_VERSION),
    engineVersion: String(body?.engineVersion || ENGINE_VERSION),
    chunkCount: Number(body?.chunkCount || 0),
    processedChunkCount: Number(body?.processedChunkCount || 0),
    partial: body?.partial === true,
    analysisGaps: Array.isArray(body?.analysisGaps) ? body.analysisGaps : [],
    expectedChunkCount: Number(body?.expectedChunkCount || 0),
    analysisCoverage: Number(body?.analysisCoverage || 0),
    secondPassChunkCount: Number(body?.secondPassChunkCount || 0),
    videoDuration: Number(body?.videoDuration ?? 0),
    mainMaleTrackId: body?.mainMaleTrackId ?? null,
    semanticVideoMap: body?.semanticVideoMap ?? [],
    videoPrompt: body?.videoPrompt ?? body?.description ?? '',
    storyContext,
    warnings: Array.isArray(body?.warnings) ? body.warnings : [],
    actions: ownership.playable,
    unownedSourceIntervals: mergeUnownedIntervals(ownership.excluded.map(action => ({
      startTime: action.startTime, endTime: action.endTime
    }))),
  };
}

function initializeInteractive(analysis, gameplaySnapshot = null) {
  cancelTimelineNavigation();
  state.gameplayPlayer?.destroy();
  state.analysisFingerprint = analysisFingerprint(analysis);
  state.adultMode = false;
  state.adultScene = null;
  state.activeAction = null;
  // The legacy composer remains an analysis diagnostic, never a gameplay owner.
  prepareAdultScenes();
  const graph = createGameplayGraph(analysis);
  if (state.adultAnalysisTrace) {
    state.adultAnalysisTrace.legacyComposition = state.adultAnalysisTrace.graph;
    state.adultAnalysisTrace.graph = graph;
    renderAdultAnalysisTrace();
  }
  state.gameplayPlayer = createGameplayPlayer({ graph, video: els.video, snapshot: gameplaySnapshot,
    conversationEndAt: time => mediaClient.conversationEndAt(time, state.sourceContext?.segments || [],
      Number(els.video.duration) || Number(analysis.videoDuration) || Infinity),
    onChange: runtime => {
      state.gameCursorTime = runtime.cursor;
      state.activeInteractionSurface = activeSurface(runtime);
      state.gameState = runtime.status === 'ended' ? 'ENDED'
        : runtime.status === 'seeking' ? 'SEGMENT_SEEKING'
          : runtime.status === 'playing' ? 'SEGMENT_PLAYING' : 'DECISION_PENDING';
      els.gameState.textContent = state.gameState;
      const stage = els.video.closest('.video-stage');
      if (stage) stage.dataset.state = state.gameState;
      renderGameplay({ state: runtime, player: state.gameplayPlayer, els });
      renderDebug();
    }
  });
  const cursor = gameplaySnapshot ? state.gameplayPlayer.getState().cursor
    : Number(analysis.playStartTime ?? analysis.introEndTime ?? graph.clips[0]?.startTime) || 0;
  const player = state.gameplayPlayer;
  const seekStart = () => { if (state.gameplayPlayer === player) void player.navigate(cursor, { rewind: true, preserveState: Boolean(gameplaySnapshot) }); };
  if (els.video.readyState >= 1) seekStart();
  else els.video.addEventListener('loadedmetadata', seekStart, { once: true });
  els.playerSection.classList.remove('hidden');
  els.videoPrompt.textContent = typeof analysis.videoPrompt === 'string' ? analysis.videoPrompt : JSON.stringify(analysis.videoPrompt || '', null, 2);
  renderTimeline();
  renderChoices();
}

function normalizeAdultLabel(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function adultSemanticFamily(value) {
  return adultPositionFamily(value);
}

function canonicalAdultPosition(action) {
  // A verified explicit label such as "ters kovboy pozisyonunda" corrects
  // stale parent metadata that still says cowgirl.
  const { family, correctedFromAction } = resolveVerifiedAdultPosition(action);

  const labels = {
    oral: 'Oral Seks',
    manual: 'Manuel Uyarım',
    'reverse-cowgirl': 'Ters Kovboy Pozisyonu',
    'seated-facing': 'Kucakta Yüz Yüze Pozisyon',
    'prone-bone': 'Prone Bone Pozisyonu',
    'legs-up': 'Bacaklar Yukarı Pozisyon',
    missionary: 'Misyoner Pozisyonu',
    cowgirl: 'Kovboy Pozisyonu',
    spoon: 'Spooning',
    'reverse-spoon': 'Ters Kaşık Pozisyonu',
    'standing-rear': 'Standing Doggy Style',
    rear: 'Doggy Style',
    seated: 'Oturarak Pozisyon',
    standing: 'Ayakta Pozisyon'
  };

  if (family) return { id: family, label: labels[family], correctedFromAction };

  return { id: '', label: '', correctedFromAction: false };
}

function adultCategoryFor(action, positionId) {
  const explicit = normalizeAdultLabel(action.activityType);

  if (explicit === 'oral') return { id: 'oral', label: 'Oral' };
  if (explicit === 'manual') return { id: 'manual', label: 'Manuel' };
  if (explicit === 'vaginal') return { id: 'vaginal', label: 'Vajinal' };
  if (explicit === 'anal') return { id: 'anal', label: 'Anal' };

  if (positionId === 'oral') return { id: 'oral', label: 'Oral' };
  if (positionId === 'manual') return { id: 'manual', label: 'Manuel' };
  if (['reverse-cowgirl', 'seated-facing', 'prone-bone', 'legs-up', 'missionary', 'cowgirl', 'spoon', 'reverse-spoon', 'standing-rear', 'rear', 'seated', 'standing'].includes(positionId)) {
    return { id: 'position', label: 'Pozisyonlar' };
  }

  const source = normalizeAdultLabel([
    action.positionLabel,
    action.label,
    action.movementType
  ].filter(Boolean).join(' '));

  if (/\b(anal|anus)\b/.test(source)) {
    return { id: 'anal', label: 'Anal' };
  }

  if (/\b(vajinal|vaginal|vajina)\b/.test(source)) {
    return { id: 'vaginal', label: 'Vajinal' };
  }

  return { id: 'other', label: 'Diğer gerçek sahneler' };
}

function isWarmupPosition(position) {
  if (position?.progressionRole) return position.progressionRole === 'foreplay';
  return ['oral', 'manual'].includes(String(position?.categoryId || '')) ||
    ['oral', 'manual'].includes(String(position?.familyId || ''));
}

function isBonusPosition(position) {
  if (position?.progressionRole) return position.progressionRole === 'bonus';
  const category = String(position?.categoryId || '');
  return category === 'anal' || category === 'other';
}

// One encounter is often split into several model scene ids even though the
// source continues with other verified positions. Keep nearby occurrences in
// one gameplay graph so progression can reveal them instead of ending early.
// Only nearby source chapters can share one timeline panel.
const ADULT_FRAGMENT_MERGE_GAP_SECONDS = 30;
const ADULT_FRAGMENT_BRIDGED_GAP_SECONDS = 45;
const ADULT_CORE_CONTINUATION_GAP_SECONDS = 60;

function mergeAdultSceneFragments(scenes, nonAdultActions = [], unownedIntervals = []) {
  const sorted = [...(Array.isArray(scenes) ? scenes : [])]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const merged = [];
  const castFor = scene => [...new Set([
    ...(scene.positions || []), ...(scene.foreplay || []), ...(scene.partnerTransitions || [])
  ].flatMap(item => {
    const subject = String(item.subjectTrackId || '').trim();
    const partner = String(item.partnerTrackId || '').trim();
    const participants = [...(item.participantTrackIds || [])]
      .map(value => String(value || '').trim()).filter(Boolean).sort();
    return subject || partner || participants.length ? [JSON.stringify([subject, partner, participants])] : [];
  }))].sort().join('|');

  for (const scene of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...scene });
      continue;
    }

    const gap = Number(scene.startTime) - Number(previous.endTime);
    const previousCast = castFor(previous);
    const sceneCast = castFor(scene);
    const castBarrier = Boolean(previousCast && sceneCast && previousCast !== sceneCast);
    const scenePair = source => {
      const rows = [...(source.positions || []), ...(source.foreplay || []), ...(source.partnerTransitions || [])];
      const row = rows.find(item => String(item.subjectTrackId || '').trim() && String(item.partnerTrackId || '').trim());
      return row ? [String(row.subjectTrackId).trim(), String(row.partnerTrackId).trim()] : [];
    };
    const [subjectTrackId, partnerTrackId] = scenePair(previous);
    const verifiedBridge = !castBarrier && Boolean(subjectTrackId && partnerTrackId) &&
      nonAdultActions.some(action => action?.sourceVerified === true &&
        String(action.subjectTrackId || '').trim() === subjectTrackId &&
        String(action.partnerTrackId || '').trim() === partnerTrackId &&
        Number(action.endTime) >= Number(previous.endTime) - 0.1 &&
        Number(action.startTime) <= Number(scene.startTime) + 2);
    const unownedBarrier = !verifiedBridge && unownedIntervals.some(interval =>
      Number(interval.endTime) > Number(previous.endTime) + 0.05 &&
      Number(interval.startTime) < Number(scene.startTime) - 0.05);
    const narrativeBarrier = gap > 0.25 && nonAdultActions.some(action => {
      const start = Number(action.startTime);
      const end = Number(action.endTime);
      const actionType = String(action.actionType || '').toLowerCase();
      const explicitNarrativeBreak = ['dialogue', 'story', 'scene_transition'].includes(actionType);
      return action?.sourceVerified === true && explicitNarrativeBreak &&
        Number.isFinite(start) && Number.isFinite(end) &&
        Math.min(end, Number(scene.startTime)) - Math.max(start, Number(previous.endTime)) >= 0.5;
    });
    // A verified transition for the same cast may cross the provider's scene
    // split. Keep its source ranges exact; joining panels never makes the gap
    // itself a playable clip or a new movement choice.
    // Two verified core chapters with the same cast can belong to the same
    // encounter despite a quiet edit between them. Preserve each exact clip
    // range; the intervening time is never offered as a movement.
    const coreContinuation = (previous.positions || []).some(position =>
      !['oral', 'manual'].includes(String(position.familyId || position.categoryId || ''))) &&
      (scene.positions || []).some(position =>
        !['oral', 'manual'].includes(String(position.familyId || position.categoryId || '')));
    const maxGap = coreContinuation ? ADULT_CORE_CONTINUATION_GAP_SECONDS :
      verifiedBridge ? ADULT_FRAGMENT_BRIDGED_GAP_SECONDS : ADULT_FRAGMENT_MERGE_GAP_SECONDS;
    if (gap > maxGap || narrativeBarrier || (unownedBarrier && !coreContinuation) || castBarrier) {
      merged.push({ ...scene });
      continue;
    }

    previous.startTime = Math.min(Number(previous.startTime), Number(scene.startTime));
    previous.endTime = Math.max(Number(previous.endTime), Number(scene.endTime));
    previous.postSceneTime = Math.max(Number(previous.postSceneTime), Number(scene.postSceneTime));
    previous.sourceSceneIds = [...new Set([
      ...(previous.sourceSceneIds || [previous.id]),
      ...(scene.sourceSceneIds || [scene.id])
    ])];
    previous.foreplay = [...(previous.foreplay || []), ...(scene.foreplay || [])]
      .sort((a, b) => Number(a.startTime) - Number(b.startTime));
    previous.dialogue = [...(previous.dialogue || []), ...(scene.dialogue || [])]
      .sort((a, b) => Number(a.startTime) - Number(b.startTime));
    previous.partnerTransitions = [
      ...(previous.partnerTransitions || []),
      ...(scene.partnerTransitions || [])
    ].sort((a, b) => Number(a.startTime) - Number(b.startTime));
    previous.positions = [...(previous.positions || []), ...(scene.positions || [])]
      .sort((a, b) => Number(a.startTime) - Number(b.startTime));
    previous.outcomes = [...(previous.outcomes || []), ...(scene.outcomes || [])]
      .sort((a, b) => Number(a.startTime) - Number(b.startTime));

    if (!previous.aftermath || (scene.aftermath && Number(scene.aftermath.startTime) > Number(previous.aftermath.startTime))) {
      previous.aftermath = scene.aftermath || previous.aftermath;
    }
  }

  return merged;
}

function prepareAdultScenes() {
  const sourceInterval = (startValue, endValue) => {
    const numeric = value => typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value) : NaN;
    const startTime = numeric(startValue), endTime = numeric(endValue);
    return Number.isFinite(startTime) && Number.isFinite(endTime) && startTime >= 0 && endTime > startTime
      ? { startTime, endTime } : null;
  };
  const actions = (state.analysis?.actions || []).map(action => bindActionCharacter(
    withChoiceSurface(canonicalizeActionTrackIds(normalizeSourceActionTimes(action),
      state.analysis?.storyContext || {}), {
      panelFamily: playableAdultPanelFamily(action)
    }), state.analysis?.storyContext || {}));
  const traceRows = actions.map((action, index) => ({
    index,
    actionId: String(action?.actionId || `action-${index}`),
    label: String(action?.label || ''),
    startTime: Number(action?.startTime),
    endTime: Number(action?.endTime),
    sourceStartTime: action?.startTime,
    sourceEndTime: action?.endTime,
    sourceVerified: action?.sourceVerified === true,
    confidence: Number(action?.confidence || 0),
    input: {
      adultScene: Boolean(action?.adultScene),
      adultSceneId: String(action?.adultSceneId || ''),
      adultSceneStartTime: action?.adultSceneStartTime ?? null,
      adultSceneEndTime: action?.adultSceneEndTime ?? null,
      positionId: String(action?.positionId || ''),
      positionLabel: String(action?.positionLabel || ''),
      positionOccurrenceId: String(action?.positionOccurrenceId || ''),
      receiverBodyOrientation: String(action?.receiverBodyOrientation || ''),
      receiverSupport: String(action?.receiverSupport || ''),
      positionConfigurationConfidence: Number(action?.positionConfigurationConfidence || 0),
      positionEvidence: String(action?.positionEvidence || ''),
      classificationReview: String(action?.classificationReview || 'legacy'),
      groupScene: action?.groupScene === true,
      partnerTrackId: String(action?.partnerTrackId || ''),
      partnerLabel: String(action?.partnerLabel || ''),
      primaryCharacterId: String(action?.primaryCharacterId || ''),
      primaryCharacterLabel: String(action?.primaryCharacterLabel || ''),
      subjectTrackId: String(action?.subjectTrackId || ''),
      involvedCharacterIds: [...(action?.involvedCharacterIds || [])],
      identityResolution: String(action?.identityResolution || 'unknown'),
      relationshipResolution: String(action?.relationshipResolution || 'unknown'),
      relationshipRoleLabel: String(action?.relationshipRoleLabel || ''),
      relationshipSubjectId: String(action?.relationshipSubjectId || ''),
      relationshipTargetId: String(action?.relationshipTargetId || ''),
      partnerSwitch: action?.partnerSwitch === true,
      actionType: String(action?.actionType || ''),
      choiceSurface: action.choiceSurface,
      choiceSurfaceEvidence: String(action.choiceSurfaceEvidence || ''),
      choiceSurfaceConfidence: Number(action.choiceSurfaceConfidence || 0),
      movementType: String(action?.movementType || ''),
      movementTempo: String(action?.movementTempo || ''),
      positionStartTime: Number(action?.positionStartTime),
      positionEndTime: Number(action?.positionEndTime),
      loopStartTime: Number(action?.loopStartTime),
      loopEndTime: Number(action?.loopEndTime)
    },
    detectedFamily: verifiedAdultPositionFamily(action) || '',
    choiceSurface: action.choiceSurface,
    sceneCandidate: false,
    sceneCandidateReason: 'NOT_EVALUATED',
    membershipReason: 'NOT_ASSIGNED',
    route: 'NOT_ROUTED',
    routeReason: 'NOT_EVALUATED',
    finalSceneId: '',
    finalPositionKey: '',
    movementAccepted: false
  }));
  const traceByAction = new Map(actions.map((action, index) => [action, traceRows[index]]));
  state.adultAnalysisTrace = {
    reportVersion: 3,
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    analysisFingerprint: state.analysisFingerprint || '',
    sourceActionCount: actions.length,
    storyContext: state.analysis?.storyContext || null,
    audioContext: {
      status: state.analysisSession?.audioContextStatus || (state.sourceContext ? 'ready' : 'unavailable'),
      segmentCount: state.sourceContext?.segments?.length || 0,
      speakerCount: state.sourceContext?.speakers?.length || 0
    },
    actions: traceRows,
    graph: null,
    warnings: [...(state.analysis?.warnings || [])]
  };
  const sceneMap = new Map();
  const verifiedSceneActions = actions.filter(action => action?.sourceVerified === true);
  const sceneOccurrenceIds = assignAdultSceneOccurrenceIds(verifiedSceneActions);
  const sceneOccurrenceByAction = new Map(
    verifiedSceneActions.map((action, index) => [action, sceneOccurrenceIds[index]])
  );
  const sceneIdFor = action => sceneOccurrenceByAction.get(action) || action.adultSceneId ||
    `adult-${Math.round(action.adultSceneStartTime || action.startTime)}`;
  const verifiedPositionSceneIds = new Set(
    actions.filter(action => {
      const row = traceByAction.get(action);
      if (action?.sourceVerified !== true) {
        row.sceneCandidateReason = 'REJECTED_SOURCE_NOT_VERIFIED';
        return false;
      }
      // A verified position may arrive without the optional adultScene flag
      // or activityEvidence. The canonical family in its label is enough to
      // route it into the dedicated adult panel; never require model-only
      // metadata that would otherwise leak the action into normal choices.
      const family = playableAdultPanelFamily(action);
      if (!family) {
        row.sceneCandidateReason = 'REJECTED_NO_CANONICAL_POSITION_FAMILY';
        return false;
      }
      const start = Number(action.positionStartTime ?? action.startTime);
      const end = Number(action.positionEndTime ?? action.endTime);
      const validTime = Boolean(sourceInterval(action.startTime, action.endTime)) &&
        isPlayableVerifiedPositionDuration(start, end);
      const validConfidence = Number(action.confidence || 0) >= 0.6;
      row.sceneCandidate = validTime && validConfidence;
      row.sceneCandidateReason = !validTime
        ? 'REJECTED_POSITION_SHORTER_THAN_3_SECONDS_OR_INVALID_TIME'
        : (!validConfidence ? 'REJECTED_CONFIDENCE_BELOW_0_60' : 'ACCEPTED_VERIFIED_POSITION');
      return row.sceneCandidate;
    }).map(sceneIdFor)
  );

  const isIntroduction = action => {
    // Keep narrative bridge evidence in the scene graph; it must NEVER set
    // the playable phase's start or count as an approach selection.
    const actionType = String(action.actionType || '').toLowerCase();
    const dialogueBridge = action.choiceSurface === 'story' &&
      (actionType === 'dialogue' || actionType === 'body_transition' ||
        (state.sourceContext?.segments || []).some(segment => sourceSpeechOverlaps(action, segment)));
    const warmupFamily = String(playableAdultPanelFamily(action) || '').toLowerCase();
    const warmupCandidate = ['oral', 'manual'].includes(warmupFamily);
    return (action.choiceSurface === 'approach' || dialogueBridge || warmupCandidate) &&
      (!traceByAction.get(action)?.sceneCandidate || warmupCandidate) &&
      !(action.relationshipResolution === 'verified' && action.relationshipRoleLabel &&
        !isAdultSocialRelationshipRole(action.relationshipRoleLabel));
  };
  const introductions = matchSceneIntroductions(actions,
    actions.filter(action => traceByAction.get(action).sceneCandidate)
      .map(action => ({ action, sceneId: sceneIdFor(action) })), isIntroduction, 45,
    (action, reason) => {
      const row = traceByAction.get(action);
      if (row && row.membershipReason !== 'VERIFIED_SAME_CAST_INTRODUCTION') row.membershipReason = reason;
    }, (action, anchor, gap) =>
      gap <= 90 && action.adultScene === true && action.choiceSurface === 'approach' &&
      String(action.subjectTrackId || '').trim() === String(anchor.subjectTrackId || '').trim() &&
      String(action.partnerTrackId || '').trim() === String(anchor.partnerTrackId || '').trim());
  introductions.forEach((sceneId, action) => sceneOccurrenceByAction.set(action, sceneId));

  // A verified opening can be separated from the first core position by a
  // substantial source gap. Keep it as its own exact, progress-bearing panel
  // instead of silently routing its actions through the ordinary story UI.
  // Never stretch this opening to a distant core position or across cast IDs.
  const standaloneOpenings = [];
  const openingCast = action => verifiedOpeningCast(action,
    state.analysis?.storyContext?.characters || []);
  const orphanApproaches = actions.filter(action =>
    action.choiceSurface === 'approach' && isIntroduction(action) &&
    action.sourceVerified === true && Number(action.confidence) >= 0.6 &&
    sourceInterval(action.startTime, action.endTime) && openingCast(action) &&
    !verifiedPositionSceneIds.has(sceneIdFor(action)))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  for (const action of orphanApproaches) {
    const previous = standaloneOpenings.at(-1);
    const last = previous?.at(-1);
    const gap = Number(action.startTime) - Number(last?.endTime);
    const interveningBreak = last && actions.some(item => item.sourceVerified === true &&
      Number(item.startTime) >= Number(last.endTime) - 0.05 &&
      Number(item.endTime) <= Number(action.startTime) + 0.05 &&
      ['scene_transition', 'partner_transition', 'outcome', 'aftermath'].includes(
        String(item.actionType || '').toLowerCase()));
    if (!last || openingCast(last) !== openingCast(action) || gap > 45 ||
        gap < -0.15 || interveningBreak) standaloneOpenings.push([action]);
    else previous.push(action);
  }
  for (const group of standaloneOpenings) {
    const first = group[0], last = group.at(-1);
    const id = `verified-opening:${String(first.actionId || Math.round(first.startTime * 1000))}`;
    const cast = openingCast(first);
    const members = [...group, ...actions.filter(action =>
      action.sourceVerified === true && action.choiceSurface === 'story' &&
      openingCast(action) === cast &&
      Number(action.startTime) >= Number(first.startTime) - 0.05 &&
      Number(action.endTime) <= Number(last.endTime) + 0.05 &&
      !verifiedPositionSceneIds.has(sceneIdFor(action)) &&
      !introductions.has(action))];
    for (const action of members) {
      sceneOccurrenceByAction.set(action, id);
      traceByAction.get(action).membershipReason = 'VERIFIED_STANDALONE_OPENING';
    }
    verifiedPositionSceneIds.add(id);
  }

  actions.filter(action =>
    verifiedPositionSceneIds.has(sceneIdFor(action))
  ).forEach((action, index) => {
    const sceneId = sceneIdFor(action);
    const traceRow = traceByAction.get(action);
    traceRow.finalSceneId = sceneId;
    if (traceRow.membershipReason === 'NOT_ASSIGNED') traceRow.membershipReason = traceRow.sceneCandidate
      ? 'VERIFIED_POSITION_ANCHOR' : 'EXISTING_SCENE_OCCURRENCE';
    const observedSource = sourceInterval(action.startTime, action.endTime);
    if (!observedSource || action.sourceVerified !== true) {
      traceRow.route = 'REJECTED';
      traceRow.routeReason = !observedSource ? 'INVALID_SOURCE_INTERVAL' : 'SOURCE_NOT_VERIFIED';
      return;
    }

    if (!sceneMap.has(sceneId)) {
      sceneMap.set(sceneId, {
        id: sceneId,
        sourceSceneIds: [sceneId],
        title: action.storyEvidenceLevel === 'fact' && action.storyEvidence && action.sceneTitle
          ? String(action.sceneTitle).trim() : 'Etkileşimli Sahne',
        startTime: Number(action.adultSceneStartTime ?? action.startTime),
        endTime: Number(action.adultSceneEndTime ?? action.endTime),
        postSceneTime: Number(action.postSceneTime ?? action.adultSceneEndTime ?? action.endTime),
        foreplay: [],
        dialogue: [],
        partnerTransitions: [],
        positions: new Map(),
        outcomes: [],
        aftermath: null
      });
    }

    const scene = sceneMap.get(sceneId);
    if (scene.title === 'Etkileşimli Sahne' && action.storyEvidenceLevel === 'fact' &&
        action.storyEvidence && action.sceneTitle) scene.title = String(action.sceneTitle).trim();
    scene.startTime = Math.min(scene.startTime, Number(action.adultSceneStartTime ?? action.startTime));
    scene.endTime = Math.max(scene.endTime, Number(action.adultSceneEndTime ?? action.endTime));
    scene.postSceneTime = Math.max(
      Number(scene.postSceneTime) || 0,
      Number(action.postSceneTime ?? action.adultSceneEndTime ?? action.endTime) || 0
    );

    const outcomeType = String(action.outcomeType || 'none').toLowerCase();
    const isOutcome = outcomeType === 'climax' || action.actionType === 'outcome';
    const isAftermath = outcomeType === 'aftermath' || action.actionType === 'aftermath';

    if (isOutcome || isAftermath) {
      traceRow.route = isAftermath ? 'AFTERMATH' : 'OUTCOME';
      traceRow.routeReason = 'ACTION_OUTCOME_TYPE';
      const startTime = Number(action.outcomeStartTime ?? action.startTime);
      const endTime = Number(action.outcomeEndTime ?? action.endTime);

      if (sourceInterval(startTime, endTime) && startTime >= observedSource.startTime &&
          endTime <= observedSource.endTime && endTime - startTime >= 2) {
        if (isAftermath) {
          if (!scene.aftermath || startTime < scene.aftermath.startTime) {
            scene.aftermath = {
              id: action.actionId || `${sceneId}:aftermath`,
              label: action.outcomeLabel || action.label || 'Sahne sonrası',
              sourceVerified: true,
              startTime,
              endTime
            };
          }
        } else {
          scene.outcomes.push({
            id: action.actionId || `${sceneId}:outcome-${index}`,
            label: action.outcomeLabel || action.label || `Final ${scene.outcomes.length + 1}`,
            sourceVerified: true,
            partnerTrackId: String(action.partnerTrackId || '').trim(),
            startTime,
            endTime,
            unlockProgress: normalizeOutcomeUnlockProgress(action.outcomeUnlockProgress)
          });
        }
      }
      return;
    }

    // Some analysis providers correctly identify the visible position in the
    // verified label but omit the optional positionId/positionLabel fields.
    // Treat that evidence as a real position so it stays in this panel.
    const hasPositionEvidence = Boolean(playableAdultPanelFamily(action));
    if (!hasPositionEvidence) {
      const actionType = String(action.actionType || '').toLowerCase();
      if (actionType === 'partner_transition') {
        const transition = verifiedPartnerTransition(action);
        if (transition) {
          traceRow.route = 'PARTNER_TRANSITION';
          traceRow.routeReason = 'VERIFIED_PARTNER_IDENTITY_CHANGE';
          scene.partnerTransitions.push(transition);
        } else {
          traceRow.route = 'REJECTED';
          traceRow.routeReason = 'UNVERIFIED_OR_INCOMPLETE_PARTNER_TRANSITION';
        }
        return;
      }
      const sourceDialogue = action.choiceSurface === 'story';
      const explicitWarmup = action.choiceSurface === 'approach';
      // A provider's scene envelope is container metadata, not evidence that
      // can erase an observed action already assigned by the routing guards.
      const startTime = Number(action.startTime);
      const endTime = Number(action.endTime);

      if (
        action.sourceVerified === true &&
        (explicitWarmup || sourceDialogue) &&
        action.label &&
        Number.isFinite(startTime) &&
        Number.isFinite(endTime) &&
        endTime - startTime >= 2
      ) {
        traceRow.route = sourceDialogue
          ? (actionType === 'body_transition' ? 'STORY_TRANSITION' : 'DIALOGUE') : 'FOREPLAY';
        traceRow.routeReason = sourceDialogue ? 'INDEPENDENT_STORY_CATEGORY' : 'VERIFIED_APPROACH_CATEGORY';
        (sourceDialogue ? scene.dialogue : scene.foreplay).push({
          id: action.actionId || `${sceneId}:warmup-${index}`,
          label: sourceIdentityLabel(action.narrativeChoiceLabel || action.label,
            { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel }),
          sourceVerified: true,
          sourceActionId: String(action.sourceActionId || action.actionId || '').trim(),
          actionType: String(action.actionType || '').trim(),
          choiceSurface: action.choiceSurface,
          routeNamespace: activityOccurrenceNamespace(action),
          nonIntimate: sourceDialogue,
          subjectTrackId: String(action.subjectTrackId || '').trim(),
          partnerTrackId: String(action.partnerTrackId || '').trim(),
          startTime,
          endTime,
          maleProgressRate: Number(action.maleProgressRate || 1),
          femaleProgressRate: Number(action.femaleProgressRate || 1)
        });
      }
      if (traceRow.route === 'NOT_ROUTED') {
        traceRow.route = 'REJECTED';
        traceRow.routeReason = 'NO_POSITION_EVIDENCE_AND_NOT_VALID_WARMUP';
      }
      return;
    }

    const canonical = canonicalAdultPosition(action);
    if (!canonical.id) {
      traceRow.route = 'REJECTED';
      traceRow.routeReason = 'CANONICAL_POSITION_RESOLUTION_FAILED';
      return;
    }

    // Canonical oral/manual intervals now enter the same verified position
    // graph as every other source-backed activity. Their progressionRole is
    // assigned after occurrences are built: opening occurrences stay in the
    // approach phase, while later occurrences remain available in the core
    // panel instead of being dropped into FOREPLAY unconditionally.

    const correctedStart = canonical.correctedFromAction
      ? Number(action.startTime)
      : Number(action.positionStartTime ?? action.startTime);
    const correctedEnd = canonical.correctedFromAction
      ? Number(action.endTime)
      : Number(action.positionEndTime ?? action.endTime);

    const displayPositionLabel = adultPositionFamily(canonical.id) ? canonical.label
      : (canonical.correctedFromAction ? '' : String(action.positionLabel || '').trim());
    const category = adultCategoryFor(action, canonical.id);
    const occurrenceId = String(
      action.positionOccurrenceId ||
      `${sceneId}:${canonical.id}:legacy-${Math.round((correctedStart || 0) * 1000)}`
    );
    const routeNamespace = activityOccurrenceNamespace(action);
    const partnerTrackId = String(action.partnerTrackId || '').trim();
    const partnerNamespace = partnerTrackId || 'partner-unknown';
    const subjectTrackId = String(action.subjectTrackId || '').trim();
    const positionKey = `${category.id}:${canonical.id}:${routeNamespace}:${subjectTrackId || 'actor-unknown'}:${partnerNamespace}:${occurrenceId}`;
    traceRow.route = 'POSITION';
    traceRow.routeReason = canonical.correctedFromAction
      ? 'LABEL_FAMILY_OVERRULED_INCONSISTENT_POSITION_METADATA'
      : 'CANONICAL_POSITION_ACCEPTED';
    traceRow.canonicalFamily = canonical.id;
    traceRow.canonicalLabel = canonical.label;
    traceRow.occurrenceId = occurrenceId;
    traceRow.routeNamespace = routeNamespace;
    traceRow.finalPositionKey = positionKey;

    if (!scene.positions.has(positionKey)) {
      scene.positions.set(positionKey, {
        id: positionKey,
        sourceVerified: action.sourceVerified === true,
        familyId: canonical.id,
        occurrenceId,
        groupScene: action.groupScene === true,
        adultParticipantCount: Number(action.adultParticipantCount || 0),
        participantTrackIds: [...(action.participantTrackIds || [])],
        partnerTrackId,
        subjectTrackId,
        partnerLabel: String(action.partnerLabel || '').trim(),
        partnerEvidence: String(action.partnerEvidence || '').trim(),
        receiverBodyOrientation: String(action.receiverBodyOrientation || 'unclear'),
        receiverSupport: String(action.receiverSupport || 'unclear'),
        positionConfigurationConfidence: Number(action.positionConfigurationConfidence || 0),
        positionEvidence: String(action.positionEvidence || ''),
        activityType: routeNamespace,
        routeNamespace,
        activityTypeConfidence: Number(action.activityTypeConfidence || 0),
        positionLabel: displayPositionLabel,
        label: sourceDisplayLabel({ ...action, positionLabel: displayPositionLabel },
          sourceIdentityLabel(canonical.label,
            { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel })),
        categoryId: category.id,
        categoryLabel: category.label,
        startTime: correctedStart,
        endTime: correctedEnd,
        unlockProgress: 0,
        sourceRanges: [],
        movements: []
      });
    }

    const position = scene.positions.get(positionKey);
    position.startTime = Math.min(
      position.startTime,
      correctedStart
    );
    position.endTime = Math.max(
      position.endTime,
      correctedEnd
    );

    if (action.label || action.movementType) {
      const movementStart = Number(action.loopStartTime ?? action.startTime);
      const movementEnd = Number(action.loopEndTime ?? action.endTime);
      const validMovementRange = sourceInterval(movementStart, movementEnd) &&
        movementStart >= observedSource.startTime && movementEnd <= observedSource.endTime &&
        movementStart >= position.startTime && movementEnd <= position.endTime;
      if (action.sourceVerified === true && validMovementRange && movementBelongsToVerifiedPosition(action, canonical.id)) {
        position.sourceVerified = true;
        traceRow.movementAccepted = true;
        traceRow.movementReason = 'MOVEMENT_MATCHES_CANONICAL_POSITION';
        position.sourceRanges.push({
          id: position.id,
          sourceVerified: action.sourceVerified === true,
          startTime: movementStart,
          endTime: movementEnd
        });
        position.movements.push({
          ...action,
          id: action.actionId || `movement-${index}`,
          sourceActionId: String(action.sourceActionId || action.actionId || '').trim(),
          sourcePositionId: position.id,
          label: sourceIdentityLabel(action.narrativeChoiceLabel || action.label,
            { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel }),
          loopStartTime: movementStart,
          loopEndTime: movementEnd
        });
      } else {
        traceRow.movementReason = !validMovementRange ? 'REJECTED_INVALID_SOURCE_INTERVAL' : 'REJECTED_MOVEMENT_POSITION_CONFLICT';
      }
    } else {
      traceRow.movementReason = 'NO_MOVEMENT_LABEL_OR_TYPE';
    }
  });

  state.adultScenes = [...sceneMap.values()]
    .map(scene => {
      const foreplay = [...scene.foreplay].sort((a, b) => a.startTime - b.startTime);

      const outcomes = [...scene.outcomes]
        .filter(item => item.endTime - item.startTime >= 2)
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((items, item) => {
          const previous = items[items.length - 1];
          const sameLabel = previous &&
            normalizeAdultLabel(previous.label) === normalizeAdultLabel(item.label);
          if (previous && sameLabel && item.sourceVerified === true && previous.sourceVerified === true &&
              item.startTime <= previous.endTime + 1e-7 &&
              String(item.partnerTrackId || '') === String(previous.partnerTrackId || '')) {
            previous.startTime = Math.min(previous.startTime, item.startTime);
            previous.endTime = Math.max(previous.endTime, item.endTime);
            return items;
          }
          items.push({ ...item });
          return items;
        }, []);

      const positions = [...scene.positions.values()]
          .map(position => {
            const movements = expandVerifiedMovementVariants(
              position.movements,
              position.startTime,
              position.endTime,
              {
                baseLabel: position.label,
                minSeconds: 3,
                maxVariants: 24,
                splitEachMovement: true
              }
            );
            // An empty or conflicting analysis is not evidence for the whole
            // parent interval. Keep it unavailable instead of fabricating a clip.
            const observedRanges = position.sourceRanges.filter(range => range.sourceVerified === true &&
              sourceInterval(range.startTime, range.endTime));
            return { ...position, movements,
              startTime: observedRanges.length ? Math.min(...observedRanges.map(range => range.startTime)) : NaN,
              endTime: observedRanges.length ? Math.max(...observedRanges.map(range => range.endTime)) : NaN };
          })
          .filter(position => position.movements.length &&
            isPlayableVerifiedPositionDuration(position.startTime, position.endTime))
          .sort((a, b) => a.startTime - b.startTime);
      if (!positions.length) {
        const verifiedForeplay = foreplay.filter(item =>
          item.sourceVerified === true && sourceInterval(item.startTime, item.endTime));
        if (!verifiedForeplay.length) return { ...scene, foreplay: [], outcomes, positions: [] };
        const interactionStart = Math.min(...verifiedForeplay.map(item => Number(item.startTime)));
        const interactionEnd = Math.max(
          ...verifiedForeplay.map(item => Number(item.endTime)),
          ...outcomes.map(item => Number(item.endTime)),
          Number(scene.aftermath?.endTime) || 0
        );
        return {
          ...scene,
          startTime: interactionStart,
          endTime: interactionEnd,
          postSceneTime: Math.max(Number(scene.postSceneTime) || 0, interactionEnd),
          foreplay: verifiedForeplay,
          partnerTransitions: (scene.partnerTransitions || [])
            .filter(item => Number(item.startTime) >= interactionStart - 0.05 &&
              Number(item.endTime) <= interactionEnd + 0.05)
            .sort((a, b) => Number(a.startTime) - Number(b.startTime)),
          outcomes: outcomes.filter(item => Number(item.startTime) >= interactionStart - 0.05),
          positions: []
        };
      }
      const positionStart = Math.min(...positions.map(position => Number(position.startTime)));
      const interactionEnd = Math.max(...positions.map(position => Number(position.endTime)));
      // The Lust warm-up panel is only for source actions that occur before
      // the first verified position. A later partner switch must never be
      // offered as the first choice and seek the player hundreds of seconds
      // forward in the source timeline.
      const playableForeplay = foreplay.filter(item =>
        item.sourceVerified === true && sourceInterval(item.startTime, item.endTime) &&
        (item.endTime <= positionStart + 0.05 || item.startTime >= positionStart - 0.05));
      // The scene keeps its dialogue as story metadata, but its playable
      // boundary begins at the first verified approach or position only.
      const openingForeplay = initialWarmupBeforeFirstPosition(playableForeplay, positions);
      const interactionStart = openingForeplay.length
        ? Math.min(positionStart, ...openingForeplay.map(item => Number(item.startTime)))
        : positionStart;
      return {
        ...scene,
        // Verified approach choices are part of the same playable occurrence;
        // their exact source times must not be clamped to the first position.
        startTime: interactionStart,
        endTime: Math.max(interactionEnd,
          ...playableForeplay.map(item => Number(item.endTime)),
          ...outcomes.map(item => Number(item.endTime)),
          Number(scene.aftermath?.endTime) || 0),
        postSceneTime: Math.max(Number(scene.postSceneTime) || 0, interactionEnd),
        foreplay: playableForeplay,
        partnerTransitions: (scene.partnerTransitions || [])
          .filter(item => Number(item.startTime) >= positionStart - 0.05 && Number(item.endTime) <= interactionEnd + 0.05)
          .sort((a, b) => Number(a.startTime) - Number(b.startTime)),
        outcomes: outcomes.filter(item => Number(item.startTime) >= interactionStart - 0.05),
        positions
      };
    })
    .filter(scene => scene.positions.length || scene.foreplay.length)
    .sort((a, b) => a.startTime - b.startTime);

  // Providers frequently split one continuous encounter into several scene
  // ids. Merge nearby fragments unless a verified narrative barrier exists;
  // otherwise early oral/manual clips become isolated panels and skipping one
  // incorrectly reveals every later position.
  state.adultScenes = mergeAdultSceneFragments(
    state.adultScenes,
    actions,
    state.analysis?.unownedSourceIntervals || []
  ).filter(scene => scene.positions?.length || scene.foreplay?.length);

  state.adultScenes.forEach(scene => {
    scene.positions = consolidateVerifiedPositions(scene.positions, {
      mergeDistantReturns: false
    });
    // Stage ownership comes from observed motion and temporal evidence,
    // not from treating the first pose change as the first core position.
    // The same rule applies to every video and to all providers.
    scene.positions = assignVerifiedOpeningRoles(scene.positions);
    const firstCoreStart = scene.positions
      .filter(position => !isWarmupPosition(position))
      .reduce((earliest, position) => Math.min(earliest, Number(position.startTime)), Number.POSITIVE_INFINITY);
    // Merging source fragments must not move a later introduction into the
    // first-entry gate of this encounter. Oral/manual are opening activities,
    // not sex-position tabs, so they remain available as approach choices.
    scene.foreplay = scene.foreplay.filter(item => !Number.isFinite(firstCoreStart) ||
      Number(item.endTime) <= firstCoreStart + 0.05 ||
      Number(item.startTime) >= firstCoreStart - 0.05);
    // Each separated source occurrence has its own chronological unlock.
    // Collapsing distant same-family returns into one tab let the next Lust
    // unlock jump past an intervening chapter without a new position card.
    scene.positions = consolidateVerifiedPositions(scene.positions, {
      mergeDistantReturns: false
    }).map(position => {
      const controlClipIds = isWarmupPosition(position) ? new Set() : exclusiveControlClipIds(position);
      const occurrences = positionOccurrenceGroups(position);
      const firstOccurrence = occurrences[0];
      const firstRange = firstOccurrence?.sourceRanges[0];
      const transition = firstRange && [...scene.foreplay, ...scene.dialogue].filter(item =>
        item.sourceVerified === true && item.nonIntimate !== true && item.sourceActionId &&
        ['body_transition', 'position_transition', 'transition'].includes(String(item.actionType || '').toLowerCase()) &&
        sourceInterval(item.startTime, item.endTime) &&
        item.endTime <= firstRange.startTime && firstRange.startTime - item.endTime <= 0.25 &&
        String(item.subjectTrackId || '') === String(position.subjectTrackId || '') &&
        String(item.partnerTrackId || '') === String(position.partnerTrackId || '') &&
        position.subjectTrackId && position.partnerTrackId)
        .sort((a, b) => b.endTime - a.endTime)[0];
      let linkedEntry = {};
      if (transition) {
        const entryRange = { id: transition.id, startTime: transition.startTime, endTime: transition.endTime,
          sourceVerified: true, sourceActionId: transition.sourceActionId,
          subjectTrackId: transition.subjectTrackId, partnerTrackId: transition.partnerTrackId,
          routeNamespace: position.routeNamespace,
          coreOccurrenceId: firstOccurrence.id, entryForGroupId: position.id };
        const entryClip = { ...transition, sourcePositionId: entryRange.id, sourceOccurrenceId: entryRange.id,
          routeNamespace: position.routeNamespace,
          loopStartTime: entryRange.startTime, loopEndTime: entryRange.endTime, entryOnly: true };
        const sourceRanges = occurrences.flatMap(occurrence => occurrence.sourceRanges.map(range =>
          ({ ...range, occurrenceId: occurrence.id })));
        if (interactionEntryGuard({ ...position, sourceRanges, entryRange }, entryClip).allowed)
          linkedEntry = { entryRange, entryClip };
      }
      return {
        ...position,
        ...linkedEntry,
        controlClipIds: [...controlClipIds],
        movementChoices: splitSparseMovementChoiceCards(buildVerifiedMovementChoices(
          position.movements,
          position.label,
          8,
          position
        ), 8)
      };
    });

    const hasWarmup = scene.foreplay.length > 0 || scene.positions.some(isWarmupPosition);
    let coreIndex = 0;
    let bonusIndex = 0;

    scene.positions.forEach((position, index) => {
      const isWarmup = isWarmupPosition(position);
      const isBonus = isBonusPosition(position);
      const order = isWarmup ? 0 : (isBonus ? bonusIndex++ : coreIndex++);
      position.unlockProgress = positionUnlockProgress({
        categoryId: position.categoryId,
        familyId: position.familyId,
        index: order,
        bootstrap: !hasWarmup && index === 0
      });
    });
  });

  const graph = summarizeAdultSceneGraph(state.adultScenes);
  state.adultAnalysisTrace.graph = graph;
  const acceptedApproachIds = new Set(state.adultScenes.flatMap(scene =>
    [...scene.foreplay, ...scene.dialogue])
    .map(item => item.sourceActionId || item.id));
  const rejectedApproaches = actions.filter(action => action.sourceVerified === true && isIntroduction(action) &&
    !acceptedApproachIds.has(String(action.sourceActionId || action.actionId || ''))).map(action => {
    const row = traceByAction.get(action);
    if (row.membershipReason === 'NOT_ASSIGNED') row.membershipReason = 'NO_VERIFIED_SCENE_MEMBERSHIP';
    return { code: 'VERIFIED_APPROACH_REJECTED', actionId: row.actionId,
      membershipReason: row.membershipReason, routeReason: row.routeReason,
      sourceStartTime: row.sourceStartTime, sourceEndTime: row.sourceEndTime };
  });
  state.adultAnalysisTrace.warnings = [
    ...state.adultAnalysisTrace.warnings,
    ...rejectedApproaches,
    ...(!state.analysis?.storyContext?.characters?.length
      ? [{ code: 'CHARACTER_CONTEXT_MISSING', message: 'Analiz karakter haritası üretmedi; ilişkiler doğrulanamıyor.' }] : []),
    ...(state.adultAnalysisTrace.audioContext.status === 'unavailable'
      ? [{ code: 'AUDIO_CONTEXT_UNAVAILABLE', message: 'Karakter eşleştirmesi için konuşma verisi bulunmuyor.' }] : []),
    ...graph.duplicateFamilies.map(item => ({
      code: 'DUPLICATE_POSITION_FAMILY_TABS',
      message: `${item.familyId} aynı sahnede ${item.tabCount} ayrı sekmeye bölündü.`,
      ...item
    })),
    ...graph.scenes.flatMap(scene => scene.positions
      .filter(position => position.movementChoiceCount <= 1)
      .map(position => ({
        code: 'SPARSE_MOVEMENT_CHOICES',
        message: `${position.label || position.familyId} için ${position.movementCount} hareketten ${position.movementChoiceCount} kart üretildi.`,
        sceneId: scene.id,
        positionId: position.id,
        movementCount: position.movementCount,
        movementChoiceCount: position.movementChoiceCount
      })))
  ];
  renderAdultAnalysisTrace();
}

function adultAnalysisTraceText() {
  const report = state.adultAnalysisTrace ? {
    ...state.adultAnalysisTrace,
    interaction: genericInteractionTrace(),
    audioContext: {
      ...state.adultAnalysisTrace.audioContext,
      ...turkishMediaDebugReport(),
      events: state.engineEvents.filter(event => event.type === 'TURKISH_MEDIA_STATUS').slice(-100)
    }
  } : null;
  return JSON.stringify(report || {
    reportVersion: 1,
    error: 'Henüz tamamlanmış bir analiz raporu yok.'
  }, null, 2);
}

function renderAdultAnalysisTrace() {
  const ready = Boolean(state.adultAnalysisTrace?.graph);
  if (els.adultTraceToggleBtn) els.adultTraceToggleBtn.disabled = !ready;
  if (els.adultTraceDownloadBtn) els.adultTraceDownloadBtn.disabled = !ready;
  if (els.adultTraceOutput && !els.adultTraceOutput.classList.contains('hidden')) {
    els.adultTraceOutput.textContent = adultAnalysisTraceText();
  }
}

function downloadAdultAnalysisTrace() {
  if (!state.adultAnalysisTrace?.graph) return;
  const blob = new Blob([adultAnalysisTraceText()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `videoquest-sex-analysis-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function genericInteractionTrace() {
  const runtime = state.gameplayPlayer?.getState();
  return runtime ? { version: runtime.version, chapterId: runtime.chapterId,
    stageId: runtime.stageId, surface: activeSurface(runtime), progression: progression(runtime),
    availableChoiceIds: availableChoices(runtime).map(choice => choice.id) } : null;
}

function renderChoices() {
  state.gameplayPlayer?.render();
}

function cancelTimelineNavigation() {
  state.navigationSeekController?.abort();
  state.navigationSeekController = null;
  state.navigationSeeking = false;
}

function cancelAdultSeek() {
  state.adultSeekController?.abort();
  state.adultSeekController = null;
  state.adultLoopSeeking = false;
}

function clearInteractionSelection() {
  state.gameplayPlayer?.destroy();
  state.gameplayPlayer = null;
}

function setAdultPanelExpanded(expanded) {
  els.adultInteractionPanel?.classList.toggle('compact-expanded', Boolean(expanded));
}

function syncAdultPanelPlacement(stage = els.video?.closest('.video-stage')) {
  mountInteractionPanel(stage, els.adultInteractionPanel);
}

function jumpChoice(direction) {
  const runtime = state.gameplayPlayer?.getState();
  if (!runtime) return;
  const index = runtime.graph.chapters.findIndex(chapter => chapter.id === runtime.chapterId);
  const next = runtime.graph.chapters[Math.max(0, Math.min(runtime.graph.chapters.length - 1, index + direction))];
  if (next) void state.gameplayPlayer.navigate(next.startTime, { rewind: direction < 0 });
}

function renderTimeline() {
  els.timelineList.replaceChildren();
  for (const action of state.analysis.actions) {
    const div = document.createElement('div');
    div.className = 'timeline-item';
    div.textContent = `${storyChoiceLabelForAction(action)} · ${action.startTime.toFixed(1)}–${action.endTime.toFixed(1)} sn`;
    els.timelineList.appendChild(div);
  }
}

function waitForEvent(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    const onEvent = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(event, onEvent); };
    target.addEventListener(event, onEvent, { once: true });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.getElementById(`${target}Panel`).classList.add('active');
  });
});

els.prevChoiceBtn?.addEventListener('click', () => jumpChoice(-1));
els.nextChoiceBtn?.addEventListener('click', () => jumpChoice(1));
els.adultTraceToggleBtn?.addEventListener('click', () => {
  if (!state.adultAnalysisTrace?.graph) return;
  const opening = els.adultTraceOutput.classList.contains('hidden');
  els.adultTraceOutput.classList.toggle('hidden', !opening);
  els.adultTraceToggleBtn.textContent = opening ? 'RAPORU GİZLE' : 'SEKS ANALİZ RAPORU';
  if (opening) els.adultTraceOutput.textContent = adultAnalysisTraceText();
});
els.adultTraceDownloadBtn?.addEventListener('click', downloadAdultAnalysisTrace);

// The gameplay player owns seek, pause, boundary and end events. The media
// client retains its independent subtitle/dub synchronization listeners.
els.video.addEventListener('timeupdate', renderDebug);

checkHealth();
checkTurkishMediaCapabilities();
setInterval(checkTurkishMediaCapabilities, 60 * 1000);
renderDebug();

function clearPreviousGameResidue() {
  mediaClient.reset();
  state.mediaRevoice = null;
  state.voiceMappingGeneration = (Number(state.voiceMappingGeneration) || 0) + 1;
  state.voiceCatalogPromise = null;
  els.voiceMappingRows?.replaceChildren?.();
  if (els.voiceMappingPanel) els.voiceMappingPanel.open = false;
  state.activeSavedGameId = null;
  state.savedGameReady = false;
  state.savedPlaybackOnly = false;
  savedGames?.resetCurrent();
  state.remoteFileDownload?.controller.abort();
  state.remoteFileDownload = null;
  cancelTimelineNavigation();
  cancelAdultSeek();
  clearInteractionSelection();
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  for (const storageName of ['localStorage', 'sessionStorage']) {
    for (const key of ['videoquest:last-analysis', 'videoquest:last-dialogue', RUNTIME_SAVE_KEY]) {
      removeStoredValue(storageName, key);
    }
  }
  state.analysis = null;
  state.sourceTranscript = null;
  state.sourceContext = null;
  state.turkishMediaStatus = null;
  state.selectedRemoteToken = '';
  state.urlCacheKey = '';
  state.urlCacheSavePromise = null;
  state.languageSyncOffset = 0;
  state.dubbingEnabled = false;
  state.subtitlesEnabled = false;
  state.analysisFingerprint = '';
  state.integrityReport = null;
  state.consumedActionIds = new Set();
  state.currentActionIndex = -1;
  state.gameCursorTime = 0;
  state.adultScenes = [];
  state.completedAdultSceneIds = new Set();
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultRevealedPositionIds = new Set();
  state.adultUnlockedOutcomeIds = new Set();
  state.adultMode = false;
  state.adultScene = null;
  state.activeAction = null;
  state.activePositionId = null;
  state.activeMovementId = null;
  state.engineEvents = [];
  els.choices.innerHTML = '';
  els.timelineList.innerHTML = '';
  els.videoPrompt.textContent = '';
  els.adultInteractionPanel?.classList.add('hidden');
  els.playerSection?.classList.add('hidden');
  els.analysisCard?.classList.add('hidden');
  els.subtitleOverlay?.classList.add('hidden');
  els.dubBufferStatus?.classList.add('hidden');
  els.dubToggleBtn?.classList.add('hidden');
  if (els.video) {
    releaseVideoObjectUrl();
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  void videoDownloads.release(state.selectedFile);
  if (state.analysisSession?.file !== state.selectedFile) void videoDownloads.release(state.analysisSession?.file);
  renderMediaControls();
  els.mediaJobStatus?.classList.add('hidden');
  setGameState('IDLE');
}

clearPreviousGameResidue();


// FULLSCREEN GAME MODE
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenStage = document.querySelector('.video-stage');

attachTactileSurface({ root: els.adultInteractionPanel, engine: tactile });
els.adultFeelToggle?.addEventListener('click', () => { tactile.toggle(); renderTactileToggle(); });
renderTactileToggle();
for (const button of [els.adultPanelToggleBtn, els.adultDockMoreBtn]) {
  button?.addEventListener('click', () => setAdultPanelExpanded(!els.adultInteractionPanel?.classList.contains('compact-expanded')));
}

fullscreenBtn?.addEventListener('click', () => {
  void toggleFullscreen({ document, stage: fullscreenStage, screen,
    status: document.getElementById('fullscreenStatus') });
});

function keepGameVideoControlsHidden() {
  if (!els.video) return;
  els.video.controls = false;
  els.video.removeAttribute('controls');
}

keepGameVideoControlsHidden();

function updateFullscreenButton() {
  if (!fullscreenBtn) return;
  const active = document.fullscreenElement === fullscreenStage || document.webkitFullscreenElement === fullscreenStage;
  const label = active ? 'Tam ekrandan çık' : 'Tam ekranı aç';
  fullscreenBtn.setAttribute('aria-label', label);
  fullscreenBtn.setAttribute('title', label);
  fullscreenBtn.setAttribute('aria-pressed', String(active));
}

updateFullscreenButton();

function syncFullscreenInteraction() {
  keepGameVideoControlsHidden();
  syncAdultPanelPlacement(fullscreenStage);
  renderChoices();
  if (state.activeInteractionSurface === 'panel') revealFullscreenChoices({ document, stage: fullscreenStage,
    panel: els.adultInteractionPanel, expand: () => setAdultPanelExpanded(true) });
  updateFullscreenButton();
}

document.addEventListener('fullscreenchange', syncFullscreenInteraction);
document.addEventListener('webkitfullscreenchange', syncFullscreenInteraction);


// VIDEO URL IMPORT
const videoUrlInput = document.getElementById('videoUrl');
const resolveUrlBtn = document.getElementById('resolveUrlBtn');
const urlStatus = document.getElementById('urlStatus');

function setUrlStatus(message, type = '') {
  if (!urlStatus) return;
  urlStatus.textContent = message;
  urlStatus.className = `url-status ${type}`.trim();
}

function hideBrowserDownloadHelp() {
  document.getElementById('browserDownloadHelp')?.classList.add('hidden');
  for (const id of ['browserVideoLink', 'browserPageLink']) document.getElementById(id)?.removeAttribute('href');
}

function showBrowserDownloadHelp(sourceUrl, pageUrl) {
  const panel = document.getElementById('browserDownloadHelp');
  if (!panel) return;
  for (const [id, value] of [['browserVideoLink', sourceUrl], ['browserPageLink', pageUrl]]) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.removeAttribute('href');
    let valid = false;
    try {
      const url = new URL(value);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        link.href = url.href;
        valid = true;
      }
    } catch {}
    link.classList.toggle('hidden', !valid);
  }
  panel.classList.remove('hidden');
}

document.getElementById('chooseDownloadedVideoBtn')?.addEventListener('click', () => {
  if (!state.analysisInProgress && !state.urlResolutionInProgress && !state.savedGameBusy) els.videoInput.click();
});

async function downloadUrlVideo(proxyUrl, sourceUrl, options = {}) {
  const startedAt = performance.now();
  return videoDownloads.download(proxyUrl, {
    parallel: options.parallel !== false,
    ...options,
    directUrl: options.allowDirect === false ? '' : sourceUrl,
    directOnly: false,
    onProgress: options.onProgress || (({ loaded, total, transport, connections }) => {
      const elapsed = Math.max(0.1, (performance.now() - startedAt) / 1000);
      const totalText = total ? ` / ${(total / 1024 / 1024).toFixed(1)}` : '';
      const route = transport === 'direct' ? 'Doğrudan kaynaktan' : 'Sunucu üzerinden';
      setUrlStatus(`${route} indiriliyor: ${(loaded / 1024 / 1024).toFixed(1)}${totalText} MB · ${(loaded / 1024 / 1024 / elapsed).toFixed(2)} MB/sn${connections > 1 ? ` · ${connections} paralel bağlantı` : ''}`);
    })
  });
}

function remoteVideoFileName(sourceUrl, contentType = '') {
  const sourcePath = new URL(sourceUrl).pathname;
  let sourceName = sourcePath.split('/').pop() || '';
  try { sourceName = decodeURIComponent(sourceName); } catch {}
  const extension = sourceName.match(/\.(mp4|webm|m4v|mov|ogv|3gp|3g2)$/i)?.[0] ||
    (contentType.includes('webm') ? '.webm' : contentType.includes('ogg') ? '.ogv' : '.mp4');
  if (!sourceName) return `url-video${extension}`;
  if (/\.(?:mpd|m3u8)$/i.test(sourceName)) return sourceName.replace(/\.[^.]+$/, '.mp4');
  return /\.(mp4|webm|m4v|mov|ogv|3gp|3g2)$/i.test(sourceName) ? sourceName : `${sourceName}${extension}`;
}

async function ensureSelectedRemoteFile({ onProgress } = {}) {
  if (state.selectedFile) return state.selectedFile;
  const remote = state.selectedRemoteVideo;
  if (!remote?.sourceUrl) throw new Error('İndirilecek uzak video kaynağı bulunamadı.');
  if (state.remoteFileDownload?.remote === remote) return state.remoteFileDownload.promise;
  setUrlStatus('Bu analiz modu için video cihaza geçici olarak indiriliyor...');
  const task = { remote, controller: new AbortController(), promise: null };
  task.promise = (async () => {
    const blob = await downloadUrlVideo(remote.proxyUrl, remote.sourceUrl, {
      allowDirect: remote.directDownload === true ||
        (remote.directDownload == null && !['hls', 'dash'].includes(remote.type)),
      signal: task.controller.signal,
      expectedSize: remote.size || 0,
      onProgress: progress => {
        if (remote !== state.selectedRemoteVideo) return;
        if (typeof onProgress === 'function') onProgress(progress);
        else setUrlStatus(`Video hazırlanıyor: ${(progress.loaded / 1024 / 1024).toFixed(1)} MB`);
      }
    });
    try {
      if (remote !== state.selectedRemoteVideo || task.controller.signal.aborted) throw new Error('Video kaynağı değişti. Yeni kaynağı tekrar analiz et.');
      if (!blob.size) throw new Error('Video boş geldi.');
      if (remote.size && blob.size !== remote.size) throw new Error('Video aktarımı eksik veya kaynak boyutu değişti. Bağlantıyı yeniden açıp tekrar dene.');
      const file = new File([blob], remote.fileName, { type: blob.type || remote.contentType || 'video/mp4' });
      videoDownloads.adopt(blob, file);
      state.selectedFile = file;
      state.selectedRemoteVideo = { ...remote, size: blob.size, contentType: file.type };
      els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • Cihazda hazır`;
      return file;
    } finally { await videoDownloads.release(blob); }
  })().finally(() => {
    if (state.remoteFileDownload === task) state.remoteFileDownload = null;
  });
  state.remoteFileDownload = task;
  return task.promise;
}

async function resolveVideoUrl() {
  if (state.urlResolutionInProgress || state.analysisInProgress || state.savedGameBusy) return;
  const pageUrl = videoUrlInput?.value.trim();
  if (!pageUrl) {
    setUrlStatus('Lütfen video sayfasının bağlantısını gir.', 'error');
    return;
  }

  state.urlResolutionInProgress = true;
  resolveUrlBtn.disabled = true;
  els.videoInput.disabled = true;
  if (videoUrlInput) videoUrlInput.disabled = true;
  updateAnalyzeAvailability();
  setUrlStatus('Sayfa inceleniyor, video kaynağı aranıyor... Yavaş sitelerde arama 5 dakika sürebilir.');
  hideBrowserDownloadHelp();
  const resolveStartedAt = performance.now();
  let pendingBlob;
  let resolved;

  try {
    const cached = await urlVideoCache.get(pageUrl).catch(() => null);
    if (cached?.file) {
      const file = cached.file;
      const objectUrl = URL.createObjectURL(file);
      clearPreviousGameResidue();
      state.selectedFile = file;
      state.selectedSourceKind = 'url';
      state.selectedRemoteVideo = null;
      state.selectedRemoteToken = cached.remoteToken || '';
      state.urlCacheKey = pageUrl;
      state.analysisSession = null;
      state.videoObjectUrl = objectUrl;
      els.video.src = objectUrl;
      els.fileMeta.textContent =
        `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • 24 saatlik cihaz önbelleği`;
      updateAnalyzeAvailability();
      renderDebug();
      setUrlStatus('Video cihazdaki 24 saatlik önbellekten açıldı; tekrar indirilmedi.', 'success');
      return;
    }

    const resolveResponse = await fetch('/api/resolve-video-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(360000),
      body: JSON.stringify({ url: pageUrl })
    });

    const result = await resolveResponse.json().catch(() => ({}));
    if (!resolveResponse.ok || !result.ok) {
      const detail = String(result.technicalDetail || '').trim();
      throw new Error(
        (result.message || 'Bu sayfada kullanılabilir video bulunamadı.') +
        (detail ? `\nTeknik neden: ${detail}` : '')
      );
    }

    resolved = result;
    const resolveSeconds = Math.max(0.1, (performance.now() - resolveStartedAt) / 1000).toFixed(1);
    setUrlStatus(`Video ${resolveSeconds} sn içinde bulundu. Cihaza indiriliyor...`);
    const blob = pendingBlob = await downloadUrlVideo(result.proxyUrl, result.sourceUrl, {
      allowDirect: result.directDownload === true
    });

    if (!blob.size) throw new Error('Video boş geldi.');

    const file = new File([blob], remoteVideoFileName(result.sourceUrl, blob.type), { type: blob.type || 'video/mp4' });
    const objectUrl = URL.createObjectURL(file);

    clearPreviousGameResidue();
    videoDownloads.adopt(blob, file);
    pendingBlob = null;
    state.selectedFile = file;
    state.selectedSourceKind = 'url';
    state.selectedRemoteVideo = null;
    state.selectedRemoteToken = String(result.remoteToken || '').trim();
    state.urlCacheKey = pageUrl;
    state.analysisSession = null;
    state.urlCacheSavePromise = urlVideoCache.put(pageUrl, file, {
      remoteToken: state.selectedRemoteToken
    }).catch(error => {
      console.warn('24 saatlik video önbelleği kaydedilemedi:', error);
      return null;
    });
    state.videoObjectUrl = objectUrl;
    els.video.src = state.videoObjectUrl;
    els.fileMeta.textContent =
      `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • URL kaynağı`;
    updateAnalyzeAvailability();
    renderDebug();

    setUrlStatus('Video cihazda hazır ve 24 saatlik önbelleğe alınıyor. Tekrar testte yeniden indirilmeyecek.', 'success');
  } catch (error) {
    setUrlStatus(error?.message || 'Video bağlantısı işlenemedi.', 'error');
    if (resolved && !['VIDEO_SIZE_LIMIT', 'VIDEO_STORAGE_FULL'].includes(error.code)) {
      showBrowserDownloadHelp(resolved.type === 'video' ? resolved.sourceUrl : '', resolved.pageUrl || pageUrl);
    }
  } finally {
    await videoDownloads.release(pendingBlob);
    state.urlResolutionInProgress = false;
    resolveUrlBtn.disabled = false;
    els.videoInput.disabled = false;
    if (videoUrlInput) videoUrlInput.disabled = false;
    updateAnalyzeAvailability();
  }
}

resolveUrlBtn?.addEventListener('click', resolveVideoUrl);
videoUrlInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') resolveVideoUrl();
});

async function captureSavedGame() {
  const video = state.selectedFile || state.analysisSession?.file;
  if (!state.savedGameReady || state.mediaRevoice && state.analysisInProgress || !(video instanceof Blob) || !video.size) return null;
  const turkishMedia = mediaClient.capture();
  const dubAudio = turkishMedia?.manifest.assets?.mix ? await mediaClient.materializeAudio() : null;
  return {
    id: state.activeSavedGameId,
    title: video.name || 'Kayıtlı oyun',
    fileName: video.name || 'video.mp4',
    sourceKind: state.selectedSourceKind,
    duration: Number(els.video.duration) || Number(state.analysis?.videoDuration) ||
      Number(turkishMedia?.manifest.sourceTranscript?.source?.duration),
    video, turkishMedia, dubAudio,
    payload: { analysis: state.analysis, gameplay: state.gameplayPlayer?.capture() || null }
  };
}

async function openSavedGame(game) {
  validateGame(game);
  if (game.dubAudio) {
    const needsEdges = game.turkishMedia?.manifest.qualityReport?.mix?.edgeFadeVersion !== 1;
    const boundaries = needsEdges ? (game.turkishMedia?.manifest.dubSegments || []).flatMap(row =>
      [row.start, row.end, row.originalSpeechStart, row.originalSpeechEnd]) : [];
    const repaired = await repairSavedAudio(game.dubAudio, progress => {
      els.fileMeta.textContent = `Kayıtlı ses onarılıyor… %${Math.round(progress * 100)}`;
    }, boundaries);
    if (repaired !== game.dubAudio) {
      const manifest = structuredClone(game.turkishMedia.manifest);
      manifest.qualityReport ||= {};
      manifest.qualityReport.mix = { ...manifest.qualityReport.mix, edgeFadeVersion: 1 };
      await savedGames.updateDubAudio(game.id, repaired, manifest);
      game = { ...game, dubAudio: repaired, turkishMedia: { ...game.turkishMedia, manifest } };
    }
  }
  if (game.payload.analysis?.schemaVersion > ANALYSIS_SCHEMA_VERSION) {
    throw new Error('Bu kayıt daha yeni bir uygulama sürümüyle oluşturulmuş. Sayfayı yenile.');
  }
  const turkishMedia = game.turkishMedia || null;
  const savedSourceContext = sourceContextAdapter(turkishMedia?.manifest.sourceTranscript);
  if (turkishMedia?.manifest.assets?.mix && !(game.dubAudio instanceof Blob)) {
    throw new Error('Kayıtlı Türkçe ses dosyası eksik; kayıt silinmedi.');
  }
  // Validate media before replacing the current game. No source URL is needed.
  const file = new File([game.video], game.fileName, { type: game.video.type || 'video/mp4' });
  const url = URL.createObjectURL(file);
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        probe.onloadedmetadata = null;
        probe.onerror = null;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('Kayıtlı video açılamadı; kayıt silinmedi.')), 20000);
      probe.onloadedmetadata = () => {
        const difference = Math.abs(probe.duration - game.duration);
        finish(!Number.isFinite(probe.duration) || difference > Math.max(2, game.duration * 0.01)
          ? new Error('Kayıtlı video ile analiz süresi uyuşmuyor; kayıt silinmedi.') : null);
      };
      probe.onerror = () => finish(new Error('Bu tarayıcı kayıtlı videonun biçimini oynatamıyor; kayıt silinmedi.'));
      probe.src = url;
    });
  } catch (error) { URL.revokeObjectURL(url); throw error; }
  finally { probe.removeAttribute('src'); probe.load(); }

  clearPreviousGameResidue();
  state.selectedFile = file;
  state.selectedRemoteVideo = null;
  state.selectedRemoteToken = '';
  state.urlCacheKey = '';
  state.urlCacheSavePromise = null;
  state.selectedSourceKind = game.sourceKind;
  state.analysisSession = null;
  state.videoObjectUrl = url;
  const savedAnalysis = game.payload.analysis;
  if (savedAnalysis) {
    const ownership = partitionProtagonistActions(savedAnalysis.actions || [],
      savedAnalysis.storyContext, savedAnalysis.mainMaleTrackId);
    state.analysis = { ...savedAnalysis, actions: ownership.playable,
      unownedSourceIntervals: mergeUnownedIntervals([...(savedAnalysis.unownedSourceIntervals || []),
        ...ownership.excluded.map(action => ({ startTime: action.startTime, endTime: action.endTime }))]) };
  } else state.analysis = savedAnalysis;
  state.sourceTranscript = turkishMedia?.manifest.sourceTranscript || null;
  state.sourceContext = savedSourceContext;
  state.activeSavedGameId = game.id;
  state.savedGameReady = true;
  state.savedPlaybackOnly = true;
  els.videoInput.value = '';
  videoUrlInput.value = '';
  setUrlStatus('');
  els.video.src = url;
  els.video.load();
  els.fileMeta.textContent = `${game.title} · kayıtlı video · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (turkishMedia) mediaClient.loadResult(turkishMedia.manifest, {
    audioBlob: game.dubAudio, dubEnabled: turkishMedia.dubEnabled,
    subtitlesEnabled: turkishMedia.manifest.outputs?.subtitles ?? Boolean(els.subtitleMode.checked),
    subtitleTrack: turkishMedia.subtitleTrack, syncOffset: 0
  });
  renderMediaControls();
  if (state.analysis) initializeInteractive(state.analysis, game.payload.gameplay);
  else {
    els.playerSection.classList.remove('hidden');
    setGameState('DIALOGUE_READY');
  }
  els.analysisCard.classList.remove('hidden');
  els.analysisState.textContent = 'SAVED_GAME_READY';
  els.analysisTitle.textContent = game.title;
  els.analysisOutput.textContent = 'Kayıtlı video ve analiz açıldı. Yeni analiz veya video indirmesi yapılmadı.';
  renderDebug();
  els.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function repairSavedGame(game, onProgress = () => {}) {
  const savedSourceContext = sourceContextAdapter(game.turkishMedia?.manifest.sourceTranscript);
  const previous = game.payload.analysis;
  const gaps = repairableAnalysisGaps(previous, game.duration);
  if (!gaps.length) throw new Error('Bu kayıtta eksik analiz aralığı yok.');
  const repairs = [];
  for (let index = 0; index < gaps.length; index++) {
    const gap = gaps[index];
    onProgress(`Eksik bölüm ${index + 1}/${gaps.length}: ${gap.startTime.toFixed(1)}–${gap.endTime.toFixed(1)} sn · kareler hazırlanıyor…`);
    const storyboard = await extractStoryboard(game.video, () => {}, undefined, { timeRange: gap });
    const form = new FormData();
    storyboard.sheets.forEach((sheet, sheetIndex) => form.append('storyboards', sheet,
      `repair-${index + 1}-${sheetIndex + 1}.jpg`));
    form.append('duration', String(game.duration));
    form.append('timestamps', JSON.stringify(storyboard.timestamps));
    form.append('motionProfile', JSON.stringify(storyboard.motionProfile));
    form.append('sceneBoundaries', JSON.stringify(storyboard.sceneBoundaries));
    form.append('chunkStart', String(gap.startTime));
    form.append('chunkEnd', String(gap.endTime));
    form.append('chunkIndex', String(index));
    form.append('chunkCount', String(gaps.length));
    form.append('qualityMode', 'ultra');
    form.append('storyContextMemory', JSON.stringify(previous.storyContext || {}));
    form.append('dialogueContext', JSON.stringify((savedSourceContext?.segments || []).filter(item =>
      Number(item.endTime) > gap.startTime && Number(item.startTime) < gap.endTime)));
    form.append('dialogueSpeakerContext', JSON.stringify(savedSourceContext?.speakers || []));
    form.append('sensoryAudioContext', JSON.stringify((savedSourceContext?.nonSpeechEvents || []).filter(item =>
      Number(item.endTime) > gap.startTime && Number(item.startTime) < gap.endTime)));
    onProgress(`Eksik bölüm ${index + 1}/${gaps.length} analiz ediliyor…`);
    const headers = geminiRequestHeaders();
    let result;
    try {
      const response = await fetch('/api/gemini-storyboard-analyze', {
        method: 'POST', headers, body: form,
        signal: AbortSignal.timeout(240000)
      });
      result = await response.json();
      recordAiUsage(result?.aiUsage);
      if (response.ok && result?.available) {
        const corrected = normalizeChunkActionTimes(result.actions, gap.startTime, gap.endTime);
        result = { ...result, actions: corrected.actions };
        const normalized = normalizeAnalysis({ ...result,
          storyContext: mergeStoryContexts([{ storyContext: previous.storyContext }, result]),
          videoDuration: game.duration });
        result.actions = normalized.actions.map((action, actionIndex) => ({
          ...action, actionId: `repair-${Math.round(gap.startTime * 1000)}-${actionIndex + 1}`
        }));
      } else if (result?.reason === 'GEMINI_CREDITS_DEPLETED') {
        throw Object.assign(new Error(result.message || 'Analiz kredisi tükendi; kayıt değiştirilmedi.'),
          { code: 'GEMINI_CREDITS_DEPLETED' });
      }
    } catch (error) {
      if (error?.code === 'GEMINI_CREDITS_DEPLETED') throw error;
      result = { available: false, message: error.message || 'Bağlantı hatası' };
      onProgress(`Bölüm ${index + 1} tamamlanamadı; mevcut analiz korunuyor. Diğer eksik bölümler deneniyor…`);
    }
    repairs.push({ gap, result });
  }
  return mergeRepairedAnalysis(previous, repairs, game.duration);
}

savedGames = mountSavedGames({
  root: $('savedGames'), capture: captureSavedGame, openGame: openSavedGame, repairGame: repairSavedGame,
  isBusy: () => state.analysisInProgress || state.urlResolutionInProgress,
  onBusy: busy => { state.savedGameBusy = busy; updateAnalyzeAvailability(); },
  onSaved: record => { state.activeSavedGameId = record.id; },
  onDeleted: id => { if (state.activeSavedGameId === id) state.activeSavedGameId = null; }
});
