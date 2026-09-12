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
  maleSceneProgress: 0,
  femaleSceneProgress: 0,
  lastAdultMediaTime: null,
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
  positionCount: $('positionCount'),
  positionTabs: $('positionTabs'),
  movementHeading: $('movementHeading'),
  movementCount: $('movementCount'),
  movementChoices: $('movementChoices'),
  maleProgressText: $('maleProgressText'),
  maleProgressBar: $('maleProgressBar'),
  femaleProgressText: $('femaleProgressText'),
  femaleProgressBar: $('femaleProgressBar'),
  finishAdultSceneBtn: $('finishAdultSceneBtn'),
};

function setServiceStatus(kind, label, meta = '') {
  els.serviceStatus.className = `status ${kind}`;
  els.serviceStatus.textContent = label;
  els.serviceMeta.textContent = meta;
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
  state.gameState = next;
  els.gameState.textContent = next;

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
    dubAudio.pause();
    dubAudio.removeAttribute("src");
    dubAudio.load();
    state.dubCache.clear();
    state.dubRequests.clear();
    state.activeDubSegmentId = null;
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
const DUB_BLOCK_SECONDS = 120;

function getDubBlockAt(videoTime) {
  const duration = Math.max(0, Number(els.video.duration) || 0);
  const time = Math.max(0, Number(videoTime) || 0);
  const blockStart = Math.floor(time / DUB_BLOCK_SECONDS) * DUB_BLOCK_SECONDS;
  const blockEnd = duration
    ? Math.min(duration, blockStart + DUB_BLOCK_SECONDS)
    : blockStart + DUB_BLOCK_SECONDS;
  const segments = (state.dialogue?.segments || [])
    .filter(s => {
      const start = Number(s.startTime) || 0;
      return start >= blockStart && start < blockEnd && s.turkishText;
    })
    .sort((x,y) => Number(x.startTime) - Number(y.startTime));
  if (!segments.length) return null;
  return {
    blockId: `dub-${blockStart.toFixed(3)}-${blockEnd.toFixed(3)}`,
    blockStart, blockEnd, segments
  };
}

async function ensureDubBlock(block) {
  if (!block) return null;
  if (state.dubCache.has(block.blockId)) return state.dubCache.get(block.blockId);
  if (state.dubRequests.has(block.blockId)) return state.dubRequests.get(block.blockId);

  const request = fetch('/api/gemini-dub-block', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(block)
  }).then(async response => {
    const body = await response.json();
    if (!response.ok || !body?.available || !body?.audioBase64) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    const source = `data:${body.mimeType || 'audio/wav'};base64,${body.audioBase64}`;
    state.dubCache.set(block.blockId, source);
    return source;
  }).catch(error => {
    console.error('Dub block failed:', block.blockId, error);
    return null;
  }).finally(() => state.dubRequests.delete(block.blockId));

  state.dubRequests.set(block.blockId, request);
  return request;
}

function stopDubPlayback() {
  dubAudio.pause();
  state.activeDubSegmentId = null;
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) return stopDubPlayback();

  const videoTime = Math.max(0, Number(els.video.currentTime) || 0);
  const block = getDubBlockAt(videoTime);
  if (!block) return stopDubPlayback();

  if (state.activeDubSegmentId === block.blockId && dubAudio.src) {
    const expected = Math.max(0, videoTime - block.blockStart);
    if (Number.isFinite(dubAudio.duration) && expected < dubAudio.duration &&
        Math.abs((Number(dubAudio.currentTime)||0)-expected) > 0.45) {
      dubAudio.currentTime = expected;
    }
    dubAudio.playbackRate = Math.max(0.9,Math.min(1.1,Number(els.video.playbackRate)||1));
    if (!els.video.paused && dubAudio.paused && expected < (dubAudio.duration||Infinity)) {
      dubAudio.play().catch(()=>{});
    }
    return;
  }

  stopDubPlayback();
  const requestedId = block.blockId;
  const source = await ensureDubBlock(block);
  if (!source || !state.dubbingEnabled) return;

  const current = getDubBlockAt(Number(els.video.currentTime)||0);
  if (!current || current.blockId !== requestedId) return;

  state.activeDubSegmentId = requestedId;
  dubAudio.src = source;
  dubAudio.load();

  const start = () => {
    if (!state.dubbingEnabled || state.activeDubSegmentId !== requestedId) return;
    const expected = Math.max(0,(Number(els.video.currentTime)||0)-block.blockStart);
    if (Number.isFinite(dubAudio.duration) && dubAudio.duration > 0) {
      dubAudio.currentTime = Math.min(Math.max(0,dubAudio.duration-0.05),expected);
    }
    dubAudio.playbackRate = Math.max(0.9,Math.min(1.1,Number(els.video.playbackRate)||1));
    if (!els.video.paused) dubAudio.play().catch(()=>{});
  };

  if (dubAudio.readyState >= 1) start();
  else dubAudio.addEventListener('loadedmetadata',start,{once:true});
}

els.video.addEventListener('timeupdate',syncDubPlayback);
els.video.addEventListener('pause',()=>dubAudio.pause());
els.video.addEventListener('seeking',()=>{
  dubAudio.pause();
  state.activeDubSegmentId=null;
});
els.video.addEventListener('play',syncDubPlayback);

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
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Video harici analiz servisine gönderiliyor…\nSahte fallback kullanılmayacak.';
  setGameState('ANALYZING');

  const file = state.selectedFile;
  const modes = selectedAnalysisModes();

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
        await Promise.all(dialogue.segments.slice(0, 8).map(ensureDubAudio));
        prepareUpcomingDubs(8);
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

      if (!modes.motion) return;
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

      try {
        response = await fetch('/api/gemini-storyboard-analyze', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(200000)
        });

        body = await response.json();

        if (!response.ok || !body?.available) {
          failureBody = body || {
            available: false,
            reason: 'CHUNK_ANALYSIS_FAILED',
            message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`
          };
          break;
        }

        chunkResults.push(body);
      if (body.protagonistProfile) {
        protagonistProfile = String(body.protagonistProfile).trim();
      }
      } catch (error) {
        failureBody = {
          available: false,
          reason: 'NETWORK_ERROR',
          message: `Bölüm ${chunkIndex + 1} sırasında bağlantı hatası oluştu.`,
          error: error?.message || String(error)
        };
        break;
      }
    }

    if (failureBody && !chunkResults.length) {
      body = failureBody;
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
        analysisMode: 'MULTI_PASS_DEEP',
        chunkCount
      };
    }

  const normalized = normalizeAnalysis(body);
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
    `${Number(body.chunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,
    'Oyun modu kullanıma hazır.'
  ].join('\n');
  initializeInteractive(normalized);
});

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
      positionLabel: String(a.positionLabel || ""),
      positionStartTime: Number(a.positionStartTime ?? a.startTime),
      positionEndTime: Number(a.positionEndTime ?? a.endTime),
      movementType: String(a.movementType || a.actionType || ""),
      loopStartTime: Number(a.loopStartTime ?? a.startTime),
      loopEndTime: Number(a.loopEndTime ?? a.endTime),
      maleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.maleProgressRate) || 1)),
      femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.femaleProgressRate) || 1)),
    }))
    .filter(a => Number.isFinite(a.startTime) && Number.isFinite(a.endTime) && a.endTime > a.startTime && a.sourceVerified)
    .sort((a, b) => a.startTime - b.startTime);

  return {
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
  state.activeMovementId = null;
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  prepareAdultScenes();
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
  const source = [
    action.positionLabel,
    action.label,
    action.positionId
  ].filter(Boolean).join(' ');

  const family = adultSemanticFamily(source);
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
    action.positionId || action.positionLabel || action.label || 'pozisyon'
  ).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    id: fallback || `position-${Math.round(Number(action.startTime) || 0)}`,
    label: action.positionLabel || action.label || 'Pozisyon'
  };
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
        postSceneTime: Number(action.postSceneEndTime ?? action.adultSceneEndTime ?? action.endTime),
        positions: new Map()
      });
    }

    const scene = sceneMap.get(sceneId);
    scene.startTime = Math.min(scene.startTime, Number(action.adultSceneStartTime ?? action.startTime));
    scene.endTime = Math.max(scene.endTime, Number(action.adultSceneEndTime ?? action.endTime));

    const canonical = canonicalAdultPosition(action);
    if (!canonical.id) return;

    if (!scene.positions.has(canonical.id)) {
      scene.positions.set(canonical.id, {
        id: canonical.id,
        label: canonical.label,
        startTime: Number(action.positionStartTime ?? action.startTime),
        endTime: Number(action.positionEndTime ?? action.endTime),
        movements: []
      });
    }

    const position = scene.positions.get(canonical.id);
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
    .map(scene => ({
      ...scene,
      positions: [...scene.positions.values()]
        .map(position => ({
          ...position,
          movements: position.movements
            .filter(item => item.loopEndTime - item.loopStartTime >= 10)
            .sort((a, b) => a.loopStartTime - b.loopStartTime)
        }))
        .filter(position => position.endTime - position.startTime >= 10)
        .sort((a, b) => a.startTime - b.startTime)
    }))
    .filter(scene => scene.positions.length)
    .sort((a, b) => a.startTime - b.startTime);
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

function renderAdultProgress() {
  const male = Math.min(100, Math.max(0, state.maleSceneProgress || 0));
  const female = Math.min(100, Math.max(0, state.femaleSceneProgress || 0));
  if (els.maleProgressText) els.maleProgressText.textContent = `${Math.round(male)}%`;
  if (els.femaleProgressText) els.femaleProgressText.textContent = `${Math.round(female)}%`;
  if (els.maleProgressBar) els.maleProgressBar.style.width = `${male}%`;
  if (els.femaleProgressBar) els.femaleProgressBar.style.width = `${female}%`;
}

function renderAdultPanel(scene) {
  if (!scene || !els.adultInteractionPanel) return;

  const videoStage = els.video?.closest('.video-stage');
  if (videoStage && els.adultInteractionPanel.parentElement === videoStage) {
    videoStage.insertAdjacentElement('afterend', els.adultInteractionPanel);
  }

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  }

  state.adultScene = scene;
  state.adultMode = true;
  els.adultInteractionPanel.classList.remove("hidden");
  document.querySelector(".choice-navigation")?.classList.add("hidden");
  if (els.adultSceneTitle) els.adultSceneTitle.textContent = scene.title;
  if (els.adultSceneTime) {
    els.adultSceneTime.textContent = `${adultTimeLabel(scene.startTime)} – ${adultTimeLabel(scene.endTime)}`;
  }
  if (els.positionCount) els.positionCount.textContent = `${scene.positions.length} pozisyon`;
  if (els.positionTabs) els.positionTabs.innerHTML = "";

  scene.positions.forEach(position => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "position-tab";
    button.textContent = position.label;
    button.dataset.positionId = position.id;
    button.addEventListener("click", () => selectAdultPosition(position.id, true));
    els.positionTabs?.appendChild(button);
  });

  const selected = scene.positions.find(item => item.id === state.activePositionId) || scene.positions[0];
  selectAdultPosition(selected.id, false);
  renderAdultProgress();
}

function selectAdultPosition(positionId, shouldSeek = true) {
  const scene = state.adultScene;
  const position = scene?.positions.find(item => item.id === positionId);
  if (!position) return;

  state.activePositionId = position.id;
  els.positionTabs?.querySelectorAll(".position-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.positionId === position.id);
  });

  if (els.movementHeading) els.movementHeading.textContent = position.label;
  if (els.movementCount) els.movementCount.textContent = `${position.movements.length} gerçek değişim`;
  if (els.movementChoices) els.movementChoices.innerHTML = "";

  position.movements.forEach(movement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "movement-choice-card";
    button.dataset.movementId = movement.id;
    button.innerHTML = `<span>${escapeHtml(movement.label)}</span><small>${adultTimeLabel(movement.loopStartTime)} – ${adultTimeLabel(movement.loopEndTime)}</small>`;
    button.addEventListener("click", () => selectAdultMovement(movement.id, true));
    els.movementChoices?.appendChild(button);
  });

  const movement = position.movements.find(item => item.id === state.activeMovementId) || position.movements[0];

  if (movement) {
    selectAdultMovement(movement.id, shouldSeek);
  } else {
    state.activeMovementId = null;
    if (els.movementChoices) els.movementChoices.innerHTML = '';
    if (els.movementCount) els.movementCount.textContent = '10 saniyelik ek seçenek yok';
    if (shouldSeek && els.video) {
      seekAdultLoop(position.startTime);
      els.video.play().catch(() => {});
    }
  }
}

function selectAdultMovement(movementId, shouldSeek = true) {
  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === movementId);
  if (!movement) return;

  state.activeMovementId = movement.id;
  state.lastAdultMediaTime = null;
  els.movementChoices?.querySelectorAll(".movement-choice-card").forEach(button => {
    button.classList.toggle("active", button.dataset.movementId === movement.id);
  });

  if (shouldSeek && els.video) {
    seekAdultLoop(movement.loopStartTime);
    els.video.play().catch(() => {});
  }
}

function finishAdultScene() {
  const scene = state.adultScene;
  if (!scene) return;
  if (!state.completedAdultSceneIds) state.completedAdultSceneIds = new Set();
  state.completedAdultSceneIds.add(scene.id);
  state.adultMode = false;
  state.adultScene = null;
  state.activePositionId = null;
  state.activeMovementId = null;
  state.lastAdultMediaTime = null;
  els.adultInteractionPanel?.classList.add("hidden");
  document.querySelector(".choice-navigation")?.classList.remove("hidden");
  if (els.video) {
    els.video.currentTime = Math.min(scene.postSceneTime, els.video.duration || scene.postSceneTime);
    els.video.play().catch(() => {});
  }
  state.gameCursorTime = scene.postSceneTime;
  renderChoices();
}


function seekAdultLoop(targetTime) {
  if (!els.video || state.adultLoopSeeking) return false;
  state.adultLoopSeeking = true;
  clearTimeout(state.adultSeekTimer);

  const finishSeek = () => {
    state.adultLoopSeeking = false;
    state.lastAdultFrameNow = performance.now();
    clearTimeout(state.adultSeekTimer);
  };

  els.video.addEventListener("seeked", finishSeek, { once: true });
  els.video.currentTime = Math.max(0, Number(targetTime) || 0);
  state.adultSeekTimer = setTimeout(finishSeek, 1500);
  return true;
}

function updateAdultPlayback(now, mediaTime) {
  if (!state.adultMode) {
    const scene = findAdultSceneAt(mediaTime);
    if (scene) {
      state.maleSceneProgress = 0;
      state.femaleSceneProgress = 0;
      state.lastAdultFrameNow = now;
      renderAdultPanel(scene);
    }
    return;
  }

  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === state.activeMovementId);
  if (!movement || !els.video || els.video.paused) {
    state.lastAdultFrameNow = now;
    return;
  }

  if (state.adultLoopSeeking) {
    state.lastAdultFrameNow = now;
    return;
  }

  if (mediaTime >= movement.loopEndTime - 0.04 || mediaTime < movement.loopStartTime - 0.15) {
    seekAdultLoop(movement.loopStartTime);
    state.lastAdultFrameNow = now;
    return;
  }

  const elapsed = Math.min(0.25, Math.max(0, (now - (state.lastAdultFrameNow || now)) / 1000));
  state.lastAdultFrameNow = now;
  state.maleSceneProgress += elapsed * Number(movement.maleProgressRate || 1);
  state.femaleSceneProgress += elapsed * Number(movement.femaleProgressRate || 1);
  renderAdultProgress();

  if (state.maleSceneProgress >= 100 || state.femaleSceneProgress >= 100) {
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
  els.finishAdultSceneBtn.addEventListener("click", finishAdultScene);
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
        !state.consumedActions.has(action.actionId)
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
  state.consumedActions = new Set(
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
  if (!state.activeAction && !state.navigationSeeking) {
    state.manualSeeking = true;
  }
});

els.video.addEventListener('seeked', () => {
  if (!state.manualSeeking || state.activeAction || state.navigationSeeking) return;
  state.manualSeeking = false;

  const actions = state.analysis?.actions || [];
  if (!actions.length) return;

  const now = Number(els.video.currentTime) || 0;
  let index = actions.findIndex(action => Number(action.startTime) >= now - 0.1);
  if (index < 0) index = actions.length - 1;

  state.currentActionIndex = index - 1;
  state.gameCursorTime = Number(actions[index].startTime) || now;
  state.consumedActions = new Set(
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

    const normalized = normalizeAnalysis(JSON.parse(raw));
    if (!normalized.actions.length) return;

    state.analysis = normalized;
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
    dubAudio.pause();
    dubAudio.removeAttribute("src");
    dubAudio.load();
    state.dubCache.clear();
    state.dubRequests.clear();
    state.activeDubSegmentId = null;
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
