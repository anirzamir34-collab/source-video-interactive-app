const $ = (id) => document.getElementById(id);

const state = {
  serviceConnected: false,
  serviceCapabilities: null,
  selectedFile: null,
  analysis: null,
  gameState: 'IDLE',
  gameCursorTime: 0,
  currentActionIndex: -1,
  consumedActionIds: new Set(),
  activeAction: null,
  stopListener: null,
};

const els = {
  serviceStatus: $('serviceStatus'),
  serviceMeta: $('serviceMeta'),
  healthBtn: $('healthBtn'),
  videoInput: $('videoInput'),
  fileMeta: $('fileMeta'),
  analyzeBtn: $('analyzeBtn'),
  analysisCard: $('analysisCard'),
  analysisTitle: $('analysisTitle'),
  analysisState: $('analysisState'),
  analysisOutput: $('analysisOutput'),
  playerSection: $('playerSection'),
  video: $('video'),
  gameState: $('gameState'),
  cursorText: $('cursorText'),
  choices: $('choices'),
  timelineList: $('timelineList'),
  videoPrompt: $('videoPrompt'),
  debugOutput: $('debugOutput'),
};

function setServiceStatus(kind, label, meta = '') {
  els.serviceStatus.className = `status ${kind}`;
  els.serviceStatus.textContent = label;
  els.serviceMeta.textContent = meta;
}

function setGameState(next) {
  state.gameState = next;
  els.gameState.textContent = next;

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

function updateAnalyzeAvailability() {
  els.analyzeBtn.disabled = !state.selectedFile;
}

els.healthBtn.addEventListener('click', checkHealth);

els.videoInput.addEventListener('change', () => {
  const file = els.videoInput.files?.[0] || null;
  state.selectedFile = file;
  if (file) {
    els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • ${file.type || 'video'}`;
    els.video.src = URL.createObjectURL(file);
  } else {
    els.fileMeta.textContent = '';
  }
  updateAnalyzeAvailability();
  renderDebug();
});

els.analyzeBtn.addEventListener('click', async () => {
  if (!state.selectedFile) return;
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Harici servis analiz isteği';
  els.analysisState.textContent = 'ANALYZING';
  els.analysisOutput.textContent = 'Video harici analiz servisine gönderiliyor…\nSahte fallback kullanılmayacak.';
  setGameState('ANALYZING');

  const file = state.selectedFile;
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

  const form = new FormData();
  storyboard.sheets.forEach((blob, index) => {
    form.append('storyboards', blob, `storyboard-${String(index + 1).padStart(2, '0')}.jpg`);
  });
  form.append('duration', String(storyboard.duration));
  form.append('timestamps', JSON.stringify(storyboard.timestamps));

  let response;
  let body;
  try {
    response = await fetch('/api/gemini-storyboard-analyze', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(200000)
    });
    body = await response.json();
  } catch (error) {
    body = { available: false, reason: 'NETWORK_ERROR', error: error.message };
    response = { ok: false, status: 0 };
  }

  els.analysisOutput.textContent = JSON.stringify(body, null, 2);

  if (!response.ok) {
    els.analysisState.textContent = `ERROR ${response.status || ''}`.trim();
    els.analysisTitle.textContent = body?.detail?.reason || body?.reason || 'Analiz motoru hazır değil';
    setGameState('ERROR');
    renderDebug({ lastAnalyzeStatus: response.status, lastAnalyzeBody: body });
    return;
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
  els.analysisTitle.textContent = `${normalized.actions.length} doğrulanmış action`;
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
  els.playerSection.classList.remove('hidden');
  els.videoPrompt.textContent = typeof analysis.videoPrompt === 'string' ? analysis.videoPrompt : JSON.stringify(analysis.videoPrompt, null, 2);
  renderTimeline();
  setGameState('DECISION_PENDING');
  renderChoices();
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
  els.choices.innerHTML = '';
  els.cursorText.textContent = `cursor: ${state.gameCursorTime.toFixed(3)}`;
  const candidates = futureActions().slice(0, 3);

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
  setGameState('SEGMENT_SEEKING');
  els.video.pause();

  const seekTarget = action.startTime;
  els.video.currentTime = seekTarget;

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

els.video.addEventListener('play', () => {
  if (state.gameState !== 'SEGMENT_PLAYING') {
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
