import {
  adultDiscoveryPhase,
  averageAdultProgress,
  canUnlockBonusPositions,
  canUnlockCorePositions,
  canUnlockOutcome,
  computeAdultSelectionDelta,
  computeWarmupSelectionDelta,
  isOutcomeUnlocked,
  monotonicAdultPhase,
  normalizeOutcomeUnlockProgress,
  pickNextVariant,
  positionUnlockProgress,
  requiredWarmupDiscoveries
} from './adult-gameplay.js';
import {
  dialogueSegmentAt,
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
  advanceAdultPhase,
  analysisFingerprint,
  appendEngineEvent,
  applyRuntimeSnapshot,
  canPlayAction,
  createRuntimeSnapshot,
  isCompatibleRuntimeSnapshot,
  mergeSecondPassReview,
  reviewAndHardenAnalysis,
  secondPassReviewCandidates
} from './engine-hardening.js';

const $ = (id) => document.getElementById(id);

const state = {
  serviceConnected: false,
  serviceCapabilities: null,
  selectedFile: null,
  analysis: null,
  dialogue: null,
  subtitlesEnabled: true,
  dubbingEnabled: false,
  keepOriginalAudioEnabled: true,
  activeDubSegmentId: null,
  dubCache: new Map(),
  dubRequests: new Map(),
  dubSyncGeneration: 0,
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
  adultFlowStatus: $('adultFlowStatus'),
  nextVariantBtn: $('nextVariantBtn'),
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
    localStorage.setItem(RUNTIME_SAVE_KEY, JSON.stringify(snapshot));
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
  els.analyzeBtn.disabled = !state.selectedFile || !hasMode;
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

  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = Math.min(
      Math.floor(index * ratio),
      audioBuffer.length - 1
    );

    let sample = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sample += channelData[channel][sourceIndex] || 0;
    }

    sample = Math.max(-1, Math.min(1, sample / channels));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 32768 : sample * 32767,
      true
    );
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
    xhr.timeout = 60000;
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
  const chunkSize = 1024 * 1024;
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

        if (retryCount >= 8) throw error;

        els.analysisTitle.textContent =
          `Bağlantı bekleniyor · parça ${chunkIndex + 1}/${chunkCount}`;
        els.analysisOutput.textContent =
          'Yükleme kesildi veya uygulama arka plana alındı.\n' +
          'Sayfaya dönüldüğünde kaldığı parçadan devam edilecek.';

        await new Promise(resolve => setTimeout(resolve, 1500));
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
    `Video ve ses Gemini'ye gönderiliyor...\n` +
    `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  const form = new FormData();
  let dialogueFile = file;

  try {
    dialogueFile = await extractDialogueAudio(file);
  } catch (error) {
    console.warn('Ses ayrılamadı; özgün video kullanılacak:', error);
    els.analysisOutput.textContent =
      'Ses telefonda ayrılamadı. Özgün video gönderiliyor...';
  }

  form.append(
    'video',
    dialogueFile,
    dialogueFile.name || 'dialogue.wav'
  );
  form.append('duration', String(Number(els.video.duration) || 0));

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
    localStorage.setItem(
      'videoquest:last-dialogue',
      JSON.stringify(state.dialogue)
    );
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

  const segment = segments.find(item =>
    now >= Number(item.startTime) &&
    now <= Number(item.endTime)
  );

  if (!segment) {
    els.subtitleOverlay?.classList.add('hidden');
    return;
  }

  const speaker =
    segment.gender === 'female'
      ? 'KADIN'
      : segment.gender === 'male'
        ? 'ERKEK'
        : 'KONUŞMACI';

  els.subtitleSpeaker.textContent =
    `${speaker} · ${String(segment.emotion || 'neutral').toUpperCase()}`;
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
}

function prefetchDubSegmentsAround(videoTime) {
  if (!state.dubbingEnabled) return;
  nextDialogueSegments(state.dialogue?.segments || [], videoTime, 3)
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
  if (!state.selectedFile) return;
  els.analyzeBtn.disabled = true;
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Video harici analiz servisine gönderiliyor…\nSahte fallback kullanılmayacak.';
  setGameState('ANALYZING');

  const file = state.selectedFile;
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
  if (modes.subtitles || modes.dubbing) {
    try {
      const dialogue = await analyzeSelectedDialogue(file);

      state.subtitlesEnabled = Boolean(modes.subtitles && dialogue.segments.length);
      els.subtitleToggleBtn.classList.toggle('hidden', !state.subtitlesEnabled);
      if (!state.subtitlesEnabled) {
        els.subtitleOverlay.textContent = '';
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
  const storyboard = await extractStoryboard(file, (progress) => {
    els.analysisTitle.textContent = `Video telefonda hazırlanıyor: %${progress}`;
  });

  const originalMB = (file.size / 1024 / 1024).toFixed(1);
  const storyboardMB = (storyboard.totalBytes / 1024 / 1024).toFixed(1);
  els.analysisTitle.textContent =
    `${storyboard.timestamps.length} kare hazır • ${originalMB} MB yerine ${storyboardMB} MB gönderiliyor`;
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
      form.append('chunkStart', String(chunkStart));
      form.append('chunkEnd', String(chunkEnd));
      form.append('chunkIndex', String(chunkIndex));
      form.append('chunkCount', String(chunkCount));

    const chunkDialogue = (state.dialogue?.segments || []).filter(segment =>
      Number(segment.endTime) >= chunkStart &&
      Number(segment.startTime) <= chunkEnd
    );

    form.append('dialogueContext', JSON.stringify(chunkDialogue));
    form.append('qualityMode', modes.quality);
    form.append('protagonistProfile', protagonistProfile);

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
            body: form,
            signal: AbortSignal.timeout(240000)
          });

          body = await response.json();

          if (!response.ok || !body?.available) {
            failureBody = body || {
              available: false,
              reason: 'CHUNK_ANALYSIS_FAILED',
              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
            };
          } else {
            const criticalReviewCandidates = secondPassReviewCandidates(body);
            if (criticalReviewCandidates.length) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(criticalReviewCandidates));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye · ${criticalReviewCandidates.length} kritik aday ikinci kez doğrulanıyor...`;
              const reviewResponse = await fetch('/api/gemini-storyboard-analyze', {
                method: 'POST',
                body: form,
                signal: AbortSignal.timeout(240000)
              });
              const reviewBody = await reviewResponse.json();
              if (!reviewResponse.ok || !reviewBody?.available) {
                failureBody = reviewBody || {
                  available: false,
                  reason: 'SECOND_PASS_REVIEW_FAILED',
                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`
                };
                continue;
              }
              body = mergeSecondPassReview(body, reviewBody, criticalReviewCandidates);
            }
            chunkResults.push(body);
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
        videoPrompt: prompts.join('\n\n'),
        actions: mergedActions,
        warnings: chunkResults.flatMap(result =>
          Array.isArray(result.warnings) ? result.warnings : []
        ),
        analysisMode: 'MULTI_PASS_DEEP_HARDENED',
        chunkCount: chunkResults.length,
        expectedChunkCount: chunkCount,
        analysisCoverage: chunkCount ? chunkResults.length / chunkCount : 0,
        secondPassChunkCount: chunkResults.filter(result => result.secondPassReviewed).length,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION
      };
    }

  if (
    body?.available &&
    (!Array.isArray(body.actions) || !body.actions.length) &&
    state.selectedFile
  ) {
    els.analysisState.textContent = 'EXTERNAL_FALLBACK';
    els.analysisTitle.textContent = 'Hareket motoru devreye giriyor';
    const fallbackForm = new FormData();
    fallbackForm.append('video', state.selectedFile, state.selectedFile.name);

    try {
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
    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';
    els.analysisTitle.textContent = 'Video analizi eksik kaldı';
    els.analysisOutput.textContent = body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.';
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
    localStorage.setItem("videoquest:last-analysis", JSON.stringify(normalized));
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
    const key = `${sceneId}::${familyId}`;

    if (!groups.has(key)) {
      groups.set(key, { sceneId, familyId, entries: [] });
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
        occurrence = {
          id: `${sceneSlug}:${familySlug}:occ-${String(generatedCount).padStart(2, '0')}-${Math.round(entry.startTime * 1000)}`,
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
  const text = normalizeAdultLabel(value);
  if (/\b(oral|sakso|blowjob|yala|agiz)\b/.test(text)) return 'oral';
  if (/\b(manuel|manual|elle|handjob|masturb)\b/.test(text)) return 'manual';
  if (/\b(misyoner|missionary)\b/.test(text)) return 'missionary';
  if (/\b(kovboy|cowgirl|rider|kadin ustte)\b/.test(text)) return 'cowgirl';
  if (/\b(kasik|spoon|yan yatarak)\b/.test(text)) return 'spoon';
  if (/\b(arka|arkadan|doggy|dort ayak)\b/.test(text) && /\b(ayakta|standing)\b/.test(text)) {
    return 'standing-rear';
  }
  if (/\b(arka|arkadan|doggy|dort ayak)\b/.test(text)) return 'rear';
  if (/\b(ayakta|standing)\b/.test(text)) return 'standing';
  return '';
}

function canonicalAdultPosition(action) {
  // Prefer human-readable visual evidence over a conflicting machine id.
  // This prevents a stale/wrong positionId from turning a visibly labelled
  // cowgirl segment into a missionary button (or the reverse).
  const family =
    adultSemanticFamily(action.positionLabel) ||
    adultSemanticFamily(action.label) ||
    adultSemanticFamily(action.positionId);

  const labels = {
    oral: 'Oral Seks',
    manual: 'Manuel Uyarım',
    missionary: 'Misyoner Pozisyonu',
    cowgirl: 'Kovboy Pozisyonu',
    spoon: 'Kaşık Pozisyonu',
    'standing-rear': 'Ayakta Arkadan Pozisyon',
    rear: 'Arkadan Pozisyon',
    standing: 'Ayakta Pozisyon'
  };

  if (family) return { id: family, label: labels[family] };

  const fallback = normalizeAdultLabel(
    action.positionLabel || action.positionId || action.label || 'pozisyon'
  ).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    id: fallback || `position-${Math.round(Number(action.startTime) || 0)}`,
    label: action.positionLabel || action.label || 'Pozisyon'
  };
}

function adultCategoryFor(action, positionId) {
  const explicit = normalizeAdultLabel(action.activityType);

  if (explicit === 'oral') return { id: 'oral', label: 'Oral' };
  if (explicit === 'manual') return { id: 'manual', label: 'Manuel' };
  if (explicit === 'vaginal') return { id: 'vaginal', label: 'Vajinal' };
  if (explicit === 'anal') return { id: 'anal', label: 'Anal' };

  if (positionId === 'oral') return { id: 'oral', label: 'Oral' };
  if (positionId === 'manual') return { id: 'manual', label: 'Manuel' };

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


const ADULT_FRAGMENT_MERGE_GAP_SECONDS = 8;

function mergeAdultSceneFragments(scenes) {
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
    if (gap > ADULT_FRAGMENT_MERGE_GAP_SECONDS) {
      merged.push({ ...scene });
      continue;
    }

    previous.startTime = Math.min(Number(previous.startTime), Number(scene.startTime));
    previous.endTime = Math.max(Number(previous.endTime), Number(scene.endTime));
    previous.postSceneTime = Math.max(Number(previous.postSceneTime), Number(scene.postSceneTime));
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

  actions.filter(action => action.adultScene).forEach((action, index) => {
    const sceneId = action.adultSceneId ||
      `adult-${Math.round(action.adultSceneStartTime || action.startTime)}`;

    if (!sceneMap.has(sceneId)) {
      sceneMap.set(sceneId, {
        id: sceneId,
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
    const positionKey = `${category.id}:${canonical.id}:${occurrenceId}`;

    if (!scene.positions.has(positionKey)) {
      scene.positions.set(positionKey, {
        id: positionKey,
        familyId: canonical.id,
        occurrenceId,
        label: canonical.label,
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
      const movementFamily = adultSemanticFamily(
        `${action.movementType || ''} ${action.label || ''}`
      );

      if (!movementFamily || movementFamily === canonical.id) {
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

      return {
        ...scene,
        foreplay,
        outcomes,
        positions: [...scene.positions.values()]
          .map(position => ({
            ...position,
            movements: position.movements
              .filter(item => item.loopEndTime - item.loopStartTime >= 10)
              .sort((a, b) => a.loopStartTime - b.loopStartTime)
          }))
          .filter(position => position.endTime - position.startTime >= 10)
          .sort((a, b) => a.startTime - b.startTime)
      };
    })
    .filter(scene => scene.positions.length || scene.foreplay.length)
    .sort((a, b) => a.startTime - b.startTime);

  state.adultScenes = mergeAdultSceneFragments(state.adultScenes);

  state.adultScenes.forEach(scene => {
    const totals = new Map();
    const indexes = new Map();

    scene.positions.forEach(position => {
      const key = `${position.categoryId}:${position.familyId}`;
      totals.set(key, (totals.get(key) || 0) + 1);
    });

    scene.positions.forEach(position => {
      const key = `${position.categoryId}:${position.familyId}`;
      if ((totals.get(key) || 0) > 1) {
        const occurrenceNumber = (indexes.get(key) || 0) + 1;
        indexes.set(key, occurrenceNumber);
        const baseLabel = String(position.label || 'Pozisyon')
          .replace(/\s+·\s+\d+$/u, '')
          .replace(/\s+Pozisyon(?:u)?$/iu, '');
        position.label = `${baseLabel} · ${occurrenceNumber}`;
      }
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
}

function findAdultSceneAt(time) {
  return (state.adultScenes || []).find(scene =>
    !state.completedAdultSceneIds?.has(scene.id) &&
    time >= scene.startTime - 0.15 &&
    time < scene.endTime
  ) || null;
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
      corePlaySeconds: state.adultCorePlaySeconds
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

  const categories = [...new Map(unlockedCore.map(position => [
    position.categoryId,
    { id: position.categoryId, label: position.categoryLabel }
  ])).values()];

  if (els.categoryTabs) els.categoryTabs.innerHTML = '';
  categories.forEach(category => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-tab';
    button.textContent = category.label;
    button.dataset.categoryId = category.id;
    button.addEventListener('click', () => selectAdultCategory(category.id, true));
    els.categoryTabs?.appendChild(button);
  });

  if (els.categoryCount) els.categoryCount.textContent = `${categories.length} açık`;
  els.categorySection?.classList.toggle('hidden', categories.length <= 1);
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
  if (videoStage && els.adultInteractionPanel.parentElement === videoStage) {
    videoStage.insertAdjacentElement('afterend', els.adultInteractionPanel);
  }

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  }

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

function selectAdultCategory(categoryId, shouldSeek = true) {
  const scene = state.adultScene;
  const positions = unlockedAdultPositions(scene)
    .filter(item => !isWarmupPosition(item) && item.categoryId === categoryId);

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
    const climaxDelta = averageAdultProgress(delta.male, delta.female) * 0.8;
    state.adultClimaxProgress = Math.min(100, state.adultClimaxProgress + climaxDelta);
  }
  renderAdultProgress();
}

function updateVariantButton(position) {
  if (!els.nextVariantBtn) return;
  const count = position?.movements?.length || 0;
  els.nextVariantBtn.classList.toggle('hidden', count < 2);
  els.nextVariantBtn.disabled = count < 2 || state.adultOutcomePhase !== 'idle';
  els.nextVariantBtn.textContent = count >= 2
    ? `↻ Sonraki gerçek varyasyon (${count})`
    : 'Tek gerçek varyasyon';
}

function playNextAdultVariant() {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  if (!position) return;
  const next = pickNextVariant(
    position.movements,
    state.activeMovementId,
    state.adultMovementPlayCounts
  );
  if (next) selectAdultMovement(next.id, true);
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

  els.positionTabs?.querySelectorAll('.position-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.positionId === position.id);
  });

  if (els.movementHeading) els.movementHeading.textContent = position.label;
  if (els.movementCount) els.movementCount.textContent = `${position.movements.length} gerçek varyasyon`;
  if (els.movementChoices) els.movementChoices.innerHTML = '';

  position.movements.forEach(movement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'movement-choice-card';
    button.dataset.movementId = movement.id;
    button.innerHTML = `<span>${escapeHtml(movement.label)}</span><small>${adultTimeLabel(movement.loopStartTime)} – ${adultTimeLabel(movement.loopEndTime)}</small>`;
    button.addEventListener('click', () => selectAdultMovement(movement.id, true));
    els.movementChoices?.appendChild(button);
  });

  updateVariantButton(position);

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
  state.lastAdultMediaTime = null;
  els.movementChoices?.querySelectorAll('.movement-choice-card').forEach(button => {
    button.classList.toggle('active', button.dataset.movementId === movement.id);
  });

  if (shouldSeek) {
    applyAdultSelectionProgress(position, movement, selectionMeta || {});
  }

  updateVariantButton(position);

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
  if (!state.completedAdultSceneIds) state.completedAdultSceneIds = new Set();
  state.completedAdultSceneIds.add(scene.id);
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
  els.adultInteractionPanel?.classList.add('hidden');
  els.outcomeSection?.classList.add('hidden');
  document.querySelector('.choice-navigation')?.classList.remove('hidden');
  if (els.video) {
    els.video.currentTime = Math.min(scene.postSceneTime, els.video.duration || scene.postSceneTime);
    els.video.play().catch(() => {});
  }
  state.gameCursorTime = scene.postSceneTime;
  persistRuntimeSnapshot('adult-scene-complete', true);
  renderChoices();
}

function seekAdultLoop(targetTime, selectionToken = state.adultSelectionToken) {
  if (!els.video) return false;

  cancelAdultSeek();
  const requestId = state.adultSeekRequestId;
  const target = Math.max(0, Number(targetTime) || 0);
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
      renderAdultPanel(scene);
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
    state.adultClimaxProgress = Math.min(
      100,
      state.adultClimaxProgress + elapsed * 0.9 * movementRate
    );
  }
  renderAdultProgress();

  const outcomes = state.adultScene?.outcomes || [];
  if (
    !outcomes.length &&
    state.adultClimaxProgress >= 100 &&
    state.adultCorePlaySeconds >= 18
  ) {
    finishAdultScene();
  }
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

  const adultCandidate = candidates.find(action => action.adultScene);
  if (adultCandidate) {
    const adultScene =
      state.adultScenes.find(scene => scene.id === adultCandidate.adultSceneId) ||
      state.adultScenes.find(scene =>
        Number(scene.startTime) <= Number(adultCandidate.startTime) + 0.25 &&
        Number(scene.endTime) >= Number(adultCandidate.startTime) - 0.25
      );

    if (adultScene) {
      els.choices.classList.add('hidden');
      document.querySelector('.choice-navigation')?.classList.add('hidden');
      state.gameCursorTime = adultScene.startTime;
      els.video.currentTime = adultScene.startTime;
      els.video.pause();
      renderAdultPanel(adultScene);
      setGameState('SEGMENT_PLAYING');
      return;
    }
  }

  if (!candidates.length) {
    setGameState('ENDED');
    els.choices.innerHTML = '<div class="meta">İleri yönde kullanılabilir doğrulanmış action kalmadı.</div>';
    return;
  }

  candidates.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'choice';
    button.innerHTML = `
      <div class="choice-title">${escapeHtml(action.label)}</div>
      <div class="choice-meta">${action.startTime.toFixed(2)} → ${action.endTime.toFixed(2)} sn • ${(action.confidence * 100).toFixed(0)}%</div>
    `;
    button.addEventListener('click', () => playAction(action));
    els.choices.appendChild(button);
  });
  renderDebug({ nextCandidateActions: candidates.map(a => a.actionId) });
}

async function playAction(action) {
  const guard = guardPlayable('timeline', action, { unlocked: true });
  if (!guard.allowed) {
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

  const seekTarget = action.startTime;
  els.video.currentTime = seekTarget;
  const mobilePlayPromise = els.video.play().catch(() => {
    els.video.controls = true;
  });

  await waitForEvent(els.video, 'seeked', 5000).catch(() => {});
  setGameState('SEGMENT_PLAYING');

  state.stopListener = () => {
    if (els.video.currentTime >= action.endTime - 0.03) {
      finishAction(action);
    }
  };
  els.video.addEventListener('timeupdate', state.stopListener);
  await els.video.play().catch(() => {});
}

function finishAction(action) {
  els.video.pause();
  if (state.stopListener) {
    els.video.removeEventListener('timeupdate', state.stopListener);
    state.stopListener = null;
  }
  state.consumedActionIds.add(action.actionId);
  state.gameCursorTime = action.endTime;
  state.currentActionIndex = Math.max(state.currentActionIndex, state.analysis.actions.findIndex(a => a.actionId === action.actionId));
  state.activeAction = null;
  setGameState('DECISION_PENDING');
  persistRuntimeSnapshot('action-finished', true);
  renderChoices();
}

function resetGameAtAction(index) {
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
    div.innerHTML = `<b>${String(i + 1).padStart(2, '0')} • ${escapeHtml(a.label)}</b><div class="meta">${a.startTime.toFixed(3)} → ${a.endTime.toFixed(3)} • ${escapeHtml(a.actionId)}</div>`;
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
renderDebug();

function restoreSavedAnalysis() {
  try {
    const raw = localStorage.getItem("videoquest:last-analysis");
    if (!raw) return;

    const saved = JSON.parse(raw);
    let normalized = normalizeAnalysis(saved);
    const hardened = reviewAndHardenAnalysis({ ...saved, ...normalized });
    normalized = hardened.analysis;
    if (hardened.integrity.fatal || !normalized.actions.length) {
      localStorage.removeItem("videoquest:last-analysis");
      localStorage.removeItem(RUNTIME_SAVE_KEY);
      return;
    }

    state.analysis = normalized;
    state.integrityReport = hardened.integrity;
    state.analysisFingerprint = analysisFingerprint(normalized);
    els.analysisState.textContent = "TIMELINE_RESTORED";
    els.analysisTitle.textContent = `${normalized.actions.length} kayıtlı eylem geri yüklendi`;
    initializeInteractive(normalized);
  } catch (error) {
    console.warn("Saved analysis could not be restored:", error);
    localStorage.removeItem("videoquest:last-analysis");
  }
}

restoreSavedAnalysis();


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
  if (fullscreenBtn) {
    fullscreenBtn.textContent = document.fullscreenElement
      ? '✕ TAM EKRANDAN ÇIK'
      : '⛶ OYUN MODU';
  }
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

async function resolveVideoUrl() {
  const pageUrl = videoUrlInput?.value.trim();
  if (!pageUrl) {
    setUrlStatus('Lütfen video sayfasının bağlantısını gir.', 'error');
    return;
  }

  resolveUrlBtn.disabled = true;
  setUrlStatus('Sayfa inceleniyor, video kaynağı aranıyor...');

  try {
    const resolveResponse = await fetch('/api/resolve-video-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl })
    });

    const result = await resolveResponse.json().catch(() => ({}));
    if (!resolveResponse.ok || !result.ok) {
      throw new Error(result.message || 'Bu sayfada kullanılabilir video bulunamadı.');
    }

    if (result.type === 'hls') {
      throw new Error('HLS/m3u8 kaynağı bulundu; ancak yerel kare analizi için MP4/WebM kaynağı gerekiyor.');
    }

    setUrlStatus('Video bulundu. Cihaza geçici olarak hazırlanıyor...');
    const blob = await downloadUrlVideo(result.proxyUrl, result.sourceUrl);

    if (!blob.size) throw new Error('Video boş geldi.');

    const sourcePath = new URL(result.sourceUrl).pathname;
    const sourceName = decodeURIComponent(sourcePath.split('/').pop() || '');
    const extension = sourceName.match(/\.(mp4|webm|m4v|mov)$/i)?.[0] ||
      (blob.type.includes('webm') ? '.webm' : '.mp4');
    const fileName = sourceName || `url-video${extension}`;
    const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });

    state.selectedFile = file;
    resetDubState();
    els.video.src = URL.createObjectURL(file);
    els.fileMeta.textContent =
      `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • URL kaynağı`;
    updateAnalyzeAvailability();
    renderDebug();

    setUrlStatus('Video hazır. Şimdi “Videoyu analiz et” düğmesine bas.', 'success');
  } catch (error) {
    state.selectedFile = null;
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
