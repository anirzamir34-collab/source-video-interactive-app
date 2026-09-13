from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


app_path = Path('public/app.js')
text = app_path.read_text()

# Imports: master clock + hardening core.
text = replace_once(
    text,
    "  dialogueSegmentAt,\n  dubSegmentKey,\n  fittedDubPlaybackRate,\n  isCompleteChunkAnalysis,",
    "  dialogueSegmentAt,\n  dubMasterClockCorrection,\n  dubSegmentKey,\n  fittedDubPlaybackRate,\n  isCompleteChunkAnalysis,",
    'playback import'
)
text = replace_once(
    text,
    "} from './playback-logic.js';\n\nconst $ = (id) => document.getElementById(id);",
    "} from './playback-logic.js';\nimport {\n  ANALYSIS_SCHEMA_VERSION,\n  ENGINE_VERSION,\n  advanceAdultPhase,\n  analysisFingerprint,\n  appendEngineEvent,\n  applyRuntimeSnapshot,\n  canPlayAction,\n  createRuntimeSnapshot,\n  isCompatibleRuntimeSnapshot,\n  reviewAndHardenAnalysis,\n  shouldSecondPassReview\n} from './engine-hardening.js';\n\nconst $ = (id) => document.getElementById(id);",
    'hardening import'
)

# Runtime state.
text = replace_once(
    text,
    "  navigationSeeking: false,\n  manualSeeking: false,\n};",
    "  navigationSeeking: false,\n  manualSeeking: false,\n  adultPhaseMachine: 'foreplay',\n  engineEvents: [],\n  integrityReport: null,\n  analysisFingerprint: '',\n  lastRuntimeSaveAt: 0,\n};",
    'state hardening fields'
)

# Central engine helpers and save/resume.
marker = """function setServiceStatus(kind, label, meta = '') {
  els.serviceStatus.className = `status ${kind}`;
  els.serviceStatus.textContent = label;
  els.serviceMeta.textContent = meta;
}

let analysisWakeLock = null;
"""
replacement = """function setServiceStatus(kind, label, meta = '') {
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
"""
text = replace_once(text, marker, replacement, 'engine helper insertion')

# Game-state event log + persistence.
old = """function setGameState(next) {
  state.gameState = next;
  els.gameState.textContent = next;
"""
new = """function setGameState(next) {
  const previous = state.gameState;
  state.gameState = next;
  els.gameState.textContent = next;
  if (previous !== next) {
    logEngineEvent('GAME_STATE_CHANGED', { from: previous, to: next });
  }
"""
text = replace_once(text, old, new, 'setGameState header')
text = replace_once(
    text,
    "  renderDebug();\n}\n\nfunction renderDebug(extra = {}) {",
    "  if (['DECISION_PENDING', 'ENDED', 'DIALOGUE_READY'].includes(next)) {\n    persistRuntimeSnapshot('game-state');\n  }\n  renderDebug();\n}\n\nfunction renderDebug(extra = {}) {",
    'setGameState persistence'
)
text = replace_once(
    text,
    "    videoCurrentTime: Number((els.video.currentTime || 0).toFixed(3)),\n    ...extra,",
    "    videoCurrentTime: Number((els.video.currentTime || 0).toFixed(3)),\n    schemaVersion: state.analysis?.schemaVersion ?? null,\n    engineVersion: state.analysis?.engineVersion ?? ENGINE_VERSION,\n    integrityReport: state.integrityReport,\n    adultPhaseMachine: state.adultPhaseMachine,\n    recentEngineEvents: state.engineEvents.slice(-30),\n    ...extra,",
    'debug hardening fields'
)

# Dubbing master clock: video clock is authoritative.
old_align = """  const expected = mapVideoTimeToDubTime({
    videoTime,
    segmentStart,
    segmentEnd,
    audioDuration
  });

  if (Math.abs((Number(dubAudio.currentTime) || 0) - expected) > 0.22) {
    dubAudio.currentTime = expected;
  }

  dubAudio.playbackRate = fittedDubPlaybackRate({
    audioDuration,
    segmentDuration: segmentEnd - segmentStart,
    videoPlaybackRate: Number(els.video.playbackRate) || 1
  });
"""
new_align = """  const correction = dubMasterClockCorrection({
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
"""
text = replace_once(text, old_align, new_align, 'dub master clock')
text = replace_once(
    text,
    "els.video.addEventListener('timeupdate', () => void syncDubPlayback());\n",
    "els.video.addEventListener('timeupdate', () => void syncDubPlayback());\nsetInterval(() => {\n  if (state.dubbingEnabled && !els.video.paused && !els.video.seeking) {\n    void syncDubPlayback();\n  }\n}, 300);\n",
    'dub clock interval'
)

# Fresh analysis must not resume a previous run.
text = replace_once(
    text,
    "  state.dialogue = null;\n  state.dubbingEnabled = false;",
    "  state.dialogue = null;\n  localStorage.removeItem(RUNTIME_SAVE_KEY);\n  state.analysisFingerprint = '';\n  state.engineEvents = [];\n  state.integrityReport = null;\n  state.dubbingEnabled = false;",
    'analysis runtime reset'
)

# True visual second pass for risky/adult chunks using the same storyboard frames.
old_success = """          } else {
            chunkResults.push(body);
            if (body.protagonistProfile) {
              protagonistProfile = String(body.protagonistProfile).trim();
            }
            chunkSucceeded = true;
            failureBody = null;
            break;
          }
"""
new_success = """          } else {
            if (shouldSecondPassReview(body)) {
              form.set('reviewMode', '1');
              form.set('reviewCandidates', JSON.stringify(body.actions || []));
              els.analysisOutput.textContent =
                `${chunkStart.toFixed(1)}–${chunkEnd.toFixed(1)} saniye ikinci kez doğrulanıyor...`;
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
              body = {
                ...reviewBody,
                secondPassReviewed: true,
                firstPassActionCount: Array.isArray(body.actions) ? body.actions.length : 0
              };
            }
            chunkResults.push(body);
            if (body.protagonistProfile) {
              protagonistProfile = String(body.protagonistProfile).trim();
            }
            chunkSucceeded = true;
            failureBody = null;
            break;
          }
"""
text = replace_once(text, old_success, new_success, 'chunk second pass')

# Merge metadata records actual analysis coverage/version.
text = replace_once(
    text,
    "        analysisMode: 'MULTI_PASS_DEEP',\n        chunkCount: chunkResults.length,\n        expectedChunkCount: chunkCount",
    "        analysisMode: 'MULTI_PASS_DEEP_HARDENED',\n        chunkCount: chunkResults.length,\n        expectedChunkCount: chunkCount,\n        analysisCoverage: chunkCount ? chunkResults.length / chunkCount : 0,\n        secondPassChunkCount: chunkResults.filter(result => result.secondPassReviewed).length,\n        schemaVersion: ANALYSIS_SCHEMA_VERSION,\n        engineVersion: ENGINE_VERSION",
    'merged analysis metadata'
)

# Deterministic integrity review before a timeline may open.
old_normalize = """  const normalized = normalizeAnalysis(body);
  if (!normalized.actions.length) {
"""
new_normalize = """  let normalized = normalizeAnalysis(body);
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
"""
text = replace_once(text, old_normalize, new_normalize, 'integrity review')
text = replace_once(
    text,
    "    `${Number(body.chunkCount || 0)}/${Number(body.expectedChunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,\n    'Oyun modu kullanıma hazır.'",
    "    `${Number(body.chunkCount || 0)}/${Number(body.expectedChunkCount || chunkCount)} analiz bölümü başarıyla birleştirildi.`,\n    `${Number(body.secondPassChunkCount || 0)} bölüm görsel ikinci kontrolden geçti.`,\n    `Bütünlük kontrolü: ${state.integrityReport?.issueCount || 0} uyarı · ${normalized.actions.length} güvenli aksiyon.`,\n    'Oyun modu kullanıma hazır.'",
    'analysis result summary'
)

# Normalize carries version/coverage metadata forward.
text = replace_once(
    text,
    "  return {\n    videoDuration: Number(body?.videoDuration ?? 0),\n    mainMaleTrackId: body?.mainMaleTrackId ?? null,",
    "  return {\n    schemaVersion: Number(body?.schemaVersion || ANALYSIS_SCHEMA_VERSION),\n    engineVersion: String(body?.engineVersion || ENGINE_VERSION),\n    chunkCount: Number(body?.chunkCount || 0),\n    expectedChunkCount: Number(body?.expectedChunkCount || 0),\n    analysisCoverage: Number(body?.analysisCoverage || 0),\n    secondPassChunkCount: Number(body?.secondPassChunkCount || 0),\n    videoDuration: Number(body?.videoDuration ?? 0),\n    mainMaleTrackId: body?.mainMaleTrackId ?? null,",
    'normalize metadata'
)

# Runtime save/resume integration.
text = replace_once(
    text,
    "  state.adultUiSignature = '';\n  state.adultLastUiPhase = 'foreplay';\n  prepareAdultScenes();",
    "  state.adultUiSignature = '';\n  state.adultLastUiPhase = 'foreplay';\n  state.adultPhaseMachine = 'foreplay';\n  prepareAdultScenes();\n  const restoredSnapshot = restoreRuntimeSnapshot(analysis);\n  if (restoredSnapshot) {\n    const restoreTarget = Math.max(0, Number(state.gameCursorTime) || 0);\n    const applyRestoreSeek = () => {\n      if (Number.isFinite(els.video.duration)) {\n        els.video.pause();\n        els.video.currentTime = Math.min(restoreTarget, Math.max(0, els.video.duration - 0.05));\n      }\n    };\n    if (els.video.readyState >= 1) applyRestoreSeek();\n    else els.video.addEventListener('loadedmetadata', applyRestoreSeek, { once: true });\n  }",
    'runtime restore in initialize'
)
# There are two reset blocks with the same phase marker: update resetAdultSceneGameplay too.
text = text.replace(
    "  state.adultUiSignature = '';\n  state.adultLastUiPhase = 'foreplay';\n}",
    "  state.adultUiSignature = '';\n  state.adultLastUiPhase = 'foreplay';\n  state.adultPhaseMachine = 'foreplay';\n}",
    1
)

# Central monotonic adult state machine.
text = replace_once(
    text,
    "  const phase = monotonicAdultPhase(proposedPhase, state.adultLastUiPhase);",
    "  const monotonicPhase = monotonicAdultPhase(proposedPhase, state.adultLastUiPhase);\n  const phase = setAdultMachinePhase(monotonicPhase);",
    'adult state machine'
)

# Central permission checks for every adult interaction.
text = replace_once(
    text,
    "  if (!item || !els.video || state.adultOutcomePhase !== 'idle') return;\n\n  const token = beginAdultSelection();",
    "  if (!item || !els.video || state.adultOutcomePhase !== 'idle') return;\n  const guard = guardPlayable('foreplay', item, { scene, unlocked: true });\n  if (!guard.allowed) return;\n  logEngineEvent('FOREPLAY_SELECTED', { id: item.id });\n\n  const token = beginAdultSelection();",
    'foreplay guard'
)
old_position_guard = """  if (
    !position ||
    state.adultOutcomePhase !== 'idle' ||
    currentAdultFlow() + 0.001 < Number(position.unlockProgress || 0)
  ) return;

  const selectionToken = shouldSeek
"""
new_position_guard = """  if (!position || state.adultOutcomePhase !== 'idle') return;
  const positionUnlocked = unlockedAdultPositions(scene).some(item => item.id === position.id);
  const positionGuard = guardPlayable(
    isWarmupPosition(position) ? 'foreplay' : 'position',
    position,
    { scene, unlocked: positionUnlocked }
  );
  if (!positionGuard.allowed) return;
  if (shouldSeek) logEngineEvent('POSITION_SELECTED', { id: position.id, family: position.familyId });

  const selectionToken = shouldSeek
"""
text = replace_once(text, old_position_guard, new_position_guard, 'position guard')
text = replace_once(
    text,
    "  const movement = position?.movements.find(item => item.id === movementId);\n  if (!movement || state.adultOutcomePhase !== 'idle') return;\n\n  const effectiveToken = selectionToken ?? beginAdultSelection();",
    "  const movement = position?.movements.find(item => item.id === movementId);\n  if (!movement || state.adultOutcomePhase !== 'idle') return;\n  const movementGuard = guardPlayable('movement', movement, {\n    scene: state.adultScene,\n    parentPosition: position,\n    unlocked: true\n  });\n  if (!movementGuard.allowed) return;\n  if (shouldSeek) logEngineEvent('MOVEMENT_SELECTED', { id: movement.id, positionId: position?.id || null });\n\n  const effectiveToken = selectionToken ?? beginAdultSelection();",
    'movement guard'
)
text = replace_once(
    text,
    "  if (!outcome || !els.video) return;\n  if (!unlockedAdultOutcomes(scene).some(item => item.id === outcome.id)) return;\n\n  const selectionToken = beginAdultSelection();\n  state.adultOutcomePhase = 'outcome';",
    "  if (!outcome || !els.video) return;\n  const outcomeReady = unlockedAdultOutcomes(scene).some(item => item.id === outcome.id);\n  const outcomeGuard = guardPlayable('outcome', outcome, { scene, unlocked: outcomeReady, outcomeReady });\n  if (!outcomeGuard.allowed) return;\n\n  const selectionToken = beginAdultSelection();\n  setAdultMachinePhase('outcome');\n  logEngineEvent('OUTCOME_SELECTED', { id: outcome.id });\n  state.adultOutcomePhase = 'outcome';",
    'outcome guard'
)
text = replace_once(
    text,
    "        state.adultOutcomePhase = 'aftermath';\n        els.video.pause();",
    "        state.adultOutcomePhase = 'aftermath';\n        setAdultMachinePhase('aftermath');\n        logEngineEvent('AFTERMATH_STARTED', { sceneId: state.adultScene?.id || null });\n        els.video.pause();",
    'aftermath phase'
)
text = replace_once(
    text,
    "  state.completedAdultSceneIds.add(scene.id);\n  state.adultSelectionToken += 1;",
    "  state.completedAdultSceneIds.add(scene.id);\n  setAdultMachinePhase('complete');\n  logEngineEvent('ADULT_SCENE_COMPLETED', { sceneId: scene.id });\n  state.adultSelectionToken += 1;",
    'adult completion phase'
)
text = replace_once(
    text,
    "  state.gameCursorTime = scene.postSceneTime;\n  renderChoices();",
    "  state.gameCursorTime = scene.postSceneTime;\n  persistRuntimeSnapshot('adult-scene-complete', true);\n  renderChoices();",
    'adult completion save'
)

# Adult progress saves are throttled.
text = replace_once(
    text,
    "  renderAdultFlowStatus();\n  renderAdultProgressiveUI(false);\n}",
    "  renderAdultFlowStatus();\n  persistRuntimeSnapshot('adult-progress');\n  renderAdultProgressiveUI(false);\n}",
    'adult progress save'
)

# Generic action guard before any seek.
text = replace_once(
    text,
    "async function playAction(action) {\n  if (state.stopListener) {",
    "async function playAction(action) {\n  const guard = guardPlayable('timeline', action, { unlocked: true });\n  if (!guard.allowed) {\n    renderChoices();\n    return;\n  }\n  logEngineEvent('TIMELINE_ACTION_SELECTED', { actionId: action.actionId });\n  if (state.stopListener) {",
    'timeline guard'
)

# Save navigation/action progression.
text = replace_once(
    text,
    "  state.activeAction = null;\n  setGameState('DECISION_PENDING');\n  renderChoices();\n}",
    "  state.activeAction = null;\n  setGameState('DECISION_PENDING');\n  persistRuntimeSnapshot('action-finished', true);\n  renderChoices();\n}",
    'finish action save'
)

# Restore saved analysis through the same integrity/version review.
old_restore = """    const normalized = normalizeAnalysis(JSON.parse(raw));
    if (!normalized.actions.length) return;

    state.analysis = normalized;
    els.analysisState.textContent = "TIMELINE_RESTORED";
    els.analysisTitle.textContent = `${normalized.actions.length} kayıtlı eylem geri yüklendi`;
    initializeInteractive(normalized);
"""
new_restore = """    const saved = JSON.parse(raw);
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
"""
text = replace_once(text, old_restore, new_restore, 'saved analysis hardening')

app_path.write_text(text)

# Server: visual second-pass mode, confidence gates, version metadata.
server_path = Path('server.js')
server = server_path.read_text()
server = replace_once(
    server,
    "const PORT = process.env.PORT || 10000;\nconst EXTERNAL_ANALYSIS_URL =",
    "const PORT = process.env.PORT || 10000;\nconst ANALYSIS_SCHEMA_VERSION = 4;\nconst ANALYSIS_ENGINE_VERSION = 'gemini-storyboard-hardening-v1';\nconst EXTERNAL_ANALYSIS_URL =",
    'server version constants'
)
server = replace_once(
    server,
    "  const qualityMode = String(req.body?.qualityMode || 'ultra');\n  const chunkDuration = Math.max(1, chunkEnd - chunkStart);",
    "  const qualityMode = String(req.body?.qualityMode || 'ultra');\n  const reviewMode = String(req.body?.reviewMode || '') === '1';\n  const reviewCandidates = String(req.body?.reviewCandidates || '[]').slice(0, 18000);\n  const reviewInstructions = reviewMode ? `\nSECOND PASS VISUAL REVIEW MODE:\n- Re-inspect the SAME storyboard frames against these first-pass candidates:\n${reviewCandidates}\n- Return only candidates that are visibly re-verified at start, midpoint and end.\n- Correct timestamps, canonical position id/label and confidence when the frames prove a correction.\n- Preserve actionId/sceneId for the same candidate.\n- Do not add a new action merely because it sounds plausible.\n- If a candidate conflicts with the frames, another position label, scene chronology, or its parent range, OMIT it and add a warning.\n- Outcome/final candidates require stronger evidence than ordinary actions.\n` : '';\n  const chunkDuration = Math.max(1, chunkEnd - chunkStart);",
    'server review fields'
)
server = replace_once(
    server,
    "Current analysis chunk: ${chunkIndex + 1} of ${chunkCount}\n\nDIALOGUE AND SCENE CONTEXT:",
    "Current analysis chunk: ${chunkIndex + 1} of ${chunkCount}\n${reviewInstructions}\nDIALOGUE AND SCENE CONTEXT:",
    'server review prompt injection'
)
# Add confidence gate after structural filter, before sort.
old_filter = """      .filter((action) =>
        action.label &&
        action.startTime + 0.05 >= introEndTime &&
        Number.isFinite(action.startTime) &&
        Number.isFinite(action.endTime) &&
        action.startTime >= 0 &&
        action.endTime > action.startTime &&
        (!duration || action.endTime <= duration + 0.5)
      )
      .sort((a, b) => a.startTime - b.startTime)
"""
new_filter = """      .filter((action) =>
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
        const minimum =
          type === 'outcome' || type === 'aftermath' || outcome === 'climax' || outcome === 'aftermath'
            ? 0.82
            : action.positionId || action.positionLabel || type === 'position'
              ? 0.72
              : action.adultScene
                ? 0.64
                : 0.52;
        return Number(action.confidence || 0) >= minimum;
      })
      .sort((a, b) => a.startTime - b.startTime)
"""
server = replace_once(server, old_filter, new_filter, 'server confidence gate')
server = replace_once(
    server,
    "    return res.json({\n      available: true,\n      videoDuration: resolvedDuration,",
    "    return res.json({\n      available: true,\n      schemaVersion: ANALYSIS_SCHEMA_VERSION,\n      engineVersion: ANALYSIS_ENGINE_VERSION,\n      reviewPass: reviewMode ? 'visual-second-pass' : 'first-pass',\n      videoDuration: resolvedDuration,",
    'server response versions'
)
server = replace_once(
    server,
    "      playStartTime: introEndTime,\n      videoPrompt: String(parsed.videoPrompt || ''),",
    "      playStartTime: introEndTime,\n      protagonistProfile: String(parsed.protagonistProfile || protagonistProfile || ''),\n      videoPrompt: String(parsed.videoPrompt || ''),",
    'server protagonist response'
)
server_path.write_text(server)

print('Engine Hardening v1 patch applied.')
