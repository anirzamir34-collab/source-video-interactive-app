import {
  adultPositionFamily,
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  buildVerifiedMovementChoices,
  consolidateVerifiedPositions,
  computeAdultSelectionDelta,
  computeWarmupSelectionDelta,
  expandVerifiedMovementVariants,
  findAdultSceneForTimeline,
  isEnergeticSexMoment,
  isOutcomeUnlocked,
  groupVerifiedMovementsByTempo,
  monotonicAdultPhase,
  nearestAvailableTempo,
  normalizeOutcomeUnlockProgress,
  playbackRateForTapTempo,
  pickNearbyRhythmVariant,
  pickNextChronologicalVariant,
  pickNextVariant,
  positionUnlockProgress,
  requiredCorePlaySecondsForOutcome,
  requiredWarmupDiscoveries,
  tapRhythm
} from './adult-gameplay.js';
import {
  dialogueSegmentAt,
  decisionBoundaryAfterDialogue,
  dubMasterClockCorrection,
  dubSegmentKey,
  fittedDubPlaybackRate,
  isCompleteChunkAnalysis,
  mapVideoTimeToDubTime,
  nextDialogueSegments
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
  sensoryActionMeta,
  storyActionMeta,
  storyChoiceLabelForAction
} from './story-engine.js';

const $ = (id) => document.getElementById(id);

const state = {
  serviceConnected: false,
  serviceCapabilities: null,
  selectedFile: null,
  selectedRemoteVideo: null,
  analysis: null,
  dialogue: null,
  subtitlesEnabled: true,
  dubbingEnabled: false,
  keepOriginalAudioEnabled: true,
  activeDubSegmentId: null,
  dubCache: new Map(),
  dubRequests: new Map(),
  dubSyncGeneration: 0,
  dubUnavailableUntil: 0,
  dubFailureReason: '',
  gameState: 'IDLE',
  gameCursorTime: 0,
  currentActionIndex: -1,
  consumedActionIds: new Set(),
  activeAction: null,
  stopListener: null,
  adultScene: null,
  adultMode: false,
  activePositionId: null,
  activeAdultCategory: null,
  activeMovementId: null,
  activeMovementChoiceId: null,
  maleSceneProgress: 0,
  femaleSceneProgress: 0,
  lastAdultMediaTime: null,
  adultScenes: [],
  completedAdultSceneIds: new Set(),
  adultLoopSeeking: false,
  adultSeekTimer: null,
  adultSeekListener: null,
  adultSeekRequestId: 0,
  adultSelectionToken: 0,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultPreludePlayCounts: new Map(),
  adultComboCount: 0,
  adultClimaxProgress: 0,
  adultCorePlaySeconds: 0,
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
  gameState: $('gameState'),
  cursorText: $('cursorText'),
  choices: $('choices'),
  prevChoiceBtn: $('prevChoiceBtn'),
  nextChoiceBtn: $('nextChoiceBtn'),
  timelineList: $('timelineList'),
  videoPrompt: $('videoPrompt'),
  debugOutput: $('debugOutput'),
  adultInteractionPanel: $('adultInteractionPanel'),
  adultPanelToggleBtn: $('adultPanelToggleBtn'),
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
  climaxProgressText: $('climaxProgressText'),
  climaxProgressBar: $('climaxProgressBar'),
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

function restoreRuntimeSnapshot(analysis) {
  state.analysisFingerprint = analysisFingerprint(analysis);
  try {
    const raw = localStorage.getItem(RUNTIME_SAVE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (!isCompatibleRuntimeSnapshot(snapshot, state.analysisFingerprint)) {
      localStorage.removeItem(RUNTIME_SAVE_KEY);
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
    localStorage.removeItem(RUNTIME_SAVE_KEY);
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

async function checkAiUsageStatus() {
  try {
    const response = await fetch('/api/ai-usage-status', { cache: 'no-store' });
    const body = await response.json();
    renderQuotaBadge(els.subtitleQuotaStatus, body.subtitles);
    renderQuotaBadge(els.dubQuotaStatus, body.dubbing);
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
  els.analyzeBtn.disabled = !(state.selectedFile || state.selectedRemoteVideo) || !hasMode;
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

els.videoInput.addEventListener('change', () => {
  const file = els.videoInput.files?.[0] || null;
  state.selectedFile = file;
  state.selectedRemoteVideo = null;
  resetDubState();
  if (file) {
    els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • ${file.type || 'video'}`;
    els.video.src = URL.createObjectURL(file);
  } else {
    els.fileMeta.textContent = '';
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
    'Büyük video sunucuya gönderilmeyecek.';

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

    xhr.open(
      'POST',
      `/api/dialogue-upload/${encodeURIComponent(uploadId)}/chunk`
    );
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    xhr.timeout = 120000;
    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', event => {
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

    xhr.addEventListener('load', () => {
      const body = xhr.response || {};

      if (xhr.status >= 200 && xhr.status < 300 && body.available) {
        resolve(body);
      } else {
        reject(
          new Error(
            body.message ||
            body.reason ||
            `Parça yükleme hatası: HTTP ${xhr.status}`
          )
        );
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Parça yüklenirken bağlantı kesildi.'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new Error('Parça yüklemesi zaman aşımına uğradı.'));
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
      mimeType: file.type || 'audio/wav'
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
  // Always-on aggressive upload: fewer round trips, larger sustained network writes.
  const chunkSize = 8 * 1024 * 1024;
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

        if (retryCount >= 5) throw error;

        els.analysisTitle.textContent =
          `Bağlantı bekleniyor · parça ${chunkIndex + 1}/${chunkCount}`;
        els.analysisOutput.textContent =
          'Yükleme kesildi veya uygulama arka plana alındı.\n' +
          'Sayfaya dönüldüğünde kaldığı parçadan devam edilecek.';

        await new Promise(resolve => setTimeout(resolve, 650));
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
    body: finishForm
  });

  const body = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

async function analyzeSelectedDialogue(file) {
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Video diyaloğu analiz ediliyor';
  els.analysisState.textContent = 'AUDIO_ANALYSIS';
  els.analysisOutput.textContent =
    `Konuşma sesi hazırlanıyor...\n` +
    `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  const form = new FormData();
  let dialogueFile = file;
  try {
    dialogueFile = await extractDialogueAudio(file);
  } catch (error) {
    console.warn('Ses ayrılamadı; özgün video yedek olarak kullanılacak:', error);
    els.analysisOutput.textContent = 'Ses ayrılamadı. Videonun ses kanalı doğrudan işleniyor...';
  }

  form.append(
    'video',
    dialogueFile,
    dialogueFile.name || 'dialogue.wav'
  );
  form.append('duration', String(Number(els.video.duration) || 0));
  form.append('protagonistProfile', String(els.protagonistInput?.value || '').trim());

  const upload = await uploadDialogueWithProgress(
    form,
    ({ loaded, total, percent, speed }) => {
      els.analysisTitle.textContent = `Video yükleniyor · %${percent}`;
      els.analysisOutput.textContent =
        `Gerçek yükleme ilerlemesi: %${percent}\n` +
        `${(loaded / 1024 / 1024).toFixed(1)} / ` +
        `${(total / 1024 / 1024).toFixed(1)} MB\n` +
        `Yükleme hızı: ${speed.toFixed(1)} MB/sn`;
    },
    () => {
      els.analysisTitle.textContent = 'Gemini konuşmaları analiz ediyor';
      els.analysisOutput.textContent =
        'Yükleme %100 tamamlandı.\n' +
        'Kaynak dil algılanıyor ve Türkçeye çevriliyor...';
    }
  );

  const { body } = upload;

  if (!upload.ok || !body.available) {
    throw new Error(body.error || body.message || `HTTP ${upload.status}`);
  }

  state.dialogue = {
    ...body,
    segments: Array.isArray(body.segments) ? body.segments : []
  };

  try {
    // Dialogue persistence intentionally disabled: refresh must start clean.
    localStorage.removeItem('videoquest:last-dialogue');
  } catch (error) {
    console.warn('Dialogue could not be saved:', error);
  }

  return state.dialogue;
}

function renderSubtitle() {
  const segments = state.dialogue?.segments || [];
  const now = Number(els.video.currentTime) || 0;

  if (!state.subtitlesEnabled || !segments.length) {
    els.subtitleOverlay?.classList.add('hidden');
    return;
  }

  const segment = dialogueSegmentAt(segments, now, 0.015);

  if (!segment) {
    els.subtitleOverlay?.classList.add('hidden');
    return;
  }

  const speakerProfile = (state.dialogue?.speakers || []).find(item =>
    String(item.speakerId) === String(segment.speakerId)
  );
  const speaker = String(
    segment.speakerName ||
    speakerProfile?.speakerName ||
    speakerProfile?.displayName ||
    (segment.gender === 'female' ? 'Kadın' : segment.gender === 'male' ? 'Erkek' : 'Konuşmacı')
  ).trim();

  els.subtitleSpeaker.textContent = speaker;
  els.subtitleText.textContent = segment.turkishText;
  els.subtitleOverlay.classList.remove('hidden');
}

const dubAudio = new Audio();
dubAudio.preload = 'auto';

function getDubSegmentAt(videoTime) {
  return dialogueSegmentAt(state.dialogue?.segments || [], videoTime);
}

function getDubSegmentId(segment) {
  if (!segment) return '';
  const segments = state.dialogue?.segments || [];
  const index = Math.max(0, segments.indexOf(segment));
  return dubSegmentKey(segment, index);
}

async function ensureDubSegment(segment) {
  if (!segment?.turkishText) return null;
  if (state.dubUnavailableUntil > Date.now()) return null;
  const segmentId = getDubSegmentId(segment);
  if (!segmentId) return null;
  if (state.dubCache.has(segmentId)) return state.dubCache.get(segmentId);
  if (state.dubRequests.has(segmentId)) return state.dubRequests.get(segmentId);

  const request = fetch('/api/gemini-dub-segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: segment.turkishText,
      gender: segment.gender,
      emotion: segment.emotion,
      speakerId: segment.speakerId || segmentId
    })
  }).then(async response => {
    const body = await response.json();
    if (!response.ok || !body?.available || !body?.audioBase64) {
      if (body?.reason === 'GEMINI_TTS_DAILY_LIMIT') {
        const retrySeconds = Math.max(60, Number(body.retryAfterSeconds) || 3600);
        state.dubUnavailableUntil = Date.now() + retrySeconds * 1000;
        state.dubFailureReason = 'GEMINI_TTS_DAILY_LIMIT';
        state.dubbingEnabled = false;
        stopDubPlayback();
        if (els.dubToggleBtn) {
          els.dubToggleBtn.textContent = `TR DUBLAJ: LİMİT DOLDU`;
          els.dubToggleBtn.classList.remove('hidden');
          els.dubToggleBtn.dataset.unavailable = 'true';
        }
        logEngineEvent('DUB_QUOTA_EXHAUSTED', { retrySeconds });
        checkAiUsageStatus();
        return null;
      }
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    const source = `data:${body.mimeType || 'audio/wav'};base64,${body.audioBase64}`;
    state.dubCache.set(segmentId, source);
    return source;
  }).catch(error => {
    console.error('Dub segment failed:', segmentId, error);
    return null;
  }).finally(() => state.dubRequests.delete(segmentId));

  state.dubRequests.set(segmentId, request);
  return request;
}

function stopDubPlayback() {
  dubAudio.pause();
  state.activeDubSegmentId = null;
}

function resetDubState() {
  dubAudio.pause();
  dubAudio.removeAttribute('src');
  dubAudio.load();
  state.dubCache.clear();
  state.dubRequests.clear();
  state.dubSyncGeneration += 1;
  state.activeDubSegmentId = null;
  state.dubFailureReason = '';
  state.dubUnavailableUntil = 0;
}

function prefetchDubSegmentsAround(videoTime) {
  if (!state.dubbingEnabled) return;
  nextDialogueSegments(state.dialogue?.segments || [], videoTime, 1)
    .forEach(segment => void ensureDubSegment(segment));
}

function alignDubAudioToSegment(segment, videoTime) {
  const audioDuration = Number(dubAudio.duration);
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) return;

  const segmentStart = Number(segment.startTime) || 0;
  const segmentEnd = Math.max(segmentStart + 0.05, Number(segment.endTime) || segmentStart + 0.05);
  const correction = dubMasterClockCorrection({
    videoTime,
    audioTime: Number(dubAudio.currentTime) || 0,
    segmentStart,
    segmentEnd,
    audioDuration,
    videoPlaybackRate: Number(els.video.playbackRate) || 1
  });

  if (correction.mode === 'seek') {
    dubAudio.currentTime = correction.targetTime;
    logEngineEvent('DUB_HARD_RESYNC', {
      drift: Number(correction.drift.toFixed(3)),
      videoTime: Number(videoTime.toFixed(3))
    });
  }
  dubAudio.playbackRate = correction.playbackRate;
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) return stopDubPlayback();

  const generation = state.dubSyncGeneration;
  const videoTime = Math.max(0, Number(els.video.currentTime) || 0);
  const segment = getDubSegmentAt(videoTime);

  if (!segment) {
    stopDubPlayback();
    prefetchDubSegmentsAround(videoTime);
    return;
  }

  const segmentId = getDubSegmentId(segment);

  if (state.activeDubSegmentId === segmentId && dubAudio.src) {
    alignDubAudioToSegment(segment, videoTime);
    if (!els.video.paused && dubAudio.paused) {
      dubAudio.play().catch(() => {});
    }
    prefetchDubSegmentsAround(videoTime);
    return;
  }

  stopDubPlayback();
  const source = await ensureDubSegment(segment);
  if (!source || !state.dubbingEnabled || generation !== state.dubSyncGeneration) return;

  const currentTime = Math.max(0, Number(els.video.currentTime) || 0);
  const currentSegment = getDubSegmentAt(currentTime);
  if (!currentSegment || getDubSegmentId(currentSegment) !== segmentId) return;

  state.activeDubSegmentId = segmentId;
  dubAudio.src = source;
  dubAudio.load();

  const start = () => {
    if (
      !state.dubbingEnabled ||
      state.activeDubSegmentId !== segmentId ||
      generation !== state.dubSyncGeneration
    ) return;

    const now = Math.max(0, Number(els.video.currentTime) || 0);
    const stillCurrent = getDubSegmentAt(now);
    if (!stillCurrent || getDubSegmentId(stillCurrent) !== segmentId) return;

    alignDubAudioToSegment(stillCurrent, now);
    if (!els.video.paused) dubAudio.play().catch(() => {});
    prefetchDubSegmentsAround(now);
  };

  if (dubAudio.readyState >= 1) start();
  else dubAudio.addEventListener('loadedmetadata', start, { once: true });
}

els.video.addEventListener('timeupdate', () => void syncDubPlayback());
setInterval(() => {
  if (state.dubbingEnabled && !els.video.paused && !els.video.seeking) {
    void syncDubPlayback();
  }
}, 300);
els.video.addEventListener('pause', () => dubAudio.pause());
els.video.addEventListener('seeking', () => {
  state.dubSyncGeneration += 1;
  dubAudio.pause();
  state.activeDubSegmentId = null;
});
els.video.addEventListener('seeked', () => {
  if (!state.dubbingEnabled) return;
  void syncDubPlayback();
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});
els.video.addEventListener('play', () => {
  void syncDubPlayback();
  prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
});

els.subtitleToggleBtn?.addEventListener('click', () => {
  state.subtitlesEnabled = !state.subtitlesEnabled;
  els.subtitleToggleBtn.textContent =
    `TR ALTYAZI: ${state.subtitlesEnabled ? 'AÇIK' : 'KAPALI'}`;
  renderSubtitle();
});

els.video.addEventListener('timeupdate', renderSubtitle);
els.video.addEventListener('seeked', renderSubtitle);

els.analyzeBtn.addEventListener('click', async () => {
  if (!state.selectedFile && !state.selectedRemoteVideo) return;
  els.analyzeBtn.disabled = true;
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Video harici analiz servisine gönderiliyor…\nSahte fallback kullanılmayacak.';
  setGameState('ANALYZING');

  let file = state.selectedFile;
  const modes = selectedAnalysisModes();

  // Every analysis run must start from a clean dialogue/dub timeline.
  // Reusing old segment ids or old translated dialogue can attach stale audio
  // to new source-video timestamps after a re-analysis.
  state.dialogue = null;
  localStorage.removeItem(RUNTIME_SAVE_KEY);
  state.analysisFingerprint = '';
  state.engineEvents = [];
  state.integrityReport = null;
  state.dubbingEnabled = false;
  state.subtitlesEnabled = false;
  resetDubState();
  els.video.muted = false;
  els.subtitleOverlay?.classList.add('hidden');

  try {
  // Full audio extraction is an explicit subtitle/dubbing operation.
  // Motion-only analysis stays visual and must not spend time or AI quota on audio.
  if (modes.subtitles || modes.dubbing) {
    try {
      if (!file) {
        els.analysisTitle.textContent = 'Ses analizi için video indiriliyor';
        file = await ensureSelectedRemoteFile();
      }
      const dialogue = await analyzeSelectedDialogue(file);

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
        els.video.muted = !modes.keepOriginalAudio;
        // İlk gerçek konuşma segmentlerini arka planda hazırla.
        prefetchDubSegmentsAround(Number(els.video.currentTime) || 0);
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
            ? 'Dublaj için konuşma verisi hazırlandı.'
            : 'Türkçe altyazılar kullanıma hazır.'
        ].join('\n');
        setGameState('DIALOGUE_READY');
        return;
      }
    } catch (error) {
      els.analysisState.textContent = 'DIALOGUE_ERROR';
      els.analysisOutput.textContent =
        `Diyalog analizi başarısız: ${error.message}`;

      if (!modes.motion) {
        setGameState('ERROR');
        return;
      }
    }
  }
  els.analysisTitle.textContent = 'Yerel storyboard hazırlanıyor';
  els.analysisState.textContent = 'LOCAL_PROCESSING';

  const { extractStoryboard } = await import('./storyboard.js');
  const storyboardSource = file || state.selectedRemoteVideo?.proxyUrl;
  const storyboard = await extractStoryboard(storyboardSource, (progress) => {
    els.analysisTitle.textContent = state.selectedRemoteVideo && !file
      ? `Video akışından kareler hazırlanıyor: %${progress}`
      : `Video telefonda hazırlanıyor: %${progress}`;
  });

  const storyboardMB = (storyboard.totalBytes / 1024 / 1024).toFixed(1);
  const sourceSize = file?.size || state.selectedRemoteVideo?.size || 0;
  const sourceSizeText = sourceSize
    ? `${(sourceSize / 1024 / 1024).toFixed(1)} MB yerine `
    : '';
  els.analysisTitle.textContent =
    `${storyboard.timestamps.length} kare hazır • ${sourceSizeText}${storyboardMB} MB gönderiliyor`;
  els.analysisState.textContent = 'UPLOADING_STORYBOARD';

    const sheetsPerChunk = 2;
    const framesPerSheet = 12;
    const chunkCount = Math.ceil(
      storyboard.sheets.length / sheetsPerChunk
    );

    const chunkResults = [];
    let failureBody = null;
    let response = null;
    let body = null;

    let protagonistProfile =
    String(els.protagonistInput?.value || '').trim();
    let storyContextMemory = normalizeStoryContext({});

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const firstSheet = chunkIndex * sheetsPerChunk;
      const chunkSheets = storyboard.sheets.slice(
        firstSheet,
        firstSheet + sheetsPerChunk
      );

      const firstFrame = firstSheet * framesPerSheet;
      const chunkTimestamps = storyboard.timestamps.slice(
        firstFrame,
        firstFrame + chunkSheets.length * framesPerSheet
      );

      const chunkStart = Number(chunkTimestamps[0] ?? 0);
      const lastTimestamp = Number(
        chunkTimestamps[chunkTimestamps.length - 1] ?? chunkStart
      );

      const chunkEnd = Math.min(
        storyboard.duration,
        lastTimestamp + storyboard.interval
      );

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
      failureBody = null;

      for (let attempt = 1; attempt <= 3 && !chunkSucceeded; attempt += 1) {
        els.analysisOutput.textContent =
          `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ayrıntılı inceleniyor...\n` +
          `Deneme ${attempt}/3 · tamamlanan ${chunkResults.length}/${chunkCount}`;

        // Every retry starts from a clean first pass. Review metadata is added
        // only after that first pass succeeds, so a failed review cannot poison
        // the next retry.
        form.delete('reviewMode');
        form.delete('reviewCandidates');

        try {
          response = await fetch('/api/gemini-storyboard-analyze', {
            method: 'POST',
            body: freshChunkForm(),
            signal: AbortSignal.timeout(240000)
          });

          body = await response.json();

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
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye · ${criticalReviewCandidates.length} kritik aday ikinci kez doğrulanıyor...`;
              const reviewResponse = await fetch('/api/gemini-storyboard-analyze', {
                method: 'POST',
                body: freshChunkForm(),
                signal: AbortSignal.timeout(240000)
              });
              let reviewBody = await reviewResponse.json();
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
                continue;
              }
              body = mergeSecondPassReview(body, reviewBody, criticalReviewCandidates);
            }
            chunkResults.push(body);
            storyContextMemory = mergeStoryContexts(chunkResults);
            if (body.protagonistProfile) {
              protagonistProfile = String(body.protagonistProfile).trim();
            }
            chunkSucceeded = true;
            failureBody = null;
            break;
          }
        } catch (error) {
          failureBody = {
            available: false,
            reason: 'NETWORK_ERROR',
            message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
            error: error?.message || String(error)
          };
        }

        if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
          break;
        }

        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1800));
        }
      }

      if (!chunkSucceeded) break;
    }

    const completeChunkAnalysis = isCompleteChunkAnalysis({
      completedChunkCount: chunkResults.length,
      expectedChunkCount: chunkCount,
      failed: Boolean(failureBody)
    });

    if (!completeChunkAnalysis) {
      if (failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {
        body = {
          ...failureBody,
          available: false,
          completedChunkCount: chunkResults.length,
          expectedChunkCount: chunkCount,
          failedChunk: Math.min(chunkCount, chunkResults.length + 1)
        };
      } else {
        body = {
          available: false,
          reason: 'INCOMPLETE_CHUNK_ANALYSIS',
          message:
            `Analiz eksik kaldı: ${chunkResults.length}/${chunkCount} bölüm tamamlandı. ` +
            `Eksik video hiçbir zaman hazır oyun olarak açılmayacak.`,
          completedChunkCount: chunkResults.length,
          expectedChunkCount: chunkCount,
          failedChunk: Math.min(chunkCount, chunkResults.length + 1),
          failure: failureBody
        };
      }
    } else {
      const mergedActions = chunkResults
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

      const prompts = chunkResults
        .map(result => String(result.videoPrompt || '').trim())
        .filter(Boolean);
      const mergedStoryContext = mergeStoryContexts(chunkResults);

      const firstResult = chunkResults[0] || {};

      body = {
        available: true,
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
        warnings: chunkResults.flatMap(result =>
          Array.isArray(result.warnings) ? result.warnings : []
        ),
        analysisGaps: chunkResults.flatMap(result =>
          Array.isArray(result.analysisGaps) ? result.analysisGaps : []
        ),
        analysisMode: 'MULTI_PASS_DEEP_HARDENED',
        chunkCount: chunkResults.length,
        expectedChunkCount: chunkCount,
        analysisCoverage: chunkCount ? chunkResults.length / chunkCount : 0,
        secondPassChunkCount: chunkResults.filter(result => result.secondPassReviewed).length,
        rebasedChunkCount: chunkResults.filter(result => result.chunkTimeRebased).length,
        analyzedThroughTime: Math.max(0, ...mergedActions.map(action => Number(action.endTime) || 0)),
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION
      };
    }

  if (
    body?.available &&
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
        body = { ...fallbackBody, analysisMode: 'EXTERNAL_FALLBACK' };
      }
    } catch (error) {
      console.warn('External fallback analysis failed:', error);
    }
  }

  if (!body?.available) {
    const creditsDepleted = body?.reason === 'GEMINI_CREDITS_DEPLETED';
    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';
    els.analysisTitle.textContent = creditsDepleted
      ? 'Gemini API kredisi tükendi'
      : 'Video analizi eksik kaldı';
    els.analysisOutput.textContent = creditsDepleted
      ? [
          'Gemini API kredisi tükendi. Analiz başlatılamadı.',
          'Yeni kredi ekle veya geçerli bakiyesi olan başka bir Gemini API anahtarı kullan.',
          'Bu hata için otomatik tekrar deneme yapılmadı.'
        ].join('\n')
      : (body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.');
    setGameState('ERROR');
    renderDebug({ lastAnalyzeBody: body });
    return;
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
  els.analysisState.textContent = 'TIMELINE_READY';
  els.analysisTitle.textContent = `${normalized.actions.length} doğrulanmış aksiyon`;
  els.analysisOutput.textContent = [
    'Derin analiz tamamlandı.',
    `${normalized.actions.length} doğrulanmış aksiyon hazır.`,
    `${Number(body.chunkCount || 0)}/${Number(body.expectedChunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,
    `${Number(body.secondPassChunkCount || 0)} bölüm görsel ikinci kontrolden geçti.`,
    `${Number(body.rebasedChunkCount || 0)} bölümün yerel zamanları video zamanına düzeltildi.`,
    `Zaman çizelgesi ${Number(body.analyzedThroughTime || 0).toFixed(1)} saniyeye kadar doğrulandı.`,
    `Bütünlük kontrolü: ${state.integrityReport?.issueCount || 0} uyarı · ${normalized.actions.length} güvenli aksiyon.`,
    'Oyun modu kullanıma hazır.'
  ].join('\n');
  initializeInteractive(normalized);
  } catch (error) {
    console.error('Analysis failed:', error);
    els.analysisState.textContent = 'ANALYSIS_ERROR';
    els.analysisTitle.textContent = 'Analiz tamamlanamadı';
    els.analysisOutput.textContent =
      error?.message || 'Beklenmeyen bir analiz hatası oluştu.';
    setGameState('ERROR');
    renderDebug({ analysisError: error?.message || String(error) });
  } finally {
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
    const key = `${sceneId}::${familyId}::${routeNamespace}`;

    if (!groups.has(key)) {
      groups.set(key, { sceneId, familyId, routeNamespace, entries: [] });
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
        occurrence = {
          id: `${sceneSlug}:${familySlug}:${routeSlug}:occ-${String(generatedCount).padStart(2, '0')}-${Math.round(entry.startTime * 1000)}`,
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
  const actions = Array.isArray(body?.actions) ? body.actions : [];
  const cleaned = actions
    .map((a, i) => ({
      actionId: String(a.actionId ?? a.id ?? `ACTION_${String(i + 1).padStart(3, '0')}`),
      label: String(a.label ?? a.action ?? 'Unnamed action'),
      narrativeChoiceLabel: String(a.narrativeChoiceLabel || ''),
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
    .sort((a, b) => a.startTime - b.startTime);

  assignPositionOccurrenceIds(cleaned);

  return {
    schemaVersion: Number(body?.schemaVersion || ANALYSIS_SCHEMA_VERSION),
    engineVersion: String(body?.engineVersion || ENGINE_VERSION),
    chunkCount: Number(body?.chunkCount || 0),
    expectedChunkCount: Number(body?.expectedChunkCount || 0),
    analysisCoverage: Number(body?.analysisCoverage || 0),
    secondPassChunkCount: Number(body?.secondPassChunkCount || 0),
    videoDuration: Number(body?.videoDuration ?? 0),
    mainMaleTrackId: body?.mainMaleTrackId ?? null,
    semanticVideoMap: body?.semanticVideoMap ?? [],
    videoPrompt: body?.videoPrompt ?? body?.description ?? '',
    storyContext: normalizeStoryContext(body?.storyContext || {}),
    actions: cleaned,
  };
}

function initializeInteractive(analysis) {
  const requestedStart = Number(
    analysis.playStartTime ??
    analysis.introEndTime ??
    analysis.actions?.[0]?.startTime ??
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
  state.activeAdultCategory = null;
  state.activeMovementId = null;
  state.adultSelectionToken += 1;
  cancelAdultSeek();
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
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
  const labelFamily = adultSemanticFamily(action.positionLabel);
  const idFamily = adultSemanticFamily(action.positionId);
  const actionFamily = action?.sourceVerified === true
    ? adultSemanticFamily([action.label, action.movementType].filter(Boolean).join(' '))
    : '';
  const declaredFamilies = [labelFamily, idFamily, actionFamily].filter(Boolean);
  // Conflicting model fields are not visual proof. Hiding an uncertain tab is
  // safer than selecting one of two incompatible body configurations.
  if (new Set(declaredFamilies).size > 1) return { id: '', label: '' };
  const family = declaredFamilies[0] || '';

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

  if (family) return { id: family, label: labels[family] };

  return { id: '', label: '' };
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
  return ['oral', 'manual'].includes(String(position?.categoryId || '')) ||
    ['oral', 'manual'].includes(String(position?.familyId || ''));
}

function isBonusPosition(position) {
  const category = String(position?.categoryId || '');
  return category === 'anal' || category === 'other';
}

function movementBelongsToPosition(action, canonicalId) {
  const text = normalizeAdultLabel([
    action?.label,
    action?.movementType,
    action?.activityEvidence,
    action?.sensoryEvidence
  ].filter(Boolean).join(' '));
  const family = adultSemanticFamily(text);
  if (family && family !== canonicalId) return false;

  // Warm-up actions must stay in the warm-up panel. A model can attach a
  // kiss/touch label to a position row; that is not proof of a position-local
  // movement and must never become a selectable position card.
  if (!family && /\b(op|opus|kiss|dudak|oksa|okus|sivaz|oksa|saril|dokun|temas|touch|caress|kiss)\b/.test(text)) {
    return false;
  }
  if (/\b(vajinal|vaginal|anal|penetrasyon|penetration|birlesme|gecis|transition|pozisyon\s+degistir|donerken|yonlendir)\b/.test(text)) {
    return false;
  }
  return true;
}


// One encounter is often split into several model scene ids even though the
// source continues with other verified positions. Keep nearby occurrences in
// one gameplay graph so progression can reveal them instead of ending early.
const ADULT_FRAGMENT_MERGE_GAP_SECONDS = 180;

function mergeAdultSceneFragments(scenes, nonAdultActions = []) {
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
    const narrativeBarrier = gap >= 30 && nonAdultActions.some(action => {
      const start = Number(action.startTime);
      const end = Number(action.endTime);
      const actionType = String(action.actionType || '').toLowerCase();
      const explicitNarrativeBreak = ['dialogue', 'story', 'scene_transition'].includes(actionType);
      return action?.sourceVerified === true && explicitNarrativeBreak &&
        Number.isFinite(start) && Number.isFinite(end) &&
        Math.min(end, Number(scene.startTime)) - Math.max(start, Number(previous.endTime)) >= 0.5;
    });
    if (gap > ADULT_FRAGMENT_MERGE_GAP_SECONDS || narrativeBarrier) {
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
  const actions = state.analysis?.actions || [];
  const sceneMap = new Map();
  const sceneIdFor = action => action.adultSceneId ||
    `adult-${Math.round(action.adultSceneStartTime || action.startTime)}`;
  const verifiedPositionSceneIds = new Set(
    actions.filter(action => {
      if (action?.sourceVerified !== true) return false;
      // A verified position may arrive without the optional adultScene flag
      // or activityEvidence. The canonical family in its label is enough to
      // route it into the dedicated adult panel; never require model-only
      // metadata that would otherwise leak the action into normal choices.
      const family = adultSemanticFamily([
        action.positionLabel,
        action.positionId,
        action.label,
        action.movementType
      ].filter(Boolean).join(' '));
      if (!family) return false;
      const start = Number(action.positionStartTime ?? action.startTime);
      const end = Number(action.positionEndTime ?? action.endTime);
      return Number.isFinite(start) && Number.isFinite(end) && end - start >= 6 &&
        Number(action.confidence || 0) >= 0.6;
    }).map(sceneIdFor)
  );

  actions.filter(action =>
    verifiedPositionSceneIds.has(sceneIdFor(action))
  ).forEach((action, index) => {
    const sceneId = sceneIdFor(action);

    if (!sceneMap.has(sceneId)) {
      sceneMap.set(sceneId, {
        id: sceneId,
        sourceSceneIds: [sceneId],
        title: 'Etkileşimli Sahne',
        startTime: Number(action.adultSceneStartTime ?? action.startTime),
        endTime: Number(action.adultSceneEndTime ?? action.endTime),
        postSceneTime: Number(action.postSceneTime ?? action.adultSceneEndTime ?? action.endTime),
        foreplay: [],
        positions: new Map(),
        outcomes: [],
        aftermath: null
      });
    }

    const scene = sceneMap.get(sceneId);
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
      const startTime = Math.max(
        scene.startTime,
        Number(action.outcomeStartTime ?? action.startTime)
      );
      const endTime = Math.min(
        scene.endTime,
        Number(action.outcomeEndTime ?? action.endTime)
      );

      if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime - startTime >= 2) {
        if (isAftermath) {
          if (!scene.aftermath || startTime < scene.aftermath.startTime) {
            scene.aftermath = {
              id: action.actionId || `${sceneId}:aftermath`,
              label: action.outcomeLabel || action.label || 'Sahne sonrası',
              startTime,
              endTime
            };
          }
        } else {
          scene.outcomes.push({
            id: action.actionId || `${sceneId}:outcome-${index}`,
            label: action.outcomeLabel || action.label || `Final ${scene.outcomes.length + 1}`,
            startTime,
            endTime,
            unlockProgress: normalizeOutcomeUnlockProgress(action.outcomeUnlockProgress)
          });
        }
      }
      return;
    }

    const hasPositionEvidence = Boolean(action.positionId || action.positionLabel);
    if (!hasPositionEvidence) {
      const actionType = String(action.actionType || '').toLowerCase();
      const labelKey = normalizeAdultLabel(action.label || action.movementType || '');
      const explicitWarmup = ['kiss', 'touch', 'clothing', 'body_transition'].includes(actionType);
      const labelWarmup = /\b(op|opus|dokun|oksa|soyun|cikar|saril|elle|elini|tenine)\b/.test(labelKey);
      const startTime = Math.max(scene.startTime, Number(action.startTime));
      const endTime = Math.min(scene.endTime, Number(action.endTime));

      if (
        (explicitWarmup || (actionType === 'other' && labelWarmup)) &&
        action.label &&
        Number.isFinite(startTime) &&
        Number.isFinite(endTime) &&
        endTime - startTime >= 2
      ) {
        scene.foreplay.push({
          id: action.actionId || `${sceneId}:warmup-${index}`,
          label: action.label,
          startTime,
          endTime,
          maleProgressRate: Number(action.maleProgressRate || 1),
          femaleProgressRate: Number(action.femaleProgressRate || 1)
        });
      }
      return;
    }

    const canonical = canonicalAdultPosition(action);
    if (!canonical.id) return;

    const category = adultCategoryFor(action, canonical.id);
    const occurrenceId = String(
      action.positionOccurrenceId ||
      `${sceneId}:${canonical.id}:legacy-${Math.round((Number(action.positionStartTime ?? action.startTime) || 0) * 1000)}`
    );
    const routeNamespace = activityOccurrenceNamespace(action);
    const positionKey = `${category.id}:${canonical.id}:${routeNamespace}:${occurrenceId}`;

    if (!scene.positions.has(positionKey)) {
      scene.positions.set(positionKey, {
        id: positionKey,
        familyId: canonical.id,
        occurrenceId,
        activityType: routeNamespace,
        activityTypeConfidence: Number(action.activityTypeConfidence || 0),
        label: activityDisplayLabel(canonical.label, action),
        categoryId: category.id,
        categoryLabel: category.label,
        startTime: Number(action.positionStartTime ?? action.startTime),
        endTime: Number(action.positionEndTime ?? action.endTime),
        unlockProgress: 0,
        movements: []
      });
    }

    const position = scene.positions.get(positionKey);
    position.startTime = Math.min(
      position.startTime,
      Number(action.positionStartTime ?? action.startTime)
    );
    position.endTime = Math.max(
      position.endTime,
      Number(action.positionEndTime ?? action.endTime)
    );

    if (action.actionType !== 'position' && action.movementType) {
      const movementStart = Math.max(
        position.startTime,
        Number(action.loopStartTime ?? action.startTime)
      );
      const movementEnd = Math.min(
        Number(action.positionEndTime ?? position.endTime),
        Number(action.loopEndTime ?? action.endTime)
      );
      if (movementBelongsToPosition(action, canonical.id)) {
        position.movements.push({
          ...action,
          id: action.actionId || `movement-${index}`,
          label: action.label,
          loopStartTime: movementStart,
          loopEndTime: movementEnd
        });
      }
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
            let movements = expandVerifiedMovementVariants(
              position.movements,
              position.startTime,
              position.endTime,
              { baseLabel: position.label }
            );
            if (!movements.length && position.endTime - position.startTime >= 10) {
              const verifiedBase = {
                id: `${position.id}:verified-base`,
                actionId: `${position.id}:verified-base`,
                label: `${position.label} sekansını oynat`,
                startTime: position.startTime,
                endTime: position.endTime,
                loopStartTime: position.startTime,
                loopEndTime: position.endTime,
                movementType: position.familyId,
                movementTempo: 'unclear',
                sourceVerified: true,
                maleProgressRate: 1,
                femaleProgressRate: 1,
                positionOnlyFallback: true
              };
              // A verified position without separately verified inner actions
              // is one honest choice, not three invented "cut" choices.
              movements = [verifiedBase];
            }
            return { ...position, movements };
          })
          .filter(position => position.endTime - position.startTime >= 10)
          .sort((a, b) => a.startTime - b.startTime);
      if (!positions.length) return { ...scene, foreplay: [], outcomes, positions: [] };
      const positionStart = Math.min(...positions.map(position => Number(position.startTime)));
      const interactionEnd = Math.max(...positions.map(position => Number(position.endTime)));
      const playableForeplay = foreplay.filter(item =>
        Number(item.endTime) > Number(scene.startTime) &&
        Number(item.startTime) < interactionEnd
      );
      const interactionStart = playableForeplay.length
        ? Math.min(positionStart, ...playableForeplay.map(item => Number(item.startTime)))
        : positionStart;
      return {
        ...scene,
        // Verified approach choices are part of the same playable occurrence;
        // their exact source times must not be clamped to the first position.
        startTime: interactionStart,
        endTime: interactionEnd,
        postSceneTime: Math.max(Number(scene.postSceneTime) || 0, interactionEnd),
        foreplay: playableForeplay,
        outcomes: outcomes.filter(item => Number(item.startTime) >= interactionStart - 0.05),
        positions
      };
    })
    .filter(scene => scene.positions.length)
    .sort((a, b) => a.startTime - b.startTime);

  state.adultScenes = mergeAdultSceneFragments(
    state.adultScenes,
    actions.filter(action => !action.adultScene)
  );

  state.adultScenes.forEach(scene => {
    scene.positions = consolidateVerifiedPositions(scene.positions).map(position => ({
      ...position,
      movementChoices: buildVerifiedMovementChoices(position.movements, position.label, 3)
    }));

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

function currentAdultFlow() {
  return averageAdultProgress(
    state.maleSceneProgress,
    state.femaleSceneProgress
  );
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
  const flow = currentAdultFlow();
  const positions = scene?.positions || [];
  const { warmupTotal, warmupUniquePlayed } = adultWarmupStats(scene);
  const corePositions = positions.filter(position => !isWarmupPosition(position) && !isBonusPosition(position));
  const coreVisitedCount = corePositions.filter(position => state.adultVisitedPositionIds.has(position.id)).length;
  const coreAllowed = canUnlockCorePositions({
    flow,
    warmupTotal,
    warmupUniquePlayed
  });
  const bonusAllowed = canUnlockBonusPositions({
    flow,
    coreVisitedCount,
    corePositionCount: corePositions.length,
    bootstrap: warmupTotal === 0 && corePositions.length === 0
  });

  return positions.filter(position => {
    if (flow + 0.001 < Number(position.unlockProgress || 0)) return false;
    if (isWarmupPosition(position)) return true;
    if (isBonusPosition(position)) return coreAllowed && bonusAllowed;
    return coreAllowed;
  });
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
  const flow = currentAdultFlow();
  const positionTarget = (scene?.positions || [])
    .filter(position =>
      !isWarmupPosition(position) &&
      Number(position.unlockProgress || 0) > flow + 0.001
    )
    .sort((a, b) => Number(a.unlockProgress) - Number(b.unlockProgress))[0];

  const outcomeTarget = (scene?.outcomes || [])
    .filter(outcome => Number(outcome.unlockProgress || 82) > state.adultClimaxProgress + 0.001)
    .sort((a, b) => Number(a.unlockProgress) - Number(b.unlockProgress))[0];

  const candidates = [];
  if (positionTarget) {
    candidates.push({
      type: 'position',
      progress: Number(positionTarget.unlockProgress || 0)
    });
  }
  if (outcomeTarget) {
    candidates.push({
      type: 'outcome',
      progress: Number(outcomeTarget.unlockProgress || 82)
    });
  }
  return candidates.sort((a, b) => a.progress - b.progress)[0] || null;
}

function renderAdultFlowStatus() {
  if (!els.adultFlowStatus) return;
  const flow = currentAdultFlow();
  els.adultFlowStatus.textContent =
    `Lust %${Math.round(flow)} · Final %${Math.round(state.adultClimaxProgress)} · combo ${state.adultComboCount}`;
}

function renderAdultProgress() {
  const male = Math.min(100, Math.max(0, state.maleSceneProgress || 0));
  const female = Math.min(100, Math.max(0, state.femaleSceneProgress || 0));
  state.maleSceneProgress = male;
  state.femaleSceneProgress = female;
  if (els.maleProgressText) els.maleProgressText.textContent = `${Math.round(male)}%`;
  if (els.femaleProgressText) els.femaleProgressText.textContent = `${Math.round(female)}%`;
  if (els.maleProgressBar) els.maleProgressBar.style.width = `${male}%`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${female}%`;
  if (els.climaxProgressText) els.climaxProgressText.textContent = `${Math.round(state.adultClimaxProgress)}%`;
  if (els.climaxProgressBar) els.climaxProgressBar.style.width = `${state.adultClimaxProgress}%`;
  renderAdultFlowStatus();
  persistRuntimeSnapshot('adult-progress');
  renderAdultProgressiveUI(false);
}

function resetAdultSceneGameplay() {
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultClimaxProgress = 0;
  state.adultCorePlaySeconds = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  state.adultRevealedPositionIds = new Set();
  state.adultUiSignature = '';
  state.adultLastUiPhase = 'foreplay';
  state.adultPhaseMachine = 'foreplay';
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
    button.dataset.discoveryId = choice.id;
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
  if (!scene || !els.adultInteractionPanel) return;

  const flow = currentAdultFlow();
  const unlockedPositions = unlockedAdultPositions(scene);
  const unlockedCore = unlockedPositions.filter(position => !isWarmupPosition(position));
  const unlockedBonus = unlockedCore.filter(isBonusPosition);
  const outcomes = unlockedAdultOutcomes(scene);
  const proposedPhase = adultDiscoveryPhase({
    flow,
    hasCoreUnlocked: unlockedCore.some(position => !isBonusPosition(position)),
    hasBonusUnlocked: unlockedBonus.length > 0,
    hasOutcomeUnlocked: outcomes.length > 0
  });
  const monotonicPhase = monotonicAdultPhase(proposedPhase, state.adultLastUiPhase);
  const phase = setAdultMachinePhase(monotonicPhase);

  const signature = [
    phase,
    Math.floor(flow),
    Math.floor(state.adultClimaxProgress),
    Math.floor(state.adultCorePlaySeconds),
    unlockedCore.map(item => item.id).join(','),
    outcomes.map(item => item.id).join(','),
    state.adultVisitedPositionIds.size,
    [...state.adultPreludePlayCounts.values()].reduce((sum, value) => sum + Number(value || 0), 0)
  ].join('|');

  const phaseCopy = {
    foreplay: {
      badge: 'YAKINLAŞMA',
      title: 'Önce yakınlaş',
      hint: 'Basit seçimlerle Lust yükselt. Sahnedeki asıl seçenekler henüz gizli.'
    },
    positions: {
      badge: 'YENİ AŞAMA',
      title: 'Pozisyonlar açılıyor',
      hint: 'Yalnızca kazandığın ve kaynak videoda gerçekten bulunan seçenekler gösteriliyor.'
    },
    reward: {
      badge: 'ÖDÜL AŞAMASI',
      title: 'Yeni bir şey keşfettin',
      hint: 'Yüksek Lust sahnedeki daha özel gerçek seçenekleri açıyor.'
    },
    final: {
      badge: 'FİNAL HAZIR',
      title: 'Sahnenin son aşaması açıldı',
      hint: 'Final seçeneği artık görünür. Önceden adı gösterilmedi.'
    }
  }[phase];

  if (els.adultPhaseBadge) els.adultPhaseBadge.textContent = phaseCopy.badge;
  if (els.adultPhaseTitle) els.adultPhaseTitle.textContent = phaseCopy.title;
  if (els.adultPhaseHint) els.adultPhaseHint.textContent = phaseCopy.hint;
  els.adultInteractionPanel.dataset.phase = phase;

  const next = nextAdultDiscovery(scene);
  const warmupStats = adultWarmupStats(scene);
  const warmupRequired = requiredWarmupDiscoveries(warmupStats.warmupTotal);
  const warmupRemaining = Math.max(0, warmupRequired - warmupStats.warmupUniquePlayed);
  if (els.discoveryGate) {
    const hideGate = phase === 'final' || (!next && warmupRemaining === 0);
    els.discoveryGate.classList.toggle('hidden', hideGate);
    if (!hideGate) {
      if (els.discoveryGateText) {
        els.discoveryGateText.textContent = warmupRemaining > 0
          ? 'Yakınlaşmayı biraz daha keşfet'
          : next?.type === 'outcome'
            ? 'Sahnenin son aşaması hâlâ gizli'
            : 'Yeni bir seçenek yaklaşıyor';
      }
      if (els.discoveryGateMeta) {
        if (warmupRemaining > 0) {
          els.discoveryGateMeta.textContent = `${warmupRemaining} yeni yakınlaşma seçimi daha keşfet`;
        } else if (next) {
          if (next.type === 'outcome') {
            const remaining = Math.max(0, Math.ceil(next.progress - state.adultClimaxProgress));
            els.discoveryGateMeta.textContent =
              `Final hazırlığı %${Math.round(state.adultClimaxProgress)} · ${remaining} puan kaldı`;
          } else {
            const remaining = Math.max(0, Math.ceil(next.progress - flow));
            els.discoveryGateMeta.textContent =
              `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;
          }
        }
      }
    }
  }

  if (!force && signature === state.adultUiSignature) return;
  state.adultUiSignature = signature;
  state.adultLastUiPhase = phase;

  const showWarmup = phase === 'foreplay';
  if (showWarmup) {
    renderAdultWarmupChoices(scene);
  } else {
    els.foreplaySection?.classList.add('hidden');
  }

  if (phase === 'final') {
    els.categorySection?.classList.add('hidden');
    els.positionSection?.classList.add('hidden');
    els.movementSection?.classList.add('hidden');
    renderAdultOutcomes(scene);
    return;
  }

  els.outcomeSection?.classList.add('hidden');
  els.outcomeChoices && (els.outcomeChoices.innerHTML = '');

  if (showWarmup || !unlockedCore.length) {
    els.categorySection?.classList.add('hidden');
    els.positionSection?.classList.add('hidden');
    els.movementSection?.classList.add('hidden');
    return;
  }

  const verifiedRoutes = new Set(
    unlockedCore
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
      button.addEventListener('click', () => selectAdultCategory(category.id, true));
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
    state.activeAdultCategory = null;
    state.activeMovementId = null;
  }
  if (restoringSameScene) {
    state.restoredAdultSceneId = null;
    logEngineEvent('ADULT_SCENE_RUNTIME_RESTORED', { sceneId: scene.id });
  }

  state.adultScene = scene;
  state.adultMode = true;
  els.adultInteractionPanel.classList.remove('hidden');
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
}

function enterAdultScene(scene, { forceStart = false, reason = 'timeline' } = {}) {
  if (!scene || state.completedAdultSceneIds?.has(scene.id) || !els.video) return false;

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
  const insideScene = mediaTime >= Number(scene.startTime) - 0.15 &&
    mediaTime < Number(scene.endTime) - 0.04;
  if (forceStart && !sameSession && (!insideScene || mediaTime > Number(scene.startTime) + 1)) {
    els.video.pause();
    els.video.currentTime = Math.max(0, Number(scene.startTime) || 0);
  }

  state.gameCursorTime = Math.max(0, Number(scene.startTime) || 0);
  renderAdultPanel(scene);
  setGameState('SEGMENT_PLAYING');
  logEngineEvent('ADULT_SCENE_ENTERED', { sceneId: scene.id, reason, sameSession });
  return true;
}

function syncAdultPanelPlacement(stage = els.video?.closest('.video-stage')) {
  if (!stage || !els.adultInteractionPanel) return;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fullscreenElement === stage) {
    if (els.adultInteractionPanel.parentElement !== stage) {
      stage.appendChild(els.adultInteractionPanel);
    }
  } else if (els.adultInteractionPanel.previousElementSibling !== stage) {
    stage.insertAdjacentElement('afterend', els.adultInteractionPanel);
  }
}

function selectAdultCategory(categoryId, shouldSeek = true) {
  const scene = state.adultScene;
  const positions = unlockedAdultPositions(scene)
    .filter(item => {
      if (isWarmupPosition(item)) return false;
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
    button.textContent = position.label;
    button.dataset.positionId = position.id;
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

  const selected =
    positions.find(item => item.id === state.activePositionId) ||
    positions[0];

  if (selected) selectAdultPosition(selected.id, shouldSeek);
}

function cancelAdultSeek() {
  state.adultSeekRequestId += 1;
  clearTimeout(state.adultSeekTimer);
  state.adultSeekTimer = null;

  if (state.adultSeekListener && els.video) {
    els.video.removeEventListener("seeked", state.adultSeekListener);
  }

  state.adultSeekListener = null;
  state.adultLoopSeeking = false;
}

function beginAdultSelection() {
  state.adultSelectionToken += 1;
  cancelAdultSeek();
  return state.adultSelectionToken;
}

function applyAdultPreludeProgress(item) {
  if (!item) return;
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
  state.maleSceneProgress = Math.min(100, state.maleSceneProgress + delta.male);
  state.femaleSceneProgress = Math.min(100, state.femaleSceneProgress + delta.female);
  renderAdultProgress();
}

function playAdultPrelude(preludeId) {
  const scene = state.adultScene;
  const item = scene?.foreplay?.find(entry => entry.id === preludeId);
  if (!item || !els.video || state.adultOutcomePhase !== 'idle') return;
  const guard = guardPlayable('foreplay', item, { scene, unlocked: true });
  if (!guard.allowed) return;
  logEngineEvent('FOREPLAY_SELECTED', { id: item.id });

  const token = beginAdultSelection();
  state.activeAdultPreludeId = item.id;
  state.activePositionId = null;
  state.activeMovementId = null;
  applyAdultPreludeProgress(item);
  renderAdultProgressiveUI(true);
  els.video.pause();
  seekAdultLoop(item.startTime, token);
  els.video.play().catch(() => {});
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
  state.maleSceneProgress = Math.min(100, state.maleSceneProgress + delta.male);
  state.femaleSceneProgress = Math.min(100, state.femaleSceneProgress + delta.female);
  if (!isWarmupPosition(position)) {
    // A selection unlocks discovery, but cannot rush the final meter.
    const climaxDelta = averageAdultProgress(delta.male, delta.female) * 0.12;
    state.adultClimaxProgress = Math.min(100, state.adultClimaxProgress + climaxDelta);
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

function updateRhythmControl(position) {
  const movement = position?.movements?.find(item => item.id === state.activeMovementId) || null;
  const activeChoice = (position?.movementChoices || []).find(choice =>
    choice.id === state.activeMovementChoiceId ||
    choice.variants?.some(item => item.id === state.activeMovementId)
  );
  const hasEnergeticVariant = Boolean(activeChoice?.variants?.some(item => isEnergeticSexMoment(item)));
  const eligible = Boolean(
    position && !isWarmupPosition(position) &&
    state.adultOutcomePhase === 'idle' &&
    (isEnergeticSexMoment(movement) || hasEnergeticVariant)
  );
  els.rhythmControl?.classList.remove('hidden');
  if (els.rhythmTapBtn) els.rhythmTapBtn.disabled = !eligible;
  if (els.rhythmTapLabel) els.rhythmTapLabel.textContent = eligible ? 'SEKS' : 'SEKS KAPALI';
  if (els.rhythmTapStatus) {
    els.rhythmTapStatus.textContent = eligible
      ? 'Yoğun doğrulanmış kesit hazır — dokununca aynı pozisyonda ileri alır'
      : 'Bu kesitte doğrulanmış yoğun hareket yok';
  }
}

function handleAdultRhythmTap(timestamp = performance.now()) {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const currentMovement = position?.movements?.find(item => item.id === state.activeMovementId) || null;
  if (!position || state.adultOutcomePhase !== 'idle') return;

  els.rhythmTapBtn?.classList.remove('tap-pulse');
  requestAnimationFrame(() => els.rhythmTapBtn?.classList.add('tap-pulse'));
  const activeChoice = (position.movementChoices || []).find(choice =>
    choice.id === state.activeMovementChoiceId ||
    choice.variants?.some(item => item.id === currentMovement.id)
  );
  const pool = (activeChoice?.variants || [])
    .filter(item => item.sourceVerified === true && item.sourcePositionId === (currentMovement?.sourcePositionId || activeChoice?.sourcePositionId))
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
  const energeticPool = pool.filter(item => isEnergeticSexMoment(item));
  if (!isEnergeticSexMoment(currentMovement) && !energeticPool.length) return;
  const next = pickNextChronologicalVariant(
    energeticPool.length ? energeticPool : pool,
    currentMovement?.id || null
  ) || (energeticPool.length ? energeticPool[0] : null);
  if (next) {
    selectAdultMovement(next.id, true, null, { awardProgress: false });
  } else if (currentMovement && els.video && Number(els.video.currentTime) < Number(currentMovement.loopEndTime) - 0.08) {
    els.video.play().catch(() => {});
  } else {
    els.video?.pause();
  }
  logEngineEvent('SEX_CONTROL_APPLIED', {
    positionId: position.id,
    occurrenceId: position.occurrenceId,
    movementId: next?.id || currentMovement.id,
    advanced: Boolean(next),
    timestamp: Number(timestamp) || performance.now()
  });
  if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([12, 18, 20]);
}

function playNextAdultVariant() {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  if (!position) return;
  const next = pickNextChronologicalVariant(position.movements, state.activeMovementId);
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
  const positionUnlocked = unlockedAdultPositions(scene).some(item => item.id === position.id);
  const positionGuard = guardPlayable(
    isWarmupPosition(position) ? 'foreplay' : 'position',
    position,
    { scene, unlocked: positionUnlocked }
  );
  if (!positionGuard.allowed) return;
  if (shouldSeek) logEngineEvent('POSITION_SELECTED', { id: position.id, family: position.familyId });

  const selectionToken = shouldSeek
    ? beginAdultSelection()
    : state.adultSelectionToken;
  if (shouldSeek) state.activeAdultPreludeId = null;
  const changedPosition = state.activePositionId !== position.id;
  state.activePositionId = position.id;
  if (changedPosition) state.activeMovementId = null;
  if (changedPosition) resetAdultTapRhythm();

  els.positionTabs?.querySelectorAll('.position-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.positionId === position.id);
  });

  const movementChoices = position.movementChoices?.length
    ? position.movementChoices
    : buildVerifiedMovementChoices(position.movements, position.label, 3);
  position.movementChoices = movementChoices;
  if (els.movementHeading) els.movementHeading.textContent = position.label;
  if (els.movementCount) els.movementCount.textContent = `${movementChoices.length} hareket seçeneği`;
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
    const tempoSummary = choice.hasTempoShift && choice.tempoVariants?.length
      ? `<small class="movement-tempo-summary">${escapeHtml(choice.tempoVariants.map(item => tempoLabel(item.movementTempo)).join(' / '))}</small>`
      : '';
    button.innerHTML = `<span>${escapeHtml(choice.label)}</span>${tempoSummary}`;
    button.addEventListener('click', () => {
      const currentId = choice.variants.some(item => item.id === state.activeMovementId)
        ? state.activeMovementId
        : null;
      const movement = pickNextVariant(choice.variants, currentId, state.adultMovementPlayCounts);
      if (!movement) return;
      state.activeMovementChoiceId = choice.id;
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

  updateVariantButton(position);
  updateRhythmControl(position);

  const movement = shouldSeek
    ? pickNextVariant(
        position.movements,
        state.activeMovementId,
        state.adultMovementPlayCounts
      )
    : position.movements.find(item => item.id === state.activeMovementId) || position.movements[0];

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
    if (els.movementCount) els.movementCount.textContent = '10 saniyelik ek varyasyon yok';
    if (shouldSeek && els.video) {
      applyAdultSelectionProgress(position, null, { positionChanged: changedPosition });
      els.video.pause();
      seekAdultLoop(position.startTime, selectionToken);
      els.video.play().catch(() => {});
    }
  }
}

function selectAdultMovement(
  movementId,
  shouldSeek = true,
  selectionToken = null,
  selectionMeta = null
) {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === movementId);
  if (!movement || state.adultOutcomePhase !== 'idle') return;
  const movementGuard = guardPlayable('movement', movement, {
    scene: state.adultScene,
    parentPosition: position,
    unlocked: true
  });
  if (!movementGuard.allowed) return;
  if (shouldSeek) logEngineEvent('MOVEMENT_SELECTED', { id: movement.id, positionId: position?.id || null });

  const effectiveToken = selectionToken ?? beginAdultSelection();
  state.activeAdultPreludeId = null;
  state.activeMovementId = movement.id;
  const matchingChoice = (position.movementChoices || []).find(
    choice => choice.variants?.some(item => item.id === movement.id)
  );
  if (matchingChoice) state.activeMovementChoiceId = matchingChoice.id;
  state.lastAdultMediaTime = null;
  els.movementChoices?.querySelectorAll('.movement-choice-card').forEach(button => {
    const variants = String(button.dataset.variantIds || '').split(',');
    button.classList.toggle('active', variants.includes(movement.id));
  });

  if (shouldSeek && selectionMeta?.awardProgress !== false) {
    applyAdultSelectionProgress(position, movement, selectionMeta || {});
  }

  updateVariantButton(position);
  updateRhythmControl(position);

  if (shouldSeek && els.video) {
    els.video.pause();
    seekAdultLoop(movement.loopStartTime, effectiveToken);
    els.video.play().catch(() => {});
  }
}

function playAdultOutcome(outcomeId) {
  const scene = state.adultScene;
  const outcome = scene?.outcomes?.find(item => item.id === outcomeId);
  if (!outcome || !els.video) return;
  const outcomeReady = unlockedAdultOutcomes(scene).some(item => item.id === outcome.id);
  const outcomeGuard = guardPlayable('outcome', outcome, { scene, unlocked: outcomeReady, outcomeReady });
  if (!outcomeGuard.allowed) return;

  const selectionToken = beginAdultSelection();
  setAdultMachinePhase('outcome');
  logEngineEvent('OUTCOME_SELECTED', { id: outcome.id });
  state.adultOutcomePhase = 'outcome';
  state.activeAdultOutcomeId = outcome.id;
  state.activeAdultPreludeId = null;
  els.video.playbackRate = 1;
  state.activeMovementId = null;
  updateVariantButton(null);
  renderAdultFlowStatus();
  els.video.pause();
  seekAdultLoop(outcome.startTime, selectionToken);
  els.video.play().catch(() => {});
}

function finishAdultScene() {
  const scene = state.adultScene;
  if (!scene) return;

  // "Skip scene" doubles as a safe next-step control. Never terminate the
  // encounter while another verified, currently unlocked position has not
  // been played yet.
  const remainingPosition = unlockedAdultPositions(scene)
    .filter(position =>
      !isWarmupPosition(position) &&
      !state.adultVisitedPositionIds.has(position.id)
    )
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))[0];
  if (remainingPosition) {
    selectAdultPosition(remainingPosition.id, true);
    return;
  }
  if (!state.completedAdultSceneIds) state.completedAdultSceneIds = new Set();
  state.completedAdultSceneIds.add(scene.id);
  const sceneSourceIds = new Set([scene.id, ...(scene.sourceSceneIds || [])].map(String));
  const sceneActions = (state.analysis?.actions || []).filter(action => {
    const start = Number(action.startTime);
    const actionSceneId = String(action.adultSceneId || '').trim();
    const sameScene = actionSceneId
      ? sceneSourceIds.has(actionSceneId)
      : start >= Number(scene.startTime) - 0.15 && start < Number(scene.endTime) + 0.15;
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
  cancelAdultSeek();
  state.adultMode = false;
  state.adultScene = null;
  state.activePositionId = null;
  state.activeAdultCategory = null;
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
  const nextScene = state.adultScenes
    .filter(item => item.id !== scene.id && !state.completedAdultSceneIds.has(item.id))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))
    .find(item => Number(item.startTime) > Number(scene.startTime) + 0.05);
  const requestedExit = Math.max(
    Number(scene.postSceneTime) || 0,
    Number(scene.endTime) + 0.05
  );
  const nextSceneStart = nextScene ? Number(nextScene.startTime) : Number.POSITIVE_INFINITY;
  state.gameCursorTime = Math.max(
    Number(scene.endTime) + 0.05,
    Math.min(requestedExit, nextSceneStart - 0.05)
  );
  persistRuntimeSnapshot('adult-scene-complete', true);

  if (!els.video) {
    renderChoices();
    return;
  }

  const target = Math.min(state.gameCursorTime, els.video.duration || state.gameCursorTime);
  state.navigationSeeking = true;
  els.video.pause();
  els.video.currentTime = target;
  let exitSettled = false;
  const finishExit = () => {
    if (exitSettled) return;
    exitSettled = true;
    state.navigationSeeking = false;
    els.video.removeEventListener('seeked', finishExit);
    setGameState('DECISION_PENDING');
    const nextAdultScene = findAdultSceneAt(state.gameCursorTime);
    if (nextAdultScene) {
      enterAdultScene(nextAdultScene, {
        forceStart: true,
        reason: 'adult-scene-complete-next-occurrence'
      });
    } else {
      renderChoices();
    }
  };
  els.video.addEventListener('seeked', finishExit);
  setTimeout(finishExit, 1200);
}

function seekAdultLoop(targetTime, selectionToken = state.adultSelectionToken) {
  if (!els.video) return false;

  cancelAdultSeek();
  const requestId = state.adultSeekRequestId;
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

  const finishSeek = (force = false) => {
    if (
      requestId !== state.adultSeekRequestId ||
      selectionToken !== state.adultSelectionToken
    ) {
      return;
    }

    if (
      !force &&
      (els.video.seeking || Math.abs((Number(els.video.currentTime) || 0) - target) > 0.25)
    ) {
      return;
    }

    if (state.adultSeekListener === onSeeked) {
      els.video.removeEventListener("seeked", onSeeked);
      state.adultSeekListener = null;
    }

    clearTimeout(state.adultSeekTimer);
    state.adultSeekTimer = null;
    state.adultLoopSeeking = false;
    state.lastAdultFrameNow = performance.now();
  };

  const onSeeked = () => finishSeek(false);
  state.adultSeekListener = onSeeked;
  els.video.addEventListener("seeked", onSeeked);
  els.video.currentTime = target;
  state.adultSeekTimer = setTimeout(() => finishSeek(true), 1500);
  return true;
}

function updateAdultPlayback(now, mediaTime) {
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

  if (!els.video || els.video.paused) {
    state.lastAdultFrameNow = now;
    return;
  }

  if (state.adultLoopSeeking) {
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
      const aftermath = state.adultScene?.aftermath;
      if (aftermath) {
        const token = beginAdultSelection();
        state.adultOutcomePhase = 'aftermath';
        setAdultMachinePhase('aftermath');
        logEngineEvent('AFTERMATH_STARTED', { sceneId: state.adultScene?.id || null });
        els.video.pause();
        seekAdultLoop(aftermath.startTime, token);
        els.video.play().catch(() => {});
      } else {
        finishAdultScene();
      }
    }
    state.lastAdultFrameNow = now;
    return;
  }

  if (state.adultOutcomePhase === 'aftermath') {
    const aftermath = state.adultScene?.aftermath;
    if (!aftermath || mediaTime >= aftermath.endTime - 0.04) {
      finishAdultScene();
    }
    state.lastAdultFrameNow = now;
    return;
  }

  const elapsed = Math.min(0.25, Math.max(0, (now - (state.lastAdultFrameNow || now)) / 1000));
  state.lastAdultFrameNow = now;

  if (state.activeAdultPreludeId) {
    const item = state.adultScene?.foreplay?.find(
      entry => entry.id === state.activeAdultPreludeId
    );
    if (!item) {
      state.activeAdultPreludeId = null;
      return;
    }
    if (mediaTime >= item.endTime - 0.04 || mediaTime < item.startTime - 0.15) {
      seekAdultLoop(item.startTime, state.adultSelectionToken);
      return;
    }
    state.maleSceneProgress = Math.min(
      100,
      state.maleSceneProgress + elapsed * 0.35 * Number(item.maleProgressRate || 1)
    );
    state.femaleSceneProgress = Math.min(
      100,
      state.femaleSceneProgress + elapsed * 0.35 * Number(item.femaleProgressRate || 1)
    );
    renderAdultProgress();
    return;
  }

  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === state.activeMovementId);
  if (!movement) {
    return;
  }

  if (mediaTime >= movement.loopEndTime - 0.04 || mediaTime < movement.loopStartTime - 0.15) {
    seekAdultLoop(movement.loopStartTime, state.adultSelectionToken);
    return;
  }

  state.maleSceneProgress = Math.min(
    100,
    state.maleSceneProgress + elapsed * Number(movement.maleProgressRate || 1)
  );
  state.femaleSceneProgress = Math.min(
    100,
    state.femaleSceneProgress + elapsed * Number(movement.femaleProgressRate || 1)
  );
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
  }
  renderAdultProgress();

  // Never auto-complete a scene merely because a meter reached 100. The
  // verified outcome/aftermath or the explicit scene-finish control owns exit.
}

function adultFrameLoop(now, metadata) {
  updateAdultPlayback(now, Number(metadata?.mediaTime ?? els.video?.currentTime ?? 0));
  if (els.video?.requestVideoFrameCallback) {
    state.adultFrameRequest = els.video.requestVideoFrameCallback(adultFrameLoop);
  }
}

if (els.finishAdultSceneBtn) {
  els.finishAdultSceneBtn.addEventListener('click', finishAdultScene);
}

if (els.nextVariantBtn) {
  els.nextVariantBtn.addEventListener('click', playNextAdultVariant);
}

els.rhythmTapBtn?.addEventListener('pointerdown', event => {
  event.preventDefault();
  handleAdultRhythmTap(event.timeStamp);
});

els.rhythmTapBtn?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  handleAdultRhythmTap(performance.now());
});

els.adultPanelToggleBtn?.addEventListener('click', () => {
  const collapsed = els.adultInteractionPanel?.classList.toggle('fullscreen-collapsed');
  els.adultPanelToggleBtn.textContent = collapsed ? 'SEÇİMLERİ AÇ' : 'SEÇİMLERİ GİZLE';
});

if (els.video?.requestVideoFrameCallback) {
  state.adultFrameRequest = els.video.requestVideoFrameCallback(adultFrameLoop);
} else if (els.video) {
  els.video.addEventListener("timeupdate", () => {
    updateAdultPlayback(performance.now(), els.video.currentTime);
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
    !state.consumedActionIds.has(a.actionId)
  );

  const seenChoices = new Set();

  return pool.filter((action) => {
    const key = action.choiceKey ||
      action.label.trim().toLocaleLowerCase('tr-TR');

    if (seenChoices.has(key)) {
      return false;
    }

    seenChoices.add(key);
    return true;
  });
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

  const cursorScene = findAdultSceneAt(state.gameCursorTime);
  if (cursorScene && enterAdultScene(cursorScene, { forceStart: true, reason: 'cursor-inside-scene' })) {
    return;
  }

  els.choices.classList.remove('hidden');
  els.choices.innerHTML = '';
  els.cursorText.textContent = `cursor: ${state.gameCursorTime.toFixed(3)}`;
  let candidates = futureActions().slice(0, 4);

  if (!candidates.length && state.analysis?.actions?.length) {
    candidates = state.analysis.actions
      .filter((action, index) =>
        index > state.currentActionIndex &&
        Number(action.startTime) >= state.gameCursorTime - 0.001 &&
        !state.consumedActionIds.has(action.actionId)
      )
      .slice(0, 4);
  }

  const firstCandidate = candidates[0];
  const candidateScene = findAdultSceneForTimeline(state.adultScenes, {
    action: firstCandidate,
    completedSceneIds: state.completedAdultSceneIds
  });
  if (candidateScene && enterAdultScene(candidateScene, { forceStart: true, reason: 'next-timeline-action' })) {
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
    candidates = state.analysis.actions
      .filter((action, index) =>
        index > state.currentActionIndex &&
        Number(action.startTime) >= state.gameCursorTime - 0.001 &&
        !state.consumedActionIds.has(action.actionId) &&
        !findAdultSceneForTimeline(state.adultScenes, {
          action,
          completedSceneIds: state.completedAdultSceneIds
        })
      )
      .slice(0, 4);
  }

  if (!candidates.length) {
    setGameState('ENDED');
    els.choices.innerHTML = '<div class="meta">İleri yönde kullanılabilir doğrulanmış action kalmadı.</div>';
    return;
  }

  candidates.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'choice';
    const storyLabel = storyChoiceLabelForAction(action);
    const storyMeta = storyActionMeta(action);
    const sensory = sensoryActionMeta(action);
    const scenePrefix = storyMeta.sceneTitle ? `${escapeHtml(storyMeta.sceneTitle)} · ` : '';
    button.innerHTML = `
      <div class="choice-title">${escapeHtml(storyLabel)}</div>
      <div class="choice-meta">${scenePrefix}${action.startTime.toFixed(2)} → ${action.endTime.toFixed(2)} sn • ${(action.confidence * 100).toFixed(0)}%</div>
      ${sensory.cues.length ? `<div class="choice-sensory">◌ ${escapeHtml(sensory.cues.join(' · '))}</div>` : ''}
    `;
    button.addEventListener('click', () => playAction(action));
    els.choices.appendChild(button);
  });
  renderDebug({ nextCandidateActions: candidates.map(a => a.actionId) });
}

async function playAction(action) {
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
  els.video.currentTime = seekTarget;
  const mobilePlayPromise = els.video.play().catch(() => {
    els.video.controls = true;
  });

  await waitForEvent(els.video, 'seeked', 5000).catch(() => {});
  setGameState('SEGMENT_PLAYING');

  const decisionEndTime = decisionBoundaryAfterDialogue(
    state.dialogue?.segments || [],
    action.endTime,
    state.analysis?.videoDuration || els.video.duration
  );

  state.stopListener = () => {
    if (els.video.currentTime >= decisionEndTime - 0.03) {
      finishAction(action, decisionEndTime);
    }
  };
  els.video.addEventListener('timeupdate', state.stopListener);
  await els.video.play().catch(() => {});
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
  const actions = state.analysis?.actions || [];
  if (!actions.length) return;

  const safeIndex = Math.max(0, Math.min(index, actions.length - 1));
  const target = actions[safeIndex];

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

  els.video.pause();
  state.navigationSeeking = true;
  els.video.currentTime = state.gameCursorTime;

  const finishNavigation = () => {
    state.navigationSeeking = false;
    setGameState('DECISION_PENDING');
    renderChoices();
  };

  els.video.addEventListener('seeked', finishNavigation, { once: true });
  setTimeout(() => {
    if (state.navigationSeeking) finishNavigation();
  }, 1200);
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
  if (
    state.adultMode ||
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

checkHealth();
checkAiUsageStatus();
setInterval(checkAiUsageStatus, 60 * 1000);
renderDebug();

function clearPreviousGameResidue() {
  localStorage.removeItem('videoquest:last-analysis');
  localStorage.removeItem('videoquest:last-dialogue');
  localStorage.removeItem(RUNTIME_SAVE_KEY);
  sessionStorage.removeItem('videoquest:last-analysis');
  sessionStorage.removeItem('videoquest:last-dialogue');
  sessionStorage.removeItem(RUNTIME_SAVE_KEY);
  state.analysis = null;
  state.dialogue = null;
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
  if (els.video) {
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  resetDubState();
  setGameState('IDLE');
}

clearPreviousGameResidue();


// FULLSCREEN GAME MODE
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenStage = document.querySelector('.video-stage');

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

document.addEventListener('fullscreenchange', () => {
  syncAdultPanelPlacement(fullscreenStage);
  if (fullscreenBtn) {
    fullscreenBtn.textContent = document.fullscreenElement
      ? '✕ TAM EKRANDAN ÇIK'
      : '⛶ OYUN MODU';
  }
});

document.addEventListener('webkitfullscreenchange', () => {
  syncAdultPanelPlacement(fullscreenStage);
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

async function downloadUrlVideo(proxyUrl, sourceUrl) {
  const response = await fetch(proxyUrl);
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message || `Video indirilemedi (${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const reader = response.body?.getReader();

  if (!reader) return response.blob();

  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    const receivedMB = (received / 1024 / 1024).toFixed(1);
    const totalText = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : '';
    setUrlStatus(`Video hazırlanıyor: ${receivedMB} MB${totalText}`);
  }

  return new Blob(chunks, { type: contentType });
}

async function probeSeekableVideo(proxyUrl) {
  try {
    const response = await fetch(proxyUrl, {
      headers: { Range: 'bytes=0-1' }
    });
    const contentRange = String(response.headers.get('content-range') || '');
    const size = Number(contentRange.match(/\/(\d+)$/)?.[1]) || 0;
    const contentType = response.headers.get('content-type') || 'video/mp4';
    try { await response.body?.cancel(); } catch {}
    return {
      seekable: response.status === 206 && /^bytes\s/i.test(contentRange),
      size,
      contentType
    };
  } catch {
    return { seekable: false, size: 0, contentType: '' };
  }
}

function remoteVideoFileName(sourceUrl, contentType = '') {
  const sourcePath = new URL(sourceUrl).pathname;
  const sourceName = decodeURIComponent(sourcePath.split('/').pop() || '');
  const extension = sourceName.match(/\.(mp4|webm|m4v|mov)$/i)?.[0] ||
    (contentType.includes('webm') ? '.webm' : '.mp4');
  return sourceName || `url-video${extension}`;
}

async function ensureSelectedRemoteFile() {
  if (state.selectedFile) return state.selectedFile;
  const remote = state.selectedRemoteVideo;
  if (!remote?.proxyUrl) throw new Error('İndirilecek uzak video kaynağı bulunamadı.');
  setUrlStatus('Bu analiz modu için video cihaza geçici olarak indiriliyor...');
  const blob = await downloadUrlVideo(remote.proxyUrl, remote.sourceUrl);
  if (!blob.size) throw new Error('Video boş geldi.');
  const file = new File([blob], remote.fileName, { type: blob.type || remote.contentType || 'video/mp4' });
  state.selectedFile = file;
  state.selectedRemoteVideo = { ...remote, size: blob.size, contentType: file.type };
  els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • URL kaynağı`;
  return file;
}

async function resolveVideoUrl() {
  const pageUrl = videoUrlInput?.value.trim();
  if (!pageUrl) {
    setUrlStatus('Lütfen video sayfasının bağlantısını gir.', 'error');
    return;
  }

  resolveUrlBtn.disabled = true;
  setUrlStatus('Sayfa inceleniyor, video kaynağı aranıyor...');
  const resolveStartedAt = performance.now();

  try {
    const resolveResponse = await fetch('/api/resolve-video-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const resolveSeconds = Math.max(0.1, (performance.now() - resolveStartedAt) / 1000).toFixed(1);
    const fileName = remoteVideoFileName(result.sourceUrl);
    if (result.type === 'video') {
      setUrlStatus(`Video ${resolveSeconds} sn içinde bulundu. Akış desteği kontrol ediliyor...`);
      const probe = await probeSeekableVideo(result.proxyUrl);
      if (probe.seekable) {
        state.selectedFile = null;
        state.selectedRemoteVideo = {
          proxyUrl: result.proxyUrl,
          sourceUrl: result.sourceUrl,
          fileName,
          size: probe.size,
          contentType: probe.contentType
        };
        resetDubState();
        els.video.src = result.proxyUrl;
        const sizeText = probe.size ? ` • ${(probe.size / 1024 / 1024).toFixed(1)} MB` : '';
        els.fileMeta.textContent = `${fileName}${sizeText} • URL akışı`;
        updateAnalyzeAvailability();
        renderDebug();
        setUrlStatus('Video akıştan hazır. Tam indirme yapmadan analiz edebilirsin.', 'success');
        return;
      }
    }

    setUrlStatus(result.type === 'hls'
      ? `HLS akışı ${resolveSeconds} sn içinde bulundu. MP4 hazırlanıyor...`
      : `Kaynak ileri sarmayı desteklemiyor. Video cihaza hazırlanıyor...`);
    const blob = await downloadUrlVideo(result.proxyUrl, result.sourceUrl);

    if (!blob.size) throw new Error('Video boş geldi.');

    const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });

    state.selectedFile = file;
    state.selectedRemoteVideo = null;
    resetDubState();
    els.video.src = URL.createObjectURL(file);
    els.fileMeta.textContent =
      `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • URL kaynağı`;
    updateAnalyzeAvailability();
    renderDebug();

    setUrlStatus('Video hazır. Şimdi “Videoyu analiz et” düğmesine bas.', 'success');
  } catch (error) {
    state.selectedFile = null;
    state.selectedRemoteVideo = null;
    updateAnalyzeAvailability();
    setUrlStatus(error?.message || 'Video bağlantısı işlenemedi.', 'error');
  } finally {
    resolveUrlBtn.disabled = false;
  }
}

resolveUrlBtn?.addEventListener('click', resolveVideoUrl);
videoUrlInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') resolveVideoUrl();
});
