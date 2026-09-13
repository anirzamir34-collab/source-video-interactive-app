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
    """import {
  averageAdultProgress,
  computeAdultSelectionDelta,
  isOutcomeUnlocked,
  normalizeOutcomeUnlockProgress,
  pickNextVariant
} from './adult-gameplay.js';""",
    """import {
  adultDiscoveryPhase,
  averageAdultProgress,
  computeAdultSelectionDelta,
  computeWarmupSelectionDelta,
  isOutcomeUnlocked,
  normalizeOutcomeUnlockProgress,
  pickNextVariant,
  positionUnlockProgress
} from './adult-gameplay.js';""",
    "gameplay imports",
)

app = replace_once(
    app,
    """  adultSelectionToken: 0,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultComboCount: 0,
  adultOutcomePhase: 'idle',
  activeAdultOutcomeId: null,
  adultUnlockedOutcomeIds: new Set(),
  lastAdultFrameNow: null,""",
    """  adultSelectionToken: 0,
  adultVisitedPositionIds: new Set(),
  adultMovementPlayCounts: new Map(),
  adultPreludePlayCounts: new Map(),
  adultComboCount: 0,
  adultOutcomePhase: 'idle',
  activeAdultOutcomeId: null,
  activeAdultPreludeId: null,
  adultUnlockedOutcomeIds: new Set(),
  adultRevealedPositionIds: new Set(),
  adultUiSignature: '',
  adultLastUiPhase: 'foreplay',
  lastAdultFrameNow: null,""",
    "progressive adult state",
)

app = replace_once(
    app,
    """  adultSceneTitle: $('adultSceneTitle'),
  adultSceneTime: $('adultSceneTime'),
  positionCount: $('positionCount'),
  categoryCount: $('categoryCount'),
  categoryTabs: $('categoryTabs'),
  positionTabs: $('positionTabs'),
  movementHeading: $('movementHeading'),
  movementCount: $('movementCount'),
  movementChoices: $('movementChoices'),""",
    """  adultSceneTitle: $('adultSceneTitle'),
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
  movementChoices: $('movementChoices'),""",
    "progressive adult elements",
)

app = replace_once(
    app,
    """  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  prepareAdultScenes();""",
    """  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  state.adultRevealedPositionIds = new Set();
  state.adultUiSignature = '';
  state.adultLastUiPhase = 'foreplay';
  prepareAdultScenes();""",
    "initialize progressive adult state",
)

prepare_block = r'''function isWarmupPosition(position) {
  return ['oral', 'manual'].includes(String(position?.categoryId || '')) ||
    ['oral', 'manual'].includes(String(position?.familyId || ''));
}

function isBonusPosition(position) {
  const category = String(position?.categoryId || '');
  return category === 'anal' || category === 'other';
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
}'''

app = replace_between(
    app,
    "function prepareAdultScenes() {",
    "function findAdultSceneAt(time) {",
    prepare_block,
    "prepareAdultScenes",
)

progressive_block = r'''function currentAdultFlow() {
  return averageAdultProgress(
    state.maleSceneProgress,
    state.femaleSceneProgress
  );
}

function unlockedAdultPositions(scene = state.adultScene) {
  const flow = currentAdultFlow();
  return (scene?.positions || []).filter(
    position => flow + 0.001 >= Number(position.unlockProgress || 0)
  );
}

function unlockedAdultOutcomes(scene = state.adultScene) {
  return (scene?.outcomes || []).filter(outcome =>
    isOutcomeUnlocked(
      outcome,
      state.maleSceneProgress,
      state.femaleSceneProgress
    )
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
    .filter(outcome => Number(outcome.unlockProgress || 82) > flow + 0.001)
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
    `Lust %${Math.round(flow)} · combo ${state.adultComboCount}`;
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
  renderAdultProgressiveUI(false);
}

function resetAdultSceneGameplay() {
  state.maleSceneProgress = 0;
  state.femaleSceneProgress = 0;
  state.adultVisitedPositionIds = new Set();
  state.adultMovementPlayCounts = new Map();
  state.adultPreludePlayCounts = new Map();
  state.adultComboCount = 0;
  state.adultOutcomePhase = 'idle';
  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultUnlockedOutcomeIds = new Set();
  state.adultRevealedPositionIds = new Set();
  state.adultUiSignature = '';
  state.adultLastUiPhase = 'foreplay';
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
    .slice(0, 4);

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
  const phase = adultDiscoveryPhase({
    flow,
    hasCoreUnlocked: unlockedCore.some(position => !isBonusPosition(position)),
    hasBonusUnlocked: unlockedBonus.length > 0,
    hasOutcomeUnlocked: outcomes.length > 0
  });

  const signature = [
    phase,
    Math.floor(flow),
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
  if (els.discoveryGate) {
    const hideGate = phase === 'final' || !next;
    els.discoveryGate.classList.toggle('hidden', hideGate);
    if (!hideGate) {
      if (els.discoveryGateText) {
        els.discoveryGateText.textContent = next.type === 'outcome'
          ? 'Sahnenin son aşaması hâlâ gizli'
          : 'Yeni bir seçenek yaklaşıyor';
      }
      if (els.discoveryGateMeta) {
        const remaining = Math.max(0, Math.ceil(next.progress - flow));
        els.discoveryGateMeta.textContent =
          `%${Math.round(next.progress)} Lust seviyesinde açılır · ${remaining} puan kaldı`;
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
}'''

app = replace_between(
    app,
    "function refreshAdultOutcomeLocks() {",
    "function cancelAdultSeek() {",
    progressive_block,
    "progressive adult rendering",
)

app = replace_once(
    app,
    """function applyAdultSelectionProgress(position, movement, { positionChanged = false } = {}) {
  if (!position) return;""",
    """function applyAdultPreludeProgress(item) {
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
  if (!position) return;""",
    "prelude gameplay",
)

app = replace_once(
    app,
    """function selectAdultPosition(positionId, shouldSeek = true) {
  const scene = state.adultScene;
  const position = scene?.positions.find(item => item.id === positionId);
  if (!position || state.adultOutcomePhase !== 'idle') return;

  const selectionToken = beginAdultSelection();""",
    """function selectAdultPosition(positionId, shouldSeek = true) {
  const scene = state.adultScene;
  const position = scene?.positions.find(item => item.id === positionId);
  if (
    !position ||
    state.adultOutcomePhase !== 'idle' ||
    currentAdultFlow() + 0.001 < Number(position.unlockProgress || 0)
  ) return;

  const selectionToken = beginAdultSelection();
  state.activeAdultPreludeId = null;""",
    "position unlock enforcement",
)

app = replace_once(
    app,
    """  const effectiveToken = selectionToken ?? beginAdultSelection();
  state.activeMovementId = movement.id;""",
    """  const effectiveToken = selectionToken ?? beginAdultSelection();
  state.activeAdultPreludeId = null;
  state.activeMovementId = movement.id;""",
    "movement clears prelude",
)

app = replace_once(
    app,
    """  state.adultOutcomePhase = 'outcome';
  state.activeAdultOutcomeId = outcome.id;
  state.activeMovementId = null;""",
    """  state.adultOutcomePhase = 'outcome';
  state.activeAdultOutcomeId = outcome.id;
  state.activeAdultPreludeId = null;
  state.activeMovementId = null;""",
    "outcome clears prelude",
)

app = replace_once(
    app,
    """  state.activeAdultOutcomeId = null;
  state.adultOutcomePhase = 'idle';
  state.lastAdultMediaTime = null;""",
    """  state.activeAdultOutcomeId = null;
  state.activeAdultPreludeId = null;
  state.adultOutcomePhase = 'idle';
  state.lastAdultMediaTime = null;""",
    "finish clears prelude",
)

old_playback = r'''function updateAdultPlayback(now, mediaTime) {
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

new_playback = r'''function updateAdultPlayback(now, mediaTime) {
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
  renderAdultProgress();

  const outcomes = state.adultScene?.outcomes || [];
  if (!outcomes.length && (state.maleSceneProgress >= 100 || state.femaleSceneProgress >= 100)) {
    finishAdultScene();
  }
}'''

app = replace_once(app, old_playback, new_playback, "progressive adult playback")

app_path.write_text(app)

styles_path = Path("public/styles.css")
styles = styles_path.read_text()
progressive_css = r'''

/* VIDEOQUEST PROGRESSIVE DISCOVERY UI V3 */
.adult-interaction-panel {
  --adult-panel-bg: rgba(7, 13, 23, .985);
  --adult-card-bg: rgba(10, 17, 29, .96);
  --adult-card-line: rgba(255, 255, 255, .10);
  --adult-accent: #35e0b2;
}

.adult-stage-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin: 4px 0 14px;
  padding: 13px 14px;
  border: 1px solid rgba(53, 224, 178, .14);
  border-radius: 17px;
  background: linear-gradient(135deg, rgba(53, 224, 178, .08), rgba(8, 14, 24, .78));
}

.adult-phase-copy {
  min-width: 0;
}

.adult-phase-badge {
  display: inline-flex;
  margin-bottom: 6px;
  padding: 4px 8px;
  border: 1px solid rgba(53, 224, 178, .28);
  border-radius: 999px;
  color: #77f4d2;
  background: rgba(53, 224, 178, .08);
  font-size: .58rem;
  font-weight: 900;
  letter-spacing: .12em;
}

.adult-phase-copy strong,
.adult-phase-copy small {
  display: block;
}

.adult-phase-copy strong {
  color: #f7fbff;
  font-size: .98rem;
}

.adult-phase-copy small {
  margin-top: 4px;
  color: #8f9cae;
  font-size: .68rem;
  line-height: 1.4;
}

.adult-flow-status {
  flex: 0 0 auto;
  padding: 7px 9px;
  border-radius: 999px;
  color: #d7fff3 !important;
  background: rgba(53, 224, 178, .09);
  font-size: .64rem !important;
  white-space: nowrap;
}

.adult-lust-bars {
  display: grid;
  gap: 10px;
  margin: 0 0 13px;
  padding: 12px 13px;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 16px;
  background: rgba(0, 0, 0, .16);
}

.adult-discovery-gate {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0 0 14px;
  padding: 11px 12px;
  border: 1px dashed rgba(255, 255, 255, .14);
  border-radius: 15px;
  background: rgba(255, 255, 255, .025);
}

.adult-discovery-gate.hidden {
  display: none !important;
}

.adult-discovery-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: #7b8797;
  background: rgba(255, 255, 255, .055);
  font-size: 1rem;
}

.adult-discovery-gate strong,
.adult-discovery-gate small {
  display: block;
}

.adult-discovery-gate strong {
  color: #dbe4ee;
  font-size: .76rem;
}

.adult-discovery-gate small {
  margin-top: 2px;
  color: #7e8b9c;
  font-size: .64rem;
}

.progressive-stage-section,
.position-section,
.movement-section,
.outcome-section {
  animation: adultStageIn .26s ease both;
}

.discovery-choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.discovery-choice-card,
.adult-interaction-panel .movement-choice-card,
.adult-interaction-panel .position-tab,
.adult-interaction-panel .category-tab {
  border: 1px solid var(--adult-card-line) !important;
  color: #edf4fb !important;
  background: var(--adult-card-bg) !important;
  box-shadow: none !important;
}

.discovery-choice-card {
  min-height: 68px !important;
  padding: 11px 12px !important;
  border-radius: 15px !important;
  text-align: left !important;
}

.discovery-choice-card span,
.discovery-choice-card small {
  display: block;
}

.discovery-choice-card span {
  color: #f6fbff !important;
  font-size: .78rem;
  font-weight: 850;
  line-height: 1.25;
}

.discovery-choice-card small {
  margin-top: 5px;
  color: #7f8c9d !important;
  font-size: .62rem;
}

.discovery-choice-card.active,
.adult-interaction-panel .movement-choice-card.active,
.adult-interaction-panel .position-tab.active,
.adult-interaction-panel .category-tab.active {
  border-color: rgba(53, 224, 178, .62) !important;
  background: linear-gradient(135deg, rgba(53, 224, 178, .14), rgba(10, 24, 28, .94)) !important;
  color: #effff9 !important;
  box-shadow: 0 0 0 1px rgba(53, 224, 178, .08) !important;
}

.adult-interaction-panel .movement-choice-card span,
.adult-interaction-panel .movement-choice-card strong {
  color: #f4f8fc !important;
  opacity: 1 !important;
}

.adult-interaction-panel .movement-choice-card small {
  color: #7eeacb !important;
  opacity: 1 !important;
}

.adult-variant-toolbar {
  margin-top: 9px !important;
}

.next-variant-btn {
  border: 1px solid rgba(53, 224, 178, .32) !important;
  color: #bffff0 !important;
  background: rgba(53, 224, 178, .08) !important;
  box-shadow: none !important;
}

.outcome-section {
  margin-top: 6px !important;
  padding: 0 !important;
  border: 0 !important;
}

.outcome-choice-card {
  border: 1px solid rgba(53, 224, 178, .55) !important;
  color: #03130e !important;
  background: linear-gradient(135deg, #35e0b2, #76f1d2) !important;
  box-shadow: 0 12px 28px rgba(53, 224, 178, .14) !important;
}

.finish-adult-scene-btn {
  min-height: 34px !important;
  margin-top: 14px !important;
  padding: 6px 10px !important;
  border: 0 !important;
  color: #748294 !important;
  background: transparent !important;
  box-shadow: none !important;
  font-size: .66rem !important;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.adult-interaction-panel[data-phase="final"] .adult-stage-summary {
  border-color: rgba(53, 224, 178, .42);
  background: linear-gradient(135deg, rgba(53, 224, 178, .18), rgba(8, 26, 25, .92));
}

.unlock-reveal {
  animation: adultUnlockReveal .42s cubic-bezier(.2, .9, .25, 1.25) both;
}

@keyframes adultStageIn {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes adultUnlockReveal {
  0% { opacity: 0; transform: translateY(9px) scale(.96); }
  70% { opacity: 1; transform: translateY(-2px) scale(1.01); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 600px) {
  .adult-interaction-panel {
    padding: 13px !important;
  }

  .adult-stage-summary {
    flex-direction: column;
    gap: 8px;
  }

  .adult-flow-status {
    align-self: flex-start;
  }

  .discovery-choice-grid {
    grid-template-columns: 1fr;
  }

  .adult-interaction-panel .movement-choice-grid {
    grid-template-columns: 1fr !important;
  }

  .adult-interaction-panel .movement-choice-card,
  .discovery-choice-card {
    min-height: 58px !important;
  }
}
'''

if "/* VIDEOQUEST PROGRESSIVE DISCOVERY UI V3 */" not in styles:
    styles += progressive_css
styles_path.write_text(styles)
