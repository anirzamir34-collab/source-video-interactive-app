import { mergeUnownedIntervals, partitionProtagonistActions } from './protagonist-ownership.js';
import {
  adultPositionFamily,
  assignAdultSceneOccurrenceIds,
  adultPlaybackProgressDelta,
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  buildVerifiedMovementChoices,
  summarizeMovementChoiceCoverage,
  consolidateVerifiedPositions,
  computeAdultSelectionDelta,
  computeWarmupSelectionDelta,
  expandVerifiedMovementVariants,
  exclusiveControlClipIds,
  findAdultSceneForTimeline,
  forwardLocalMovementClips,
  isEnergeticSexMoment,
  isPlayableVerifiedPositionDuration,
  isOutcomeUnlocked,
  groupVerifiedMovementsByTempo,
  initialWarmupBeforeFirstPosition,
  selectSequentialApproachChoices,
  movementsForPositionOccurrence,
  positionOccurrenceGroups,
  positionOccurrenceForMovement,
  monotonicAdultPhase,
  normalizeSourceActionTimes,
  playableAdultPanelFamily,
  maleOrgasmPlaybackMultiplier,
  movementBelongsToVerifiedPosition,
  nearestAvailableTempo,
  normalizeOutcomeUnlockProgress,
  playbackRateForTapTempo,
  pickNearbyRhythmVariant,
  pickNextChronologicalVariant,
  pickNextVariant,
  positionUnlockProgress,
  requiredCorePlaySecondsForOutcome,
  requiredWarmupDiscoveries,
  resolveVerifiedAdultPosition,
  summarizeAdultSceneGraph,
  tapRhythm,
  verifiedAdultPositionFamily,
  verifiedPartnerTransition
} from './adult-gameplay.js';
import {
  buildDubBlocks,
  dialogueSegmentAt,
  dialogueSegmentsAt,
  dialogueSegmentsForTarget,
  dialogueSegmentsForTargets,
  decisionBoundaryAfterDialogue,
  dubMasterClockCorrection,
  dubSegmentKey,
  fittedDubPlaybackRate,
  analysisGapBridgeTarget,
  hasRemainingVideo,
  isCompleteChunkAnalysis,
  languageTimelineTime,
  mapVideoTimeToDubTime,
  nextDialogueSegments,
  resolveDubGender,
  sceneExitTime,
  seekMediaTo
} from './playback-logic.js';
import {
  ANALYSIS_SCHEMA_VERSION,
  ENGINE_VERSION,
  activityDisplayLabel,
  activityOccurrenceNamespace,
  advanceAdultPhase,
  analysisFingerprint,
  appendEngineEvent,
  applyRuntimeSnapshot,
  canPlayAction,
  createRuntimeSnapshot,
  isCompatibleRuntimeSnapshot,
  mergeSecondPassReview,
  normalizeChunkActionTimes,
  reviewAndHardenAnalysis,
  secondPassReviewCandidates
} from './engine-hardening.js';
import {
  mergeStoryContexts,
  normalizeStoryContext,
  selectDiverseStoryActions,
  storyChoiceLabelForAction
} from './story-engine.js';
import { bindActionCharacter, verifiedCharacterName, verifiedVisualDescription } from './character-identity.js';
import {
  adaptiveAnalysisChunkPlan,
  extractStoryboard
} from './storyboard.js';
import { canContinuePastChunkFailure, chunkGapResult } from './analysis-recovery.js';
import { repairableAnalysisGaps, mergeRepairedAnalysis } from './analysis-gap-repair.js';

import { createDubMixer, naturalDubRate, canFinishDubTail, correctDubClock } from './dubbing-audio.js';
import { createDubRequestQueue } from './dubbing-queue.js';
import { attachPanelFeedback, forwardVerifiedClips } from './panel-feedback.js';
import { mountSavedGames } from './saved-games-ui.js';
import { validateGame } from './saved-games.js';
import {
  attachHoldReleaseControl,
  attachTactileSurface,
  createTactileEngine
} from './tactile-controls.js';

import { dubSpeakerKey, buildDubSpeakerRoster, validateDubVoicePlan } from './dub-speakers.js';
import { activeDubSegments, dubSpeechEnd, sourceSpeechOverlaps } from './dub-overlap.js';
import { createVideoDownloader } from './video-download.js';
import { normalizeDialogueSegments } from './dialogue-integrity.js';
import { matchSceneIntroductions, sourcePositionAtTime, sceneEntrySeekTarget } from './scene-entry.js';
import { sourceIdentityLabel } from './choice-groups.js';
import { isAdultSocialRelationshipRole } from './relationship-roles.js';
import { canDecodeDialogueLocally, dialogueUploadMimeType } from './media-limits.js';
import { extractMp4Audio } from './mp4-audio.js';

const videoDownloads = createVideoDownloader();
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
  remoteFileDownload: null,
  videoObjectUrl: '',
  analysisSession: null,
  analysisInProgress: false,
  urlResolutionInProgress: false,
  analysis: null,
  dialogue: null,
  subtitlesEnabled: true,
  dubbingEnabled: false,
  keepOriginalAudioEnabled: true,
  languageSyncOffset: 0,
  activeDubSegmentId: null,
  dubCache: new Map(),
  dubRequests: new Map(),
  dubSyncGeneration: 0,
  dubStartingToken: null,
  dubResumeTime: null,
  dubVideoWaiting: false,
  dubPlaybackBlocked: false,
  dubRequestController: new AbortController(),
  dubUnavailableUntil: 0,
  dubFailureReason: '',
  dubProviderLock: '',
  dubQueue: createDubRequestQueue(2),
  dubBuffer: null,
  dubSpeakerVoices: new Map(),
  dubVoicePlanRequest: null,
  dubStableSpeakerGenders: new Map(),
  dubPlayedSegmentIds: new Set(),
  decisionDubHold: false,
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
  activeAdultOccurrenceId: null,
  activeAdultCategory: null,
  activeAdultPartnerTrackId: null,
  activeMovementId: null,
  activeMovementChoiceId: null,
  maleSceneProgress: 0,
  femaleSceneProgress: 0,
  adultMaleOrgasmProgress: 0,
  adultFemaleOrgasmProgress: 0,
  adultMaleOrgasmCount: 0,
  adultFemaleOrgasmCount: 0,
  adultOrgasmDecision: null,
  adultPlayedOutcomeIds: new Set(),
  adultSexUnlocked: false,
  adultUnlockedPositionIds: new Set(),
  lastAdultMediaTime: null,
  adultScenes: [],
  adultAnalysisTrace: null,
  completedAdultSceneIds: new Set(),
  adultLoopSeeking: false,
  adultSeekTimer: null,
  adultSeekListener: null,
  adultSeekRequestId: 0,
  adultSeekController: null,
  adultSelectionToken: 0,
  adultPendingSelectionProgress: null,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultPreludePlayCounts: new Map(),
  adultComboCount: 0,
  adultClimaxProgress: 0,
  adultCorePlaySeconds: 0,
  adultTimelineFloor: 0,
  adultLastApproachRefreshAt: 0,
  adultOutcomePhase: 'idle',
  activeAdultOutcomeId: null,
  activeAdultPreludeId: null,
  adultUnlockedOutcomeIds: new Set(),
  adultRevealedPositionIds: new Set(),
  adultUiSignature: '',
  adultLastUiPhase: 'foreplay',
  lastAdultFrameNow: null,
  adultFrameRequest: null,
  navigationSeeking: false,
  navigationSeekController: null,
  manualSeeking: false,
  adultPhaseMachine: 'foreplay',
  engineEvents: [],
  integrityReport: null,
  analysisFingerprint: '',
  lastRuntimeSaveAt: 0,
  restoredAdultSceneId: null,
  adultTapTimes: [],
  adultTapTempo: 'unclear',
  adultTapCandidateTempo: 'unclear',
  adultTapCandidateCount: 0,
  adultLastTempoSwitchAt: 0,
  adultFireHeld: false,
  adultFireArmed: false,
  adultAwaitingFire: false,
};

const els = {
  serviceStatus: $('serviceStatus'),
  serviceMeta: $('serviceMeta'),
  healthBtn: $('healthBtn'),
  videoInput: $('videoInput'),
  fileMeta: $('fileMeta'),
  analyzeBtn: $('analyzeBtn'),
  qualityMode: $('qualityMode'),
  geminiApiKeyInput: $('geminiApiKeyInput'),
  saveGeminiApiKeyBtn: $('saveGeminiApiKeyBtn'),
  testGeminiApiKeyBtn: $('testGeminiApiKeyBtn'),
  clearGeminiApiKeyBtn: $('clearGeminiApiKeyBtn'),
  apiKeyStatus: $('apiKeyStatus'),
  elevenLabsApiKeyInput: $('elevenLabsApiKeyInput'),
  saveElevenLabsBtn: $('saveElevenLabsBtn'),
  testElevenLabsBtn: $('testElevenLabsBtn'),
  clearElevenLabsBtn: $('clearElevenLabsBtn'),
  elevenLabsStatus: $('elevenLabsStatus'),
  motionMode: $('motionMode'),
  subtitleMode: $('subtitleMode'),
  dubMode: $('dubMode'),
  subtitleQuotaStatus: $('subtitleQuotaStatus'),
  dubQuotaStatus: $('dubQuotaStatus'),
  keepOriginalAudio: $('keepOriginalAudio'),
  originalAudioRow: $('originalAudioRow'),
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
  subtitleToggleBtn: $('subtitleToggleBtn'),
  dubToggleBtn: $('dubToggleBtn'),
  languageSyncControls: $('languageSyncControls'),
  languageEarlierBtn: $('languageEarlierBtn'),
  languageLaterBtn: $('languageLaterBtn'),
  languageSyncValue: $('languageSyncValue'),
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

const RUNTIME_SAVE_KEY = 'videoquest:runtime-state-v2';

function logEngineEvent(type, data = {}) {
  appendEngineEvent(state.engineEvents, type, data);
}

function persistRuntimeSnapshot(reason = 'runtime', force = false) {
  if (!state.analysis || !state.analysisFingerprint || state.gameState === 'ANALYZING') return;
  const now = Date.now();
  if (!force && now - state.lastRuntimeSaveAt < 750) return;
  state.lastRuntimeSaveAt = now;
  try {
    const snapshot = createRuntimeSnapshot(state, state.analysisFingerprint);
    // Session persistence intentionally disabled: refresh must start clean.
    return;
  } catch (error) {
    console.warn('Runtime state could not be saved:', error);
  }
}

function removeStoredValue(storageName, key) {
  // Storage can be disabled even when its global property exists.
  try { globalThis[storageName]?.removeItem(key); } catch {}
}

function restoreRuntimeSnapshot(analysis) {
  state.analysisFingerprint = analysisFingerprint(analysis);
  try {
    const raw = localStorage.getItem(RUNTIME_SAVE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (!isCompatibleRuntimeSnapshot(snapshot, state.analysisFingerprint)) {
      removeStoredValue('localStorage', RUNTIME_SAVE_KEY);
      return null;
    }
    applyRuntimeSnapshot(state, snapshot);
    logEngineEvent('RUNTIME_RESTORED', {
      cursor: state.gameCursorTime,
      actionIndex: state.currentActionIndex
    });
    return snapshot;
  } catch (error) {
    console.warn('Runtime state could not be restored:', error);
    removeStoredValue('localStorage', RUNTIME_SAVE_KEY);
    return null;
  }
}

function setAdultMachinePhase(proposed) {
  const previous = state.adultPhaseMachine || 'foreplay';
  const next = advanceAdultPhase(previous, proposed);
  if (next !== previous) {
    state.adultPhaseMachine = next;
    logEngineEvent('ADULT_PHASE_CHANGED', { from: previous, to: next });
    persistRuntimeSnapshot('adult-phase');
  }
  return state.adultPhaseMachine || next;
}

function guardPlayable(kind, action, options = {}) {
  const result = canPlayAction({
    kind,
    action,
    phase: state.adultPhaseMachine || state.adultLastUiPhase || 'foreplay',
    videoDuration: Number(state.analysis?.videoDuration || els.video?.duration || 0),
    ...options
  });
  if (!result.allowed) {
    logEngineEvent('ACTION_REJECTED', {
      kind,
      actionId: action?.id || action?.actionId || null,
      reason: result.reason
    });
  }
  return result;
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

  if (['DECISION_PENDING', 'ENDED', 'DIALOGUE_READY'].includes(next)) {
    persistRuntimeSnapshot('game-state');
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
  } else if (stateName === 'available') {
    element.textContent = status.lastSuccessAt ? 'Kullanılabilir' : 'Hazır · miktar bilinmiyor';
  } else if (stateName === 'unconfigured') {
    element.textContent = 'Kullanılamıyor';
  } else {
    element.textContent = 'Kalan miktar bilinmiyor';
  }
  element.title = status?.message || '';
}

const GEMINI_SESSION_KEY = 'videoquest_gemini_api_key';
const ELEVENLABS_SESSION_KEY = 'videoquest_elevenlabs_api_key';

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
  if (els.apiKeyStatus) els.apiKeyStatus.textContent = active
    ? 'Bu oturumda kendi anahtarın kullanılıyor'
    : 'Sunucu anahtarı kullanılıyor';
  els.clearGeminiApiKeyBtn?.classList.toggle('hidden', !active);
  els.testGeminiApiKeyBtn?.classList.toggle('hidden', !active);
  if (active && els.geminiApiKeyInput) els.geminiApiKeyInput.value = '';
}

function saveGeminiApiKey() {
  const key = String(els.geminiApiKeyInput?.value || '')
    .trim()
    .replace(/^GEMINI_API_KEY\s*=\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (key.length < 20 || key.length > 256 || /\s/.test(key)) {
    if (els.apiKeyStatus) els.apiKeyStatus.textContent = 'Anahtar eksik veya boşluk içeriyor';
    return;
  }
  try { sessionStorage.setItem(GEMINI_SESSION_KEY, key); } catch {}
  renderGeminiApiKeyState();
  checkAiUsageStatus();
  testGeminiApiKey();
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
      body: '{}'
    });
    const body = await response.json().catch(() => ({}));
    if (els.apiKeyStatus) {
      els.apiKeyStatus.className = String(body.state || 'unavailable');
      els.apiKeyStatus.textContent = body.message || (response.ok ? 'Anahtar çalışıyor' : 'Anahtar kullanılamıyor');
    }
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
  try { sessionStorage.removeItem(GEMINI_SESSION_KEY); } catch {}
  if (els.geminiApiKeyInput) els.geminiApiKeyInput.value = '';
  renderGeminiApiKeyState();
  checkAiUsageStatus();
}

function activeElevenLabsApiKey() {
  try { return String(sessionStorage.getItem(ELEVENLABS_SESSION_KEY) || '').trim(); }
  catch { return ''; }
}

function elevenLabsHeaders(base = {}) {
  const key = activeElevenLabsApiKey();
  return key ? { ...base, 'X-ElevenLabs-Key': key } : base;
}

function renderElevenLabsState() {
  const active = Boolean(activeElevenLabsApiKey());
  if (els.elevenLabsStatus) {
    els.elevenLabsStatus.className = active ? 'available' : '';
    els.elevenLabsStatus.textContent = active ? 'ElevenLabs etkin · test edilmedi' : 'Anahtar girilmedi';
  }
  els.testElevenLabsBtn?.classList.toggle('hidden', !active);
  els.clearElevenLabsBtn?.classList.toggle('hidden', !active);
  if (active && els.elevenLabsApiKeyInput) els.elevenLabsApiKeyInput.value = '';
}

function saveElevenLabsKey() {
  const key = String(els.elevenLabsApiKeyInput?.value || '').trim();
  if (key.length < 20 || key.length > 256 || /\s/.test(key)) {
    if (els.elevenLabsStatus) els.elevenLabsStatus.textContent = 'Anahtar eksik veya geçersiz';
    return;
  }
  try { sessionStorage.setItem(ELEVENLABS_SESSION_KEY, key); } catch {}
  resetDubState();
  renderElevenLabsState();
  testElevenLabsKey();
}

async function testElevenLabsKey() {
  if (!activeElevenLabsApiKey()) return;
  if (els.testElevenLabsBtn) {
    els.testElevenLabsBtn.disabled = true;
    els.testElevenLabsBtn.textContent = 'Test...';
  }
  if (els.elevenLabsStatus) {
    els.elevenLabsStatus.className = 'checking';
    els.elevenLabsStatus.textContent = 'Anahtar, sesler ve kredi kontrol ediliyor';
  }
  try {
    const response = await fetch('/api/elevenlabs-status', {
      method: 'POST',
      headers: elevenLabsHeaders({ 'Content-Type': 'application/json' }),
      body: '{}'
    });
    const body = await response.json().catch(() => ({}));
    if (els.elevenLabsStatus) {
      els.elevenLabsStatus.className = response.ok ? String(body.state || 'available') : String(body.state || 'invalid');
      els.elevenLabsStatus.textContent = body.message || (response.ok ? 'ElevenLabs çalışıyor' : 'ElevenLabs kullanılamıyor');
    }
    if (response.ok && els.dubToggleBtn) {
      delete els.dubToggleBtn.dataset.unavailable;
      els.dubToggleBtn.title = '';
      els.dubToggleBtn.textContent = `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;
    }
    checkAiUsageStatus();
  } catch {
    if (els.elevenLabsStatus) {
      els.elevenLabsStatus.className = 'invalid';
      els.elevenLabsStatus.textContent = 'ElevenLabs bağlantısı kurulamadı';
    }
  } finally {
    if (els.testElevenLabsBtn) {
      els.testElevenLabsBtn.disabled = false;
      els.testElevenLabsBtn.textContent = 'Test et';
    }
  }
}

function clearElevenLabsKey() {
  try { sessionStorage.removeItem(ELEVENLABS_SESSION_KEY); } catch {}
  if (els.elevenLabsApiKeyInput) els.elevenLabsApiKeyInput.value = '';
  resetDubState();
  renderElevenLabsState();
  checkAiUsageStatus();
}

async function checkAiUsageStatus() {
  try {
    const response = await fetch('/api/ai-usage-status', {
      cache: 'no-store',
      headers: geminiRequestHeaders()
    });
    const body = await response.json();
    renderQuotaBadge(els.subtitleQuotaStatus, body.subtitles);
    renderQuotaBadge(els.dubQuotaStatus, activeElevenLabsApiKey()
      ? { state: 'available', message: 'ElevenLabs anahtarı tanımlı. Kullanılabilir kota sağlayıcı isteğinde doğrulanır.' }
      : { state: 'unconfigured', message: 'Oynatıcı dublajı için ElevenLabs anahtarı gerekli.' });
  } catch {
    renderQuotaBadge(els.subtitleQuotaStatus, { state: 'unknown' });
    renderQuotaBadge(els.dubQuotaStatus, { state: 'unknown' });
  }
}

function selectedAnalysisModes() {
  return {
    motion: Boolean(els.motionMode?.checked),
    subtitles: Boolean(els.subtitleMode?.checked),
    dubbing: Boolean(els.dubMode?.checked),
    keepOriginalAudio: Boolean(els.keepOriginalAudio?.checked),
    quality: String(els.qualityMode?.value || 'ultra')
  };
}

function updateAnalysisModesUI() {
  const modes = selectedAnalysisModes();
  const qualityNames = {
    fast: 'Hızlı',
    balanced: 'Dengeli',
    ultra: 'Ultra'
  };

  if (els.keepOriginalAudio) {
    els.keepOriginalAudio.disabled = !modes.dubbing;
  }

  els.originalAudioRow?.classList.toggle('disabled', !modes.dubbing);

  const active = [];
  if (modes.motion) active.push('hareket ve seçim');
  if (modes.subtitles) active.push('Türkçe altyazı');
  if (modes.dubbing) active.push('Türkçe dublaj');

  if (els.selectedModesSummary) {
    els.selectedModesSummary.textContent = active.length
      ? `${qualityNames[modes.quality]} · ${active.join(' + ')}`
      : 'En az bir analiz modu seçmelisin.';
  }

  return active.length > 0;
}

function updateAnalyzeAvailability() {
  const hasMode = updateAnalysisModesUI();
  const busy = state.analysisInProgress || state.urlResolutionInProgress || state.savedGameBusy;
  els.analyzeBtn.disabled = busy || !(state.selectedFile || state.selectedRemoteVideo) || !hasMode;
  els.videoInput.disabled = busy;
  $('videoUrl').disabled = busy;
  $('resolveUrlBtn').disabled = busy;
  savedGames?.refreshControls();
}

[
  els.qualityMode,
  els.motionMode,
  els.subtitleMode,
  els.dubMode,
  els.keepOriginalAudio
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
els.saveElevenLabsBtn?.addEventListener('click', saveElevenLabsKey);
els.testElevenLabsBtn?.addEventListener('click', testElevenLabsKey);
els.clearElevenLabsBtn?.addEventListener('click', clearElevenLabsKey);
els.elevenLabsApiKeyInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') saveElevenLabsKey();
});
renderGeminiApiKeyState();
renderElevenLabsState();

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

function createDialogueWav(audioBuffer, targetRate = 16000) {
  const sourceRate = audioBuffer.sampleRate;
  const sampleCount = Math.ceil(audioBuffer.duration * targetRate);
  const wavBuffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(wavBuffer);
  const channels = audioBuffer.numberOfChannels;
  const channelData = Array.from(
    { length: channels },
    (_, index) => audioBuffer.getChannelData(index)
  );

  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  const ratio = sourceRate / targetRate;
  const mono = new Float32Array(sampleCount);

  // Keep the strongest usable channel when stereo averaging would cancel a
  // quiet voice. This preserves whispers before speech recognition.
  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = Math.min(
      Math.floor(index * ratio),
      audioBuffer.length - 1
    );

    let sum = 0;
    let strongest = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = channelData[channel][sourceIndex] || 0;
      sum += value;
      if (Math.abs(value) > Math.abs(strongest)) strongest = value;
    }

    const average = sum / channels;
    mono[index] = Math.abs(average) >= Math.abs(strongest) * 0.35
      ? average
      : strongest * 0.72;
  }

  // Windowed speech normalization raises low-volume dialogue without applying
  // one destructive gain value to the whole soundtrack.
  const windowSize = Math.max(1, Math.round(targetRate * 0.4));
  let smoothedGain = 1;

  for (let windowStart = 0; windowStart < sampleCount; windowStart += windowSize) {
    const windowEnd = Math.min(sampleCount, windowStart + windowSize);
    let energy = 0;
    let peak = 0;

    for (let index = windowStart; index < windowEnd; index += 1) {
      const value = mono[index];
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }

    const rms = Math.sqrt(energy / Math.max(1, windowEnd - windowStart));
    const desiredGain = rms > 0.0008
      ? Math.min(6, Math.max(1, 0.105 / rms, 0.86 / Math.max(peak, 0.001)))
      : 1;
    smoothedGain = smoothedGain * 0.45 + desiredGain * 0.55;

    for (let index = windowStart; index < windowEnd; index += 1) {
      const sample = Math.tanh(mono[index] * smoothedGain * 1.12);
      view.setInt16(
        44 + index * 2,
        sample < 0 ? sample * 32768 : sample * 32767,
        true
      );
    }
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

async function extractDialogueAudio(file) {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;

  if (!AudioEngine) {
    throw new Error('Bu tarayıcı ses çıkarma işlemini desteklemiyor.');
  }

  els.analysisTitle.textContent = 'Videodan konuşma sesi ayrılıyor';
  els.analysisOutput.textContent =
    'Video telefonda işleniyor...\n' +
    'Konuşma için ses kanalı cihazdaki dosyadan hazırlanıyor.';

  const audioContext = new AudioEngine();

  try {
    const sourceBuffer = await file.arrayBuffer();
    const decodedAudio = await audioContext.decodeAudioData(sourceBuffer);
    const wavBlob = createDialogueWav(decodedAudio, 16000);
    const baseName = (file.name || 'video').replace(/\.[^.]+$/, '');

    return new File(
      [wavBlob],
      `${baseName}-dialogue.wav`,
      { type: 'audio/wav' }
    );
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function waitUntilPageVisible() {
  if (document.visibilityState === 'visible') {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') resolve();
      },
      { once: true }
    );
  });
}

function sendDialogueChunk({
  uploadId,
  chunk,
  chunkIndex,
  completedBytes,
  totalBytes,
  startedAt,
  onProgress
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const attemptStartedAt = performance.now();
    let settled = false;
    let stallTimer = null;
    let uploadComplete = false;
    const chunkError = (message, details = {}) => Object.assign(new Error(message), details);
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      handler(value);
    };
    const armStallTimer = () => {
      if (uploadComplete) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        const error = chunkError('Bu parçada 45 saniye veri gönderilemedi.', {
          code: 'CHUNK_UPLOAD_STALLED', retryable: true
        });
        finish(reject, error);
        xhr.abort();
      }, 45000);
    };

    xhr.open(
      'POST',
      `/api/dialogue-upload/${encodeURIComponent(uploadId)}/chunk`
    );
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    // The upload may already be at 100% while Render is still accepting and
    // writing the request. Do not let the progress watchdog abort that wait.
    xhr.timeout = 120000;
    xhr.responseType = 'json';
    armStallTimer();

    xhr.upload.addEventListener('progress', event => {
      armStallTimer();
      const loaded = Math.min(
        totalBytes,
        completedBytes + (event.loaded || 0)
      );
      const elapsed = Math.max(
        (performance.now() - startedAt) / 1000,
        0.1
      );

      onProgress({
        loaded,
        total: totalBytes,
        percent: Math.min(100, Math.round(loaded / totalBytes * 100)),
        speed: (loaded / 1024 / 1024) / elapsed
      });
    });

    xhr.upload.addEventListener('load', () => {
      uploadComplete = true;
      clearTimeout(stallTimer);
      stallTimer = null;
    });

    xhr.addEventListener('load', () => {
      const body = xhr.response || {};

      if (xhr.status >= 200 && xhr.status < 300 && body.available) {
        finish(resolve, body);
      } else {
        const retryable = xhr.status === 0 || xhr.status === 408 || xhr.status === 409 ||
          xhr.status === 425 || xhr.status === 429 || xhr.status >= 500;
        finish(
          reject,
          chunkError(
            body.message ||
            body.reason ||
            `Parça yükleme hatası: HTTP ${xhr.status}`,
            { code: body.reason || 'CHUNK_UPLOAD_HTTP_ERROR', status: xhr.status, retryable }
          )
        );
      }
    });

    xhr.addEventListener('error', () => {
      finish(reject, chunkError('Parça sunucuya ulaşamadı.', { code: 'CHUNK_NETWORK_ERROR', retryable: true }));
    });

    xhr.addEventListener('timeout', () => {
      finish(reject, chunkError('Sunucu bu parçaya 120 saniye içinde yanıt vermedi.', { code: 'CHUNK_RESPONSE_TIMEOUT', retryable: true }));
    });

    xhr.addEventListener('abort', () => {
      finish(reject, chunkError('Takılan parça iptal edilip yeniden başlatıldı.', { code: 'CHUNK_UPLOAD_ABORTED', retryable: true }));
    });

    xhr.send(chunk);
  });
}

async function uploadDialogueWithProgress(
  form,
  onProgress,
  onUploadComplete
) {
  const file = form.get('video');
  const duration = String(form.get('duration') || '0');
  const protagonistProfile = String(form.get('protagonistProfile') || '');

  if (!(file instanceof Blob)) {
    throw new Error('Yüklenecek ses dosyası bulunamadı.');
  }

  await waitUntilPageVisible();

  const startResponse = await fetch('/api/dialogue-upload/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      totalSize: file.size,
      fileName: file.name || 'dialogue.wav',
      mimeType: dialogueUploadMimeType(file)
    })
  });

  const startBody = await startResponse.json();

  if (!startResponse.ok || !startBody.available) {
    throw new Error(
      startBody.message ||
      startBody.reason ||
      `Yükleme başlatılamadı: HTTP ${startResponse.status}`
    );
  }

  const uploadId = startBody.uploadId;
  // Reduce request/response round trips on fast mobile/Wi-Fi links while
  // retaining smaller retry units on constrained connections. The server raw
  // parser accepts up to 10 MiB, so the fast path stays safely below that.
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const constrained = connection?.saveData === true ||
    ['slow-2g', '2g'].includes(String(connection?.effectiveType || '').toLowerCase());
  const chunkSize = constrained
    ? 2 * 1024 * 1024
    : file.size >= 8 * 1024 * 1024
      ? 8 * 1024 * 1024
      : 4 * 1024 * 1024;
  const chunkCount = Math.ceil(file.size / chunkSize);
  const startedAt = performance.now();

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const chunk = file.slice(start, end);
    let retryCount = 0;

    while (true) {
      await waitUntilPageVisible();

      try {
        await sendDialogueChunk({
          uploadId,
          chunk,
          chunkIndex,
          completedBytes: start,
          totalBytes: file.size,
          startedAt,
          onProgress
        });
        break;
      } catch (error) {
        retryCount += 1;

        if (error.retryable === false || retryCount >= 5) throw error;

        els.analysisTitle.textContent =
          `Parça yeniden deneniyor (${retryCount}/5) · ${chunkIndex + 1}/${chunkCount}`;
        els.analysisOutput.textContent =
          `${error.message || 'Parça gönderilemedi.'}\n` +
          `${navigator.onLine === false ? 'Telefon çevrimdışı görünüyor. Bağlantı gelince devam edilecek.' : 'Bağlantı açık; aynı parça yeniden gönderilecek.'}`;

        if (navigator.onLine === false) {
          await new Promise(resolve => window.addEventListener('online', resolve, { once: true }));
        } else {
          await new Promise(resolve => setTimeout(resolve, Math.min(6000, 1000 * retryCount)));
        }
      }
    }

    const loaded = end;
    const elapsed = Math.max(
      (performance.now() - startedAt) / 1000,
      0.1
    );

    onProgress({
      loaded,
      total: file.size,
      percent: Math.min(100, Math.round(loaded / file.size * 100)),
      speed: (loaded / 1024 / 1024) / elapsed
    });
  }

  onUploadComplete();

  const finishForm = new FormData();
  finishForm.append('uploadId', uploadId);
  finishForm.append('duration', duration);
  finishForm.append('protagonistProfile', protagonistProfile);

  const response = await fetch('/api/gemini-dialogue-analyze', {
    method: 'POST',
    headers: geminiRequestHeaders(),
    body: finishForm
  });

  const body = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

async function prepareDialoguePayload(file, session = state.analysisSession) {
  if (session?.audioSource === file && session.audioFile instanceof Blob) return session.audioFile;
  const duration = Number(els.video.duration) || Number(session?.sourceDuration) || 0;
  const controller = new AbortController();
  session?.audioPreparationController?.abort();
  if (session) session.audioPreparationController = controller;
  const startedAt = performance.now();
  let progress = null;
  const showPreparation = () => {
    if (controller.signal.aborted || (session && session !== state.analysisSession)) return;
    const elapsed = Math.round((performance.now() - startedAt) / 1000);
    const total = Number(progress?.total) || 0;
    const loaded = Number(progress?.loaded) || 0;
    const percent = total ? Math.min(100, Math.round(loaded / total * 100)) : null;
    els.analysisTitle.textContent = percent === null
      ? `Videonun ses bilgileri okunuyor · ${elapsed} sn`
      : `Konuşma sesi hazırlanıyor · %${percent}`;
    els.analysisOutput.textContent = (total
      ? `Hazırlanan ses: ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB\n`
      : 'Video cihazda kalıyor; ses kanalı bulunuyor.\n') +
      `${elapsed} sn geçti. Cihazda hazırlama 120 saniyede tamamlanamazsa sunucuda devam edilecek.`;
  };
  showPreparation();
  const preparationTimer = setInterval(showPreparation, 1000);
  try {
    const audioFile = await extractMp4Audio(file, {
      signal: controller.signal,
      onProgress: value => { progress = value; showPreparation(); }
    });
    controller.signal.throwIfAborted();
    if (audioFile) {
      if (session) { session.audioSource = file; session.audioFile = audioFile; }
      return audioFile;
    }
  } catch (error) {
    if (controller.signal.aborted) throw error;
    if (error?.code === 'LOCAL_AUDIO_PREPARATION_TIMEOUT') {
      // A stuck file read must not start another full-file local decoder.
      // Reuse the original bytes with the existing server audio preparation.
      els.analysisTitle.textContent = 'Ses hazırlığı sunucuda devam edecek';
      els.analysisOutput.textContent = 'Cihazda ses hazırlama 120 saniyede tamamlanamadı. Mevcut video sunucuya yüklenerek devam edilecek.';
      if (session) { session.audioSource = file; session.audioFile = file; }
      return file;
    }
    console.warn('Sıkıştırılmış ses kanalı ayrılamadı; mevcut ses hazırlığı kullanılacak:', error);
  } finally {
    clearInterval(preparationTimer);
    if (session?.audioPreparationController === controller) delete session.audioPreparationController;
  }
  if (!canDecodeDialogueLocally(file, duration)) {
    els.analysisOutput.textContent = 'Bu dosyanın ses kanalı cihazda ayrılamadı. Video, ses hazırlığı için sunucuya yüklenecek.';
    return file;
  }
  try {
    const audioFile = await extractDialogueAudio(file);
    if (session) {
      session.audioSource = file;
      session.audioFile = audioFile;
    }
    return audioFile;
  } catch (error) {
    console.warn('Ses ayrılamadı; cihazdaki özgün video kullanılacak:', error);
    els.analysisOutput.textContent = 'Ses ayrılamadı. Cihazdaki dosyanın ses kanalı doğrudan analiz edilecek.';
    return file;
  }
}

async function analyzeSelectedDialogue(file, session = state.analysisSession) {
  els.analysisCard.classList.remove('hidden');
  els.analysisState.textContent = 'AUDIO_ANALYSIS';

  if (!file) throw new Error('Diyalog analizi için video bulunamadı.');
  const duration = Number(els.video.duration) || Number(session?.sourceDuration) || 0;
  const protagonistProfile = String(els.protagonistInput?.value || '').trim();
  const remoteToken = state.selectedSourceKind === 'url'
    ? String(session?.remoteToken || state.selectedRemoteToken || '').trim()
    : '';

  let processingTimer = null;
  let upload;

  // URL imports already exist at the source and on Render. Ask Render to pull
  // only the audio and encode a compact 64 kbps mono MP3 there instead of
  // uploading a second copy from the phone.
  if (remoteToken) {
    els.analysisTitle.textContent = 'Konuşma sesi sunucuda hazırlanıyor';
    els.analysisOutput.textContent = 'Telefon ses yüklemiyor; kaynak videonun sesi doğrudan sunucuda ayrılıyor.';
    const form = new FormData();
    form.append('remoteToken', remoteToken);
    form.append('duration', String(duration));
    form.append('protagonistProfile', protagonistProfile);
    const processingStartedAt = performance.now();
    const showProcessing = () => {
      els.analysisState.textContent = 'DIALOGUE_PROCESSING';
      els.analysisTitle.textContent = 'Sunucuda ses + Gemini analizi';
      els.analysisOutput.textContent =
        `Telefon yüklemesi atlandı. Konuşma ve karakter bağlamı inceleniyor...\n` +
        `${Math.round((performance.now() - processingStartedAt) / 1000)} sn geçti`;
    };
    showProcessing();
    processingTimer = setInterval(showProcessing, 1000);
    try {
      const response = await fetch('/api/gemini-dialogue-analyze', {
        method: 'POST',
        headers: geminiRequestHeaders(),
        body: form
      });
      const body = await response.json().catch(() => ({}));
      upload = { ok: response.ok, status: response.status, body };
      if (!response.ok && (response.status === 410 || body.reason === 'VIDEO_SESSION_EXPIRED')) {
        // The source token can expire after a long idle period. Fall back to
        // the local file without losing the analysis run.
        if (session) session.remoteToken = '';
        state.selectedRemoteToken = '';
        upload = null;
      }
    } finally {
      if (processingTimer !== null) clearInterval(processingTimer);
      processingTimer = null;
    }
  }

  if (!upload) {
    els.analysisTitle.textContent = 'Cihazdaki konuşma sesi hazırlanıyor';
    els.analysisOutput.textContent =
      `Konuşma sesi hazırlanıyor...\n` +
      `${(file.size / 1024 / 1024).toFixed(1)} MB`;

    const form = new FormData();
    const dialogueFile = await prepareDialoguePayload(file, session);
    form.append('video', dialogueFile, dialogueFile.name || 'dialogue.wav');
    form.append('duration', String(duration));
    form.append('protagonistProfile', protagonistProfile);

    try {
      upload = await uploadDialogueWithProgress(
        form,
        ({ loaded, total, percent, speed }) => {
          els.analysisState.textContent = 'AUDIO_UPLOAD';
          const audioOnly = dialogueFile.type.startsWith('audio/');
          els.analysisTitle.textContent = `${audioOnly ? 'Yalnızca konuşma sesi' : 'Cihazdaki video'} sunucuya yükleniyor · %${percent}`;
          const speedText = speed > 0 && speed < 0.05 ? '<0.1' : speed.toFixed(1);
          els.analysisOutput.textContent =
            (audioOnly ? 'Video cihazda kalıyor; sadece ses gönderiliyor.\n' : 'Ses cihazda ayrılamadığı için video sunucuya gönderiliyor.\n') +
            `Gerçek yükleme ilerlemesi: %${percent}\n` +
            `${(loaded / 1024 / 1024).toFixed(1)} / ` +
            `${(total / 1024 / 1024).toFixed(1)} MB\n` +
            `Ortalama yükleme hızı: ${speedText} MB/sn`;
        },
        () => {
          const processingStartedAt = performance.now();
          const showProcessing = () => {
            els.analysisState.textContent = 'DIALOGUE_PROCESSING';
            els.analysisTitle.textContent = 'Gemini konuşmaları analiz ediyor';
            els.analysisOutput.textContent = `Yükleme tamamlandı. Konuşma ve karakter bağlamı inceleniyor...\n${Math.round((performance.now() - processingStartedAt) / 1000)} sn geçti`;
          };
          showProcessing();
          processingTimer = setInterval(showProcessing, 1000);
        }
      );
    } finally {
      if (processingTimer !== null) clearInterval(processingTimer);
    }
  }

  const { body } = upload;

  recordAiUsage(body?.aiUsage);

  if (!upload.ok || !body.available) {
    throw new Error(body.error || body.message || `HTTP ${upload.status}`);
  }

  const segments = normalizeDialogueSegments(body.segments, Number(els.video.duration));
  state.dialogue = {
    ...body,
    segments,
    // Captions remain individually timed, while adjacent pieces of the same
    // spoken sentence become one TTS utterance. This prevents a voice from
    // stopping between subtitle rows or restarting with a clipped syllable.
    dubSegments: buildDubBlocks(segments, {
      mergeAdjacent: true,
      maxGap: 0.5,
      maxDuration: 18
    })
  };
  updateLanguageSyncControls();

  try {
    // Dialogue persistence intentionally disabled: refresh must start clean.
    localStorage.removeItem('videoquest:last-dialogue');
  } catch (error) {
    console.warn('Dialogue could not be saved:', error);
  }

  return state.dialogue;
}

function languageClockTime(videoTime = els.video.currentTime) {
  return languageTimelineTime(videoTime, state.languageSyncOffset);
}

function renderSubtitle() {
  const segments = state.dialogue?.segments || [];
  const now = languageClockTime();

  if (!state.subtitlesEnabled || !segments.length) {
    els.subtitleOverlay?.classList.add('hidden');
    return;
  }

  const heldVoice = dubBoundaryHold && state.dubbingEnabled
    ? [...dubBoundaryHold.ids].map(id => dubChannels.get(id)?._vqSegment).filter(Boolean)
    : [];
  const active = heldVoice.length ? heldVoice : activeDubSegments(segments, now, 0.015);
  if (!active.length) {
    els.subtitleOverlay?.classList.add('hidden');
    return;
  }
  const label = segment => {
    const profile = (state.dialogue?.speakers || []).find(item => dubSpeakerKey(item) === dubSpeakerKey(segment));
    return String(segment.speakerName || profile?.speakerName || profile?.displayName || 'Konuşmacı').trim();
  };
  const speakerText = active.length === 1 ? label(active[0]) : '';
  const captionText = active.length === 1 ? active[0].turkishText :
    active.map(segment => `${label(segment)}: ${segment.turkishText}`).join('\n');
  if (els.subtitleSpeaker.textContent !== speakerText) els.subtitleSpeaker.textContent = speakerText;
  if (els.subtitleText.textContent !== captionText) els.subtitleText.textContent = captionText;
  els.subtitleOverlay.classList.remove('hidden');
}

const dubChannels = new Map();
const dubRecoveryOffsets = new Map();
let dubBoundaryHold = null;
const preparedDubAudio = new Map();
const dubMixer = createDubMixer(els.video);
let dubPlaybackTimer = null;

function cancelDubBoundaryHold() {
  if (dubBoundaryHold) clearTimeout(dubBoundaryHold.timer);
  dubBoundaryHold = null;
}

function isDubBoundaryHoldCurrent(hold) {
  return dubBoundaryHold === hold && state.dubbingEnabled &&
    hold.generation === state.dubSyncGeneration && hold.controller === state.dubRequestController &&
    hold.selectionToken === state.adultSelectionToken && hold.playbackGeneration === state.playbackGeneration &&
    hold.gameState === state.gameState && !els.video.seeking && !els.video.ended &&
    Math.abs(Number(els.video.currentTime) - hold.videoTime) < 0.35;
}

function beginDubBoundaryHold(ids) {
  if (dubBoundaryHold || !ids.size) return;
  const hold = {
    ids, generation: state.dubSyncGeneration, controller: state.dubRequestController,
    selectionToken: state.adultSelectionToken, playbackGeneration: state.playbackGeneration,
    gameState: state.gameState, videoTime: Number(els.video.currentTime), resuming: false
  };
  dubBoundaryHold = hold;
  // Let only the overdue speakers finish. Other overlapping voices retain
  // their exact sample offsets while the source clock is stopped.
  for (const [id, audio] of dubChannels) if (!ids.has(id)) audio.pause();
  els.video.pause();
  stopDubClock();
  updateDubMix();
  const remaining = Math.max(0, ...[...ids].map(id => {
    const audio = dubChannels.get(id);
    return audio ? (audio.duration - audio.currentTime) / Math.max(.25, audio.playbackRate) : 0;
  }));
  // A decoder that never emits ended must expose recovery, not hang forever.
  hold.timer = setTimeout(() => {
    if (!isDubBoundaryHoldCurrent(hold)) { if (dubBoundaryHold === hold) cancelDubBoundaryHold(); return; }
    const audio = [...hold.ids].map(id => dubChannels.get(id)).find(item => item && !item.ended);
    if (!audio) { void resumeDubBoundaryHold(); return; }
    cancelDubBoundaryHold();
    beginDubBuffer(audio._vqSegment, false);
  }, (remaining + 8) * 1000);
}

async function resumeDubBoundaryHold() {
  const hold = dubBoundaryHold;
  if (!hold || hold.resuming) return;
  if (!isDubBoundaryHoldCurrent(hold)) { cancelDubBoundaryHold(); return; }
  if ([...hold.ids].some(id => dubChannels.has(id))) return;
  clearTimeout(hold.timer);
  if (state.decisionDubHold) { cancelDubBoundaryHold(); return; }
  hold.resuming = true;
  for (const audio of dubChannels.values()) {
    audio._vqAnchorVideoTime = languageClockTime();
    audio._vqAnchorAudioTime = audio.currentTime;
  }
  try {
    await els.video.play();
    if (!isDubBoundaryHoldCurrent(hold)) return;
    cancelDubBoundaryHold();
    renderSubtitle();
    startDubClock();
    void syncDubPlayback();
  } catch {
    if (isDubBoundaryHoldCurrent(hold)) {
      cancelDubBoundaryHold();
      beginDubBuffer(activeDubSegments(dubTimeline(), languageClockTime())[0], false);
    }
  }
}

function renderDubBuffer(message, loading = false) {
  els.dubBufferStatus?.classList.toggle('hidden', !state.dubBuffer);
  if (els.dubBufferMessage) els.dubBufferMessage.textContent = message;
  if (els.dubRetryBtn) els.dubRetryBtn.disabled = loading;
}

function cancelDubBuffer() {
  state.dubBuffer = null;
  renderDubBuffer('');
}

function isDubBufferCurrent(buffer) {
  return state.dubBuffer === buffer && buffer.generation === state.dubSyncGeneration &&
    buffer.controller === state.dubRequestController &&
    buffer.selectionToken === state.adultSelectionToken &&
    buffer.playbackGeneration === state.playbackGeneration && buffer.gameState === state.gameState &&
    !els.video.seeking && !els.video.ended &&
    Math.abs(Number(els.video.currentTime) - buffer.videoTime) < 0.35;
}

function beginDubBuffer(segment, loading = true) {
  cancelDubBoundaryHold();
  const buffer = {
    segment, generation: state.dubSyncGeneration, controller: state.dubRequestController,
    selectionToken: state.adultSelectionToken, playbackGeneration: state.playbackGeneration,
    gameState: state.gameState, videoTime: Number(els.video.currentTime), loading
  };
  state.dubBuffer = buffer;
  // Freeze the source, not just the voice: an unprepared line must not become
  // an undubbed gap while TTS or audio decoding is still in flight.
  els.video.pause();
  dubChannels.forEach(audio => audio.pause());
  updateDubMix();
  stopDubClock();
  renderDubBuffer(loading ? 'Türkçe dublaj hazırlanıyor… Video aynı noktada bekliyor.' :
    'Dublaj oynatılamadı. Devam etmek için yeniden dene.', loading);
  return buffer;
}

async function retryDubBuffer(useOriginal = false) {
  const buffer = state.dubBuffer;
  if (!buffer || !isDubBufferCurrent(buffer) || (buffer.loading && !useOriginal)) return;
  if (!useOriginal && state.dubUnavailableUntil > Date.now()) {
    const seconds = Math.ceil((state.dubUnavailableUntil - Date.now()) / 1000);
    renderDubBuffer(`Dublaj servisi bekletiyor. ${seconds} saniye sonra yeniden deneyebilirsin.`);
    return;
  }
  cancelDubBuffer();
  state.dubStartingToken = null;
  state.dubPlaybackBlocked = false;
  if (useOriginal) {
    state.dubbingEnabled = false;
    stopDubPlayback();
    if (els.dubToggleBtn) els.dubToggleBtn.textContent = 'TR DUBLAJ: KAPALI';
  } else {
    state.dubbingEnabled = true;
  }
  try {
    await els.video.play();
    if (state.dubbingEnabled) { startDubClock(); void syncDubPlayback(); }
  } catch {
    // Keep an actionable control if the browser requires a fresh play gesture.
    if (buffer.generation !== state.dubSyncGeneration || buffer.controller !== state.dubRequestController ||
        buffer.selectionToken !== state.adultSelectionToken || buffer.playbackGeneration !== state.playbackGeneration) return;
    buffer.loading = false;
    state.dubBuffer = buffer;
    renderDubBuffer('Tarayıcı oynatmayı engelledi. Devam etmek için yeniden dokun.');
  }
}

async function prepareDubForPlayback(segment) {
  const group = await prepareDubGroupForPlayback([segment]);
  return group?.get(getDubSegmentId(segment)) || null;
}

async function prepareDubGroupForPlayback(segments) {
  const result = new Map();
  const missing = [];
  for (const segment of segments) {
    const id = getDubSegmentId(segment);
    const audio = preparedDubAudio.get(id);
    if (audio?.readyState >= 2 && !audio.error) result.set(id, audio);
    else missing.push(segment);
  }
  if (!missing.length) return result;
  // One preparation hold covers every simultaneous speaker. Independent holds
  // would cancel each other and resume with only the last prepared voice.
  const buffer = beginDubBuffer(missing[0]);
  try {
    await Promise.all(missing.map(async segment => {
      const audio = await prepareDubAudio(segment, 100);
      if (audio) result.set(getDubSegmentId(segment), audio);
    }));
  } catch (error) {
    logEngineEvent('DUB_PREPARATION_FAILED', { message: error?.message || String(error) });
  }
  if (!isDubBufferCurrent(buffer) || !state.dubbingEnabled) {
    if (state.dubBuffer === buffer) cancelDubBuffer();
    return null;
  }
  buffer.loading = false;
  if (result.size !== segments.length) {
    renderDubBuffer('Bu bölümün Türkçe dublajı hazırlanamadı. Yeniden dene veya dublajı kapatarak devam et.');
    return null;
  }
  try { await els.video.play(); }
  catch {
    if (isDubBufferCurrent(buffer)) renderDubBuffer('Ses hazır. Oynatmak için yeniden dokun.');
    return null;
  }
  if (!isDubBufferCurrent(buffer) || !state.dubbingEnabled) {
    if (state.dubBuffer === buffer) cancelDubBuffer();
    return null;
  }
  cancelDubBuffer();
  startDubClock();
  return result;
}

function updateDubMix() {
  dubMixer.update({
    enabled: state.dubbingEnabled,
    keepOriginal: state.keepOriginalAudioEnabled,
    speaking: [...dubChannels.values()].some(audio => !audio.paused && !audio.ended)
  });
  const voices = [...dubChannels.values()].filter(audio => !audio.ended).length;
  for (const audio of dubChannels.values()) audio.volume = dubMixer.voiceVolume(voices);
}

function clearPreparedDubAudio() {
  for (const audio of preparedDubAudio.values()) {
    audio.pause();
    audio._vqCancelReady?.();
    audio.removeAttribute('src');
    audio.load();
  }
  preparedDubAudio.clear();
}

async function prepareDubAudio(segment, priority = 0) {
  const controller = state.dubRequestController;
  const source = await ensureDubSegment(segment, priority);
  if (!source || controller !== state.dubRequestController || !dubTimeline().includes(segment)) return null;
  const id = getDubSegmentId(segment);
  if (preparedDubAudio.has(id)) return preparedDubAudio.get(id)._vqReady;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = dubMixer.voiceVolume();
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
  audio._vqSegment = segment;
  audio._vqReady = new Promise(resolve => {
    let timer;
    let cancelled = false;
    const done = () => {
      clearTimeout(timer);
      for (const event of ['canplay', 'error']) audio.removeEventListener(event, done);
      const ready = !cancelled && audio.readyState >= 2 && !audio.error;
      if (!ready && preparedDubAudio.get(id) === audio) preparedDubAudio.delete(id);
      resolve(ready ? audio : null);
    };
    for (const event of ['canplay', 'error']) audio.addEventListener(event, done);
    audio._vqCancelReady = () => { cancelled = true; done(); };
    timer = setTimeout(done, 10000);
  });
  audio.addEventListener('ended', () => {
    if (dubChannels.get(id) !== audio) return;
    dubChannels.delete(id);
    if (state.activeDubSegmentId === id) state.activeDubSegmentId = null;
    updateDubMix();
    if (dubBoundaryHold) void resumeDubBoundaryHold();
    else if (state.dubbingEnabled && !els.video.paused) void syncDubPlayback();
  });
  audio.addEventListener('error', () => {
    if (dubChannels.get(id) !== audio) return;
    audio.pause();
    dubChannels.delete(id);
    if (state.activeDubSegmentId === id) state.activeDubSegmentId = null;
    state.dubPlayedSegmentIds.delete(id);
    dubRecoveryOffsets.set(id, { segment, offset: Math.max(0, Number(audio.currentTime) || 0) });
    preparedDubAudio.delete(id);
    if (state.dubbingEnabled) beginDubBuffer(segment, false);
    updateDubMix();
  });
  preparedDubAudio.set(id, audio);
  // Keep only a handful of decoded media elements, including the active line.
  for (const [key, old] of preparedDubAudio) {
    if (preparedDubAudio.size <= Math.max(6, activeDubSegments(dubTimeline(), languageClockTime()).length + 3)) break;
    if (key === id || dubChannels.has(key) || activeDubSegments(dubTimeline(), languageClockTime()).some(row => getDubSegmentId(row) === key)) continue;
    preparedDubAudio.delete(key);
    old.pause();
    old._vqCancelReady?.();
    old.removeAttribute('src');
    old.load();
  }
  audio.src = source;
  audio.load();
  return audio._vqReady;
}

function finishDubPlaybackAtVideoEnd() {
  cancelDubBoundaryHold();
  cancelDubBuffer();
  state.dubStartingToken = null;
  // The video's natural end emits pause before ended. Neither event should
  // truncate a voice that is already playing. The source cannot drift into
  // another scene after its natural end, so no artificial tail limit is needed.
  for (const [id, audio] of dubChannels) {
    if (!audio.paused && !audio.ended) continue;
    audio.pause();
    dubChannels.delete(id);
  }
  state.activeDubSegmentId = dubChannels.keys().next().value || null;
  updateDubMix();
  stopDubClock();
}

function startDubClock() {
  if (dubPlaybackTimer !== null || (!state.dubbingEnabled && !state.subtitlesEnabled)) return;
  // timeupdate can be as sparse as four events per second on mobile.
  dubPlaybackTimer = setInterval(() => {
    if (state.subtitlesEnabled) renderSubtitle();
    if (state.dubbingEnabled) void syncDubPlayback();
  }, 50);
}

function stopDubClock() {
  if (dubPlaybackTimer !== null) clearInterval(dubPlaybackTimer);
  dubPlaybackTimer = null;
}

function recordAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'thinkingTokens', 'totalTokens']) {
    state.aiUsage[key] += Math.max(0, Number(usage[key]) || 0);
  }
  logEngineEvent('AI_USAGE', { ...state.aiUsage });
}

function getDubSegmentAt(videoTime) {
  return dialogueSegmentAt(dubTimeline(), languageClockTime(videoTime), 0.12);
}

function dubTimeline() {
  return state.dialogue?.dubSegments || state.dialogue?.segments || [];
}

function getDubSegmentId(segment) {
  if (!segment) return '';
  const segments = dubTimeline();
  const index = Math.max(0, segments.indexOf(segment));
  return dubSegmentKey(segment, index);
}

function stableDubGender(segment) {
  const speakerId = String(segment?.speakerId || '').trim() || 'speaker-unknown';
  const profile = (state.dialogue?.speakers || []).find(item =>
    String(item?.speakerId || '') === speakerId
  );
  // The time-aligned segment is the closest evidence to the audible line.
  // A global speaker profile can be wrong for an isolated diarization turn;
  // preferring it made a woman's voice read a man's line (and vice versa).
  const resolved = resolveDubGender(
    segment?.gender,
    profile?.gender,
    state.dubStableSpeakerGenders.get(speakerId)
  );
  if (resolved !== 'uncertain') state.dubStableSpeakerGenders.set(speakerId, resolved);
  return resolved;
}

async function ensureDubVoicePlan() {
  const controller = state.dubRequestController;
  const dialogue = state.dialogue;
  const roster = buildDubSpeakerRoster(dialogue?.segments || dubTimeline(), dialogue?.speakers || []);
  state.dubSpeakerVoices ||= new Map();
  if (roster.every(row => state.dubSpeakerVoices.has(row.speakerId))) return state.dubSpeakerVoices;
  if (state.dubVoicePlanRequest?.controller === controller && state.dubVoicePlanRequest.dialogue === dialogue) {
    return state.dubVoicePlanRequest.promise;
  }
  const task = { controller, dialogue, promise: null };
  task.promise = (async () => {
    const response = await fetch('/api/elevenlabs-voice-plan', {
      method: 'POST', headers: elevenLabsHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]),
      body: JSON.stringify({ speakers: roster, previous: [...state.dubSpeakerVoices.values()] })
    });
    const body = await response.json().catch(() => ({}));
    if (controller !== state.dubRequestController || dialogue !== state.dialogue || controller.signal.aborted) return null;
    if (!response.ok || !body.available) throw new Error(body.message || 'Karakterler için ayrı sesler hazırlanamadı.');
    const plan = validateDubVoicePlan(roster, body.assignments);
    state.dubSpeakerVoices = plan;
    return plan;
  })().finally(() => {
    if (state.dubVoicePlanRequest === task) state.dubVoicePlanRequest = null;
  });
  state.dubVoicePlanRequest = task;
  return task.promise;
}

async function ensureDubSegment(segment, priority = 0) {
  if (!segment?.turkishText) return null;
  if (!dubTimeline().includes(segment)) return null;
  const requestController = state.dubRequestController;
  const isCurrent = () => requestController === state.dubRequestController && !requestController.signal.aborted;
  const segmentId = getDubSegmentId(segment);
  if (!segmentId) return null;
  if (state.dubCache.has(segmentId)) return state.dubCache.get(segmentId);
  if (state.savedPlaybackOnly) return null;
  if (state.dubRequests.has(segmentId)) {
    state.dubQueue.promote(segmentId, priority);
    return state.dubRequests.get(segmentId);
  }
  // Provider cooldowns do not invalidate audio that is already available.
  if (state.dubUnavailableUntil > Date.now()) return null;

  const runRequest = async () => {
    if (!isCurrent() || state.dubbingEnabled === false || state.dubUnavailableUntil > Date.now()) return null;
    if (!activeElevenLabsApiKey()) throw new Error('ElevenLabs anahtarı gerekli');
    const plan = await ensureDubVoicePlan();
    if (!isCurrent()) return null;
    const assignment = plan?.get(dubSpeakerKey(segment));
    if (!assignment?.voiceId) throw new Error('Bu konuşmacıya ayrı ses atanamadı.');
    const timeline = dubTimeline();
    const segmentIndex = timeline.indexOf(segment);
    const adjacentText = offset => {
      const neighbor = timeline[segmentIndex + offset];
      return neighbor && dubSpeakerKey(neighbor) === dubSpeakerKey(segment)
        ? String(neighbor.turkishText || '') : '';
    };
    const payload = JSON.stringify({
      text: segment.turkishText, speakerId: dubSpeakerKey(segment),
      gender: assignment.gender, voiceId: assignment.voiceId,
      emotion: segment.emotion || 'uncertain',
      sourceContext: {
        segmentId, startTime: segment.startTime, endTime: segment.endTime,
        originalText: segment.originalText || '',
        previousText: adjacentText(-1),
        nextText: adjacentText(1)
      }
    });
    let lastFailure = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (!isCurrent()) return null;
      try {
        const response = await fetch('/api/elevenlabs-dub-segment', {
          method: 'POST', headers: elevenLabsHeaders({ 'Content-Type': 'application/json' }), body: payload,
          signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(70000)])
        });
        const body = await response.json().catch(() => ({}));
        if (!isCurrent()) return null;
        if (response.ok && body?.available && body?.audioBase64) {
          if (state.dubFailureReason && els.dubToggleBtn) {
            delete els.dubToggleBtn.dataset.unavailable;
            els.dubToggleBtn.title = '';
            els.dubToggleBtn.textContent = `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;
          }
          state.dubFailureReason = '';
          state.dubProviderLock = 'elevenlabs';
          if (body.voiceId !== assignment.voiceId || (body.speakerId && body.speakerId !== assignment.speakerId)) {
            throw Object.assign(new Error('Dublaj yanıtının konuşmacı sesi eşleşmedi; yanlış ses oynatılmadı.'), { code: 'DUB_VOICE_MISMATCH' });
          }
          const source = `data:${body.mimeType || 'audio/wav'};base64,${body.audioBase64}`;
          state.dubCache.set(segmentId, source);
          logEngineEvent('DUB_PROVIDER_USED', { provider: 'elevenlabs', segmentId, voiceId: body.voiceId });
          return source;
        }
        lastFailure = { response, body };
        if (body?.reason === 'ELEVENLABS_RATE_LIMIT' && attempt < 4) {
          const retrySeconds = Math.max(1, Number(body.retryAfterSeconds) || attempt * 2);
          // Do not retry before the provider's deadline or block every queued
          // line behind a long rate-limit wait. Surface it for a later retry.
          if (retrySeconds > 30) break;
          await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
          continue;
        }
        break;
      } catch (error) {
        if (!isCurrent()) return null;
        lastFailure = { error };
        if (error.code === 'DUB_VOICE_MISMATCH') break;
        if (attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1200));
          continue;
        }
      }
    }

    if (!isCurrent()) return null;
    const body = lastFailure?.body || {};
    if (body.reason === 'ELEVENLABS_RATE_LIMIT') {
      state.dubUnavailableUntil = Date.now() + Math.max(1, Number(body.retryAfterSeconds) || 30) * 1000;
    }
    if (body.reason === 'ELEVENLABS_QUOTA_LIMIT') {
      const retrySeconds = Math.max(60, Number(body.retryAfterSeconds) || 3600);
      state.dubUnavailableUntil = Date.now() + retrySeconds * 1000;
      state.dubFailureReason = body.reason;
      // Keep the user's dubbing preference. At a missing line the player will
      // pause with an explicit retry/original-audio choice, not silently switch.
      if (els.dubToggleBtn) {
        els.dubToggleBtn.textContent = 'TR DUBLAJ: LİMİT DOLDU';
        els.dubToggleBtn.classList.remove('hidden');
        els.dubToggleBtn.dataset.unavailable = 'true';
      }
      logEngineEvent('DUB_QUOTA_EXHAUSTED', { retrySeconds });
      checkAiUsageStatus();
      return null;
    }
    const message = body?.message || body?.error || lastFailure?.error?.message || 'ElevenLabs dublaj üretilemedi';
    state.dubFailureReason = body?.reason || lastFailure?.error?.code || 'DUB_PROVIDER_ERROR';
    if (els.dubToggleBtn) {
      els.dubToggleBtn.textContent = `DUBLAJ HATASI: ${message}`;
      els.dubToggleBtn.title = message;
      els.dubToggleBtn.classList.remove('hidden');
      els.dubToggleBtn.dataset.unavailable = 'true';
    }
    throw lastFailure?.error || new Error(message);
  };

  const request = state.dubQueue.enqueue(segmentId, runRequest, priority).catch(error => {
    if (isCurrent()) console.error('Dub segment failed:', segmentId, error);
    return null;
  }).finally(() => {
    if (state.dubRequests.get(segmentId) === request) state.dubRequests.delete(segmentId);
  });

  state.dubRequests.set(segmentId, request);
  return request;
}

function stopDubPlayback() {
  cancelDubBoundaryHold();
  cancelDubBuffer();
  state.dubStartingToken = null;
  dubRecoveryOffsets.clear();
  dubChannels.forEach(audio => audio.pause());
  dubChannels.clear();
  state.activeDubSegmentId = null;
  updateDubMix();
  if (!state.dubbingEnabled && !state.subtitlesEnabled) stopDubClock();
}

function resetDubState() {
  state.dubRequestController.abort();
  state.dubRequestController = new AbortController();
  stopDubPlayback();
  stopDubClock();
  clearPreparedDubAudio();
  state.dubResumeTime = null;
  state.dubVideoWaiting = false;
  state.dubPlaybackBlocked = false;
  state.dubCache.clear();
  state.dubRequests.clear();
  state.dubSyncGeneration += 1;
  state.activeDubSegmentId = null;
  state.dubFailureReason = '';
  state.dubProviderLock = '';
  state.dubQueue.clear();
  state.dubQueue = createDubRequestQueue(2);
  state.dubStableSpeakerGenders.clear();
  state.dubPlayedSegmentIds.clear();
  state.dubSpeakerVoices = new Map();
  state.dubVoicePlanRequest = null;
  state.decisionDubHold = false;
  state.dubUnavailableUntil = 0;
  state.aiUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  };
}

function prefetchDubSegmentsAround(videoTime) {
  if (!state.dubbingEnabled) return;
  nextDialogueSegments(dubTimeline(), languageClockTime(videoTime), 3)
    .forEach((segment, index) => void prepareDubAudio(segment, 20 - index));
}

async function prepareCompleteDubTimeline(segments = [], concurrency = 1, onProgress = null) {
  const requestController = state.dubRequestController;
  const queue = (Array.isArray(segments) ? segments : [])
    .filter(segment => String(segment?.turkishText || '').trim());
  let cursor = 0;
  const worker = async () => {
    while (state.dubbingEnabled && requestController === state.dubRequestController) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      await ensureDubSegment(queue[index], 10);
      if (typeof onProgress === 'function') {
        onProgress(
          queue.filter(segment => state.dubCache.has(getDubSegmentId(segment))).length,
          queue.length
        );
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) },
    () => worker()
  ));
  if (requestController !== state.dubRequestController) return 0;
  const missing = queue.filter(segment => !state.dubCache.has(getDubSegmentId(segment)));
  for (const segment of missing) {
    if (!state.dubbingEnabled || requestController !== state.dubRequestController) break;
    await ensureDubSegment(segment, 10);
    if (typeof onProgress === 'function') {
      onProgress(
        queue.filter(item => state.dubCache.has(getDubSegmentId(item))).length,
        queue.length
      );
    }
  }
  return queue.filter(segment => state.dubCache.has(getDubSegmentId(segment))).length;
}

function primeLanguageTracksAt(videoTime, count = 2) {
  if (!state.dubbingEnabled) return;
  dialogueSegmentsForTarget(dubTimeline(), languageClockTime(videoTime), count)
    .forEach((segment, index) => void prepareDubAudio(segment, 50 - index));
}

function primeAdultPositionLanguage(position) {
  if (!state.dubbingEnabled || !position) return;
  const requestController = state.dubRequestController;
  const selectionToken = state.adultSelectionToken;
  const targetTimes = [
    position.startTime,
    ...(position.movements || []).map(item => item.loopStartTime)
  ];
  const segments = dialogueSegmentsForTargets(
    dubTimeline(),
    targetTimes.map(languageClockTime),
    12
  );
  void (async () => {
    for (const segment of segments) {
      if (!state.dubbingEnabled || requestController !== state.dubRequestController ||
          selectionToken !== state.adultSelectionToken) break;
      await ensureDubSegment(segment);
    }
  })();
}

function resyncLanguageTracks() {
  renderSubtitle();
  if (!state.dubbingEnabled) return;
  // The seeking event already invalidates the old voice. Doing it a second
  // time after seeked discarded the freshly prepared line as "already played".
  const time = Math.max(0, Number(els.video?.currentTime) || 0);
  primeLanguageTracksAt(time, 3);
  updateDubMix();
  void syncDubPlayback();
}

async function playDubAudio(audio, segmentId, generation) {
  try {
    audio._vqPlayGeneration = generation;
    await audio.play();
    if (generation !== state.dubSyncGeneration || dubChannels.get(segmentId) !== audio ||
        !state.dubbingEnabled || (els.video.paused && !state.decisionDubHold) ||
        state.dubVideoWaiting || els.video.seeking) {
      if (audio._vqPlayGeneration === generation) audio.pause();
      return false;
    }
    // A queued or blocked play() is not a heard sentence.
    state.dubPlayedSegmentIds.add(segmentId);
    dubRecoveryOffsets.delete(segmentId);
    state.dubResumeTime = null;
    if (state.dubBuffer?.segment === audio._vqSegment) cancelDubBuffer();
    updateDubMix();
    return true;
  } catch (error) {
    if (generation !== state.dubSyncGeneration || dubChannels.get(segmentId) !== audio) return false;
    // pause()/seek() may legitimately interrupt a pending play promise.
    if (error?.name !== 'AbortError') {
      state.dubPlaybackBlocked = true;
      logEngineEvent('DUB_PLAYBACK_BLOCKED', { message: error?.message || String(error) });
      beginDubBuffer(audio._vqSegment, false);
    }
    updateDubMix();
    return false;
  }
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) return stopDubPlayback();
  if (els.video.paused || els.video.seeking || state.dubVideoWaiting || state.dubPlaybackBlocked || state.dubStartingToken) return;
  const generation = state.dubSyncGeneration;
  const token = { generation };
  state.dubStartingToken = token;
  const current = () => state.dubStartingToken === token && generation === state.dubSyncGeneration && state.dubbingEnabled;
  try {
    const videoTime = languageClockTime();
    const active = activeDubSegments(dubTimeline(), videoTime);
    // A decoder retry resumes unheard samples even if its caption has ended.
    // Explicit seeks and source changes clear these recovery entries.
    for (const { segment } of dubRecoveryOffsets.values()) if (!active.includes(segment)) active.push(segment);
    const activeIds = new Set(active.map(getDubSegmentId));
    const waitingForTail = new Set();
    const overdue = new Set();
    let mustHold = false;
    for (const [id, audio] of dubChannels) {
      if (activeIds.has(id) && !audio.ended) {
        correctDubClock(audio, videoTime, els.video.playbackRate || 1);
        continue;
      }
      if (!audio.ended && (!audio.paused || state.dubPlayedSegmentIds.has(id))) {
        overdue.add(id);
        const remaining = (audio.duration - audio.currentTime) / Math.max(.25, audio._vqSpeechRate || 1);
        if (!canFinishDubTail(audio, active[0], videoTime)) mustHold = true;
        for (const segment of active) {
          // Only consecutive turns wait for a final syllable. Actual source
          // overlap starts immediately on each speaker's independent channel.
          if (dubSpeakerKey(audio._vqSegment) === dubSpeakerKey(segment) || !sourceSpeechOverlaps(audio._vqSegment, segment)) {
            waitingForTail.add(getDubSegmentId(segment));
            // A brief reply can expire entirely during the preceding tail.
            if (remaining >= Number(segment.endTime) - videoTime - .12) mustHold = true;
          }
        }
        continue;
      }
      audio.pause();
      dubChannels.delete(id);
    }
    state.activeDubSegmentId = dubChannels.keys().next().value || null;
    if (mustHold || waitingForTail.size) {
      await Promise.all([...overdue].filter(id => dubChannels.get(id)?.paused)
        .map(id => playDubAudio(dubChannels.get(id), id, generation)));
      if (current() && !els.video.paused && !state.dubPlaybackBlocked) beginDubBoundaryHold(overdue);
      return;
    }
    const pending = active.filter(segment => {
      const id = getDubSegmentId(segment);
      return !waitingForTail.has(id) && !dubChannels.has(id) && !state.dubPlayedSegmentIds.has(id);
    });
    const prepared = await prepareDubGroupForPlayback(pending);
    if (!prepared || !current() || els.video.paused || els.video.seeking || state.dubVideoWaiting || state.dubPlaybackBlocked) return;
    const now = languageClockTime();
    const stillActive = new Set(activeDubSegments(dubTimeline(), now).map(getDubSegmentId));
    for (const segment of pending) {
      const id = getDubSegmentId(segment);
      const audio = prepared.get(id);
      if (!audio || (!stillActive.has(id) && !dubRecoveryOffsets.has(id)) || state.dubPlayedSegmentIds.has(id)) continue;
      const elapsed = Math.max(0, now - Number(segment.startTime));
      const sourceRate = naturalDubRate(audio.duration, dubSpeechEnd(segment, dubTimeline()) - Number(segment.startTime));
      // Only an explicit source seek skips heard material. A late callback,
      // initial preparation or preceding speaker must not cut the beginning.
      const offset = dubRecoveryOffsets.get(id)?.offset ??
        (state.dubResumeTime !== null
          ? Math.min(audio.duration, elapsed * sourceRate) : 0);
      if (offset >= audio.duration - 0.02) { state.dubPlayedSegmentIds.add(id); continue; }
      audio.currentTime = offset;
      audio._vqSpeechEnd = dubSpeechEnd(segment, dubTimeline());
      audio._vqSpeechRate = naturalDubRate(audio.duration - offset, Math.max(0.05, dubSpeechEnd(segment, dubTimeline()) - now));
      audio._vqAnchorVideoTime = now;
      audio._vqAnchorAudioTime = offset;
      audio._vqClockHold = false;
      audio.playbackRate = audio._vqSpeechRate * (els.video.playbackRate || 1);
      dubChannels.set(id, audio);
    }
    state.activeDubSegmentId = dubChannels.keys().next().value || null;
    const starts = [...dubChannels].filter(([, audio]) => audio.paused && !audio.ended && !audio._vqClockHold);
    updateDubMix();
    if (starts.length) dubMixer.update({ enabled: true, keepOriginal: state.keepOriginalAudioEnabled, speaking: true });
    await Promise.all(starts.map(([id, audio]) => playDubAudio(audio, id, generation)));
    if (current()) prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
  } finally {
    if (state.dubStartingToken === token) state.dubStartingToken = null;
  }
}

els.video.addEventListener('timeupdate', () => { renderSubtitle(); void syncDubPlayback(); });
els.video.addEventListener('pause', () => {
  if (els.video.ended && state.dubbingEnabled) { finishDubPlaybackAtVideoEnd(); return; }
  stopDubClock();
  if (!state.decisionDubHold && !dubBoundaryHold) {
    dubChannels.forEach(audio => audio.pause());
    updateDubMix();
  }
});
els.video.addEventListener('waiting', () => {
  state.dubVideoWaiting = true;
  if (!state.decisionDubHold && !dubBoundaryHold) dubChannels.forEach(audio => audio.pause());
  updateDubMix();
});
els.video.addEventListener('seeking', () => {
  state.dubSyncGeneration += 1;
  // Previously selected timestamps are now speculative, not urgent.
  state.dubQueue?.deprioritize();
  state.dubResumeTime = Math.max(0, Number(els.video.currentTime) || 0);
  stopDubPlayback();
  state.dubPlayedSegmentIds.clear();
});
els.video.addEventListener('seeked', () => {
  renderSubtitle();
  state.dubVideoWaiting = els.video.readyState < 3;
  if (!state.dubbingEnabled) return;
  void syncDubPlayback();
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});
els.video.addEventListener('play', () => {
  // A new user play gesture takes ownership from an automatic speech hold.
  if (dubBoundaryHold && !dubBoundaryHold.resuming) cancelDubBoundaryHold();
  state.dubPlaybackBlocked = false;
  // play() is still pending here. Pausing for TTS inside this event would
  // reject the caller's play promise and incorrectly fail its navigation.
  state.dubVideoWaiting = true;
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});
els.video.addEventListener('playing', () => {
  state.dubVideoWaiting = false;
  startDubClock();
  // The browser settles play() only after dispatching `playing`. Wait for
  // that task to finish before a preparation hold is allowed to pause it.
  setTimeout(() => void syncDubPlayback(), 0);
});
els.video.addEventListener('ratechange', () => {
  for (const audio of dubChannels.values()) {
    audio.playbackRate = (audio._vqSpeechRate || 1) * (els.video.playbackRate || 1);
  }
});
els.video.addEventListener('ended', () => {
  finishDubPlaybackAtVideoEnd();
});
els.keepOriginalAudio?.addEventListener('change', () => {
  state.keepOriginalAudioEnabled = Boolean(els.keepOriginalAudio.checked);
  updateDubMix();
});
els.dubRetryBtn?.addEventListener('click', () => void retryDubBuffer());
els.dubContinueOriginalBtn?.addEventListener('click', () => void retryDubBuffer(true));

els.subtitleToggleBtn?.addEventListener('click', () => {
  state.subtitlesEnabled = !state.subtitlesEnabled;
  els.subtitleToggleBtn.textContent =
    `TR ALTYAZI: ${state.subtitlesEnabled ? 'AÇIK' : 'KAPALI'}`;
  renderSubtitle();
  if (state.subtitlesEnabled && !els.video.paused) startDubClock();
  if (!state.subtitlesEnabled && !state.dubbingEnabled) stopDubClock();
});

let languageSyncSave = Promise.resolve();
function updateLanguageSyncControls() {
  els.languageSyncControls?.classList.toggle('hidden', !state.dialogue?.segments?.length);
  if (els.languageSyncValue) {
    const offset = Number(state.languageSyncOffset) || 0;
    els.languageSyncValue.textContent = `Ses/yazı ${offset > 0 ? '+' : ''}${offset.toFixed(2).replace('.', ',')} sn`;
  }
}

function adjustLanguageSync(delta) {
  const previous = Number(state.languageSyncOffset) || 0;
  const offset = Math.max(-10, Math.min(10, Math.round((previous + delta) * 4) / 4));
  if (offset === previous) return;
  state.languageSyncOffset = offset;
  updateLanguageSyncControls();
  state.dubSyncGeneration += 1;
  stopDubPlayback();
  state.dubPlayedSegmentIds.clear();
  state.dubResumeTime = languageClockTime();
  resyncLanguageTracks();
  if (!els.video.paused) startDubClock();
  const id = state.activeSavedGameId;
  if (id) {
    languageSyncSave = languageSyncSave.then(() => savedGames?.setSyncOffset(id, offset))
      .catch(error => {
        if (els.analysisOutput) els.analysisOutput.textContent =
          `Ses eşitlemesi bu kayda yazılamadı: ${error?.message || error}`;
      });
  }
}
els.languageEarlierBtn?.addEventListener('click', () => adjustLanguageSync(0.25));
els.languageLaterBtn?.addEventListener('click', () => adjustLanguageSync(-0.25));

els.dubToggleBtn?.addEventListener('click', () => {
  if (state.dubBuffer) { void retryDubBuffer(true); return; }
  if (els.dubToggleBtn.dataset.unavailable === 'true') return;
  state.dubbingEnabled = !state.dubbingEnabled;
  els.dubToggleBtn.textContent = `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;
  if (!state.dubbingEnabled) {
    stopDubPlayback();
    return;
  }
  state.dubPlaybackBlocked = false;
  state.dubPlayedSegmentIds.clear();
  state.dubResumeTime = Math.max(0, Number(els.video.currentTime) || 0);
  updateDubMix();
  if (!els.video.paused) startDubClock();
  resyncLanguageTracks();
});

els.video.addEventListener('timeupdate', renderSubtitle);
els.video.addEventListener('seeked', renderSubtitle);

function analysisSourceKey(file, remote) {
  // The transport can change from a URL to a downloaded File during analysis.
  // Keep the same session identity so completed chapters/dialogue survive retry.
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
  // Playback uses the same bytes too; later seeks need no remote range requests.
  if (remote && !state.videoObjectUrl) {
    state.videoObjectUrl = URL.createObjectURL(localFile);
    els.video.src = state.videoObjectUrl;
    els.video.load();
  }
  return localFile;
}

els.analyzeBtn.addEventListener('click', async () => {
  if (state.analysisInProgress || state.urlResolutionInProgress || state.savedGameBusy) return;
  if (!state.selectedFile && !state.selectedRemoteVideo) return;
  state.analysisInProgress = true;
  state.savedGameReady = false;
  state.savedPlaybackOnly = false;
  try {
  els.analyzeBtn.disabled = true;
  els.videoInput.disabled = true;
  els.video.pause();
  if (videoUrlInput) videoUrlInput.disabled = true;
  if (resolveUrlBtn) resolveUrlBtn.disabled = true;
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Video harici analiz servisine gönderiliyor…\nSahte fallback kullanılmayacak.';
  setGameState('ANALYZING');

  let file = state.selectedFile;
  const modes = selectedAnalysisModes();
  if (modes.dubbing && !activeElevenLabsApiKey()) {
    throw new Error('Türkçe dublaj için ElevenLabs anahtarı gerekli. Anahtarı ekle veya yalnız altyazı/hareket analizini seç.');
  }
  const sourceKey = analysisSourceKey(file, state.selectedRemoteVideo);
  const requestedProtagonist = String(els.protagonistInput?.value || '').trim();
  let analysisModeKey = '';
  let dubPreparation = null;
  let dubPreparationPlan = null;
  const finishCompleteDub = async () => {
    if (!dubPreparation || !dubPreparationPlan) return;
    const { dialogue, dubSegments } = dubPreparationPlan;
    const ready = await dubPreparation;
    if (ready !== dubSegments.length) {
      const reason = state.dubFailureReason ? ` (${state.dubFailureReason})` : '';
      throw new Error(`Dublaj eksik kaldı: ${ready}/${dubSegments.length} blok hazır${reason}. Video dublajsız başlatılmadı.`);
    }
    dialogue.dubCoverage = { ready, total: dubSegments.length, complete: true };
    const initialSegments = nextDialogueSegments(dubSegments, 0, 2);
    await Promise.all(initialSegments.map(segment => prepareDubAudio(segment)));
    dubPreparation = null;
    dubPreparationPlan = null;
  };
  const reusableSession = state.analysisSession?.sourceKey === sourceKey;
  const session = reusableSession ? state.analysisSession : {
    sourceKey, file: file || null, dialogue: null, storyboard: null,
    remoteToken: state.selectedSourceKind === 'url' ? String(state.selectedRemoteToken || '') : '',
    analysisModeKey: '', chunkResults: [], protagonistProfile: '', storyContextMemory: null
  };
  if (state.selectedSourceKind === 'url' && state.selectedRemoteToken && !session.remoteToken) {
    session.remoteToken = state.selectedRemoteToken;
  }
  state.analysisSession = session;

  // Every analysis run must start from a clean dialogue/dub timeline.
  // Reusing old segment ids or old translated dialogue can attach stale audio
  // to new source-video timestamps after a re-analysis.
  state.dialogue = session.dialogue || null;
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
  state.dubbingEnabled = false;
  updateDubMix();
  state.subtitlesEnabled = false;
  if (!reusableSession) resetDubState();
  els.video.muted = false;
  els.subtitleOverlay?.classList.add('hidden');

  // Dialogue also supplies source evidence for character identity. Reuse the
  // same audio result across motion, subtitles and dubbing for this video.
  session.audioContextStatus = session.dialogue ? 'ready' : 'pending';
  // Finish one complete download before any audio or frame request. A retained
  // URL token must never override an already downloaded File on retry.
  if ((!session.dialogue && (modes.motion || modes.subtitles || modes.dubbing)) ||
      (modes.motion && !session.storyboard)) {
    file = await prepareStoryboardSource(session, file);
  }
  let fastStoryboardPreparation = null;
  if (modes.motion && !session.storyboard && session.remoteToken) {
    // Remote audio work happens entirely on the server, so use that time to
    // prepare local frames in parallel instead of doing the two long stages
    // serially.
    fastStoryboardPreparation = extractStoryboard(file, () => {}, undefined, { remoteSampling: false });
  }

  if (modes.motion || modes.subtitles || modes.dubbing) {
    try {
      const dialogue = session.dialogue || await analyzeSelectedDialogue(file, session);
      session.dialogue = dialogue;
      state.dialogue = dialogue;
      session.audioContextStatus = dialogue.segments.length ? 'ready' : 'no_speech';

      state.subtitlesEnabled = Boolean(modes.subtitles && dialogue.segments.length);
      els.subtitleToggleBtn.classList.toggle('hidden', !state.subtitlesEnabled);
      if (!state.subtitlesEnabled) {
        // Keep the speaker/text nodes mounted. Removing the overlay contents
        // leaves the cached element references detached, so a later successful
        // analysis updates invisible nodes and subtitles never return.
        els.subtitleSpeaker.textContent = '';
        els.subtitleText.textContent = '';
        els.subtitleOverlay.classList.add('hidden');
      }

      if (modes.dubbing && dialogue.segments.length) {
        state.dubbingEnabled = true;
        state.keepOriginalAudioEnabled = modes.keepOriginalAudio;
        els.dubToggleBtn?.classList.remove('hidden');
        updateDubMix();
        const dubSegments = dialogue.dubSegments || dialogue.segments;
        els.analysisState.textContent = 'PREPARING_DUB';
        els.analysisTitle.textContent = 'Türkçe dublajın tamamı hazırlanıyor';
        els.analysisOutput.textContent = `0/${dubSegments.length} konuşma bloğu hazır…`;
        await ensureDubVoicePlan();
        let completedDubBlocks = 0;
        dubPreparationPlan = { dialogue, dubSegments };
        dubPreparation = prepareCompleteDubTimeline(dubSegments, 2, (completed, total) => {
          completedDubBlocks = completed;
          if (!modes.motion) {
            els.analysisOutput.textContent = `${completed}/${total} konuşma bloğu ElevenLabs ile hazırlandı…`;
          }
        });
        if (!modes.motion) {
          await finishCompleteDub();
          els.analysisOutput.textContent = `${dialogue.dubCoverage.ready}/${dubSegments.length} konuşma bloğunun tamamı Türkçe dublaja hazır.`;
        } else {
          logEngineEvent('DUB_PREPARATION_OVERLAPPED', { total: dubSegments.length, completed: completedDubBlocks });
        }
      }

      if (!modes.motion) {
        els.playerSection.classList.remove('hidden');
        els.analysisState.textContent = dialogue.segments.length
          ? 'DIALOGUE_READY'
          : 'NO_DIALOGUE';
        els.analysisTitle.textContent = dialogue.segments.length
          ? `${dialogue.segments.length} Türkçe diyalog bölümü hazır`
          : 'Anlaşılabilir diyalog bulunamadı';
        els.analysisOutput.textContent = [
          dialogue.summaryTr || 'Diyalog analizi tamamlandı.',
          `${dialogue.speakers?.length || 0} konuşmacı algılandı.`,
          modes.dubbing
            ? `${dialogue.dubCoverage?.ready || 0}/${dialogue.dubCoverage?.total || 0} dublaj bloğunun tamamı hazır.`
            : 'Türkçe altyazılar kullanıma hazır.'
        ].join('\n');
        setGameState('DIALOGUE_READY');
        state.analysis = null;
        state.savedGameReady = true;
        await savedGames?.saveCurrent(true);
        return;
      }
    } catch (error) {
      session.audioContextStatus = 'unavailable';
      logEngineEvent('AUDIO_CONTEXT_UNAVAILABLE', { message: String(error.message || error).slice(0, 300) });
      els.analysisState.textContent = 'DIALOGUE_ERROR';
      els.analysisOutput.textContent =
        `Diyalog analizi başarısız: ${error.message}`;

      if (modes.dubbing || !modes.motion) {
        setGameState('ERROR');
        return;
      }
    }
  }
  const remoteStoryboardSource = state.selectedRemoteVideo;
  const storyboardSource = session.storyboard ? null : await prepareStoryboardSource(session, file);
  els.analysisTitle.textContent = 'Video cihazdan işleniyor';
  els.analysisState.textContent = 'LOCAL_PROCESSING';
  const storyboard = session.storyboard || await (fastStoryboardPreparation || extractStoryboard(storyboardSource, (progress, detail) => {
    const count = detail ? `${detail.captured}/${detail.total} kare · ` : '';
    els.analysisTitle.textContent = `Cihazdan kareler hazırlanıyor: ${count}%${Math.round(progress)}`;
    if (!detail) return;
    els.analysisOutput.textContent = [
      Number.isFinite(detail.time) ? `Videodaki konum: ${detail.time.toFixed(1)} sn${detail.retrying ? ' · yeniden deneniyor' : ''}` : 'Kareler analiz için birleştiriliyor…',
      `${Math.round(detail.elapsedSeconds)} sn geçti`
    ].join('\n');
  }, undefined, {
    // Preserve every original sample, including focused motion probes, even
    // though the URL video's bytes are now local.
    remoteSampling: Boolean(remoteStoryboardSource)
  }));
  session.storyboard = storyboard;
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

    const dialogueRows = state.dialogue?.segments || [];
    const dialogueSample = [
      dialogueRows.length,
      ...dialogueRows.slice(0, 4).map(row => `${row.segmentId}:${row.startTime}:${row.gender}`),
      ...dialogueRows.slice(-4).map(row => `${row.segmentId}:${row.startTime}:${row.gender}`)
    ].join('|');
    analysisModeKey = JSON.stringify({
      pipelineVersion: 'source-context-3',
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
    const chunkResults = session.chunkResults;
    session.firstPassResults ||= {};
    let failureBody = null;
    let failedChunk = null;
    let response = null;
    let body = null;

    let protagonistProfile = session.protagonistProfile || requestedProtagonist;
    let storyContextMemory = session.storyContextMemory || normalizeStoryContext({});

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      // Resume by index: completed later chapters survive a failure in the middle.
      if (chunkResults[chunkIndex]?.available || chunkResults[chunkIndex]?.retryable === false) continue;
      // A retry in the middle only receives context from earlier chapters.
      storyContextMemory = mergeStoryContexts(chunkResults.slice(0, chunkIndex).filter(result => result?.available));
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

    const chunkDialogue = (state.dialogue?.segments || []).filter(segment =>
      Number(segment.endTime) >= chunkStart &&
      Number(segment.startTime) <= chunkEnd
    );

    form.append('dialogueContext', JSON.stringify(chunkDialogue));
    form.append('dialogueSpeakerContext', JSON.stringify((state.dialogue?.speakers || []).map(speaker => ({
      speakerId: speaker.speakerId, speakerName: speaker.speakerName,
      description: speaker.description
    }))));
    const chunkSensoryAudio = (state.dialogue?.nonSpeechEvents || []).filter(event =>
      Number(event.endTime) >= chunkStart && Number(event.startTime) <= chunkEnd
    );
    form.append('sensoryAudioContext', JSON.stringify(chunkSensoryAudio));
    form.append('qualityMode', modes.quality);
    form.append('protagonistProfile', protagonistProfile);
      form.append('storyContextMemory', JSON.stringify(storyContextMemory));

      const freshChunkForm = () => {
        const next = new FormData();
        form.forEach((value, key) => {
          if (typeof value === 'string') next.append(key, value);
          else next.append(key, value, value.name || 'storyboard.jpg');
        });
        return next;
      };

      els.analysisTitle.textContent =
        `Derin analiz: bölüm ${chunkIndex + 1}/${chunkCount}`;

      els.analysisState.textContent = 'DEEP_CHUNK_ANALYSIS';

      els.analysisOutput.textContent =
        `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...`;

      let chunkSucceeded = false;
      let firstPassBody = session.firstPassResults[chunkIndex] || null;
      failureBody = null;

      const maxChunkAttempts = 4;
      for (let attempt = 1; attempt <= maxChunkAttempts && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\n` +
          `Deneme ${attempt}/${maxChunkAttempts} · tamamlanan ${chunkResults.filter(result => result?.available).length}/${chunkCount}`;

        // Keep a completed first pass when only its review needs retrying.
        form.delete('reviewMode');
        form.delete('reviewCandidates');

        try {
          if (firstPassBody) {
            body = firstPassBody;
            response = { ok: true };
          } else {
            response = await fetch('/api/gemini-storyboard-analyze', {
              method: 'POST',
              headers: geminiRequestHeaders(),
              body: freshChunkForm(),
              signal: AbortSignal.timeout(240000)
            });

            body = await response.json();
            recordAiUsage(body?.aiUsage);

            if (response.ok && body?.available) {
              const normalizedChunk = normalizeChunkActionTimes(
                body.actions,
                chunkStart,
                chunkEnd
              );
              body = {
                ...body,
                actions: normalizedChunk.actions,
                chunkStart,
                chunkEnd,
                chunkTimeRebased: normalizedChunk.rebased
              };
              firstPassBody = body;
              session.firstPassResults[chunkIndex] = body;
            }
          }

          if (!response.ok || !body?.available) {
            failureBody = body || {
              available: false,
              reason: 'CHUNK_ANALYSIS_FAILED',
              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
            };
            if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
              break;
            }
          } else {
            const criticalReviewCandidates = secondPassReviewCandidates(body);
            if (criticalReviewCandidates.length) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(criticalReviewCandidates));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye · ${criticalReviewCandidates.length} bulgu ikinci kez doğrulanıyor...\nHazır kareler yeniden kullanılıyor; videodan tekrar kare çıkarılmıyor.`;
              const reviewResponse = await fetch('/api/gemini-storyboard-analyze', {
                method: 'POST',
                headers: geminiRequestHeaders(),
                body: freshChunkForm(),
                signal: AbortSignal.timeout(240000)
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
                failureBody = reviewBody || {
                  available: false,
                  reason: 'SECOND_PASS_REVIEW_FAILED',
                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`
                };
                if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
                  break;
                }
                // Apply the same retry delay to failed review requests as to
                // failed initial requests; preserve the provider's reason.
                throw Object.assign(new Error(failureBody.message || 'Doğrulama isteği başarısız.'), {
                  analysisFailure: failureBody
                });
              }
              body = mergeSecondPassReview(body, reviewBody, criticalReviewCandidates);
            }
            chunkResults[chunkIndex] = body;
            delete session.firstPassResults[chunkIndex];
            storyContextMemory = mergeStoryContexts(chunkResults.filter(result => result?.available));
            if (body.protagonistProfile) {
              protagonistProfile = String(body.protagonistProfile).trim();
            }
            session.chunkResults = chunkResults;
            session.storyContextMemory = storyContextMemory;
            session.protagonistProfile = protagonistProfile;
            chunkSucceeded = true;
            failureBody = null;
            break;
          }
        } catch (error) {
          failureBody = error?.analysisFailure || {
            available: false,
            reason: 'NETWORK_ERROR',
            message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
            error: error?.message || String(error)
          };
        }

        if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
          break;
        }

        if (attempt < maxChunkAttempts) {
          const retryDelay = Math.min(12000, 1800 * (2 ** (attempt - 1)));
          els.analysisOutput.textContent =
            `Bölüm ${chunkIndex + 1}/${chunkCount} geçici olarak başarısız oldu.\n` +
            `${Math.ceil(retryDelay / 1000)} saniye sonra yalnız bu bölüm yeniden denenecek...\n` +
            `Tamamlanan bölümler korunuyor: ${chunkResults.filter(result => result?.available).length}/${chunkCount}`;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }

      if (!chunkSucceeded) {
        if (!canContinuePastChunkFailure(failureBody)) {
          failedChunk = chunkIndex + 1;
          break;
        }
        chunkResults[chunkIndex] = chunkGapResult(failureBody, chunkIndex, chunkStart, chunkEnd);
        session.chunkResults = chunkResults;
        els.analysisState.textContent = 'CONTINUING_WITH_GAP';
        els.analysisOutput.textContent = `Bölüm ${chunkIndex + 1} okunamadı; tamamlanan bölümler korunarak sıradaki bölüme geçiliyor.`;
        failureBody = null;
      }
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
      const fallbackResponse = await fetch('/api/external-analyze', {
        method: 'POST',
        body: fallbackForm,
        signal: AbortSignal.timeout(900000)
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

  if (dubPreparation) {
    els.analysisState.textContent = 'FINALIZING_DUB';
    els.analysisTitle.textContent = 'Görsel analiz hazır · dublaj tamamlanıyor';
    els.analysisOutput.textContent = 'Görsel analiz sürerken hazırlanan Türkçe seslerin son kontrolü yapılıyor…';
    await finishCompleteDub();
  }

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
  try {
    // Analysis persistence intentionally disabled: refresh must start clean.
    localStorage.removeItem("videoquest:last-analysis");
  } catch (error) {
    console.warn("Analysis could not be saved locally:", error);
  }
  els.analysisState.textContent = body.partial ? 'PARTIAL_TIMELINE_READY' : 'TIMELINE_READY';
  els.analysisTitle.textContent = `${body.partial ? 'Kısmi analiz hazır · ' : ''}${normalized.actions.length} doğrulanmış aksiyon`;
  els.analysisOutput.textContent = [
    body.partial ? 'Analiz kısmen hazır. Okunamayan aralıklarda seçenek üretilmedi.' : 'Derin analiz tamamlandı.',
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
    `Gemini kullanımı: ${state.aiUsage.requests} istek · ${state.aiUsage.inputTokens} giriş · ${state.aiUsage.outputTokens} çıkış tokenı.`,
    body.partial ? 'Doğrulanmış bölümlerle oynayabilirsin. Yeniden analiz, yalnız geçici hata veren eksik bölümleri dener.' : 'Oyun modu kullanıma hazır.'
  ].join('\n');
  initializeInteractive(normalized);
  state.savedGameReady = true;
  await savedGames?.saveCurrent(true);
  } catch (error) {
    console.error('Analysis failed:', error);
    els.analysisState.textContent = 'ANALYSIS_ERROR';
    els.analysisTitle.textContent = 'Analiz tamamlanamadı';
    els.analysisOutput.textContent =
      error?.message || 'Beklenmeyen bir analiz hatası oluştu.';
    setGameState('ERROR');
    renderDebug({ analysisError: error?.message || String(error) });
  } finally {
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

function initializeInteractive(analysis) {
  cancelTimelineNavigation();
  const requestedStart = Number(
    analysis.playStartTime ??
    analysis.introEndTime ??
    Math.min(analysis.unownedSourceIntervals?.[0]?.startTime ?? Infinity,
      analysis.actions?.[0]?.startTime ?? Infinity) ??
    0
  );

  const playStartTime = Number.isFinite(requestedStart)
    ? Math.max(0, requestedStart)
    : 0;

  state.gameCursorTime = playStartTime;

  const seekToMainScene = () => {
    const safeDuration = Number.isFinite(els.video.duration)
      ? els.video.duration
      : playStartTime;

    els.video.pause();
    els.video.currentTime = Math.min(
      playStartTime,
      Math.max(0, safeDuration - 0.05)
    );
  };

  if (els.video.readyState >= 1) {
    seekToMainScene();
  } else {
    els.video.addEventListener('loadedmetadata', seekToMainScene, {
      once: true
    });
  }
  state.currentActionIndex = -1;
  state.consumedActionIds.clear();
  state.activeAction = null;
  state.adultMode = false;
  state.adultScene = null;
  state.completedAdultSceneIds = new Set();
  state.activePositionId = null;
  state.activeAdultOccurrenceId = null;
  state.activeAdultCategory = null;
  state.activeAdultPartnerTrackId = null;
  state.activeMovementId = null;
  state.adultSelectionToken += 1;
  cancelAdultSeek();
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultMaleOrgasmProgress = 0;
  state.adultFemaleOrgasmProgress = 0;
  state.adultMaleOrgasmCount = 0;
  state.adultFemaleOrgasmCount = 0;
  state.adultOrgasmDecision = null;
  state.adultSexUnlocked = false;
  state.adultUnlockedPositionIds = new Set();
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultClimaxProgress = 0;
  state.adultCorePlaySeconds = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.activeMovementChoiceId = null;
  state.adultUnlockedOutcomeIds = new Set();
  state.adultRevealedPositionIds = new Set();
  state.adultUiSignature = '';
  state.adultLastUiPhase = 'foreplay';
  state.adultPhaseMachine = 'foreplay';
  prepareAdultScenes();
  const restoredSnapshot = restoreRuntimeSnapshot(analysis);
  if (restoredSnapshot) {
    const restoreTarget = Math.max(0, Number(state.gameCursorTime) || 0);
    const applyRestoreSeek = () => {
      if (Number.isFinite(els.video.duration)) {
        els.video.pause();
        els.video.currentTime = Math.min(restoreTarget, Math.max(0, els.video.duration - 0.05));
      }
    };
    if (els.video.readyState >= 1) applyRestoreSeek();
    else els.video.addEventListener('loadedmetadata', applyRestoreSeek, { once: true });
  }
  els.adultInteractionPanel?.classList.add("hidden");
  els.playerSection.classList.remove('hidden');
  els.videoPrompt.textContent = typeof analysis.videoPrompt === 'string' ? analysis.videoPrompt : JSON.stringify(analysis.videoPrompt, null, 2);
  renderTimeline();
  setGameState('DECISION_PENDING');
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
    spoon: 'Kaşık Pozisyonu',
    'reverse-spoon': 'Ters Kaşık Pozisyonu',
    'standing-rear': 'Ayakta Arkadan Pozisyon',
    rear: 'Arkadan Pozisyon',
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
const ADULT_FRAGMENT_MERGE_GAP_SECONDS = 18;

function mergeAdultSceneFragments(scenes, nonAdultActions = [], unownedIntervals = []) {
  const sorted = [...(Array.isArray(scenes) ? scenes : [])]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const merged = [];

  for (const scene of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...scene });
      continue;
    }

    const gap = Number(scene.startTime) - Number(previous.endTime);
    const unownedBarrier = unownedIntervals.some(interval =>
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
    if (gap > ADULT_FRAGMENT_MERGE_GAP_SECONDS || narrativeBarrier || unownedBarrier) {
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
  const actions = (state.analysis?.actions || []).map(action => bindActionCharacter(
    normalizeSourceActionTimes(action), state.analysis?.storyContext || {}));
  const traceRows = actions.map((action, index) => ({
    index,
    actionId: String(action?.actionId || `action-${index}`),
    label: String(action?.label || ''),
    startTime: Number(action?.startTime),
    endTime: Number(action?.endTime),
    sourceVerified: action?.sourceVerified === true,
    confidence: Number(action?.confidence || 0),
    input: {
      adultScene: Boolean(action?.adultScene),
      adultSceneId: String(action?.adultSceneId || ''),
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
      movementType: String(action?.movementType || ''),
      movementTempo: String(action?.movementTempo || ''),
      positionStartTime: Number(action?.positionStartTime),
      positionEndTime: Number(action?.positionEndTime),
      loopStartTime: Number(action?.loopStartTime),
      loopEndTime: Number(action?.loopEndTime)
    },
    detectedFamily: verifiedAdultPositionFamily(action) || '',
    sceneCandidate: false,
    sceneCandidateReason: 'NOT_EVALUATED',
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
      status: state.analysisSession?.audioContextStatus || (state.dialogue ? 'ready' : 'unavailable'),
      segmentCount: state.dialogue?.segments?.length || 0,
      speakerCount: state.dialogue?.speakers?.length || 0
    },
    actions: traceRows,
    graph: null,
    warnings: [...(state.analysis?.warnings || [])]
  };
  const sceneMap = new Map();
  const sceneOccurrenceIds = assignAdultSceneOccurrenceIds(actions);
  const sceneOccurrenceByAction = new Map(
    actions.map((action, index) => [action, sceneOccurrenceIds[index]])
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
      const validTime = isPlayableVerifiedPositionDuration(start, end);
      const validConfidence = Number(action.confidence || 0) >= 0.6;
      row.sceneCandidate = validTime && validConfidence;
      row.sceneCandidateReason = !validTime
        ? 'REJECTED_POSITION_SHORTER_THAN_3_SECONDS_OR_INVALID_TIME'
        : (!validConfidence ? 'REJECTED_CONFIDENCE_BELOW_0_60' : 'ACCEPTED_VERIFIED_POSITION');
      return row.sceneCandidate;
    }).map(sceneIdFor)
  );

  const introductions = matchSceneIntroductions(actions,
    actions.filter(action => traceByAction.get(action).sceneCandidate)
      .map(action => ({ action, sceneId: sceneIdFor(action) })),
    action => ['kiss', 'touch', 'clothing', 'body_transition'].includes(action.actionType) &&
      !action.positionId && !action.positionLabel &&
      !(action.relationshipResolution === 'verified' && action.relationshipRoleLabel &&
        !isAdultSocialRelationshipRole(action.relationshipRoleLabel)));
  introductions.forEach((sceneId, action) => sceneOccurrenceByAction.set(action, sceneId));

  actions.filter(action =>
    verifiedPositionSceneIds.has(sceneIdFor(action))
  ).forEach((action, index) => {
    const sceneId = sceneIdFor(action);
    const traceRow = traceByAction.get(action);
    traceRow.finalSceneId = sceneId;

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
      const startTime = Math.max(
        scene.startTime,
        Number(action.outcomeStartTime ?? action.startTime)
      );
      const endTime = Math.min(
        scene.endTime,
        Number(action.outcomeEndTime ?? action.endTime)
      );

      if (action.sourceVerified === true && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime - startTime >= 2) {
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
    const hasPositionEvidence = Boolean(
      action.positionId ||
      action.positionLabel ||
      playableAdultPanelFamily(action)
    );
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
      const labelKey = normalizeAdultLabel(action.label || action.movementType || '');
      const explicitWarmup = ['kiss', 'touch', 'clothing', 'body_transition'].includes(actionType);
      const sourceDialogue = actionType === 'other' &&
        !/\b(?:pozisyon|seks|oral)\b/iu.test(action.label || '');
      const labelWarmup = /\b(op|opus|dokun|oksa|soyun|cikar|saril|elle|elini|tenine)\b/.test(labelKey);
      const startTime = Math.max(scene.startTime, Number(action.startTime));
      const endTime = Math.min(scene.endTime, Number(action.endTime));

      if (
        action.sourceVerified === true &&
        (explicitWarmup || sourceDialogue || (actionType === 'other' && labelWarmup)) &&
        action.label &&
        Number.isFinite(startTime) &&
        Number.isFinite(endTime) &&
        endTime - startTime >= 2
      ) {
        traceRow.route = 'FOREPLAY';
        traceRow.routeReason = sourceDialogue ? 'SOURCE_DIALOGUE_OVERLAY' : 'EXPLICIT_OR_LABEL_WARMUP';
        scene.foreplay.push({
          id: action.actionId || `${sceneId}:warmup-${index}`,
          label: sourceIdentityLabel(action.narrativeChoiceLabel || action.label,
            { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel }),
          sourceVerified: true,
          nonIntimate: sourceDialogue,
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

    const correctedStart = canonical.correctedFromAction
      ? Number(action.startTime)
      : Number(action.positionStartTime ?? action.startTime);
    const correctedEnd = canonical.correctedFromAction
      ? Number(action.endTime)
      : Number(action.positionEndTime ?? action.endTime);

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
        activityTypeConfidence: Number(action.activityTypeConfidence || 0),
        label: sourceIdentityLabel(activityDisplayLabel(canonical.label, action),
          { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel }),
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
      const movementStart = Math.max(
        position.startTime,
        Number(action.startTime),
        Number(action.loopStartTime ?? action.startTime)
      );
      const movementEnd = Math.min(
        position.endTime,
        Number(action.endTime),
        Number(action.loopEndTime ?? action.endTime)
      );
      if (movementBelongsToVerifiedPosition(action, canonical.id)) {
        traceRow.movementAccepted = true;
        traceRow.movementReason = 'MOVEMENT_MATCHES_CANONICAL_POSITION';
        position.sourceRanges.push({
          id: position.id,
          startTime: movementStart,
          endTime: movementEnd
        });
        position.movements.push({
          ...action,
          id: action.actionId || `movement-${index}`,
          sourcePositionId: position.id,
          label: sourceIdentityLabel(action.narrativeChoiceLabel || action.label,
            { ...action, primaryCharacterLabel: action.partnerLabel || action.primaryCharacterLabel }),
          loopStartTime: movementStart,
          loopEndTime: movementEnd
        });
      } else {
        traceRow.movementReason = 'REJECTED_MOVEMENT_POSITION_CONFLICT';
      }
    } else {
      traceRow.movementReason = 'NO_MOVEMENT_LABEL_OR_TYPE';
    }
  });

  state.adultScenes = [...sceneMap.values()]
    .map(scene => {
      const foreplay = [...scene.foreplay]
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((items, item) => {
          const previous = items[items.length - 1];
          const sameLabel = previous &&
            normalizeAdultLabel(previous.label) === normalizeAdultLabel(item.label);
          if (previous && sameLabel && item.startTime <= previous.endTime + 0.25) {
            previous.endTime = Math.max(previous.endTime, item.endTime);
            return items;
          }
          items.push({ ...item });
          return items;
        }, []);

      const outcomes = [...scene.outcomes]
        .filter(item => item.endTime - item.startTime >= 2)
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((items, item) => {
          const previous = items[items.length - 1];
          const sameLabel = previous &&
            normalizeAdultLabel(previous.label) === normalizeAdultLabel(item.label);
          if (previous && sameLabel && item.startTime <= previous.endTime + 0.25) {
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
            return { ...position, movements };
          })
          .filter(position => position.movements.length &&
            isPlayableVerifiedPositionDuration(position.startTime, position.endTime))
          .sort((a, b) => a.startTime - b.startTime);
      if (!positions.length) return { ...scene, foreplay: [], outcomes, positions: [] };
      const positionStart = Math.min(...positions.map(position => Number(position.startTime)));
      const interactionEnd = Math.max(...positions.map(position => Number(position.endTime)));
      // The Lust warm-up panel is only for source actions that occur before
      // the first verified position. A later partner switch must never be
      // offered as the first choice and seek the player hundreds of seconds
      // forward in the source timeline.
      const playableForeplay = foreplay.filter(item =>
        item.sourceVerified === true && Number(item.endTime) > Number(item.startTime));
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
    .filter(scene => scene.positions.length)
    .sort((a, b) => a.startTime - b.startTime);

  // Providers frequently split one continuous encounter into several scene
  // ids. Merge nearby fragments unless a verified narrative barrier exists;
  // otherwise early oral/manual clips become isolated panels and skipping one
  // incorrectly reveals every later position.
  state.adultScenes = mergeAdultSceneFragments(
    state.adultScenes,
    actions.filter(action => !action?.adultScene && !String(action?.adultSceneId || '').trim()),
    state.analysis?.unownedSourceIntervals || []
  );

  state.adultScenes.forEach(scene => {
    const firstCoreStart = scene.positions
      .reduce((earliest, position) => Math.min(earliest, Number(position.startTime)), Number.POSITIVE_INFINITY);
    // Merging source fragments must not move a later introduction into the
    // first-entry gate of this encounter.
    scene.foreplay = scene.foreplay.filter(item => Number(item.endTime) <= firstCoreStart + 0.05 ||
      Number(item.startTime) >= firstCoreStart - 0.05);
    scene.positions = scene.positions.map(position => {
      return {
        ...position,
        progressionRole: 'core'
      };
    });
    scene.positions = consolidateVerifiedPositions(scene.positions, {
      mergeDistantReturns: false
    }).map(position => {
      const controlClipIds = isWarmupPosition(position) ? new Set() : exclusiveControlClipIds(position);
      return {
        ...position,
        controlClipIds: [...controlClipIds],
        movementChoices: buildVerifiedMovementChoices(
          position.movements.filter(item => item.id !== position.entryMovementId && !controlClipIds.has(item.id)),
          position.label,
          5,
          position
        )
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
  state.adultAnalysisTrace.warnings = [
    ...state.adultAnalysisTrace.warnings,
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
  return JSON.stringify(state.adultAnalysisTrace || {
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

function findAdultSceneAt(time) {
  return findAdultSceneForTimeline(state.adultScenes, {
    time,
    completedSceneIds: state.completedAdultSceneIds
  });
}


function adultTimeLabel(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

const ADULT_LUST_UNLOCK_THRESHOLD = 35;

function currentAdultFlow() {
  const raw = Math.min(ADULT_LUST_UNLOCK_THRESHOLD, Math.max(0, Number(state.femaleSceneProgress) || 0));
  return (raw / ADULT_LUST_UNLOCK_THRESHOLD) * 100;
}

function orderedLockedAdultPositions(scene = state.adultScene) {
  return (scene?.positions || [])
    .filter(position => !isWarmupPosition(position))
    .filter(position => !state.adultUnlockedPositionIds.has(position.id))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

function unlockNextAdultPositionFromLust() {
  if (currentAdultFlow() < 99.9 || state.adultOutcomePhase !== 'idle' || state.adultOrgasmDecision) return null;
  const firstUnlock = !state.adultSexUnlocked;
  const positions = state.adultScene?.positions || [];
  // A full meter may open the first nearby verified segment. Requiring the
  // playhead to reach the segment first can strand a paused introduction.
  const latestUnlocked = positions.filter(position =>
    !isWarmupPosition(position) && state.adultUnlockedPositionIds.has(position.id)
  ).sort((a, b) => Number(b.startTime) - Number(a.startTime))[0];
  // Each cycle opens one chronological step. The previous step must actually
  // have started playback; clicking locked/stalled cards cannot skip it.
  if (!firstUnlock && (!latestUnlocked || !state.adultVisitedPositionIds.has(latestUnlocked.id))) return null;
  const locked = orderedLockedAdultPositions();
  const cursor = Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0);
  const coreVisited = (state.adultScene?.positions || []).some(position =>
    !isWarmupPosition(position) && !isBonusPosition(position) &&
    state.adultVisitedPositionIds.has(position.id)
  );
  const next = locked.find(position =>
    (!state.adultSexUnlocked ? !isBonusPosition(position) : coreVisited) &&
    forwardLocalMovementClips(position, cursor).length
  );
  if (!next) return null;
  state.adultUnlockedPositionIds.add(next.id);
  state.adultRevealedPositionIds.add(next.id);
  state.adultSexUnlocked = true;
  state.femaleSceneProgress = 0;
  state.adultUiSignature = '';
  logEngineEvent('LUST_POSITION_UNLOCKED', {
    positionId: next.id,
    bonus: isBonusPosition(next)
  });
  if (firstUnlock) {
    const scene = state.adultScene;
    const token = state.adultSelectionToken;
    // Defer until the current playback/progress handler has finished. A newer
    // user selection or scene exit supersedes this automatic first entry.
    queueMicrotask(() => {
      if (!state.adultMode || state.adultScene !== scene || token !== state.adultSelectionToken ||
          state.adultOutcomePhase !== 'idle') return;
      renderAdultProgressiveUI(true);
      selectAdultPosition(next.id, true);
    });
  }
  return next;
}

function addFemaleLust(amount) {
  if (state.adultOrgasmDecision) return null;
  state.femaleSceneProgress = Math.min(
    ADULT_LUST_UNLOCK_THRESHOLD,
    Math.max(0, Number(state.femaleSceneProgress) || 0) + Math.max(0, Number(amount) || 0)
  );
  if (state.femaleSceneProgress + 0.001 < ADULT_LUST_UNLOCK_THRESHOLD) return null;
  const active = state.adultScene?.positions?.find(item => item.id === state.activePositionId);
  if (state.adultSexUnlocked && (!active || isWarmupPosition(active))) return null;
  return unlockNextAdultPositionFromLust();
}

function triggerAdultOrgasmDecision() {
  if (state.adultOrgasmDecision || state.adultOutcomePhase !== 'idle') return false;
  const maleReady = state.adultMaleOrgasmProgress >= 100;
  if (!maleReady) return false;
  const actor = 'male';
  state.adultOrgasmDecision = {
    actor,
    mediaTime: Number(els.video?.currentTime || 0),
    resumePositionId: state.activePositionId,
    resumeMovementId: state.activeMovementId,
    resumeOccurrenceId: state.activeAdultOccurrenceId,
    resumeCategory: state.activeAdultCategory,
    resumePhase: state.adultPhaseMachine,
    resumeTimelineFloor: state.adultTimelineFloor,
    hasVerifiedOutcome: false
  };
  const position = state.adultScene?.positions?.find(item => item.id === state.activePositionId);
  const outcomes = [...(state.adultScene?.outcomes || [])]
    .filter(item => item.sourceVerified === true &&
      Number(item.startTime) >= state.adultOrgasmDecision.mediaTime - 0.05 &&
      (position?.groupScene
        ? Boolean(position.partnerTrackId && item.partnerTrackId === position.partnerTrackId)
        : (!position?.partnerTrackId || !item.partnerTrackId || item.partnerTrackId === position.partnerTrackId)))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const outcome = outcomes.find(item => !state.adultPlayedOutcomeIds.has(item.id)) || outcomes[0];
  if (outcome) {
    state.adultOrgasmDecision.hasVerifiedOutcome = true;
    if (playAdultOutcome(outcome.id, { orgasmTriggered: true })) return true;
    state.adultOrgasmDecision.hasVerifiedOutcome = false;
  }
  return openAdultOrgasmDecision();
}

function openAdultOrgasmDecision() {
  const actor = state.adultOrgasmDecision?.actor;
  if (!actor) return false;
  state.adultOutcomePhase = 'orgasm-decision';
  els.video?.pause();
  els.orgasmDecision?.classList.remove('hidden');
  if (els.orgasmDecisionTitle) {
    els.orgasmDecisionTitle.textContent = !state.adultOrgasmDecision.hasVerifiedOutcome
      ? 'Doğrulanmış final kesiti bulunamadı'
      : actor === 'both'
      ? 'Kadın ve erkek orgazm oldu'
      : actor === 'female' ? 'Kadın orgazm oldu' : 'Erkek orgazm oldu';
  }
  if (els.orgasmDecisionMeta) {
    els.orgasmDecisionMeta.textContent =
      'Devam et: dolan orgazm barını sıfırla ve aynı gerçek video akışını sürdür. Bitir: sahneyi kapat.';
  }
  logEngineEvent('ORGASM_DECISION_OPENED', { actor });
  renderAdultProgress();
  return true;
}

function continueAfterAdultOrgasm() {
  const decision = state.adultOrgasmDecision;
  const actor = decision?.actor;
  if (!actor || state.adultOutcomePhase !== 'orgasm-decision') return;
  const resumePosition = state.adultScene?.positions?.find(item => item.id === decision.resumePositionId);
  const occurrenceId = decision.resumeOccurrenceId || positionOccurrenceGroups(resumePosition)[0]?.id;
  const resumeMovement = resumePosition && movementsForPositionOccurrence(resumePosition, occurrenceId)
    .find(item => item.id === decision.resumeMovementId);
  const resumeTime = Number(decision.mediaTime);
  if (!resumeMovement || !Number.isFinite(resumeTime) ||
      resumeTime < Number(resumeMovement.loopStartTime) - 0.05 ||
      resumeTime >= Number(resumeMovement.loopEndTime)) {
    if (els.orgasmDecisionMeta) els.orgasmDecisionMeta.textContent =
      'Kayıtlı devam noktası bu kesitte bulunamadı. Sahneyi bitirebilirsin.';
    return;
  }
  const token = beginAdultSelection();
  if (actor === 'female' || actor === 'both') {
    state.adultFemaleOrgasmProgress = 0;
    state.adultFemaleOrgasmCount += 1;
  }
  if (actor === 'male' || actor === 'both') {
    state.adultMaleOrgasmProgress = 0;
    state.adultMaleOrgasmCount += 1;
  }
  state.adultOrgasmDecision = null;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activePositionId = resumePosition.id;
  state.activeAdultOccurrenceId = occurrenceId;
  state.activeMovementId = resumeMovement.id;
  state.activeAdultCategory = decision.resumeCategory || 'all';
  state.adultTimelineFloor = Number.isFinite(Number(decision.resumeTimelineFloor))
    ? Number(decision.resumeTimelineFloor) : Number(resumePosition.startTime);
  // Returning from an outcome is an intentional branch return, not a new
  // unlock. Restore the saved phase rather than the monotonic forward phase.
  state.adultPhaseMachine = decision.resumePhase || 'positions';
  state.adultLastUiPhase = state.adultPhaseMachine;
  state.adultUiSignature = '';
  els.orgasmDecision?.classList.add('hidden');
  logEngineEvent('ORGASM_CONTINUED', {
    actor,
    femaleCount: state.adultFemaleOrgasmCount,
    maleCount: state.adultMaleOrgasmCount
  });
  renderAdultProgress();
  void seekAdultLoop(resumeTime, token);
}

function adultWarmupStats(scene = state.adultScene) {
  const warmupPositions = (scene?.positions || []).filter(isWarmupPosition);
  const warmupActionIds = new Set((scene?.foreplay || []).map(item => item.id));
  let warmupUniquePlayed = 0;

  warmupActionIds.forEach(id => {
    if (Number(state.adultPreludePlayCounts.get(id) || 0) > 0) warmupUniquePlayed += 1;
  });
  warmupPositions.forEach(position => {
    if (state.adultVisitedPositionIds.has(position.id)) warmupUniquePlayed += 1;
  });

  return {
    warmupTotal: warmupActionIds.size + warmupPositions.length,
    warmupUniquePlayed
  };
}

function unlockedAdultPositions(scene = state.adultScene) {
  const positions = scene?.positions || [];
  if (!state.adultSexUnlocked) return positions.filter(isWarmupPosition);
  const unlocked = positions
    .filter(position => !isWarmupPosition(position) && state.adultUnlockedPositionIds.has(position.id))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  // Keep every position the player has unlocked visible. Showing only the
  // newest one turned the panel into a single-choice dead end and made earlier
  // valid selections disappear after each Lust unlock.
  return unlocked;
}

function unlockedAdultOutcomes(scene = state.adultScene) {
  const corePositions = (scene?.positions || []).filter(position =>
    !isWarmupPosition(position) && !isBonusPosition(position)
  );
  const coreVisitedCount = corePositions.filter(position =>
    state.adultVisitedPositionIds.has(position.id)
  ).length;

  return (scene?.outcomes || []).filter(outcome =>
    canUnlockOutcome({
      outcome,
      climaxProgress: state.adultClimaxProgress,
      coreVisitedCount,
      corePlaySeconds: state.adultCorePlaySeconds,
      requiredCorePlaySeconds: requiredCorePlaySecondsForOutcome(
        Math.max(0, Number(scene?.endTime) - Number(scene?.startTime))
      )
    })
  );
}

function nextAdultDiscovery(scene = state.adultScene) {
  const positionTarget = orderedLockedAdultPositions(scene)[0];
  return positionTarget
    ? { type: isBonusPosition(positionTarget) ? 'reward' : 'position', progress: 100 }
    : null;
}

function renderAdultFlowStatus() {
  if (!els.adultFlowStatus) return;
  const flow = currentAdultFlow();
  els.adultFlowStatus.textContent =
    `Açılan ${state.adultUnlockedPositionIds.size} · combo ${state.adultComboCount}`;
}

function renderAdultProgress() {
  const rawLust = Math.min(ADULT_LUST_UNLOCK_THRESHOLD, Math.max(0, state.femaleSceneProgress || 0));
  const lust = currentAdultFlow();
  const maleOrgasm = Math.min(100, Math.max(0, state.adultMaleOrgasmProgress || 0));
  const femaleOrgasm = 0;
  state.femaleSceneProgress = rawLust;
  state.adultMaleOrgasmProgress = maleOrgasm;
  state.adultFemaleOrgasmProgress = femaleOrgasm;
  if (els.maleProgressText) els.maleProgressText.textContent = `${Math.round(maleOrgasm)}%`;
  if (els.femaleProgressText) els.femaleProgressText.textContent = `${Math.round(lust)}%`;
  if (els.maleProgressBar) els.maleProgressBar.style.width = `${maleOrgasm}%`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${lust}%`;
  if (els.adultDockLustValue) els.adultDockLustValue.textContent = String(Math.round(lust));
  if (els.adultDockMaleValue) els.adultDockMaleValue.textContent = String(Math.round(maleOrgasm));
  renderAdultFlowStatus();
  persistRuntimeSnapshot('adult-progress');
  renderAdultProgressiveUI(false);
}

function setAdultPanelExpanded(expanded) {
  if (!els.adultInteractionPanel) return;
  els.adultInteractionPanel.classList.toggle('compact-expanded', expanded);
  els.adultInteractionPanel.classList.toggle('compact-collapsed', !expanded);
  els.adultInteractionPanel.classList.remove('fullscreen-collapsed');
  els.adultDockMoreBtn?.setAttribute('aria-expanded', String(expanded));
  if (els.adultDockMoreBtn) {
    els.adultDockMoreBtn.querySelector('span').textContent = expanded ? 'Kapat' : 'Tümü';
    els.adultDockMoreBtn.querySelector('b').textContent = expanded ? '⌄' : '⌃';
  }
  if (els.adultPanelToggleBtn) els.adultPanelToggleBtn.textContent = expanded ? 'SEÇİMLERİ GİZLE' : 'SEÇİMLER';
}

function refreshAdultCompactDock() {
  if (!els.adultInteractionPanel || !els.adultQuickChoices) return;
  const activePosition = state.adultScene?.positions?.find(item => item.id === state.activePositionId);
  if (els.adultDockTitle) {
    els.adultDockTitle.textContent = activePosition?.label || els.adultPhaseTitle?.textContent || 'Seçimler hazır';
  }
  if (els.adultDockPhase) {
    els.adultDockPhase.textContent = els.adultPhaseBadge?.textContent || 'SAHNE';
  }
  const sourceButtons = [
    ...els.foreplayChoices?.querySelectorAll('button') || [],
    ...els.movementChoices?.querySelectorAll('.movement-choice-card') || []
  ].filter(button => !button.disabled).slice(0, 2);
  els.adultQuickChoices.innerHTML = '';
  sourceButtons.forEach(source => {
    const quick = document.createElement('button');
    quick.type = 'button';
    quick.className = 'adult-quick-choice';
    quick.textContent = source.querySelector('span, strong')?.textContent || source.textContent.trim();
    quick.addEventListener('click', () => {
      const discoveryId = source.dataset.discoveryId;
      if (discoveryId) {
        if (source.dataset.discoveryKind === 'foreplay') playAdultPrelude(discoveryId);
        else selectAdultPosition(discoveryId, true);
        return;
      }
      const choiceId = source.dataset.movementChoiceId;
      const position = state.adultScene?.positions?.find(item => item.id === state.activePositionId);
      const choice = position?.activeMovementChoices?.find(item => item.id === choiceId);
      if (!choice) return;
      const currentId = choice.variants.some(item => item.id === state.activeMovementId)
        ? state.activeMovementId : null;
      const movement = pickNextVariant(choice.variants, currentId, state.adultMovementPlayCounts);
      if (!movement) return;
      state.activeMovementChoiceId = choice.id;
      selectAdultMovement(movement.id, true);
    });
    els.adultQuickChoices.appendChild(quick);
  });
}

function resetAdultSceneGameplay() {
  state.adultPendingSelectionProgress = null;
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultMaleOrgasmProgress = 0;
  state.adultFemaleOrgasmProgress = 0;
  state.adultMaleOrgasmCount = 0;
  state.adultFemaleOrgasmCount = 0;
  state.adultOrgasmDecision = null;
  state.adultSexUnlocked = false;
  state.adultUnlockedPositionIds = new Set();
  state.activeAdultOccurrenceId = null;
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultClimaxProgress = 0;
  state.adultCorePlaySeconds = 0;
  state.adultTimelineFloor = Math.max(0, Number(state.adultScene?.startTime) || 0);
  state.adultLastApproachRefreshAt = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  state.adultPlayedOutcomeIds = new Set();
  state.adultRevealedPositionIds = new Set();
  state.adultUiSignature = '';
  state.adultLastUiPhase = 'foreplay';
  state.adultPhaseMachine = 'foreplay';
  els.orgasmDecision?.classList.add('hidden');
  resetAdultTapRhythm();
}

function renderAdultWarmupChoices(scene) {
  if (!els.foreplayChoices || !els.foreplaySection) return;
  const flow = currentAdultFlow();
  const warmupPositions = (scene?.positions || [])
    .filter(position => isWarmupPosition(position) && flow >= Number(position.unlockProgress || 0))
    .map(position => ({
      kind: 'position',
      id: position.id,
      label: position.label,
      startTime: position.startTime,
      playCount: state.adultVisitedPositionIds.has(position.id) ? 1 : 0
    }));

  const warmupActions = (scene?.foreplay || []).map(item => ({
    kind: 'foreplay',
    id: item.id,
    label: item.label,
    startTime: item.startTime,
    playCount: Number(state.adultPreludePlayCounts.get(item.id) || 0)
  }));

  const choices = [...warmupActions, ...warmupPositions]
    .sort((a, b) => a.playCount - b.playCount || a.startTime - b.startTime)
    .slice(0, 3);

  els.foreplayChoices.innerHTML = '';
  if (els.foreplayCount) {
    els.foreplayCount.textContent = `${choices.length} seçenek`;
  }

  choices.forEach(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discovery-choice-card';
    button.dataset.clipId = choice.id;
    button.dataset.discoveryId = choice.id;
    button.dataset.discoveryKind = choice.kind;
    button.innerHTML = `
      <span>${escapeHtml(choice.label)}</span>
      <small>${choice.playCount ? 'Tekrar · daha az Lust' : 'Yeni keşif · Lust kazan'}</small>
    `;
    if (choice.id === state.activeAdultPreludeId || choice.id === state.activePositionId) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => {
      if (choice.kind === 'foreplay') playAdultPrelude(choice.id);
      else selectAdultPosition(choice.id, true);
    });
    els.foreplayChoices.appendChild(button);
  });

  els.foreplaySection.classList.toggle('hidden', !choices.length);
  refreshAdultCompactDock();
}

function renderAdultApproachChoices(scene, later = false) {
  const flow = currentAdultFlow();
  const approachPool = [
    ...(later ? (scene?.foreplay || []).filter(item => Number(item.startTime) >=
      Math.min(...(scene?.positions || []).map(position => Number(position.startTime))))
      : initialWarmupBeforeFirstPosition(scene?.foreplay || [],
        (scene?.positions || []).filter(position => !isWarmupPosition(position)))).map(item => ({
      kind: 'foreplay', id: item.id, label: item.label,
      startTime: item.startTime, endTime: item.endTime,
      playCount: Number(state.adultPreludePlayCounts.get(item.id) || 0)
    })),
    ...(!later ? (scene?.positions || []).filter(isWarmupPosition) : []).flatMap(position => {
      const firstCoreStart = Math.min(...(scene.positions || []).filter(item => !isWarmupPosition(item)).map(item => Number(item.startTime)));
      const movements = (position.movements || []).filter(item =>
        positionOccurrenceForMovement(position, item) && Number(item.loopEndTime) <= firstCoreStart + 0.05);
      const cards = buildVerifiedMovementChoices(movements, position.label, 5, position);
      return cards.map((card, index) => ({
        choiceId: card.id, variants: card.variants,
        kind: 'position', id: position.id,
        movementId: card?.variants?.[0]?.id || movements[0]?.id || '',
        label: card?.label || card?.variants?.[0]?.label || movements[0]?.label || position.label || `Yakınlaşma ${index + 1}`,
        startTime: Math.min(...card.variants.map(item => Number(item.loopStartTime))),
        endTime: Math.max(...card.variants.map(item => Number(item.loopEndTime))),
        playCount: Math.min(...(card.variants.map(item =>
          Number(state.adultMovementPlayCounts.get(item.id) || 0)
        )))
      }));
    })
  ];
  const candidates = selectSequentialApproachChoices(approachPool, {
    timelineFloor: Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0),
    limit: 5
  });

  state.adultApproachChoices = candidates;
  els.choices.innerHTML = '';
  els.choices.classList.remove('hidden');
  const heading = document.createElement('div');
  heading.className = 'approach-status';
  heading.innerHTML = later ? '<strong>SAHNE SEÇENEKLERİ</strong>' :
    `<strong>YAKINLAŞMA · Lust ${Math.round(flow)}/100</strong><small>İlk gerçek pozisyon kaynak anında açılır.</small>`;
  els.choices.appendChild(heading);
  const compactChoiceLabel = value => String(value || '')
    .replace(/\s+sekansını oynat/giu, '')
    .replace(/\s*·\s*(?:Sekans|Bölüm)\s+\d+$/giu, '')
    .replace(/\s*·\s*(?:Vajinal|Anal)$/giu, '')
    .trim();
  candidates.forEach(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-btn';
    button.dataset.clipId = choice.movementId || choice.id;
    if (choice.choiceId) {
      button.dataset.movementChoiceId = choice.choiceId;
      button.dataset.variantIds = choice.variants.map(item => item.id).join(',');
    }
    button.innerHTML = `<span data-choice-label>${escapeHtml(compactChoiceLabel(choice.label))}</span>`;
    button.addEventListener('click', () => {
      if (choice.kind === 'foreplay') playAdultPrelude(choice.id);
      else {
        selectAdultPosition(choice.id, false);
        const variants = (choice.variants || []).filter(item => Number(item.loopEndTime) > state.adultTimelineFloor + 0.05);
        const next = pickNextVariant(variants, state.activeMovementId, state.adultMovementPlayCounts);
        if (next) selectAdultMovement(next.id, true);
      }
    });
    els.choices.appendChild(button);
  });

  // A choice screen must never be an empty pause trap. At full Lust the next
  // core position is revealed; otherwise natural playback continues until a
  // verified forward action becomes reachable.
  if (!candidates.length) {
    const unlocked = flow >= 99.9 ? unlockNextAdultPositionFromLust() : null;
    if (unlocked) {
      state.adultUiSignature = '';
      queueMicrotask(() => renderAdultProgressiveUI(true));
    } else if (els.video?.paused && !state.activeAdultPreludeId && !state.activeMovementId) {
      const continueButton = document.createElement('button');
      continueButton.type = 'button';
      continueButton.className = 'choice-btn';
      continueButton.textContent = 'Videoya devam et';
      continueButton.addEventListener('click', () => void resumePanelPlayback());
      els.choices.appendChild(continueButton);
    }
  }
}

function renderAdultOutcomes(scene) {
  if (!els.outcomeSection || !els.outcomeChoices) return;
  const outcomes = unlockedAdultOutcomes(scene);
  els.outcomeChoices.innerHTML = '';
  els.outcomeSection.classList.toggle('hidden', !outcomes.length);

  if (!outcomes.length) {
    if (els.outcomeCount) els.outcomeCount.textContent = '0 açık';
    return;
  }

  outcomes.forEach((outcome, index) => {
    state.adultUnlockedOutcomeIds.add(outcome.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outcome-choice-card unlock-reveal';
    button.dataset.outcomeId = outcome.id;
    button.innerHTML = `
      <span>${escapeHtml(outcome.label || `Final ${index + 1}`)}</span>
      <small>${adultTimeLabel(outcome.startTime)} – ${adultTimeLabel(outcome.endTime)}</small>
      <small>Yeni açıldı · gerçek video segmenti</small>
    `;
    button.addEventListener('click', () => playAdultOutcome(outcome.id));
    els.outcomeChoices.appendChild(button);
  });

  if (els.outcomeCount) els.outcomeCount.textContent = `${outcomes.length} açık`;
}

function renderAdultProgressiveUI(force = false) {
  const scene = state.adultScene;
  if (!scene || !els.adultInteractionPanel || state.adultOutcomePhase !== 'idle') return;

  if (!state.activeAdultPreludeId && !state.activeMovementId) {
    const current = sourcePositionAtTime((scene.positions || []).filter(position =>
      !isWarmupPosition(position) && !isBonusPosition(position)), Number(els.video?.currentTime));
    const currentOccurrence = current && positionOccurrenceGroups(current).find(group =>
      Number(els.video.currentTime) >= group.startTime - 0.04 &&
      Number(els.video.currentTime) < group.endTime - 0.04)?.id || null;
    if (current && (!state.adultUnlockedPositionIds.has(current.id) ||
        current.id !== state.activePositionId || currentOccurrence !== state.activeAdultOccurrenceId)) {
      state.adultUnlockedPositionIds.add(current.id);
      state.adultRevealedPositionIds.add(current.id);
      state.adultSexUnlocked = true;
      state.activePositionId = current.id;
      state.activeAdultOccurrenceId = currentOccurrence;
      resetAdultTapRhythm();
      state.adultUiSignature = '';
      logEngineEvent('SOURCE_BOUNDARY_PANEL_OPENED', { sceneId: scene.id, positionId: current.id });
    }
  }

  // Full Lust is the transition condition itself. Waiting for the approach
  // list to become empty left playback paused forever at 100/100.
  if (!state.adultSexUnlocked && currentAdultFlow() >= 99.9) {
    unlockNextAdultPositionFromLust();
  }

  const availablePositions = unlockedAdultPositions(scene)
    .filter(position => !isWarmupPosition(position))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  const hasCoreUnlocked = availablePositions.some(position => !isBonusPosition(position));
  const hasBonusUnlocked = availablePositions.some(isBonusPosition);
  const phase = setAdultMachinePhase(adultDiscoveryPhase({ hasCoreUnlocked, hasBonusUnlocked }));
  const videoTime = Number(els.video?.currentTime) || 0;
  const laterOverlay = state.adultSexUnlocked && !state.activeMovementId &&
    !sourcePositionAtTime(scene.positions || [], videoTime) &&
    (scene.positions || []).some(position => Number(position.startTime) < videoTime) &&
    (scene.positions || []).some(position => Number(position.startTime) > videoTime + 0.04);

  const signature = [
    phase,
    availablePositions.map(item => item.id).join(','),
    state.activePositionId || '',
    state.activeAdultCategory || '',
    state.activeAdultPartnerTrackId || '',
    laterOverlay ? 'overlay' : '',
    phase === 'foreplay' ? Math.floor(Math.max(Number(els.video?.currentTime) || 0,
      Number(state.adultTimelineFloor) || 0) / 3) : '',
    Math.round(currentAdultFlow())
  ].join('|');

  if (els.adultPhaseBadge) els.adultPhaseBadge.textContent = phase === 'foreplay' ? 'YAKINLAŞMA' : phase === 'reward' ? 'BONUS' : 'POZİSYONLAR';
  if (els.adultPhaseTitle) els.adultPhaseTitle.textContent = phase === 'foreplay' ? 'Yakınlaşma' : 'Sahnedeki doğrulanmış pozisyonlar';
  if (els.adultPhaseHint) els.adultPhaseHint.textContent = phase === 'foreplay'
    ? 'Yakınlaşma seçenekleri Lust göstergesini doldurur; ilk gerçek pozisyon sonra açılır.'
    : 'Bir pozisyon ve ardından gerçek video hareketini seç.';
  els.adultInteractionPanel.dataset.phase = phase;
  els.outcomeSection?.classList.add('hidden');

  if (!force && signature === state.adultUiSignature) return;
  state.adultUiSignature = signature;
  state.adultLastUiPhase = phase;

  if (phase === 'foreplay' || laterOverlay) {
    if (els.discoveryGateText) els.discoveryGateText.textContent = `İlk seks pozisyonu için Lust ${Math.round(currentAdultFlow())}/100`;
    if (els.discoveryGateMeta) els.discoveryGateMeta.textContent = 'Önce kaynak videodaki yakınlaşma, oral ve manuel seçenekleri oynatılır.';
    els.discoveryGate?.classList.remove('hidden');
    els.adultInteractionPanel.classList.add('hidden');
    els.adultPanelToggleBtn?.classList.add('hidden');
    renderAdultApproachChoices(scene, laterOverlay);
    els.categorySection?.classList.add('hidden');
    els.positionSection?.classList.add('hidden');
    els.movementSection?.classList.add('hidden');
    refreshAdultCompactDock();
    return;
  }

  els.choices.classList.add('hidden');
  els.choices.innerHTML = '';
  els.adultInteractionPanel.classList.remove('hidden');
  els.adultPanelToggleBtn?.classList.remove('hidden');

  els.discoveryGate?.classList.add('hidden');
  els.foreplaySection?.classList.add('hidden');

  if (!availablePositions.length) {
    els.categorySection?.classList.add('hidden');
    els.positionSection?.classList.add('hidden');
    els.movementSection?.classList.add('hidden');
    return;
  }

  const verifiedRoutes = new Set(
    availablePositions
      .filter(position =>
        ['vaginal', 'anal'].includes(String(position.activityType || '')) &&
        Number(position.activityTypeConfidence || 0) >= 0.78
      )
      .map(position => String(position.activityType))
  );
  const showRouteCategories = verifiedRoutes.has('vaginal') && verifiedRoutes.has('anal');
  const categories = showRouteCategories
    ? [
        { id: 'all', label: 'Tümü' },
        { id: 'vaginal', label: 'Vajinal' },
        { id: 'anal', label: 'Anal' }
      ]
    : [{ id: 'all', label: 'Tümü' }];

  if (els.categoryTabs) els.categoryTabs.innerHTML = '';
  if (showRouteCategories) {
    categories.forEach(category => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'category-tab';
      button.textContent = category.label;
      button.dataset.categoryId = category.id;
      button.addEventListener('click', () => selectAdultCategory(category.id, false));
      els.categoryTabs?.appendChild(button);
    });
  }

  if (els.categoryCount) els.categoryCount.textContent = showRouteCategories ? '2 doğrulanmış tür' : '';
  els.categorySection?.classList.toggle('hidden', !showRouteCategories);
  els.positionSection?.classList.remove('hidden');

  const selectedCategory = categories.find(item => item.id === state.activeAdultCategory) || categories[0];
  if (selectedCategory) {
    selectAdultCategory(selectedCategory.id, false);
  }
}

function renderAdultPanel(scene) {
  if (!scene || (!scene.positions?.length && !scene.foreplay?.length) || !els.adultInteractionPanel) return;

  const previousSceneId = state.adultScene?.id || null;
  const videoStage = els.video?.closest('.video-stage');
  syncAdultPanelPlacement(videoStage);

  const restoringSameScene = state.restoredAdultSceneId === scene.id;
  if (previousSceneId !== scene.id && !restoringSameScene) {
    resetAdultSceneGameplay();
    state.activePositionId = null;
    state.activeAdultOccurrenceId = null;
    state.activeAdultCategory = null;
    state.activeAdultPartnerTrackId = null;
    state.activeMovementId = null;
  }
  if (restoringSameScene) {
    state.restoredAdultSceneId = null;
    logEngineEvent('ADULT_SCENE_RUNTIME_RESTORED', { sceneId: scene.id });
  }

  state.adultScene = scene;
  if (previousSceneId !== scene.id && !restoringSameScene) {
    state.adultTimelineFloor = Math.max(0, Number(scene.startTime) || 0);
  }
  state.adultMode = true;
  const warmupPositions = (scene.positions || []).filter(isWarmupPosition);
  warmupPositions.forEach(position => state.adultUnlockedPositionIds.add(position.id));
  if (!warmupPositions.length && !scene.foreplay?.length) {
    const firstCore = (scene.positions || [])
      .filter(position => !isWarmupPosition(position) && !isBonusPosition(position))
      .sort((a, b) => Number(a.startTime) - Number(b.startTime))[0];
    if (firstCore) {
      state.adultUnlockedPositionIds.add(firstCore.id);
      state.adultRevealedPositionIds.add(firstCore.id);
      state.adultSexUnlocked = true;
    }
  }
  els.adultInteractionPanel.classList.remove('hidden');
  setAdultPanelExpanded(true);
  els.adultPanelToggleBtn?.classList.remove('hidden');
  document.querySelector('.choice-navigation')?.classList.add('hidden');

  if (els.adultSceneTitle) els.adultSceneTitle.textContent = scene.title;
  if (els.adultSceneTime) {
    els.adultSceneTime.textContent =
      `${adultTimeLabel(scene.startTime)} – ${adultTimeLabel(scene.endTime)}`;
  }

  if (els.categoryTabs) els.categoryTabs.innerHTML = '';
  if (els.positionTabs) els.positionTabs.innerHTML = '';
  if (els.movementChoices) els.movementChoices.innerHTML = '';
  renderAdultProgress();
  renderAdultProgressiveUI(true);
  refreshAdultCompactDock();
}

function enterAdultScene(scene, { forceStart = false, reason = 'timeline' } = {}) {
  if (!scene || state.completedAdultSceneIds?.has(scene.id) || !els.video) return false;
  if (state.adultScene?.id !== scene.id) cancelAdultSeek();

  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  state.activeAction = null;
  els.choices.innerHTML = '';
  els.choices.classList.add('hidden');
  document.querySelector('.choice-navigation')?.classList.add('hidden');

  const sameSession = state.adultMode && state.adultScene?.id === scene.id;
  const mediaTime = Number(els.video.currentTime) || 0;
  const seekTarget = sceneEntrySeekTarget(scene, mediaTime, forceStart, sameSession);
  if (seekTarget !== null) {
    els.video.pause();
    els.video.currentTime = seekTarget;
  }

  state.gameCursorTime = Math.max(0, Number(scene.startTime) || 0, mediaTime);
  renderAdultPanel(scene);
  setGameState('SEGMENT_PLAYING');
  logEngineEvent('ADULT_SCENE_ENTERED', { sceneId: scene.id, reason, sameSession });
  return true;
}

function syncAdultPanelPlacement(stage = els.video?.closest('.video-stage')) {
  if (!stage || !els.adultInteractionPanel) return;
  if (els.adultInteractionPanel.parentElement !== stage) stage.appendChild(els.adultInteractionPanel);
}

function selectAdultCategory(categoryId, shouldSeek = true) {
  const scene = state.adultScene;
  const unlocked = unlockedAdultPositions(scene).filter(item => !isWarmupPosition(item));
  const characters = state.analysis?.storyContext?.characters || [];
  const protagonists = [...new Set(unlocked.filter(item => item.groupScene)
    .map(item => item.subjectTrackId).filter(Boolean))].filter(trackId => {
    const character = characters.find(item => item.participantTrackId === trackId);
    const role = String(character?.sourceRole || character?.role || '').toLocaleLowerCase('tr-TR');
    return character?.evidenceLevel === 'fact' &&
      /(?:^|\s)(?:erkek|adam|baba|male|man)(?:\s|$)/iu.test(role) &&
      !/(?:kadın|kız|female|woman)/iu.test(role);
  });
  const showPartners = protagonists.length > 1;
  if (!showPartners || !protagonists.includes(state.activeAdultPartnerTrackId)) {
    state.activeAdultPartnerTrackId = protagonists.includes('MAIN_MALE') ? 'MAIN_MALE' : protagonists[0] || null;
  }
  if (els.groupPartnerTabs) els.groupPartnerTabs.innerHTML = '';
  els.groupPartnerSection?.classList.toggle('hidden', !showPartners);
  if (showPartners) {
    for (const trackId of protagonists) {
      const character = characters.find(item => item.participantTrackId === trackId);
      const label = verifiedCharacterName(character) || verifiedVisualDescription(character) || 'Erkek karakter';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'position-tab';
      button.textContent = label;
      button.classList.toggle('active', state.activeAdultPartnerTrackId === trackId);
      button.addEventListener('click', () => {
        state.activeAdultPartnerTrackId = trackId;
        selectAdultCategory(categoryId, false);
      });
      els.groupPartnerTabs?.appendChild(button);
    }
  }
  const positions = unlocked
    .filter(item => !showPartners || item.subjectTrackId === state.activeAdultPartnerTrackId)
    .filter(item => !isWarmupPosition(item))
    .filter(item => {
      if (categoryId === 'all') return true;
      return String(item.activityType || '') === categoryId &&
        Number(item.activityTypeConfidence || 0) >= 0.78;
    });

  if (!positions.length) return;

  state.activeAdultCategory = categoryId;

  els.categoryTabs
    ?.querySelectorAll('.category-tab')
    .forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.categoryId === categoryId
      );
    });

  if (els.positionTabs) els.positionTabs.innerHTML = '';
  if (els.positionCount) {
    els.positionCount.textContent = `${positions.length} açık`;
  }

  positions.forEach(position => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'position-tab';
    button.textContent = String(position.label || '')
      .replace(/\s*·\s*(?:Vajinal|Anal)$/giu, '')
      .trim();
    button.dataset.positionId = position.id;
    button.disabled = !forwardLocalMovementClips(position,
      Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0)).length;
    if (!state.adultRevealedPositionIds.has(position.id)) {
      state.adultRevealedPositionIds.add(position.id);
      button.classList.add('unlock-reveal');
    }
    button.addEventListener(
      'click',
      () => selectAdultPosition(position.id, true)
    );
    els.positionTabs?.appendChild(button);
  });

  const selected = positions.find(item => item.id === state.activePositionId) ||
    positions.find(item => forwardLocalMovementClips(item,
      Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0)).length);

  if (selected) selectAdultPosition(selected.id, shouldSeek);
}

function cancelAdultSeek() {
  state.adultSeekRequestId = (state.adultSeekRequestId || 0) + 1;
  state.adultSeekController?.abort();
  state.adultSeekController = null;
  clearTimeout(state.adultSeekTimer);
  state.adultSeekTimer = null;

  if (state.adultSeekListener && els.video) {
    els.video.removeEventListener("seeked", state.adultSeekListener);
  }

  state.adultSeekListener = null;
  state.adultLoopSeeking = false;
  clearPanelPlaybackRecovery();
}

function beginAdultSelection() {
  state.adultSelectionToken += 1;
  state.adultPendingSelectionProgress = null;
  cancelAdultSeek();
  return state.adultSelectionToken;
}

function commitAdultSelectionProgress(selectionToken) {
  const pending = state.adultPendingSelectionProgress;
  if (!pending || pending.token !== selectionToken) return;
  state.adultPendingSelectionProgress = null;
  if (pending.kind === 'prelude') applyAdultPreludeProgress(pending.item);
  else if (pending.kind === 'outcome') {
    state.adultPlayedOutcomeIds.add(pending.item.id);
    logEngineEvent('ORGASM_OUTCOME_STARTED', { outcomeId: pending.item.id });
  } else applyAdultSelectionProgress(pending.position, pending.movement, pending.meta);
}

function applyAdultPreludeProgress(item) {
  if (!item) return;
  if (item.nonIntimate) return;
  const repeatCount = Number(state.adultPreludePlayCounts.get(item.id) || 0);
  state.adultComboCount = repeatCount === 0
    ? Math.min(6, state.adultComboCount + 1)
    : Math.max(0, state.adultComboCount - 1);

  const delta = computeWarmupSelectionDelta({
    repeatCount,
    comboCount: state.adultComboCount,
    maleRate: item.maleProgressRate || 1,
    femaleRate: item.femaleProgressRate || 1
  });

  state.adultPreludePlayCounts.set(item.id, repeatCount + 1);
  addFemaleLust(delta.female);
  renderAdultProgress();
}

function playAdultPrelude(preludeId) {
  const scene = state.adultScene;
  const item = scene?.foreplay?.find(entry => entry.id === preludeId);
  if (!item || item.sourceVerified !== true || !els.video || state.adultOutcomePhase !== 'idle') return;
  const guard = guardPlayable('foreplay', item, { scene, unlocked: true });
  if (!guard.allowed) return;
  logEngineEvent('FOREPLAY_SELECTED', { id: item.id });

  const token = beginAdultSelection();
  state.activeAdultPreludeId = item.id;
  state.activePositionId = null;
  state.activeAdultOccurrenceId = null;
  state.activeMovementId = null;
  state.adultPendingSelectionProgress = { token, kind: 'prelude', item };
  renderAdultProgressiveUI(true);
  els.video.pause();
  void seekAdultLoop(item.startTime, token);
}

function applyAdultSelectionProgress(position, movement, { positionChanged = false } = {}) {
  if (!position) return;
  const positionNew = !state.adultVisitedPositionIds.has(position.id);
  const repeatCount = movement
    ? Number(state.adultMovementPlayCounts.get(movement.id) || 0)
    : 0;
  const movementNew = Boolean(movement && repeatCount === 0);

  if (positionChanged || positionNew || movementNew) {
    state.adultComboCount = Math.min(6, state.adultComboCount + 1);
  } else {
    state.adultComboCount = Math.max(0, state.adultComboCount - 1);
  }

  const delta = computeAdultSelectionDelta({
    repeatCount,
    positionNew,
    positionChanged,
    movementNew,
    comboCount: state.adultComboCount,
    maleRate: movement?.maleProgressRate || 1,
    femaleRate: movement?.femaleProgressRate || 1
  });

  state.adultVisitedPositionIds.add(position.id);
  if (movement) {
    state.adultMovementPlayCounts.set(movement.id, repeatCount + 1);
  }
  addFemaleLust(delta.female);
  if (!isWarmupPosition(position)) {
    // Tapping a card never advances orgasm. Only verified core playback does.
    const climaxDelta = averageAdultProgress(delta.male, delta.female) * 0.12;
    state.adultClimaxProgress = Math.min(100, state.adultClimaxProgress + climaxDelta);
    state.adultFemaleOrgasmProgress = 0;
  }
  renderAdultProgress();
}

function updateVariantButton(_position) {
  // Movement choices already own their coherent clip pools. A second global
  // "next variation" control would bypass that graph and can jump timelines.
  if (!els.nextVariantBtn) return;
  els.nextVariantBtn.classList.add('hidden');
  els.nextVariantBtn.disabled = true;
}

function resetAdultTapRhythm() {
  state.adultTapTimes = [];
  state.adultTapTempo = 'unclear';
  state.adultTapCandidateTempo = 'unclear';
  state.adultTapCandidateCount = 0;
  state.adultLastTempoSwitchAt = 0;
  els.rhythmTapBtn?.removeAttribute('data-tempo');
  if (els.video && Number(els.video.playbackRate) !== 1) els.video.playbackRate = 1;
  if (els.rhythmTapLabel) els.rhythmTapLabel.textContent = 'SEKS';
  if (els.rhythmTapStatus) els.rhythmTapStatus.textContent = 'Yalnızca hızlı, sert veya derin doğrulanmış kesitlerde açılır';
}

function remainingPositionControlClips(position, currentMovement = null) {
  if (!position) return [];
  // Preserve the existing source/occurrence/classification constraints. The
  // completed clip ID is cleared at its end, so time must also exclude it.
  return forwardVerifiedClips(
    movementsForPositionOccurrence(position, state.activeAdultOccurrenceId)
      .filter(item => position.controlClipIds?.includes(item.id) && isEnergeticSexMoment(item)),
    {
      currentId: currentMovement?.id || '',
      after: Math.max(Number(state.adultTimelineFloor) || 0,
        Number(els.video?.currentTime) || 0,
        currentMovement ? Number(currentMovement.loopStartTime) + 0.04 : 0)
    }
  );
}

function nextEnergeticPositionMovement(position, currentMovement = null) {
  return remainingPositionControlClips(position, currentMovement)[0] || null;
}

function updateRhythmControl(position) {
  const movement = position?.movements?.find(item => item.id === state.activeMovementId) || null;
  const remaining = remainingPositionControlClips(position, movement);
  const nextEnergetic = remaining[0];
  const eligible = Boolean(
    position && !isWarmupPosition(position) &&
    state.adultOutcomePhase === 'idle' &&
    movement && isEnergeticSexMoment(movement) &&
    Number(els.video?.currentTime) >= Number(movement.loopStartTime) &&
    Number(els.video?.currentTime) < Number(movement.loopEndTime) &&
    nextEnergetic
  );
  els.rhythmControl?.classList.toggle('hidden', !eligible);
  if (els.rhythmTapBtn) {
    els.rhythmTapBtn.disabled = !eligible;
    els.rhythmTapBtn.setAttribute('aria-label', eligible
      ? `Sonraki doğrulanmış kesiti oynat. ${remaining.length} kesit kaldı.`
      : 'Bu bölümde ilerlenebilecek uygun kesit kalmadı.');
  }
  const nextLabel = String(nextEnergetic?.label || '').trim();
  const nextTempo = String(nextEnergetic?.movementTempo || '').toLowerCase();
  let controlLabel = 'RİTMİ SÜRDÜR';
  if (/derin/i.test(nextLabel)) controlLabel = 'DERİN DEVAM ET';
  else if (/hızlı|sert|yoğun/i.test(nextLabel) || nextTempo === 'fast') controlLabel = 'DAHA YOĞUN';
  else if (nextTempo === 'moderate') controlLabel = 'RİTMİ KORU';
  if (els.rhythmTapLabel) els.rhythmTapLabel.textContent = eligible ? controlLabel : 'SEKS KAPALI';
  if (els.rhythmTapStatus) {
    els.rhythmTapStatus.textContent = eligible
      ? 'Hazır'
      : 'Bu bölümde ilerlenebilecek uygun kesit kalmadı';
  }
}

function handleAdultRhythmTap(timestamp = performance.now()) {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const currentMovement = position?.movements?.find(item => item.id === state.activeMovementId) || null;
  if (!position || state.adultOutcomePhase !== 'idle') return false;

  els.rhythmTapBtn?.classList.remove('tap-pulse');
  requestAnimationFrame(() => els.rhythmTapBtn?.classList.add('tap-pulse'));
  const next = nextEnergeticPositionMovement(position, currentMovement);
  if (!next) {
    updateRhythmControl(position);
    return false;
  }
  if (next) {
    selectAdultMovement(next.id, true, null, { awardProgress: false });
  }
  logEngineEvent('SEX_CONTROL_APPLIED', {
    positionId: position.id,
    occurrenceId: position.occurrenceId,
    movementId: next.id,
    advanced: true,
    timestamp: Number(timestamp) || performance.now()
  });
  return true;
}

function playNextAdultVariant() {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  if (!position) return;
  const occurrenceMovements = movementsForPositionOccurrence(position, state.activeAdultOccurrenceId);
  const next = pickNextChronologicalVariant(occurrenceMovements, state.activeMovementId);
  if (next) selectAdultMovement(next.id, true);
}

function tempoLabel(value) {
  return { slow: 'Yavaş', moderate: 'Normal', fast: 'Hızlı' }[String(value || '')] || 'Tempo';
}

function selectMovementTempoVariant(choice) {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  if (!position || !choice?.tempoVariants?.length) return;
  const currentIndex = choice.tempoVariants.findIndex(item => item.id === state.activeMovementId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % choice.tempoVariants.length;
  const next = choice.tempoVariants[nextIndex];
  if (!next) return;
  state.activeMovementChoiceId = choice.id;
  selectAdultMovement(next.id, true, null, { awardProgress: false });
}

function selectAdultPosition(positionId, shouldSeek = true) {
  const scene = state.adultScene;
  const position = scene?.positions.find(item => item.id === positionId);
  if (!position || state.adultOutcomePhase !== 'idle') return;
  const cursor = Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0);
  const localMovements = forwardLocalMovementClips(position, cursor);
  if (shouldSeek && !localMovements.length) {
    logEngineEvent('POSITION_FORWARD_RANGE_BLOCKED', { positionId: position.id, cursor });
    return;
  }
  primeAdultPositionLanguage(position);
  const positionGuard = guardPlayable(
    isWarmupPosition(position) ? 'foreplay' : 'position',
    position,
    { scene, unlocked: isWarmupPosition(position)
      ? !state.adultSexUnlocked : state.adultUnlockedPositionIds.has(position.id) }
  );
  if (!positionGuard.allowed) return;
  if (shouldSeek) logEngineEvent('POSITION_SELECTED', { id: position.id, family: position.familyId });

  const selectionToken = shouldSeek
    ? beginAdultSelection()
    : state.adultSelectionToken;
  if (shouldSeek) state.activeAdultPreludeId = null;
  const changedPosition = state.activePositionId !== position.id;
  state.activePositionId = position.id;
  if (changedPosition) {
    state.activeMovementId = null;
    state.activeAdultOccurrenceId = positionOccurrenceForMovement(position, localMovements[0])?.id || null;
  }
  if (changedPosition) resetAdultTapRhythm();

  els.positionTabs?.querySelectorAll('.position-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.positionId === position.id);
  });

  // The main tab owns only the verified position entry. All later returns and
  // movements from the same canonical position live under its subchoices.
  const verifiedMovements = localMovements;
  const entryMovement = verifiedMovements[0] || null;
  const entryMovementId = entryMovement?.id || '';
  const movementPool = verifiedMovements.filter(item => item.id !== entryMovementId &&
    !position.controlClipIds?.includes(item.id));
  const movementChoices = buildVerifiedMovementChoices(movementPool, position.label, 5, position);
  const movementCoverage = summarizeMovementChoiceCoverage(movementChoices);
  position.activeMovementChoices = movementChoices;
  if (els.movementHeading) els.movementHeading.textContent = position.label;
  if (els.movementCount) {
    els.movementCount.textContent = `${movementCoverage.variantCount} gerçek hareket · ${movementCoverage.choiceCount} seçenek`;
  }
  if (els.movementChoices) els.movementChoices.innerHTML = '';
  els.movementSection?.classList.remove('hidden');

  movementChoices.forEach(choice => {
    const wrapper = document.createElement('div');
    wrapper.className = 'movement-choice-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'movement-choice-card';
    button.dataset.movementChoiceId = choice.id;
    button.dataset.variantIds = choice.variants.map(item => item.id).join(',');
    const energyBadge = choice.energyLabel
      ? `<small class="movement-energy-badge" data-energy="${escapeHtml(choice.energyFlavor)}">${escapeHtml(choice.energyLabel)}</small>`
      : '';
    const variantStatus = choice.variants.length > 1
      ? `<small class="movement-variant-status" data-variant-status>${choice.variants.length} hareket · dönüşümlü oynatılır</small>`
      : '<small class="movement-variant-status" data-variant-status>1 gerçek hareket</small>';
    const tempoSummary = choice.hasTempoShift && choice.tempoVariants?.length
      ? `<small class="movement-tempo-summary">${escapeHtml(choice.tempoVariants.map(item => tempoLabel(item.movementTempo)).join(' / '))}</small>`
      : '';
    button.innerHTML = `${energyBadge}<span data-choice-label>${escapeHtml(choice.label)}</span>${variantStatus}${tempoSummary}`;
    button.addEventListener('click', () => {
      const currentId = choice.variants.some(item => item.id === state.activeMovementId)
        ? state.activeMovementId
        : null;
      const movement = pickNextVariant(choice.variants, currentId, state.adultMovementPlayCounts);
      if (!movement) return;
      state.activeMovementChoiceId = choice.id;
      // Actual media readiness, not a click, drives the visible playing state.
      selectAdultMovement(movement.id, true);
    });
    wrapper.appendChild(button);
    if (choice.hasTempoShift && choice.tempoVariants?.length > 1) {
      const tempoButton = document.createElement('button');
      tempoButton.type = 'button';
      tempoButton.className = 'movement-tempo-btn';
      tempoButton.textContent = 'Tempo değişimini oynat';
      tempoButton.addEventListener('click', event => {
        event.stopPropagation();
        selectMovementTempoVariant(choice);
      });
      wrapper.appendChild(tempoButton);
    }
    els.movementChoices?.appendChild(wrapper);
  });

  refreshAdultCompactDock();

  updateVariantButton(position);
  updateRhythmControl(position);

  // Rendering must not arm a clip or cancel a pending selection. Only an
  // explicit play request (including the first unlock) may change playback.
  if (!shouldSeek) return;
  const movement = entryMovement;

  if (movement) {
    selectAdultMovement(
      movement.id,
      shouldSeek,
      selectionToken,
      { positionChanged: changedPosition }
    );
  } else {
    state.activeMovementId = null;
    if (els.movementChoices) els.movementChoices.innerHTML = '';
    if (els.movementCount) els.movementCount.textContent = 'Bu bölümde doğrulanmış oynatılabilir kesit yok';
    els.video?.pause();
    // No verified local clip means no playable choice; never seek an entire
    // parent interval as an unverified fallback.
  }
}

function selectAdultMovement(
  movementId,
  shouldSeek = true,
  selectionToken = null,
  selectionMeta = null
) {
  if (selectionToken !== null && selectionToken !== state.adultSelectionToken) return;
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === movementId);
  if (!movement || movement.sourceVerified !== true || state.adultOutcomePhase !== 'idle') return;
  const movementOccurrence = positionOccurrenceForMovement(position, movement);
  if (!movementOccurrence) {
    logEngineEvent('MOVEMENT_OCCURRENCE_BLOCKED', {
      movementId: movement.id,
      positionId: position.id,
      occurrenceId: state.activeAdultOccurrenceId,
      sourcePositionId: movement.sourcePositionId || null
    });
    return;
  }
  if (shouldSeek && !forwardLocalMovementClips(position,
    Math.max(Number(state.adultTimelineFloor) || 0, Number(els.video?.currentTime) || 0))
    .some(item => item.id === movement.id)) {
    logEngineEvent('MOVEMENT_FORWARD_RANGE_BLOCKED', { movementId: movement.id });
    return;
  }
  const movementGuard = guardPlayable('movement', movement, {
    scene: state.adultScene,
    parentPosition: position,
    unlocked: isWarmupPosition(position)
      ? !state.adultSexUnlocked : state.adultUnlockedPositionIds.has(position.id)
  });
  if (!movementGuard.allowed) return;
  if (shouldSeek) logEngineEvent('MOVEMENT_SELECTED', { id: movement.id, positionId: position?.id || null });

  if (!shouldSeek) return;
  const effectiveToken = selectionToken ?? beginAdultSelection();
  state.activeAdultOccurrenceId = movementOccurrence.id;
  state.activeAdultPreludeId = null;
  state.activeMovementId = movement.id;
  const matchingChoice = (position.activeMovementChoices || []).find(
    choice => choice.variants?.some(item => item.id === movement.id)
  );
  if (matchingChoice) state.activeMovementChoiceId = matchingChoice.id;
  state.lastAdultMediaTime = null;
  els.movementChoices?.querySelectorAll('.movement-choice-card').forEach(button => {
    const variants = String(button.dataset.variantIds || '').split(',');
    button.classList.toggle('active', variants.includes(movement.id));
  });

  if (shouldSeek && selectionMeta?.awardProgress !== false) {
    state.adultPendingSelectionProgress = {
      token: effectiveToken, kind: 'movement', position, movement, meta: selectionMeta || {}
    };
  }

  updateVariantButton(position);
  updateRhythmControl(position);

  if (shouldSeek && els.video) {
    els.video.pause();
    const cursor = Number(els.video.currentTime) || 0;
    const target = cursor >= movement.loopStartTime && cursor < movement.loopEndTime
      ? cursor : movement.loopStartTime;
    void seekAdultLoop(target, effectiveToken);
  }
}

function playAdultOutcome(outcomeId, options = {}) {
  const scene = state.adultScene;
  const outcome = scene?.outcomes?.find(item => item.id === outcomeId);
  if (!outcome || outcome.sourceVerified !== true || !els.video) return false;
  const outcomeReady = options?.orgasmTriggered === true ||
    unlockedAdultOutcomes(scene).some(item => item.id === outcome.id);
  const outcomeGuard = guardPlayable('outcome', outcome, {
    scene, unlocked: outcomeReady, outcomeReady, phase: outcomeReady ? 'final' : state.adultPhaseMachine
  });
  if (!outcomeGuard.allowed) return false;

  const selectionToken = beginAdultSelection();
  setAdultMachinePhase('final');
  setAdultMachinePhase('outcome');
  logEngineEvent('OUTCOME_SELECTED', { id: outcome.id });
  state.adultOutcomePhase = 'outcome';
  state.activeAdultOutcomeId = outcome.id;
  state.activeAdultPreludeId = null;
  els.video.playbackRate = 1;
  state.activeMovementId = null;
  state.adultPendingSelectionProgress = { token: selectionToken, kind: 'outcome', item: outcome };
  updateVariantButton(null);
  renderAdultFlowStatus();
  els.video.pause();
  void seekAdultLoop(outcome.startTime, selectionToken);
  return true;
}

function handleSourceEnded() {
  if (state.navigationSeeking || state.adultLoopSeeking || !state.analysis) return;
  if (state.adultMode) {
    if (state.adultOrgasmDecision) {
      openAdultOrgasmDecision();
      return;
    }
    finishAdultScene({ force: true, resumeAtCurrentTime: true });
    return;
  }
  if (state.activeAction) return;
  state.gameCursorTime = Number(els.video.duration) || Number(els.video.currentTime) || 0;
  renderChoices();
}

function skipCurrentScene() {
  finishAdultScene({ force: true });
}

function finishAdultScene(options = {}) {
  const scene = state.adultScene;
  if (!scene) return;
  const force = options?.force === true;
  state.adultOrgasmDecision = null;
  els.orgasmDecision?.classList.add('hidden');

  // "Skip scene" doubles as a safe next-step control. Never terminate the
  // encounter while another verified, currently unlocked position has not
  // been played yet.
  const remainingPosition = (scene.positions || [])
    .filter(position =>
      !isWarmupPosition(position) &&
      state.adultUnlockedPositionIds.has(position.id) &&
      !state.adultVisitedPositionIds.has(position.id)
    )
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))[0];
  if (remainingPosition && !force) {
    selectAdultPosition(remainingPosition.id, true);
    return;
  }
  // "Sahneyi geç" inside an encounter means advance to the next verified
  // position, not delete the complete panel. Unlock exactly one chronological
  // position and keep control with the player. Only a forced finish or a truly
  // exhausted graph may close the encounter.
  const nextLockedPosition = orderedLockedAdultPositions(scene)[0];
  if (nextLockedPosition && !force) {
    state.adultUnlockedPositionIds.add(nextLockedPosition.id);
    state.adultRevealedPositionIds.add(nextLockedPosition.id);
    state.adultSexUnlocked = true;
    state.adultUiSignature = '';
    logEngineEvent('ADULT_SCENE_SKIP_ADVANCED', { positionId: nextLockedPosition.id });
    renderAdultProgressiveUI(true);
    selectAdultPosition(nextLockedPosition.id, true);
    return;
  }
  if (!state.completedAdultSceneIds) state.completedAdultSceneIds = new Set();
  state.completedAdultSceneIds.add(scene.id);
  const sceneSourceIds = new Set([scene.id, ...(scene.sourceSceneIds || [])].map(String));
  const sceneActions = (state.analysis?.actions || []).filter(action => {
    const start = Number(action.startTime);
    const actionSceneId = String(action.adultSceneId || '').trim();
    const insideMergedEncounter = start >= Number(scene.startTime) - 0.15 &&
      start < Number(scene.endTime) + 0.15;
    const sameScene = sceneSourceIds.has(actionSceneId) || insideMergedEncounter;
    return sameScene && start < Number(scene.endTime) + 0.15;
  });
  sceneActions.forEach(action => state.consumedActionIds.add(action.actionId));
  const lastSceneActionIndex = (state.analysis?.actions || []).reduce(
    (last, action, index) => sceneActions.includes(action) ? Math.max(last, index) : last,
    state.currentActionIndex
  );
  if (lastSceneActionIndex >= state.currentActionIndex) {
    state.currentActionIndex = lastSceneActionIndex;
  }
  setAdultMachinePhase('complete');
  logEngineEvent('ADULT_SCENE_COMPLETED', { sceneId: scene.id });
  state.adultSelectionToken += 1;
  state.adultPendingSelectionProgress = null;
  cancelAdultSeek();
  state.adultMode = false;
  state.adultScene = null;
  state.activePositionId = null;
    state.activeAdultCategory = null;
    state.activeAdultPartnerTrackId = null;
  state.activeMovementId = null;
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultOutcomePhase = 'idle';
  state.lastAdultMediaTime = null;
  if (els.video) els.video.playbackRate = 1;
  els.adultInteractionPanel?.classList.add('hidden');
  els.adultPanelToggleBtn?.classList.add('hidden');
  els.outcomeSection?.classList.add('hidden');
  document.querySelector('.choice-navigation')?.classList.remove('hidden');
  const exitTime = options.resumeAtCurrentTime
    ? Math.max(Number(scene.endTime) || 0, Number(els.video?.currentTime) || 0)
    : scene.endTime;
  state.gameCursorTime = sceneExitTime(exitTime, els.video?.duration || state.analysis?.videoDuration);
  persistRuntimeSnapshot('adult-scene-complete', true);

  if (!els.video) {
    renderChoices();
    return;
  }

  void navigateTimelineTo(state.gameCursorTime, { resumeWhenEmpty: true });
}

function clearPanelPlaybackRecovery() {
  els.panelPlaybackRecovery?.remove();
  els.panelPlaybackRecovery = null;
}

function showPanelPlaybackRecovery(message, retry, label = 'Geçişi tekrar dene') {
  clearPanelPlaybackRecovery();
  const stage = els.video?.closest('.video-stage');
  if (!stage) return;
  const recovery = document.createElement('div');
  recovery.className = 'player-playback-recovery';
  recovery.setAttribute('role', 'status');
  const copy = document.createElement('p');
  copy.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.playbackRecovery = label === 'Videoya devam et' ? 'continue' : 'retry';
  button.textContent = label;
  const requestId = state.adultSeekRequestId;
  button.addEventListener('click', () => {
    if (state.adultMode && requestId === state.adultSeekRequestId) void retry();
  });
  recovery.append(copy, button);
  stage.appendChild(recovery);
  els.panelPlaybackRecovery = recovery;
}

async function resumePanelPlayback(selectionToken = state.adultSelectionToken) {
  if (!els.video || !state.adultMode || state.adultLoopSeeking ||
      selectionToken !== state.adultSelectionToken) return false;
  const requestId = state.adultSeekRequestId;
  clearPanelPlaybackRecovery();
  setGameState('SEGMENT_PLAYING');
  try {
    await els.video.play();
    if (!state.adultMode || requestId !== state.adultSeekRequestId ||
        selectionToken !== state.adultSelectionToken) return false;
    commitAdultSelectionProgress(selectionToken);
    return true;
  } catch (error) {
    if (!state.adultMode || requestId !== state.adultSeekRequestId ||
        selectionToken !== state.adultSelectionToken) return false;
    els.video.pause();
    setGameState('DECISION_PENDING');
    showPanelPlaybackRecovery('Video oynatılamadı. Devam etmek için dokun.',
      () => resumePanelPlayback(selectionToken), 'Videoya devam et');
    logEngineEvent('PANEL_PLAYBACK_BLOCKED', { message: error?.message || String(error) });
    return false;
  }
}

async function seekAdultLoop(targetTime, selectionToken = state.adultSelectionToken) {
  if (!els.video || !state.adultMode || selectionToken !== state.adultSelectionToken) return false;

  cancelAdultSeek();
  const requestId = state.adultSeekRequestId;
  const sceneId = state.adultScene?.id;
  const controller = new AbortController();
  state.adultSeekController = controller;
  const requestedTarget = Math.max(0, Number(targetTime) || 0);
  const sceneStart = Number(state.adultScene?.startTime);
  const sceneEnd = Number(state.adultScene?.endTime);
  const target = state.adultMode && Number.isFinite(sceneStart) && Number.isFinite(sceneEnd)
    ? Math.min(Math.max(requestedTarget, sceneStart), Math.max(sceneStart, sceneEnd - 0.05))
    : requestedTarget;
  if (Math.abs(target - requestedTarget) > 0.01) {
    logEngineEvent('ADULT_SEEK_CLAMPED', { requestedTarget, target, sceneId: state.adultScene?.id || null });
  }
  state.adultLoopSeeking = true;
  els.video.pause();
  setGameState('SEGMENT_SEEKING');
  const isCurrent = () => !controller.signal.aborted && state.adultMode &&
    sceneId === state.adultScene?.id && requestId === state.adultSeekRequestId &&
    selectionToken === state.adultSelectionToken;
  try {
    primeLanguageTracksAt(target, 2);
    if (Math.abs((Number(els.video.currentTime) || 0) - target) > 0.12) {
      await seekMediaTo(els.video, target, { signal: controller.signal });
    }
    if (!isCurrent()) return false;
    state.adultLoopSeeking = false;
    state.lastAdultFrameNow = performance.now();
    resyncLanguageTracks();
    return await resumePanelPlayback(selectionToken);
  } catch (error) {
    if (!isCurrent()) return false;
    state.adultLoopSeeking = false;
    els.video.pause();
    setGameState('DECISION_PENDING');
    showPanelPlaybackRecovery(error?.message || 'Video konumu yüklenemedi.',
      () => seekAdultLoop(target, selectionToken));
    logEngineEvent('PANEL_SEEK_FAILED', { target, message: error?.message || String(error) });
    return false;
  } finally {
    if (state.adultSeekController === controller) {
      state.adultSeekController = null;
      state.adultLoopSeeking = false;
    }
  }
}

function updateAdultPlayback(now, mediaTime) {
  if (state.navigationSeeking) return;
  if (!state.adultMode) {
    const scene = findAdultSceneAt(mediaTime);
    if (scene) {
      if (state.restoredAdultSceneId !== scene.id) {
        resetAdultSceneGameplay();
      }
      state.lastAdultFrameNow = now;
      enterAdultScene(scene, { forceStart: false, reason: 'playback-boundary' });
    }
    return;
  }

  if (!els.video) return;

  if (state.adultLoopSeeking || els.video.seeking) {
    state.lastAdultFrameNow = now;
    return;
  }

  const sceneEnd = Number(state.adultScene?.endTime);
  const hasActiveClip = state.activeAdultPreludeId || state.activeMovementId ||
    state.adultOutcomePhase !== 'idle' || state.adultOrgasmDecision;
  // When the source leaves this scene, release its panel. Preserve the actual
  // source time after a forward seek instead of jumping back to the boundary.
  if (!state.adultOrgasmDecision && Number.isFinite(sceneEnd) && (mediaTime > sceneEnd + 0.1 ||
      (!hasActiveClip && mediaTime >= sceneEnd - 0.04))) {
    finishAdultScene({ force: true, resumeAtCurrentTime: true });
    return;
  }

  if (els.video.paused) {
    state.lastAdultFrameNow = now;
    return;
  }

  if (state.adultOutcomePhase === 'outcome') {
    const outcome = state.adultScene?.outcomes?.find(
      item => item.id === state.activeAdultOutcomeId
    );
    if (!outcome) {
      state.adultOutcomePhase = 'idle';
      state.activeAdultOutcomeId = null;
      return;
    }
    if (mediaTime >= outcome.endTime - 0.04) {
      if (state.adultOrgasmDecision) {
        openAdultOrgasmDecision();
        state.lastAdultFrameNow = now;
        return;
      }
      const aftermath = state.adultScene?.aftermath;
      if (aftermath) {
        const token = beginAdultSelection();
        state.adultOutcomePhase = 'aftermath';
        setAdultMachinePhase('aftermath');
        logEngineEvent('AFTERMATH_STARTED', { sceneId: state.adultScene?.id || null });
        els.video.pause();
        void seekAdultLoop(aftermath.startTime, token);
      } else {
        finishAdultScene({ force: true });
      }
    }
    state.lastAdultFrameNow = now;
    return;
  }

  if (state.adultOutcomePhase === 'aftermath') {
    const aftermath = state.adultScene?.aftermath;
    if (!aftermath || mediaTime >= aftermath.endTime - 0.04) {
      if (state.adultOrgasmDecision) openAdultOrgasmDecision();
      else finishAdultScene({ force: true });
    }
    state.lastAdultFrameNow = now;
    return;
  }

  const elapsed = Math.min(0.25, Math.max(0, (now - (state.lastAdultFrameNow || now)) / 1000));
  state.lastAdultFrameNow = now;

  // Passive playback is progress too. The old implementation advanced this
  // floor only after a clicked card ended, leaving the UI permanently stuck
  // on an earlier room even while the video had moved far ahead.
  const previousFloor = Number(state.adultTimelineFloor) || 0;
  // Do not move the chronology floor through the currently playable clip.
  // Doing so made every visible card a forbidden "past" target moments after
  // playback started. Completed clips advance the floor in their own branches.
  if (!state.activeAdultPreludeId && !state.activeMovementId) {
    state.adultTimelineFloor = Math.max(previousFloor, Number(mediaTime) || 0);
  }
  const floorAdvanced = state.adultTimelineFloor > previousFloor + 0.01;
  if (currentAdultFlow() >= 99.9) unlockNextAdultPositionFromLust();
  if (floorAdvanced && now - Number(state.adultLastApproachRefreshAt || 0) >= 750) {
    state.adultLastApproachRefreshAt = now;
    state.adultUiSignature = '';
    renderAdultProgressiveUI(true);
  }

  if (state.activeAdultPreludeId) {
    const item = state.adultScene?.foreplay?.find(
      entry => entry.id === state.activeAdultPreludeId
    );
    if (!item) {
      state.activeAdultPreludeId = null;
      return;
    }
    if (mediaTime >= item.endTime - 0.04 || mediaTime < item.startTime - 0.15) {
      if (mediaTime >= item.endTime - 0.04) {
        state.adultTimelineFloor = Math.max(state.adultTimelineFloor, Number(item.endTime) || 0);
        state.activeAdultPreludeId = null;
        if (currentAdultFlow() >= 99.9) unlockNextAdultPositionFromLust();
        els.video?.pause();
        renderAdultProgressiveUI(true);
      }
      return;
    }
    const progress = adultPlaybackProgressDelta({
      elapsed,
      femaleRate: item.femaleProgressRate || 1,
      warmup: true
    });
    addFemaleLust(progress.lust);
    renderAdultProgress();
    return;
  }

  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === state.activeMovementId);
  if (!movement) {
    return;
  }

  if (mediaTime >= movement.loopEndTime - 0.04 || mediaTime < movement.loopStartTime - 0.15) {
    // A verified clip never chooses the next movement on behalf of the user.
    // Automatic chaining could cross a bad model grouping and visibly jump
    // from missionary to another position. End on the current frame and keep
    // the panel available until the user explicitly chooses what plays next.
    if (mediaTime >= movement.loopEndTime - 0.04) {
      els.video?.pause();
      state.adultTimelineFloor = Math.max(state.adultTimelineFloor, Number(movement.loopEndTime) || 0);
      state.activeMovementId = null;
      if (currentAdultFlow() >= 99.9) unlockNextAdultPositionFromLust();
      renderAdultProgressiveUI(true);
      logEngineEvent('MOVEMENT_ENDED_AWAITING_SELECTION', {
        positionId: position.id,
        occurrenceId: state.activeAdultOccurrenceId,
        movementId: movement.id
      });
      return;
    }
    els.video?.pause();
    renderAdultProgressiveUI(true);
    logEngineEvent('MOVEMENT_LEFT_RANGE_AWAITING_SELECTION', {
      positionId: position.id,
      movementId: movement.id,
      mediaTime
    });
    return;
  }

  const progress = adultPlaybackProgressDelta({
    elapsed,
    maleRate: movement.maleProgressRate || 1,
    femaleRate: movement.femaleProgressRate || 1,
    warmup: false
  });
  addFemaleLust(progress.lust);
  if (!isWarmupPosition(position)) {
    const movementRate = averageAdultProgress(
      Number(movement.maleProgressRate || 1),
      Number(movement.femaleProgressRate || 1)
    );
    state.adultCorePlaySeconds += elapsed;
    const requiredSeconds = requiredCorePlaySecondsForOutcome(
      Math.max(0, Number(state.adultScene?.endTime) - Number(state.adultScene?.startTime))
    );
    const ratePerSecond = 100 / requiredSeconds;
    state.adultClimaxProgress = Math.min(100,
      state.adultClimaxProgress + elapsed * ratePerSecond * movementRate
    );
    const corePositions = (state.adultScene?.positions || []).filter(item => !isWarmupPosition(item) && !isBonusPosition(item));
    const visitedCore = corePositions.filter(item => state.adultVisitedPositionIds.has(item.id)).length;
    const maleOrgasmMultiplier = maleOrgasmPlaybackMultiplier({
      corePlaySeconds: state.adultCorePlaySeconds,
      requiredCorePlaySeconds: requiredSeconds,
      coreVisitedCount: visitedCore,
      movementTempo: movement.movementTempo,
      maleRate: movement.maleProgressRate || 1
    });
    if (maleOrgasmMultiplier > 0) {
      state.adultMaleOrgasmProgress = Math.min(100,
        state.adultMaleOrgasmProgress + progress.maleOrgasm * maleOrgasmMultiplier
      );
    }
    state.adultFemaleOrgasmProgress = 0;
  }
  renderAdultProgress();
  if (triggerAdultOrgasmDecision()) return;

  // Never auto-complete a scene merely because a meter reached 100. The
  // verified outcome/aftermath or the explicit scene-finish control owns exit.
}

function adultFrameLoop(now, metadata) {
  renderSubtitle();
  updateAdultPlayback(now, Number(metadata?.mediaTime ?? els.video?.currentTime ?? 0));
  if (els.video?.requestVideoFrameCallback) {
    state.adultFrameRequest = els.video.requestVideoFrameCallback(adultFrameLoop);
  }
}

if (els.finishAdultSceneBtn) {
  els.finishAdultSceneBtn.addEventListener('click', skipCurrentScene);
}

els.orgasmContinueBtn?.addEventListener('click', continueAfterAdultOrgasm);
els.orgasmFinishBtn?.addEventListener('click', () => finishAdultScene({ force: true }));

if (els.nextVariantBtn) {
  els.nextVariantBtn.addEventListener('click', playNextAdultVariant);
}

attachHoldReleaseControl({
  button: els.rhythmTapBtn,
  engine: tactile,
  onActivate: ({ timestamp }) => handleAdultRhythmTap(timestamp)
});

attachTactileSurface({ root: els.adultInteractionPanel, engine: tactile });

els.adultFeelToggle?.addEventListener('click', () => {
  tactile.toggle();
  renderTactileToggle();
});
renderTactileToggle();

els.adultPanelToggleBtn?.addEventListener('click', () => {
  setAdultPanelExpanded(!els.adultInteractionPanel?.classList.contains('compact-expanded'));
});

els.adultDockMoreBtn?.addEventListener('click', () => {
  setAdultPanelExpanded(!els.adultInteractionPanel?.classList.contains('compact-expanded'));
});

if (els.video?.requestVideoFrameCallback) {
  state.adultFrameRequest = els.video.requestVideoFrameCallback(adultFrameLoop);
} else if (els.video) {
  els.video.addEventListener("timeupdate", () => {
    updateAdultPlayback(performance.now(), els.video.currentTime);
  });
}

function isUnownedTimelineChoice(action) {
  if (action?.sourceVerified !== true) return false;
  const family = playableAdultPanelFamily(action);
  if (family) {
    const explicitContact = ['kiss', 'touch', 'clothing', 'body_transition'].includes(action.actionType);
    if (!explicitContact || action.positionId || action.positionLabel) return false;
  }
  return !findAdultSceneForTimeline(state.adultScenes, {
    action, completedSceneIds: state.completedAdultSceneIds
  });
}

function futureActions() {
  const lookAheadSeconds = 45;
  const windowEnd = Math.min(
    state.gameCursorTime + lookAheadSeconds,
    state.analysis.videoDuration || Number.POSITIVE_INFINITY
  );

  const pool = state.analysis.actions.filter((a, idx) =>
    idx > state.currentActionIndex &&
    a.startTime >= state.gameCursorTime - 0.001 &&
    a.startTime <= windowEnd &&
    !state.consumedActionIds.has(a.actionId) &&
    isUnownedTimelineChoice(a)
  );

  const seenChoices = new Set();

  const unique = pool.filter((action) => {
    const key = action.choiceKey ||
      action.label.trim().toLocaleLowerCase('tr-TR');

    if (seenChoices.has(key)) {
      return false;
    }

    seenChoices.add(key);
    return true;
  });
  return selectDiverseStoryActions(unique, 3);
}

function nextVerifiedRouteTime() {
  const cursor = Number(state.gameCursorTime) || 0;
  const actionTimes = (state.analysis?.actions || [])
    .filter((action, index) =>
      index > state.currentActionIndex &&
      action?.sourceVerified === true &&
      !state.consumedActionIds.has(action.actionId) &&
      Number(action.startTime) > cursor + 0.05
    )
    .map(action => Number(action.startTime));
  const sceneTimes = (state.adultScenes || [])
    .filter(scene =>
      !state.completedAdultSceneIds?.has(scene.id) &&
      Number(scene.startTime) > cursor + 0.05
    )
    .map(scene => Number(scene.startTime));
  const routes = [...actionTimes, ...sceneTimes].filter(Number.isFinite);
  return routes.length ? Math.min(...routes) : null;
}

async function resumeAnalysisGap(target) {
  if (state.navigationSeeking || state.adultMode || state.activeAction) return;
  const generation = state.playbackGeneration;
  const bridgeTarget = Math.max(Number(state.gameCursorTime) || 0, Number(target) || 0);
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  els.choices.classList.add('hidden');
  setGameState('SEGMENT_PLAYING');
  logEngineEvent('ANALYSIS_GAP_PLAYBACK_STARTED', {
    from: Number(state.gameCursorTime) || 0,
    to: bridgeTarget
  });
  state.stopListener = () => {
    if (generation !== state.playbackGeneration || Number(els.video.currentTime) < bridgeTarget - 0.04) return;
    els.video.pause();
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
    state.gameCursorTime = Math.min(
      bridgeTarget,
      Number(els.video.duration) || Number(state.analysis?.videoDuration) || bridgeTarget
    );
    logEngineEvent('ANALYSIS_GAP_PLAYBACK_COMPLETED', { at: state.gameCursorTime });
    setGameState('DECISION_PENDING');
    renderChoices();
  };
  els.video.addEventListener('timeupdate', state.stopListener);
  try {
    await els.video.play();
  } catch {
    if (generation !== state.playbackGeneration) return;
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
    setGameState('DECISION_PENDING');
    showPlaybackRecovery(
      'Analiz edilemeyen bölüm kaynak videodan oynatılacak.',
      () => void resumeAnalysisGap(bridgeTarget),
      'Videoya devam et'
    );
  }
}

function renderChoices() {
  if (
    state.adultMode &&
    state.adultScene &&
    !state.completedAdultSceneIds?.has(state.adultScene.id)
  ) {
    els.choices.innerHTML = '';
    els.choices.classList.add('hidden');
    document.querySelector('.choice-navigation')?.classList.add('hidden');
    renderAdultPanel(state.adultScene);
    setGameState('SEGMENT_PLAYING');
    return;
  }

  const routeTime = nextVerifiedRouteTime();
  const gapTarget = state.analysis?.partial === true
    ? analysisGapBridgeTarget(
        state.analysis.analysisGaps,
        state.gameCursorTime,
        routeTime === null ? [] : [routeTime],
        Number(els.video.duration) || Number(state.analysis.videoDuration)
      )
    : null;
  if (gapTarget !== null) {
    void resumeAnalysisGap(gapTarget);
    return;
  }

  const cursorScene = findAdultSceneAt(state.gameCursorTime);
  if (cursorScene && enterAdultScene(cursorScene, { forceStart: true, reason: 'cursor-inside-scene' })) {
    return;
  }

  const intervals = state.analysis?.unownedSourceIntervals || [];
  const unowned = intervals.find(interval =>
    Number(interval.endTime) > state.gameCursorTime + 0.05 &&
    (routeTime === null || Number(interval.startTime) < routeTime - 0.05));
  if (unowned) {
    const duration = Number(els.video.duration) || Number(state.analysis?.videoDuration) || 0;
    if (Number(unowned.startTime) > state.gameCursorTime + 0.3) {
      void resumeAnalysisGap(Number(unowned.startTime));
      return;
    }
    const end = Math.min(duration || Infinity, Number(unowned.endTime));
    const nextRoute = [
      ...(state.analysis?.actions || []).filter(action => action.sourceVerified &&
        !state.consumedActionIds.has(action.actionId)).map(action => Number(action.startTime)),
      ...(state.adultScenes || []).filter(scene => !state.completedAdultSceneIds?.has(scene.id))
        .map(scene => Number(scene.startTime))
    ].filter(time => Number.isFinite(time) && time >= end - 0.05);
    const nextUnowned = intervals.find(interval => Number(interval.startTime) >= end - 0.05);
    const skipTarget = Math.min(duration || Infinity, ...nextRoute,
      Number(nextUnowned?.startTime) || Infinity);
    if (end > state.gameCursorTime + 0.1) {
      els.choices.replaceChildren();
      els.choices.classList.remove('hidden');
      const message = document.createElement('div');
      message.className = 'meta';
      message.textContent = 'Bu bölümde baş karakter doğrulanamadı.';
      const watch = document.createElement('button');
      watch.className = 'choice';
      watch.textContent = 'Bölümü izle';
      watch.addEventListener('click', () => void resumeAnalysisGap(end));
      const skip = document.createElement('button');
      skip.className = 'choice';
      skip.textContent = 'Sahneyi geç';
      skip.addEventListener('click', () => void navigateTimelineTo(Number.isFinite(skipTarget) ? skipTarget : end));
      els.choices.append(message, watch, skip);
      setGameState('DECISION_PENDING');
      return;
    }
  }

  els.choices.classList.remove('hidden');
  els.choices.innerHTML = '';
  els.cursorText.textContent = `cursor: ${state.gameCursorTime.toFixed(3)}`;
  let candidates = futureActions();

  if (!candidates.length && state.analysis?.actions?.length) {
    candidates = selectDiverseStoryActions(state.analysis.actions
      .filter((action, index) =>
        index > state.currentActionIndex &&
        Number(action.startTime) >= state.gameCursorTime - 0.001 &&
        !state.consumedActionIds.has(action.actionId) &&
        isUnownedTimelineChoice(action)
      ), 3);
  }

  const firstCandidate = candidates[0];
  const candidateScene = findAdultSceneForTimeline(state.adultScenes, {
    action: firstCandidate,
    completedSceneIds: state.completedAdultSceneIds
  });
  if (candidateScene && Number(candidateScene.startTime) <= state.gameCursorTime + 0.15 &&
      enterAdultScene(candidateScene, { forceStart: true, reason: 'next-timeline-action' })) {
    return;
  }

  // Only actions owned by a validated adult-scene graph are removed from
  // the normal timeline. A raw model flag alone must never orphan an action.
  candidates = candidates.filter(action =>
    !findAdultSceneForTimeline(state.adultScenes, {
      action,
      completedSceneIds: state.completedAdultSceneIds
    })
  );

  if (!candidates.length) {
    candidates = selectDiverseStoryActions(state.analysis.actions
      .filter((action, index) =>
        index > state.currentActionIndex &&
        Number(action.startTime) >= state.gameCursorTime - 0.001 &&
        !state.consumedActionIds.has(action.actionId) &&
        isUnownedTimelineChoice(action) &&
        !findAdultSceneForTimeline(state.adultScenes, {
          action,
          completedSceneIds: state.completedAdultSceneIds
        })
      ), 3);
  }

  if (!candidates.length) {
    const duration = Number(els.video.duration) || Number(state.analysis?.videoDuration);
    const cursor = Math.max(state.gameCursorTime, Number(els.video.currentTime) || 0);
    if (hasRemainingVideo(cursor, duration)) {
      setGameState('DECISION_PENDING');
      showPlaybackRecovery('Bu noktadan sonra seçim yok; video devam ediyor.', resumeSourceVideo, 'Videoya devam et');
    } else {
      setGameState('ENDED');
      els.choices.innerHTML = '<div class="meta">Video tamamlandı.</div>';
    }
    return;
  }

  candidates.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'choice';
    const storyLabel = storyChoiceLabelForAction(action);
    button.innerHTML = `
      <div class="choice-title">${escapeHtml(storyLabel)}</div>
    `;
    button.addEventListener('click', () => playAction(action));
    els.choices.appendChild(button);
  });
  renderDebug({ nextCandidateActions: candidates.map(a => a.actionId) });
}

function showPlaybackRecovery(message, retry, label = 'Geçişi tekrar dene') {
  els.choices.replaceChildren();
  els.choices.classList.remove('hidden');
  const copy = document.createElement('div');
  copy.className = 'meta';
  copy.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  button.dataset.playbackRecovery = label === 'Videoya devam et' ? 'continue' : 'retry';
  button.textContent = label;
  button.addEventListener('click', retry);
  els.choices.append(copy, button);
  document.querySelector('.choice-navigation')?.classList.remove('hidden');
}

async function resumeSourceVideo() {
  if (state.navigationSeeking || state.adultMode) return;
  const generation = state.playbackGeneration;
  state.activeAction = null;
  els.choices.classList.add('hidden');
  setGameState('SEGMENT_PLAYING');
  try { await els.video.play(); }
  catch {
    if (generation !== state.playbackGeneration) return;
    setGameState('DECISION_PENDING');
    showPlaybackRecovery('Video oynatılamadı. Devam etmek için dokun.', resumeSourceVideo, 'Videoya devam et');
  }
}

async function navigateTimelineTo(target, { resumeWhenEmpty = false } = {}) {
  cancelTimelineNavigation();
  const controller = new AbortController();
  state.navigationSeekController = controller;
  state.navigationSeeking = true;
  state.manualSeeking = false;
  state.activeAction = null;
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  els.video.pause();
  setGameState('SEGMENT_SEEKING');
  try {
    const reached = await seekMediaTo(els.video, target, { signal: controller.signal });
    if (controller.signal.aborted) return;
    state.gameCursorTime = reached;
    state.navigationSeeking = false;
    setGameState('DECISION_PENDING');
    renderChoices();
    if (resumeWhenEmpty && !state.adultMode &&
        els.choices.querySelector('[data-playback-recovery="continue"]')) {
      await resumeSourceVideo();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    state.navigationSeeking = false;
    setGameState('DECISION_PENDING');
    showPlaybackRecovery(error.message, () => void navigateTimelineTo(target, { resumeWhenEmpty }));
  } finally {
    if (state.navigationSeekController === controller) state.navigationSeekController = null;
  }
}

function cancelTimelineNavigation() {
  state.playbackGeneration = (state.playbackGeneration || 0) + 1;
  state.decisionDubHold = false;
  state.navigationSeekController?.abort();
  state.navigationSeekController = null;
  state.navigationSeeking = false;
  state.manualSeeking = false;
}

async function playAction(action) {
  cancelTimelineNavigation();
  const adultScene = findAdultSceneForTimeline(state.adultScenes, {
    action,
    completedSceneIds: state.completedAdultSceneIds
  });
  if (adultScene) {
    enterAdultScene(adultScene, { forceStart: true, reason: 'action-route-guard' });
    return;
  }

  const guard = guardPlayable('timeline', action, { unlocked: true });
  const actionStart = Number(action?.startTime);
  if (!guard.allowed || !Number.isFinite(actionStart) || actionStart < state.gameCursorTime - 0.03) {
    logEngineEvent('TIMELINE_BACKWARD_SEEK_BLOCKED', {
      actionId: action?.actionId || null,
      actionStart,
      cursor: state.gameCursorTime
    });
    renderChoices();
    return;
  }
  logEngineEvent('TIMELINE_ACTION_SELECTED', { actionId: action.actionId });
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }

  state.activeAction = action;
  els.choices.innerHTML = '';
  els.choices.classList.add('hidden');
  setGameState('SEGMENT_SEEKING');
  els.video.pause();

  const seekTarget = Math.max(state.gameCursorTime, actionStart);
  const controller = new AbortController();
  state.navigationSeekController = controller;
  state.navigationSeeking = true;
  try {
    await seekMediaTo(els.video, seekTarget, { signal: controller.signal });
    if (controller.signal.aborted || state.activeAction !== action) return;
    state.navigationSeeking = false;
    const decisionEndTime = decisionBoundaryAfterDialogue(
      state.dialogue?.segments || [],
      action.endTime,
      state.analysis?.videoDuration || els.video.duration
    );
    state.stopListener = () => {
      if (state.activeAction === action && els.video.currentTime >= decisionEndTime - 0.03) {
        void finishActionAfterDub(action, decisionEndTime);
      }
    };
    els.video.addEventListener('timeupdate', state.stopListener);
    await resumeActionPlayback(action);
  } catch (error) {
    if (controller.signal.aborted || state.activeAction !== action) return;
    state.navigationSeeking = false;
    setGameState('DECISION_PENDING');
    showPlaybackRecovery(error.message, () => void playAction(action));
  } finally {
    if (state.navigationSeekController === controller) state.navigationSeekController = null;
  }
}

async function resumeActionPlayback(action) {
  if (state.activeAction !== action || state.navigationSeeking) return;
  const generation = state.playbackGeneration;
  els.choices.classList.add('hidden');
  setGameState('SEGMENT_PLAYING');
  try { await els.video.play(); }
  catch {
    if (state.activeAction !== action || generation !== state.playbackGeneration) return;
    setGameState('DECISION_PENDING');
    showPlaybackRecovery('Video oynatılamadı. Devam etmek için dokun.',
      () => void resumeActionPlayback(action), 'Videoya devam et');
  }
}

function waitForDubEnd(playing) {
  return new Promise(resolve => {
    const pending = new Set(playing);
    const listeners = new Map();
    const finish = () => {
      clearTimeout(timer);
      for (const [audio, done] of listeners) {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
      }
      resolve();
    };
    const remainingSeconds = Math.max(0, ...playing.map(audio => {
      const remaining = (Number(audio.duration) - Number(audio.currentTime)) / Math.max(.25, Number(audio.playbackRate) || 1);
      return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    }));
    const timer = setTimeout(finish, (remainingSeconds + 8) * 1000);
    for (const audio of playing) {
      const done = () => {
        pending.delete(audio);
        if (!pending.size) finish();
      };
      listeners.set(audio, done);
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      if (audio.ended) done();
    }
    if (!pending.size) finish();
  });
}

async function finishActionAfterDub(action, decisionEndTime) {
  if (state.decisionDubHold || state.activeAction !== action) return;
  const generation = state.playbackGeneration;
  const playing = [...dubChannels.values()].filter(audio =>
    audio && !audio.paused && !audio.ended && Number(audio.currentTime) < Number(audio.duration || Infinity) - 0.03
  );
  if (!state.dubbingEnabled || !playing.length) {
    finishAction(action, decisionEndTime);
    return;
  }

  state.decisionDubHold = true;
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  els.video.pause();
  await waitForDubEnd(playing);
  if (generation !== state.playbackGeneration || state.activeAction !== action) return;
  playing.forEach(audio => audio.pause());
  state.decisionDubHold = false;
  finishAction(action, decisionEndTime);
}

function finishAction(action, decisionEndTime = action.endTime) {
  els.video.pause();
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  const reachedTime = Math.max(Number(action.endTime) || 0, Number(decisionEndTime) || 0);
  let reachedIndex = state.analysis.actions.findIndex(a => a.actionId === action.actionId);
  state.analysis.actions.forEach((candidate, index) => {
    if (Number(candidate.endTime) <= reachedTime + 0.03) {
      state.consumedActionIds.add(candidate.actionId);
      reachedIndex = Math.max(reachedIndex, index);
    }
  });
  state.gameCursorTime = reachedTime;
  state.currentActionIndex = Math.max(state.currentActionIndex, reachedIndex);
  state.activeAction = null;
  setGameState('DECISION_PENDING');
  persistRuntimeSnapshot('action-finished', true);
  renderChoices();
}

function resetGameAtAction(index) {
  if (state.adultMode) return;
  cancelTimelineNavigation();
  const actions = state.analysis?.actions || [];
  if (!actions.length) return;

  const safeIndex = Math.max(0, Math.min(index, actions.length - 1));
  const target = actions[safeIndex];
  const targetAdultScene = findAdultSceneForTimeline(state.adultScenes, {
    action: target,
    time: Number(target.startTime),
    completedSceneIds: new Set()
  });

  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }

  state.activeAction = null;
  state.currentActionIndex = safeIndex - 1;
  state.gameCursorTime = Number(target.startTime) || 0;
  state.consumedActionIds = new Set(
    actions.slice(0, safeIndex).map(action => action.actionId)
  );

  if (targetAdultScene) {
    state.completedAdultSceneIds.delete(targetAdultScene.id);
    resetAdultSceneGameplay();
    state.restoredAdultSceneId = null;
    enterAdultScene(targetAdultScene, {
      forceStart: true,
      reason: 'choice-navigation-adult-scene'
    });
    persistRuntimeSnapshot('adult-scene-reopened', true);
    return;
  }

  void navigateTimelineTo(state.gameCursorTime);
}

function jumpChoice(direction) {
  if (state.adultMode) return;
  const actions = state.analysis?.actions || [];
  if (!actions.length) return;

  const now = Number(els.video.currentTime) || 0;
  let index;

  if (direction > 0) {
    index = actions.findIndex(action => Number(action.startTime) > now + 0.35);
    if (index < 0) index = actions.length - 1;
  } else {
    index = actions.length - 1;
    while (index >= 0 && Number(actions[index].startTime) >= now - 0.35) {
      index -= 1;
    }
    if (index < 0) index = 0;
  }

  resetGameAtAction(index);
}

function renderTimeline() {
  els.timelineList.innerHTML = '';
  state.analysis.actions.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'timeline-item';
    div.innerHTML = `<b>${String(i + 1).padStart(2, '0')} • ${escapeHtml(storyChoiceLabelForAction(a))}</b><div class="meta">${a.startTime.toFixed(3)} → ${a.endTime.toFixed(3)} • ${escapeHtml(a.actionId)}</div>`;
    els.timelineList.appendChild(div);
  });
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

els.video.addEventListener('seeking', () => {
  if (state.adultMode || state.adultLoopSeeking) {
    state.manualSeeking = false;
    return;
  }

  if (!state.activeAction && !state.navigationSeeking) {
    state.manualSeeking = true;
  }
});

els.video.addEventListener('seeked', () => {
  if (state.adultMode) {
    updateAdultPlayback(performance.now(), Number(els.video.currentTime) || 0);
    return;
  }
  if (
    state.adultLoopSeeking ||
    !state.manualSeeking ||
    state.activeAction ||
    state.navigationSeeking
  ) return;
  state.manualSeeking = false;

  const actions = state.analysis?.actions || [];
  if (!actions.length) return;

  const now = Number(els.video.currentTime) || 0;
  let index = actions.findIndex(action => Number(action.startTime) >= now - 0.1);
  if (index < 0) index = actions.length - 1;

  state.currentActionIndex = index - 1;
  state.gameCursorTime = Number(actions[index].startTime) || now;
  state.consumedActionIds = new Set(
    actions.slice(0, index).map(action => action.actionId)
  );

  els.video.pause();
  setGameState('DECISION_PENDING');
  renderChoices();
});

els.video.addEventListener('play', () => {
  if (
    state.gameState !== 'SEGMENT_PLAYING' &&
    state.gameState !== 'DIALOGUE_READY'
  ) {
    els.video.pause();
  }
});
els.video.addEventListener('timeupdate', renderDebug);
els.video.addEventListener('ended', handleSourceEnded);

checkHealth();
checkAiUsageStatus();
setInterval(checkAiUsageStatus, 60 * 1000);
renderDebug();

function clearPreviousGameResidue() {
  state.analysisSession?.audioPreparationController?.abort();
  state.activeSavedGameId = null;
  state.savedGameReady = false;
  state.savedPlaybackOnly = false;
  savedGames?.resetCurrent();
  state.remoteFileDownload?.controller.abort();
  state.remoteFileDownload = null;
  cancelTimelineNavigation();
  cancelAdultSeek();
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
  state.dialogue = null;
  state.selectedRemoteToken = '';
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
  updateLanguageSyncControls();
  els.dubToggleBtn?.classList.add('hidden');
  if (els.video) {
    releaseVideoObjectUrl();
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  void videoDownloads.release(state.selectedFile);
  if (state.analysisSession?.file !== state.selectedFile) void videoDownloads.release(state.analysisSession?.file);
  resetDubState();
  setGameState('IDLE');
}

clearPreviousGameResidue();


// FULLSCREEN GAME MODE
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenStage = document.querySelector('.video-stage');

attachPanelFeedback({
  stage: fullscreenStage, panel: els.adultInteractionPanel, choices: els.choices, video: els.video,
  getSnapshot: () => {
    const position = state.adultScene?.positions?.find(item => item.id === state.activePositionId);
    const clip = position?.movements?.find(item => item.id === state.activeMovementId) ||
      state.adultScene?.foreplay?.find(item => item.id === state.activeAdultPreludeId) || state.activeAction;
    return {
      scope: `${state.analysisFingerprint}:${state.adultScene?.id}:${state.activePositionId}:${state.activeAdultOccurrenceId}`,
      controlScope: `${state.analysisFingerprint}:${state.adultScene?.id}:${state.activePositionId}`,
      choiceClips: (state.adultMode && !state.adultSexUnlocked
        ? (state.adultApproachChoices || []).filter(choice => choice.variants?.length).map(choice => ({ ...choice, id: choice.choiceId }))
        : (position?.activeMovementChoices || [])).map(choice => ({
        ...choice,
        nextClip: pickNextVariant(choice.variants,
          choice.variants.some(item => item.id === state.activeMovementId) ? state.activeMovementId : null,
          state.adultMovementPlayCounts)
      })),
      clip, seeking: state.adultLoopSeeking || state.navigationSeeking,
      buffering: Boolean(state.dubBuffer), failed: Boolean(els.panelPlaybackRecovery)
    };
  }
});

fullscreenBtn?.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await fullscreenStage.requestFullscreen();
      try { await screen.orientation?.lock?.('landscape'); } catch {}
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    console.error('Tam ekran açılamadı:', error);
  }
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

document.addEventListener('fullscreenchange', () => {
  keepGameVideoControlsHidden();
  syncAdultPanelPlacement(fullscreenStage);
  updateFullscreenButton();
});

document.addEventListener('webkitfullscreenchange', () => {
  syncAdultPanelPlacement(fullscreenStage);
  updateFullscreenButton();
});


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
    parallel: options.allowDirect !== false,
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
      allowDirect: !['hls', 'dash'].includes(remote.type),
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
      allowDirect: result.type === 'video'
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
    state.analysisSession = null;
    state.videoObjectUrl = objectUrl;
    els.video.src = state.videoObjectUrl;
    els.fileMeta.textContent =
      `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • URL kaynağı`;
    updateAnalyzeAvailability();
    renderDebug();

    setUrlStatus('Video cihazda hazır. “Seçili analizleri başlat” ile devam et.', 'success');
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

function captureSavedGame() {
  const video = state.selectedFile || state.analysisSession?.file;
  if (!state.savedGameReady || !(video instanceof Blob) || !video.size) return null;
  return {
    id: state.activeSavedGameId,
    title: video.name || 'Kayıtlı oyun',
    fileName: video.name || 'video.mp4',
    sourceKind: state.selectedSourceKind,
    duration: Number(els.video.duration) || Number(state.analysis?.videoDuration),
    video,
    payload: {
      analysis: state.analysis,
      dialogue: state.dialogue,
      dubCache: [...state.dubCache],
      dubSpeakerVoices: [...state.dubSpeakerVoices.values()],
      dubStableSpeakerGenders: [...state.dubStableSpeakerGenders],
      subtitlesEnabled: state.subtitlesEnabled,
      dubbingEnabled: state.dubbingEnabled,
      keepOriginalAudioEnabled: state.keepOriginalAudioEnabled,
      languageSyncOffset: state.languageSyncOffset
    }
  };
}

async function openSavedGame(game) {
  validateGame(game);
  if (game.payload.analysis?.schemaVersion > ANALYSIS_SCHEMA_VERSION) {
    throw new Error('Bu kayıt daha yeni bir uygulama sürümüyle oluşturulmuş. Sayfayı yenile.');
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
  state.dialogue = game.payload.dialogue;
  state.languageSyncOffset = Number(game.payload.languageSyncOffset) || 0;
  state.dubCache = new Map(game.payload.dubCache || []);
  state.dubSpeakerVoices = new Map((game.payload.dubSpeakerVoices || []).map(row => [row.speakerId, row]));
  state.dubVoicePlanRequest = null;
  state.dubStableSpeakerGenders = new Map(game.payload.dubStableSpeakerGenders || []);
  state.subtitlesEnabled = Boolean(game.payload.subtitlesEnabled);
  state.dubbingEnabled = Boolean(game.payload.dubbingEnabled && state.dubCache.size);
  state.keepOriginalAudioEnabled = game.payload.keepOriginalAudioEnabled !== false;
  state.activeSavedGameId = game.id;
  state.savedGameReady = true;
  state.savedPlaybackOnly = true;
  els.videoInput.value = '';
  videoUrlInput.value = '';
  setUrlStatus('');
  els.video.src = url;
  els.video.load();
  els.fileMeta.textContent = `${game.title} · kayıtlı video · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  els.subtitleToggleBtn.classList.toggle('hidden', !state.dialogue?.segments?.length);
  els.subtitleToggleBtn.textContent = `TR ALTYAZI: ${state.subtitlesEnabled ? 'AÇIK' : 'KAPALI'}`;
  updateLanguageSyncControls();
  els.dubToggleBtn.classList.toggle('hidden', !state.dubCache.size);
  delete els.dubToggleBtn.dataset.unavailable;
  els.dubToggleBtn.title = '';
  els.dubToggleBtn.textContent = `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;
  updateDubMix();
  if (state.analysis) initializeInteractive(state.analysis);
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
    form.append('dialogueContext', JSON.stringify((game.payload.dialogue?.segments || []).filter(item =>
      Number(item.endTime) > gap.startTime && Number(item.startTime) < gap.endTime)));
    form.append('dialogueSpeakerContext', JSON.stringify(game.payload.dialogue?.speakers || []));
    form.append('sensoryAudioContext', JSON.stringify((game.payload.dialogue?.nonSpeechEvents || []).filter(item =>
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
