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
  if (file) {
    els.fileMeta.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(1)} MB • ${file.type || 'video'}`;
    els.video.src = URL.createObjectURL(file);
  } else {
    els.fileMeta.textContent = '';
  }
  updateAnalyzeAvailability();
  renderDebug();
});

async function analyzeSelectedDialogue(file) {
  els.analysisCard.classList.remove('hidden');
  els.analysisTitle.textContent = 'Video diyaloğu analiz ediliyor';
  els.analysisState.textContent = 'AUDIO_ANALYSIS';
  els.analysisOutput.textContent =
    `Video ve ses Gemini'ye gönderiliyor...\n` +
    `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  const form = new FormData();
  form.append('video', file, file.name || 'video.mp4');
  form.append('duration', String(Number(els.video.duration) || 0));

  const response = await fetch('/api/gemini-dialogue-analyze', {
    method: 'POST',
    body: form
  });

  const body = await response.json();

  if (!response.ok || !body.available) {
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
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

async function ensureDubAudio(segment) {
  if (!segment?.segmentId || !segment.turkishText) return null;

  if (state.dubCache.has(segment.segmentId)) {
    return state.dubCache.get(segment.segmentId);
  }

  if (state.dubRequests.has(segment.segmentId)) {
    return state.dubRequests.get(segment.segmentId);
  }

  const request = fetch('/api/gemini-dub-segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: segment.turkishText,
      gender: segment.gender,
      emotion: segment.emotion,
      speakerId: segment.speakerId
    })
  })
    .then(async response => {
      const body = await response.json();
      if (!response.ok || !body.available || !body.audioBase64) {
        throw new Error(body.error || body.message || `HTTP ${response.status}`);
      }

      const source =
        `data:${body.mimeType || 'audio/wav'};base64,${body.audioBase64}`;

      state.dubCache.set(segment.segmentId, source);
      return source;
    })
    .catch(error => {
      console.error('Dub segment failed:', segment.segmentId, error);
      return null;
    })
    .finally(() => {
      state.dubRequests.delete(segment.segmentId);
    });

  state.dubRequests.set(segment.segmentId, request);
  return request;
}

function prepareUpcomingDubs(currentIndex) {
  const segments = state.dialogue?.segments || [];
  segments
    .slice(Math.max(0, currentIndex), currentIndex + 8)
    .forEach(segment => ensureDubAudio(segment));
}

async function syncDubPlayback() {
  if (!state.dubbingEnabled) {
    if (!dubAudio.paused) dubAudio.pause();
    return;
  }

  const segments = state.dialogue?.segments || [];
  const now = Number(els.video.currentTime) || 0;
  const index = segments.findIndex(segment =>
    now >= Number(segment.startTime) &&
    now <= Number(segment.endTime)
  );

  if (index < 0) {
    if (!dubAudio.paused) dubAudio.pause();
    state.activeDubSegmentId = null;
    return;
  }

  const segment = segments[index];
  prepareUpcomingDubs(index + 1);

  if (state.activeDubSegmentId === segment.segmentId) return;
  state.activeDubSegmentId = segment.segmentId;

  if (!dubAudio.paused) dubAudio.pause();

  const source = await ensureDubAudio(segment);
  if (!source || !state.dubbingEnabled) return;

  const currentTime = Number(els.video.currentTime) || 0;
  if (
    currentTime < Number(segment.startTime) ||
    currentTime > Number(segment.endTime)
  ) {
    return;
  }

  dubAudio.src = source;

  const playWhenReady = () => {
    const targetDuration = Math.max(
      0.5,
      Number(segment.endTime) - Number(segment.startTime)
    );

    if (Number.isFinite(dubAudio.duration) && dubAudio.duration > 0) {
      dubAudio.playbackRate = Math.max(
        0.75,
        Math.min(1.5, dubAudio.duration / targetDuration)
      );
    }

    dubAudio.play().catch(error => {
      console.warn('Dub autoplay was blocked:', error);
    });
  };

  if (dubAudio.readyState >= 2) {
    playWhenReady();
  } else {
    dubAudio.addEventListener('loadedmetadata', playWhenReady, { once: true });
  }
}

els.dubToggleBtn?.addEventListener('click', () => {
  state.dubbingEnabled = !state.dubbingEnabled;
  els.dubToggleBtn.textContent =
    `TR DUBLAJ: ${state.dubbingEnabled ? 'AÇIK' : 'KAPALI'}`;

  els.video.muted =
    state.dubbingEnabled && !state.keepOriginalAudioEnabled;

  if (!state.dubbingEnabled) {
    dubAudio.pause();
    state.activeDubSegmentId = null;
  } else {
    syncDubPlayback();
  }
});

els.video.addEventListener('timeupdate', syncDubPlayback);
els.video.addEventListener('pause', () => dubAudio.pause());
els.video.addEventListener('seeking', () => {
  dubAudio.pause();
  state.activeDubSegmentId = null;
});
els.video.addEventListener('play', syncDubPlayback);

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

    if (failureBody) {
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
        actions: chunkResults.flatMap(result =>
          Array.isArray(result.actions) ? result.actions : []
        ),
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
