from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Missing patch anchor: {label}")
    return text.replace(old, new, 1)


def replace_between(text: str, start_marker: str, end_marker: str, new_block: str, label: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Missing start marker for {label}: {start_marker}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"Missing end marker for {label}: {end_marker}")
    return text[:start] + new_block.rstrip() + "\n\n" + text[end:]


app_path = Path("public/app.js")
app = app_path.read_text()

app = replace_once(
    app,
    "const $ = (id) => document.getElementById(id);",
    """import {
  averageAdultProgress,
  computeAdultSelectionDelta,
  isOutcomeUnlocked,
  normalizeOutcomeUnlockProgress,
  pickNextVariant
} from './adult-gameplay.js';

const $ = (id) => document.getElementById(id);""",
    "app imports",
)

app = replace_once(
    app,
    """  adultSeekRequestId: 0,
  adultSelectionToken: 0,
  lastAdultFrameNow: null,""",
    """  adultSeekRequestId: 0,
  adultSelectionToken: 0,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultComboCount: 0,
  adultOutcomePhase: 'idle',
  activeAdultOutcomeId: null,
  adultUnlockedOutcomeIds: new Set(),
  lastAdultFrameNow: null,""",
    "adult gameplay state",
)

app = replace_once(
    app,
    """  femaleProgressText: $('femaleProgressText'),
  femaleProgressBar: $('femaleProgressBar'),
  finishAdultSceneBtn: $('finishAdultSceneBtn'),""",
    """  femaleProgressText: $('femaleProgressText'),
  femaleProgressBar: $('femaleProgressBar'),
  adultFlowStatus: $('adultFlowStatus'),
  nextVariantBtn: $('nextVariantBtn'),
  outcomeSection: $('outcomeSection'),
  outcomeCount: $('outcomeCount'),
  outcomeChoices: $('outcomeChoices'),
  finishAdultSceneBtn: $('finishAdultSceneBtn'),""",
    "adult gameplay elements",
)

app = replace_once(
    app,
    """      maleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.maleProgressRate) || 1)),
      femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.femaleProgressRate) || 1)),
    }))""",
    """      maleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.maleProgressRate) || 1)),
      femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(a.femaleProgressRate) || 1)),
      outcomeType: ['climax', 'aftermath'].includes(String(a.outcomeType || '').toLowerCase())
        ? String(a.outcomeType).toLowerCase()
        : 'none',
      outcomeLabel: String(a.outcomeLabel || ''),
      outcomeStartTime: Number(a.outcomeStartTime ?? a.startTime),
      outcomeEndTime: Number(a.outcomeEndTime ?? a.endTime),
      outcomeUnlockProgress: normalizeOutcomeUnlockProgress(a.outcomeUnlockProgress),
    }))""",
    "normalized outcome fields",
)

app = replace_once(
    app,
    """  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  prepareAdultScenes();""",
    """  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  prepareAdultScenes();""",
    "initialize adult gameplay state",
)

prepare_block = r'''function prepareAdultScenes() {
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
    if (!hasPositionEvidence) return;

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
    .filter(scene => scene.positions.length)
    .sort((a, b) => a.startTime - b.startTime);

  state.adultScenes.forEach(scene => {
    const totals = new Map();
    const indexes = new Map();

    scene.positions.forEach(position => {
      const key = `${position.categoryId}:${position.familyId}`;
      totals.set(key, (totals.get(key) || 0) + 1);
    });

    scene.positions.forEach(position => {
      const key = `${position.categoryId}:${position.familyId}`;
      if ((totals.get(key) || 0) <= 1) return;

      const occurrenceNumber = (indexes.get(key) || 0) + 1;
      indexes.set(key, occurrenceNumber);
      const baseLabel = String(position.label || 'Pozisyon')
        .replace(/\s+·\s+\d+$/u, '')
        .replace(/\s+Pozisyon(?:u)?$/iu, '');
      position.label = `${baseLabel} · ${occurrenceNumber}`;
    });
  });
}'''

app = replace_between(
    app,
    "function prepareAdultScenes() {",
    "function findAdultSceneAt(time) {",
    prepare_block,
    "prepareAdultScenes",
)

progress_panel_block = r'''function refreshAdultOutcomeLocks() {
  const scene = state.adultScene;
  const buttons = els.outcomeChoices?.querySelectorAll('[data-outcome-id]') || [];
  let unlockedCount = 0;

  buttons.forEach(button => {
    const outcome = scene?.outcomes?.find(item => item.id === button.dataset.outcomeId);
    if (!outcome) return;
    const unlocked = isOutcomeUnlocked(
      outcome,
      state.maleSceneProgress,
      state.femaleSceneProgress
    );
    button.disabled = !unlocked;
    button.classList.toggle('locked', !unlocked);
    if (unlocked) {
      unlockedCount += 1;
      state.adultUnlockedOutcomeIds.add(outcome.id);
    }
    const status = button.querySelector('[data-outcome-status]');
    if (status) {
      status.textContent = unlocked
        ? 'Açık · gerçek video segmenti'
        : `%${Math.round(outcome.unlockProgress)} akışta açılır`;
    }
  });

  if (els.outcomeCount && scene?.outcomes?.length) {
    els.outcomeCount.textContent = `${unlockedCount}/${scene.outcomes.length} açık`;
  }
}

function renderAdultFlowStatus() {
  if (!els.adultFlowStatus) return;
  const flow = averageAdultProgress(
    state.maleSceneProgress,
    state.femaleSceneProgress
  );
  const visited = state.adultVisitedPositionIds.size;
  const played = [...state.adultMovementPlayCounts.values()]
    .filter(count => Number(count) > 0).length;
  els.adultFlowStatus.textContent =
    `Akış %${Math.round(flow)} · ${visited} pozisyon · ${played} varyasyon · combo ${state.adultComboCount}`;
  refreshAdultOutcomeLocks();
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
}

function resetAdultSceneGameplay() {
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.adultUnlockedOutcomeIds = new Set();
}

function renderAdultOutcomes(scene) {
  if (!els.outcomeSection || !els.outcomeChoices) return;
  const outcomes = scene?.outcomes || [];
  els.outcomeChoices.innerHTML = '';
  els.outcomeSection.classList.toggle('hidden', !outcomes.length);

  if (!outcomes.length) {
    if (els.outcomeCount) els.outcomeCount.textContent = '0 final';
    return;
  }

  outcomes.forEach((outcome, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outcome-choice-card locked';
    button.dataset.outcomeId = outcome.id;
    button.innerHTML = `
      <span>${escapeHtml(outcome.label || `Final ${index + 1}`)}</span>
      <small>${adultTimeLabel(outcome.startTime)} – ${adultTimeLabel(outcome.endTime)}</small>
      <small data-outcome-status>%${Math.round(outcome.unlockProgress)} akışta açılır</small>
    `;
    button.addEventListener('click', () => playAdultOutcome(outcome.id));
    els.outcomeChoices.appendChild(button);
  });

  refreshAdultOutcomeLocks();
}

function renderAdultPanel(scene) {
  if (!scene || !scene.positions?.length || !els.adultInteractionPanel) return;

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

  if (previousSceneId !== scene.id) {
    resetAdultSceneGameplay();
    state.activePositionId = null;
    state.activeAdultCategory = null;
    state.activeMovementId = null;
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

  const categories = [...new Map(scene.positions.map(position => [
    position.categoryId,
    {
      id: position.categoryId,
      label: position.categoryLabel
    }
  ])).values()];

  if (els.categoryCount) {
    els.categoryCount.textContent = `${categories.length} kategori`;
  }

  categories.forEach(category => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-tab';
    button.textContent = category.label;
    button.dataset.categoryId = category.id;
    button.addEventListener(
      'click',
      () => selectAdultCategory(category.id, true)
    );
    els.categoryTabs?.appendChild(button);
  });

  renderAdultOutcomes(scene);

  const selectedCategory =
    categories.find(item => item.id === state.activeAdultCategory) ||
    categories[0];

  selectAdultCategory(selectedCategory.id, false);
  renderAdultProgress();
}'''

app = replace_between(
    app,
    "function renderAdultProgress() {",
    "function selectAdultCategory(categoryId, shouldSeek = true) {",
    progress_panel_block,
    "adult progress and panel",
)

selection_block = r'''function applyAdultSelectionProgress(position, movement, { positionChanged = false } = {}) {
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

  const selectionToken = beginAdultSelection();
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

  const effectiveToken = selectionToken ?? beginAdultSelection();
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
  if (!isOutcomeUnlocked(outcome, state.maleSceneProgress, state.femaleSceneProgress)) return;

  const selectionToken = beginAdultSelection();
  state.adultOutcomePhase = 'outcome';
  state.activeAdultOutcomeId = outcome.id;
  state.activeMovementId = null;
  updateVariantButton(null);
  renderAdultFlowStatus();
  els.video.pause();
  seekAdultLoop(outcome.startTime, selectionToken);
  els.video.play().catch(() => {});
}'''

app = replace_between(
    app,
    "function selectAdultPosition(positionId, shouldSeek = true) {",
    "function finishAdultScene() {",
    selection_block,
    "adult selection gameplay",
)

finish_block = r'''function finishAdultScene() {
  const scene = state.adultScene;
  if (!scene) return;
  if (!state.completedAdultSceneIds) state.completedAdultSceneIds = new Set();
  state.completedAdultSceneIds.add(scene.id);
  state.adultSelectionToken += 1;
  cancelAdultSeek();
  state.adultMode = false;
  state.adultScene = null;
  state.activePositionId = null;
  state.activeAdultCategory = null;
  state.activeMovementId = null;
  state.activeAdultOutcomeId = null;
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
  renderChoices();
}'''

app = replace_between(
    app,
    "function finishAdultScene() {",
    "function seekAdultLoop(targetTime, selectionToken = state.adultSelectionToken) {",
    finish_block,
    "finish adult scene",
)

playback_block = r'''function updateAdultPlayback(now, mediaTime) {
  if (!state.adultMode) {
    const scene = findAdultSceneAt(mediaTime);
    if (scene) {
      resetAdultSceneGameplay();
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

  const position = state.adultScene?.positions.find(item => item.id === state.activePositionId);
  const movement = position?.movements.find(item => item.id === state.activeMovementId);
  if (!movement) {
    state.lastAdultFrameNow = now;
    return;
  }

  if (mediaTime >= movement.loopEndTime - 0.04 || mediaTime < movement.loopStartTime - 0.15) {
    seekAdultLoop(movement.loopStartTime, state.adultSelectionToken);
    state.lastAdultFrameNow = now;
    return;
  }

  const elapsed = Math.min(0.25, Math.max(0, (now - (state.lastAdultFrameNow || now)) / 1000));
  state.lastAdultFrameNow = now;
  state.maleSceneProgress = Math.min(
    100,
    state.maleSceneProgress + elapsed * Number(movement.maleProgressRate || 1)
  );
  state.femaleSceneProgress = Math.min(
    100,
    state.femaleSceneProgress + elapsed * Number(movement.femaleProgressRate || 1)
  );
  renderAdultProgress();

  const outcomes = state.adultScene?.outcomes || [];
  if (!outcomes.length && (state.maleSceneProgress >= 100 || state.femaleSceneProgress >= 100)) {
    finishAdultScene();
  }
}'''

app = replace_between(
    app,
    "function updateAdultPlayback(now, mediaTime) {",
    "function adultFrameLoop(now, metadata) {",
    playback_block,
    "adult playback state machine",
)

app = replace_once(
    app,
    """if (els.finishAdultSceneBtn) {
  els.finishAdultSceneBtn.addEventListener("click", finishAdultScene);
}

if (els.video?.requestVideoFrameCallback) {""",
    """if (els.finishAdultSceneBtn) {
  els.finishAdultSceneBtn.addEventListener('click', finishAdultScene);
}

if (els.nextVariantBtn) {
  els.nextVariantBtn.addEventListener('click', playNextAdultVariant);
}

if (els.video?.requestVideoFrameCallback) {""",
    "variant button listener",
)

app_path.write_text(app)

index_path = Path("public/index.html")
index = index_path.read_text()
index = replace_once(
    index,
    """              <div id="movementChoices" class="movement-choice-grid"></div>
            </div>

            <div class="scene-progress-bars">""",
    """              <div id="movementChoices" class="movement-choice-grid"></div>
              <div class="adult-variant-toolbar">
                <button id="nextVariantBtn" class="next-variant-btn hidden" type="button">↻ Sonraki gerçek varyasyon</button>
                <span id="adultFlowStatus" class="adult-flow-status">Akış %0 · 0 pozisyon · 0 varyasyon · combo 0</span>
              </div>
            </div>

            <div id="outcomeSection" class="outcome-section hidden">
              <div class="choice-section-heading">
                <strong>Gerçek final seçenekleri</strong>
                <span id="outcomeCount">0 final</span>
              </div>
              <div id="outcomeChoices" class="outcome-choice-grid"></div>
            </div>

            <div class="scene-progress-bars">""",
    "adult gameplay UI",
)
index_path.write_text(index)

styles_path = Path("public/styles.css")
styles = styles_path.read_text()
marker = "/* VIDEOQUEST ADULT GAMEPLAY V2 */"
if marker not in styles:
    styles += r'''

/* VIDEOQUEST ADULT GAMEPLAY V2 */
.adult-variant-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.next-variant-btn {
  min-height: 42px !important;
  padding: 9px 13px !important;
  border-radius: 13px !important;
}

.adult-flow-status {
  color: rgba(236, 255, 249, .72);
  font-size: 11px;
  font-weight: 750;
}

.outcome-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, .08);
}

.outcome-choice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
}

.outcome-choice-card {
  min-height: 76px !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  justify-content: center !important;
  gap: 4px !important;
  padding: 12px 14px !important;
  text-align: left !important;
  border-radius: 15px !important;
}

.outcome-choice-card span {
  color: #06150f;
  font-weight: 900;
}

.outcome-choice-card small {
  color: rgba(3, 19, 14, .68);
  font-size: 10px;
}

.outcome-choice-card.locked,
.outcome-choice-card:disabled {
  cursor: not-allowed;
  opacity: .48;
  filter: saturate(.45);
}

.outcome-choice-card.locked span,
.outcome-choice-card:disabled span {
  color: rgba(255, 255, 255, .78);
}

.outcome-choice-card.locked small,
.outcome-choice-card:disabled small {
  color: rgba(255, 255, 255, .48);
}

@media (max-width: 600px) {
  .adult-variant-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .next-variant-btn {
    width: 100%;
  }

  .outcome-choice-grid {
    grid-template-columns: 1fr;
  }
}
'''
styles_path.write_text(styles)

server_path = Path("server.js")
server = server_path.read_text()
server = replace_once(
    server,
    '"actionType": "position|tempo_change|kiss|touch|clothing|body_transition|camera_transition|other",',
    '"actionType": "position|tempo_change|kiss|touch|clothing|body_transition|camera_transition|outcome|aftermath|other",',
    "server action type schema",
)
server = replace_once(
    server,
    """      "maleProgressRate": 1,
      "femaleProgressRate": 1,
      "cameraMode": "third_person|male_pov|mixed|uncertain",""",
    """      "maleProgressRate": 1,
      "femaleProgressRate": 1,
      "outcomeType": "none|climax|aftermath",
      "outcomeLabel": "",
      "outcomeStartTime": 0,
      "outcomeEndTime": 0,
      "outcomeUnlockProgress": 82,
      "cameraMode": "third_person|male_pov|mixed|uncertain",""",
    "server outcome schema",
)
server = replace_once(
    server,
    """- maleProgressRate and femaleProgressRate are game pacing weights from 0.25 to 2.5 based on visible motion intensity and duration.
- Never invent any position, movement, transition, outcome or label absent from the source frames.""",
    """- maleProgressRate and femaleProgressRate are game pacing weights from 0.25 to 2.5 based on visible motion intensity and duration.
- When the source visibly contains a real climax/final segment inside the adult scene, emit it as actionType \"outcome\", outcomeType \"climax\", with exact outcomeStartTime/outcomeEndTime and a short outcomeLabel. Do not assign positionId to an outcome.
- When the source visibly contains a distinct post-final continuation inside the same adult scene, emit it as actionType \"aftermath\", outcomeType \"aftermath\", with exact outcomeStartTime/outcomeEndTime. Do not convert aftermath into a position or movement loop.
- outcomeUnlockProgress is a gameplay hint only; use 82 by default and never use it to invent or extend footage. If no verified outcome or aftermath exists, keep outcomeType \"none\" and do not fabricate one.
- Outcome and aftermath boundaries must be directly source-verified and must never overlap a selectable movement loop.
- Never invent any position, movement, transition, outcome or label absent from the source frames.""",
    "server outcome rules",
)
server = replace_once(
    server,
    """          maleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.maleProgressRate) || 1)),
          femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.femaleProgressRate) || 1)),
        cameraMode:""",
    """          maleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.maleProgressRate) || 1)),
          femaleProgressRate: Math.min(2.5, Math.max(0.25, Number(action.femaleProgressRate) || 1)),
          outcomeType: ['climax', 'aftermath'].includes(String(action.outcomeType || '').toLowerCase())
            ? String(action.outcomeType).toLowerCase()
            : 'none',
          outcomeLabel: String(action.outcomeLabel || ''),
          outcomeStartTime: Number(action.outcomeStartTime ?? action.startTime),
          outcomeEndTime: Number(action.outcomeEndTime ?? action.endTime),
          outcomeUnlockProgress: Math.min(100, Math.max(60, Number(action.outcomeUnlockProgress) || 82)),
        cameraMode:""",
    "server outcome normalization",
)
server_path.write_text(server)

print("Adult gameplay v2 patch applied")
