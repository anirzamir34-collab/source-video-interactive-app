const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const ANALYSIS_SCHEMA_VERSION = 5;
export const ENGINE_VERSION = 'videoquest-story-v1';
export const SAVE_VERSION = 8;

export const ADULT_PHASE_ORDER = Object.freeze({
  foreplay: 0,
  positions: 1,
  reward: 2,
  final: 3,
  outcome: 4,
  aftermath: 5,
  complete: 6
});

export const MIN_CONFIDENCE = Object.freeze({
  generic: 0.52,
  adult: 0.64,
  position: 0.72,
  outcome: 0.82
});

function numberOr(value, fallback = 0) {
  const resolved = Number(value);
  return Number.isFinite(resolved) ? resolved : fallback;
}

export function normalizeChunkActionTimes(actions = [], chunkStart = 0, chunkEnd = 0) {
  const source = Array.isArray(actions) ? actions : [];
  const start = Math.max(0, numberOr(chunkStart));
  const end = Math.max(start, numberOr(chunkEnd, start));
  const duration = Math.max(0, end - start);
  if (!source.length || start < 1 || duration <= 0) {
    return { actions: source, rebased: false };
  }

  const starts = source.map(action => numberOr(action?.startTime, NaN))
    .filter(Number.isFinite);
  const absoluteCount = starts.filter(value => value >= start - 1 && value <= end + 1).length;
  const relativeCount = starts.filter(value => value >= -1 && value <= duration + 1).length;
  const clearlyBeforeChunk = starts.filter(value => value < start - 1).length;
  const rebased = relativeCount > absoluteCount &&
    clearlyBeforeChunk >= Math.ceil(starts.length * 0.6);

  if (!rebased) return { actions: source, rebased: false };

  const offset = value => Number.isFinite(Number(value)) ? Number(value) + start : value;
  return {
    rebased: true,
    actions: source.map(action => {
      const next = {
        ...action,
        startTime: offset(action.startTime),
        endTime: offset(action.endTime),
        chunkTimeRebased: true
      };
      if (action.adultScene === true) {
        next.adultSceneStartTime = offset(action.adultSceneStartTime);
        next.adultSceneEndTime = offset(action.adultSceneEndTime);
        next.postSceneTime = offset(action.postSceneTime);
      }
      if (action.positionId || action.positionLabel || action.actionType === 'position') {
        next.positionStartTime = offset(action.positionStartTime);
        next.positionEndTime = offset(action.positionEndTime);
        next.loopStartTime = offset(action.loopStartTime);
        next.loopEndTime = offset(action.loopEndTime);
      }
      const outcome = String(action.outcomeType || '').toLowerCase();
      if (['outcome', 'aftermath'].includes(String(action.actionType || '').toLowerCase()) ||
          ['climax', 'aftermath'].includes(outcome)) {
        next.outcomeStartTime = offset(action.outcomeStartTime);
        next.outcomeEndTime = offset(action.outcomeEndTime);
      }
      return next;
    })
  };
}

function normalizedText(value) {
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

export function analysisFingerprint(analysis = {}) {
  const actions = Array.isArray(analysis.actions) ? analysis.actions : [];
  const seed = [
    Number(analysis.videoDuration || 0).toFixed(3),
    actions.length,
    actions.slice(0, 8).map(action => `${action.actionId}:${Number(action.startTime || 0).toFixed(2)}`).join('|'),
    actions.slice(-8).map(action => `${action.actionId}:${Number(action.endTime || 0).toFixed(2)}`).join('|')
  ].join('::');

  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `vq-${(hash >>> 0).toString(16)}-${actions.length}`;
}

export function minimumConfidenceForAction(action = {}) {
  const type = String(action.actionType || '').toLowerCase();
  const outcome = String(action.outcomeType || '').toLowerCase();
  if (type === 'outcome' || type === 'aftermath' || outcome === 'climax' || outcome === 'aftermath') {
    return MIN_CONFIDENCE.outcome;
  }
  if (action.positionId || action.positionLabel || type === 'position') return MIN_CONFIDENCE.position;
  if (action.adultScene) return MIN_CONFIDENCE.adult;
  return MIN_CONFIDENCE.generic;
}

export function actionConfidence(action = {}) {
  const raw = Number(action.confidence);
  if (Number.isFinite(raw)) return clamp(raw, 0, 1);
  // Backward-compatible legacy analyses are reviewed structurally instead of being discarded.
  return minimumConfidenceForAction(action);
}

export function validateActionInterval(action = {}, videoDuration = 0) {
  const start = numberOr(action.startTime, NaN);
  const end = numberOr(action.endTime, NaN);
  const duration = Math.max(0, numberOr(videoDuration));
  const reasons = [];

  if (!Number.isFinite(start) || !Number.isFinite(end)) reasons.push('NON_FINITE_TIME');
  if (Number.isFinite(start) && start < 0) reasons.push('NEGATIVE_START');
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) reasons.push('NON_POSITIVE_DURATION');
  if (duration && Number.isFinite(end) && end > duration + 0.5) reasons.push('OUTSIDE_VIDEO');

  if (action.positionId || action.positionLabel || action.actionType === 'position') {
    const positionStart = numberOr(action.positionStartTime, start);
    const positionEnd = numberOr(action.positionEndTime, end);
    if (positionEnd <= positionStart) reasons.push('INVALID_POSITION_RANGE');
    const loopStart = numberOr(action.loopStartTime, start);
    const loopEnd = numberOr(action.loopEndTime, end);
    if (loopEnd <= loopStart) reasons.push('INVALID_LOOP_RANGE');
    if (loopStart < positionStart - 0.05 || loopEnd > positionEnd + 0.05) reasons.push('LOOP_OUTSIDE_POSITION');
  }

  if (['outcome', 'aftermath'].includes(String(action.actionType || '').toLowerCase()) ||
      ['climax', 'aftermath'].includes(String(action.outcomeType || '').toLowerCase())) {
    const outcomeStart = numberOr(action.outcomeStartTime, start);
    const outcomeEnd = numberOr(action.outcomeEndTime, end);
    if (outcomeEnd <= outcomeStart) reasons.push('INVALID_OUTCOME_RANGE');
  }

  return { valid: reasons.length === 0, reasons, start, end };
}

function semanticPositionFamily(action = {}) {
  const text = normalizedText(`${action.positionId || ''} ${action.positionLabel || ''} ${action.label || ''}`);
  if (/\b(reverse cowgirl|reverse rider|ters kovboy|ters cowgirl|ters rider|ters kucak(?:ta)?|arkasi donuk kovboy|sirtini donerek ustte)\b/.test(text)) return 'reverse-cowgirl';
  if (/\b(lap dance|kucakta|kucaginda|lotus|yuz yuze oturarak|seated face to face)\b/.test(text)) return 'seated-facing';
  if (/\b(prone[\s-]?bone|pronebone|flat[\s-]?doggy|yuzustu\s+arkadan|yuzukoyun\s+arkadan)\b/.test(text)) return 'prone-bone';
  if (/\b(piledriver|omuzda|bacak(?:lar)? (?:yukari(?:da)?|havada)|legs[\s-]+up)\b/.test(text)) return 'legs-up';
  if (/\b(misyoner|missionary)\b/.test(text)) return 'missionary';
  if (/\b(kovboy|cowgirl|rider|kadin ustte)\b/.test(text)) return 'cowgirl';
  if (/\b(arkadan|doggy|dort ayak)\b/.test(text) && /\b(ayakta|standing)\b/.test(text)) return 'standing-rear';
  if (/\b(arka|arkadan|doggy|dort ayak)\b/.test(text)) return 'rear';
  if (/\b(ters kasik|reverse spoon)\b/.test(text)) return 'reverse-spoon';
  if (/\b(kasik|spoon|yan yatarak|side lying|yan pozisyon)\b/.test(text)) return 'spoon';
  if (/\b(oral|sakso|blowjob|agiz)\b/.test(text)) return 'oral';
  if (/\b(manual|manuel|handjob|elle)\b/.test(text)) return 'manual';
  if (/\b(oturarak|seated|chair|sandalye|koltukta)\b/.test(text)) return 'seated';
  if (/\b(ayakta|standing)\b/.test(text)) return 'standing';
  return String(action.positionId || '').trim().toLowerCase();
}

function overlapSeconds(a, b) {
  return Math.max(0, Math.min(numberOr(a.endTime), numberOr(b.endTime)) - Math.max(numberOr(a.startTime), numberOr(b.startTime)));
}

function chooseHigherConfidence(a, b) {
  const ca = actionConfidence(a);
  const cb = actionConfidence(b);
  if (ca !== cb) return ca > cb ? a : b;
  const da = numberOr(a.endTime) - numberOr(a.startTime);
  const db = numberOr(b.endTime) - numberOr(b.startTime);
  return da >= db ? a : b;
}

export const SECOND_PASS_POSITION_CONFIDENCE = 0.84;
export const SECOND_PASS_ACTIVITY_CONFIDENCE = 0.90;

function isOutcomeCritical(action = {}) {
  const type = String(action.actionType || '').toLowerCase();
  const outcome = String(action.outcomeType || '').toLowerCase();
  return type === 'outcome' || outcome === 'climax';
}

function isCorePositionCritical(action = {}) {
  const hasPosition = Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position');
  if (!hasPosition) return false;
  const family = semanticPositionFamily(action);
  return Boolean(family && !['oral', 'manual'].includes(family));
}

export function normalizedActivityType(action = {}) {
  const value = String(action.activityType || '').trim().toLowerCase();
  return ['oral', 'manual', 'vaginal', 'anal', 'other'].includes(value) ? value : 'other';
}

export function verifiedActivityRoute(action = {}) {
  const route = normalizedActivityType(action);
  if (['oral', 'manual'].includes(route)) return route;
  if (!['vaginal', 'anal'].includes(route)) return 'other';
  const confidence = Number(action.activityTypeConfidence);
  const evidence = String(action.activityEvidence || '').trim();
  return Number.isFinite(confidence) && confidence >= SECOND_PASS_ACTIVITY_CONFIDENCE && evidence
    ? route
    : 'other';
}

export function activityOccurrenceNamespace(action = {}) {
  return verifiedActivityRoute(action);
}

export function activityDisplayLabel(baseLabel, action = {}) {
  const base = String(baseLabel || 'Pozisyon').trim() || 'Pozisyon';
  const route = verifiedActivityRoute(action);
  if (route === 'vaginal') return `${base} · Vajinal`;
  if (route === 'anal') return `${base} · Anal`;
  return base;
}

function isPenetrativeActivity(action = {}) {
  return ['vaginal', 'anal'].includes(normalizedActivityType(action));
}

function activityTypeConfidence(action = {}) {
  const raw = Number(action.activityTypeConfidence);
  return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
}

function activityTypeEvidence(action = {}) {
  return String(action.activityEvidence || '').trim();
}

export function secondPassReviewCandidates(result = {}) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  if (!actions.length) return [];

  const selected = new Set();

  // Final/outcome mistakes are expensive in gameplay, so they always receive
  // one visual verification pass. Ordinary foreplay and generic actions do not.
  actions.forEach(action => {
    if (action?.groupScene === true || action?.partnerSwitch === true ||
      String(action?.actionType || '').toLowerCase() === 'partner_transition') {
      selected.add(action);
      return;
    }
    if (isOutcomeCritical(action)) {
      selected.add(action);
      return;
    }
    if (isCorePositionCritical(action) && isPenetrativeActivity(action)) {
      // Route classification is gameplay-critical. Re-check every explicit
      // vaginal/anal claim once, even when first-pass confidence is high.
      // Candidates are batched per storyboard chunk, so this does not double
      // every adult-analysis request.
      selected.add(action);
      return;
    }
    if (isCorePositionCritical(action) && actionConfidence(action) < SECOND_PASS_POSITION_CONFIDENCE) {
      selected.add(action);
    }
  });

  // Even high-confidence position labels are rechecked when two incompatible
  // canonical positions claim the same source-video interval.
  const positions = actions
    .filter(action => Boolean(action.positionId || action.positionLabel || String(action.actionType || '').toLowerCase() === 'position'))
    .sort((a, b) => numberOr(a.startTime) - numberOr(b.startTime));

  for (let left = 0; left < positions.length; left += 1) {
    const a = positions[left];
    for (let right = left + 1; right < positions.length; right += 1) {
      const b = positions[right];
      if (numberOr(b.startTime) >= numberOr(a.endTime)) break;
      if (String(a.adultSceneId || '') !== String(b.adultSceneId || '')) continue;
      const familyA = semanticPositionFamily(a);
      const familyB = semanticPositionFamily(b);
      if (!familyA || !familyB) continue;
      const overlap = overlapSeconds(a, b);
      if (overlap < 1.5) continue;
      const activityA = normalizedActivityType(a);
      const activityB = normalizedActivityType(b);
      const routeConflict = familyA === familyB &&
        ['vaginal', 'anal'].includes(activityA) &&
        ['vaginal', 'anal'].includes(activityB) &&
        activityA !== activityB;
      if (familyA !== familyB || routeConflict) {
        selected.add(a);
        selected.add(b);
      }
    }
  }

  return actions.filter(action => selected.has(action));
}

export function shouldSecondPassReview(result = {}) {
  return secondPassReviewCandidates(result).length > 0;
}

export function mergeSecondPassReview(firstPass = {}, reviewPass = {}, candidates = []) {
  const firstActions = Array.isArray(firstPass.actions) ? firstPass.actions : [];
  const reviewedActions = Array.isArray(reviewPass.actions) ? reviewPass.actions : [];
  const candidateIds = new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map(action => String(action?.actionId || ''))
      .filter(Boolean)
  );

  const untouched = firstActions.filter(action => !candidateIds.has(String(action?.actionId || '')));
  // A second pass may verify, correct, or omit only the supplied candidates.
  // It is never allowed to invent a brand-new action id.
  const verified = reviewedActions.filter(action => candidateIds.has(String(action?.actionId || '')));
  const actions = [...untouched, ...verified]
    .sort((a, b) => numberOr(a.startTime) - numberOr(b.startTime));
  const warnings = [...new Set([
    ...(Array.isArray(firstPass.warnings) ? firstPass.warnings : []),
    ...(Array.isArray(reviewPass.warnings) ? reviewPass.warnings : [])
  ])];

  return {
    ...firstPass,
    ...reviewPass,
    actions,
    warnings,
    secondPassReviewed: true,
    secondPassCandidateCount: candidateIds.size,
    firstPassActionCount: firstActions.length
  };
}

export function reviewAndHardenAnalysis(input = {}) {
  const duration = Math.max(0, numberOr(input.videoDuration));
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  const issues = [];
  const droppedActionIds = [];
  const accepted = [];

  const chunkCount = Math.max(0, Math.floor(numberOr(input.chunkCount)));
  const expectedChunkCount = Math.max(0, Math.floor(numberOr(input.expectedChunkCount)));
  if (expectedChunkCount && chunkCount !== expectedChunkCount) {
    issues.push({ severity: 'fatal', code: 'INCOMPLETE_CHUNK_COVERAGE', chunkCount, expectedChunkCount });
  }

  const sorted = rawActions
    .map((action, index) => ({ ...action, __index: index }))
    .sort((a, b) => numberOr(a.startTime) - numberOr(b.startTime));

  for (const action of sorted) {
    const interval = validateActionInterval(action, duration);
    const confidence = actionConfidence(action);
    const minimum = minimumConfidenceForAction(action);
    const id = String(action.actionId || `action-${action.__index}`);

    if (!interval.valid) {
      droppedActionIds.push(id);
      issues.push({ severity: 'drop', code: interval.reasons.join('+'), actionId: id });
      continue;
    }
    if (confidence + 1e-6 < minimum) {
      droppedActionIds.push(id);
      issues.push({ severity: 'drop', code: 'LOW_CONFIDENCE', actionId: id, confidence, minimum });
      continue;
    }

    const { __index, ...clean } = action;
    const route = normalizedActivityType(clean);
    if (['vaginal', 'anal'].includes(route) && (
      activityTypeConfidence(clean) < SECOND_PASS_ACTIVITY_CONFIDENCE ||
      !activityTypeEvidence(clean)
    )) {
      clean.activityType = 'other';
      clean.activityTypeConfidence = activityTypeConfidence(clean);
      const explicitRouteLabel = /\b(vajinal|vaginal|anal)\b/i.test(String(clean.label || ''));
      if (explicitRouteLabel) clean.label = String(clean.positionLabel || 'Pozisyon').trim();
      issues.push({
        severity: 'repair',
        code: 'UNVERIFIED_ACTIVITY_TYPE',
        actionId: id,
        claimedActivityType: route
      });
    }
    accepted.push({ ...clean, confidence });
  }

  // Resolve conflicting overlapping canonical position labels conservatively.
  const removed = new Set();
  for (let left = 0; left < accepted.length; left += 1) {
    const a = accepted[left];
    if (removed.has(a.actionId) || !(a.positionId || a.positionLabel)) continue;
    for (let right = left + 1; right < accepted.length; right += 1) {
      const b = accepted[right];
      if (numberOr(b.startTime) >= numberOr(a.endTime)) break;
      if (removed.has(b.actionId) || !(b.positionId || b.positionLabel)) continue;
      if (String(a.adultSceneId || '') !== String(b.adultSceneId || '')) continue;
      const familyA = semanticPositionFamily(a);
      const familyB = semanticPositionFamily(b);
      if (!familyA || !familyB || familyA === familyB) continue;
      if (overlapSeconds(a, b) < 1.5) continue;

      // A later verified position can begin while the model's previous parent
      // range still extends too far. Preserve both real occurrences by ending
      // the earlier one at the orientation change instead of deleting either.
      const aStart = numberOr(a.startTime);
      const bStart = numberOr(b.startTime);
      const earlier = aStart <= bStart ? a : b;
      const later = earlier === a ? b : a;
      const transition = numberOr(later.startTime);
      if (transition - numberOr(earlier.startTime) >= 10) {
        earlier.endTime = Math.min(numberOr(earlier.endTime), transition);
        earlier.positionEndTime = Math.min(numberOr(earlier.positionEndTime, earlier.endTime), transition);
        earlier.loopEndTime = Math.min(numberOr(earlier.loopEndTime, earlier.endTime), transition);
        issues.push({
          severity: 'repair',
          code: 'POSITION_TRANSITION_TRIMMED',
          actionId: earlier.actionId,
          nextActionId: later.actionId,
          transition
        });
        continue;
      }
      const winner = chooseHigherConfidence(a, b);
      const loser = winner === a ? b : a;
      removed.add(String(loser.actionId));
      issues.push({ severity: 'drop', code: 'CONFLICTING_POSITION_OVERLAP', actionId: loser.actionId, keptActionId: winner.actionId });
    }
  }

  let filtered = accepted.filter(action => !removed.has(String(action.actionId)));

  // Outcomes must be chronologically downstream of a verified core position in the same scene.
  const byScene = new Map();
  filtered.forEach(action => {
    const sceneId = String(action.adultSceneId || '');
    if (!sceneId) return;
    if (!byScene.has(sceneId)) byScene.set(sceneId, []);
    byScene.get(sceneId).push(action);
  });

  const invalidOutcomes = new Set();
  for (const [sceneId, sceneActions] of byScene) {
    const core = sceneActions.filter(action => {
      const family = semanticPositionFamily(action);
      return Boolean(family && !['oral', 'manual'].includes(family) && String(action.outcomeType || 'none') === 'none' && action.actionType !== 'outcome');
    });
    const firstCoreStart = core.length ? Math.min(...core.map(action => numberOr(action.positionStartTime, action.startTime))) : Number.POSITIVE_INFINITY;
    for (const action of sceneActions) {
      const outcomeLike = action.actionType === 'outcome' || action.outcomeType === 'climax';
      if (!outcomeLike) continue;
      if (!core.length || numberOr(action.outcomeStartTime, action.startTime) < firstCoreStart + 8) {
        invalidOutcomes.add(String(action.actionId));
        issues.push({ severity: 'drop', code: 'OUTCOME_BEFORE_CORE_POSITION', actionId: action.actionId, sceneId });
      }
    }
  }
  filtered = filtered.filter(action => !invalidOutcomes.has(String(action.actionId)));

  const fatal = issues.some(issue => issue.severity === 'fatal');
  const firstStart = filtered.length ? numberOr(filtered[0].startTime) : 0;
  const lastEnd = filtered.length ? Math.max(...filtered.map(action => numberOr(action.endTime))) : 0;
  const temporalSpanRatio = duration > 0 ? clamp((lastEnd - firstStart) / duration, 0, 1) : 0;

  const analysis = {
    ...input,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    actions: filtered,
    reviewPass: {
      mode: 'deterministic-second-pass',
      reviewed: true,
      acceptedActions: filtered.length,
      droppedActions: rawActions.length - filtered.length
    },
    integrity: {
      valid: !fatal,
      fatal,
      issueCount: issues.length,
      issues,
      droppedActionIds: [...new Set([...droppedActionIds, ...removed, ...invalidOutcomes])],
      temporalSpanRatio: Number(temporalSpanRatio.toFixed(3)),
      actionCountBefore: rawActions.length,
      actionCountAfter: filtered.length
    }
  };

  return { analysis, integrity: analysis.integrity };
}

export function canTransitionAdultPhase(current = 'foreplay', next = 'foreplay') {
  const currentRank = ADULT_PHASE_ORDER[current] ?? 0;
  const nextRank = ADULT_PHASE_ORDER[next] ?? 0;
  return nextRank >= currentRank;
}

export function advanceAdultPhase(current = 'foreplay', proposed = 'foreplay') {
  return canTransitionAdultPhase(current, proposed) ? proposed : current;
}

export function canPlayAction({
  kind = 'timeline',
  action = null,
  scene = null,
  parentPosition = null,
  phase = 'foreplay',
  unlocked = true,
  outcomeReady = false,
  videoDuration = 0
} = {}) {
  if (!action) return { allowed: false, reason: 'ACTION_MISSING' };
  const interval = validateActionInterval(action, videoDuration);
  if (!interval.valid) return { allowed: false, reason: interval.reasons[0] || 'INVALID_INTERVAL' };
  if (!unlocked) return { allowed: false, reason: 'LOCKED' };

  if (kind === 'foreplay' && !['foreplay', 'positions', 'reward'].includes(phase)) {
    return { allowed: false, reason: 'FOREPLAY_PHASE_CLOSED' };
  }
  if (kind === 'position' && !['positions', 'reward', 'final'].includes(phase)) {
    return { allowed: false, reason: 'POSITION_PHASE_LOCKED' };
  }
  if (kind === 'movement' && parentPosition) {
    const start = numberOr(action.loopStartTime, action.startTime);
    const end = numberOr(action.loopEndTime, action.endTime);
    const parentStart = numberOr(parentPosition.startTime);
    const parentEnd = numberOr(parentPosition.endTime);
    if (start < parentStart - 0.05 || end > parentEnd + 0.05) {
      return { allowed: false, reason: 'MOVEMENT_OUTSIDE_PARENT' };
    }
  }
  if (kind === 'outcome') {
    if (phase !== 'final') return { allowed: false, reason: 'FINAL_PHASE_LOCKED' };
    if (!outcomeReady) return { allowed: false, reason: 'FINAL_NOT_READY' };
  }

  if (scene) {
    const sceneStart = numberOr(scene.startTime);
    const sceneEnd = numberOr(scene.endTime);
    const start = kind === 'outcome' ? numberOr(action.outcomeStartTime, action.startTime) : interval.start;
    const end = kind === 'outcome' ? numberOr(action.outcomeEndTime, action.endTime) : interval.end;
    if (start < sceneStart - 0.1 || end > sceneEnd + 0.1) {
      return { allowed: false, reason: 'ACTION_OUTSIDE_SCENE' };
    }
  }

  return { allowed: true, reason: 'OK' };
}

export function appendEngineEvent(log, type, data = {}, maxEntries = 240) {
  const target = Array.isArray(log) ? log : [];
  target.push({
    at: Date.now(),
    type: String(type || 'EVENT'),
    data: data && typeof data === 'object' ? data : { value: data }
  });
  if (target.length > maxEntries) target.splice(0, target.length - maxEntries);
  return target;
}

export function createRuntimeSnapshot(state = {}, fingerprint = '') {
  const mapEntries = value => value instanceof Map ? [...value.entries()] : [];
  const setValues = value => value instanceof Set ? [...value] : [];
  return {
    saveVersion: SAVE_VERSION,
    engineVersion: ENGINE_VERSION,
    fingerprint,
    savedAt: Date.now(),
    gameState: String(state.gameState || 'IDLE'),
    gameCursorTime: numberOr(state.gameCursorTime),
    currentActionIndex: Math.floor(numberOr(state.currentActionIndex, -1)),
    consumedActionIds: setValues(state.consumedActionIds),
    completedAdultSceneIds: setValues(state.completedAdultSceneIds),
    maleSceneProgress: clamp(state.maleSceneProgress, 0, 100),
    femaleSceneProgress: clamp(state.femaleSceneProgress, 0, 100),
    adultMaleOrgasmProgress: clamp(state.adultMaleOrgasmProgress, 0, 100),
    adultFemaleOrgasmProgress: clamp(state.adultFemaleOrgasmProgress, 0, 100),
    adultMaleOrgasmCount: Math.max(0, Math.floor(numberOr(state.adultMaleOrgasmCount))),
    adultFemaleOrgasmCount: Math.max(0, Math.floor(numberOr(state.adultFemaleOrgasmCount))),
    adultSexUnlocked: Boolean(state.adultSexUnlocked),
    adultUnlockedPositionIds: setValues(state.adultUnlockedPositionIds),
    adultClimaxProgress: clamp(state.adultClimaxProgress, 0, 100),
    adultCorePlaySeconds: Math.max(0, numberOr(state.adultCorePlaySeconds)),
    adultVisitedPositionIds: setValues(state.adultVisitedPositionIds),
    adultMovementPlayCounts: mapEntries(state.adultMovementPlayCounts),
    adultPreludePlayCounts: mapEntries(state.adultPreludePlayCounts),
    adultComboCount: Math.max(0, Math.floor(numberOr(state.adultComboCount))),
    adultPhaseMachine: String(state.adultPhaseMachine || state.adultLastUiPhase || 'foreplay'),
    adultLastUiPhase: String(state.adultLastUiPhase || 'foreplay'),
    activePositionId: state.activePositionId || null,
    activeAdultCategory: state.activeAdultCategory || null,
    activeMovementId: state.activeMovementId || null,
    adultSceneId: state.adultScene?.id || null
  };
}

export function isCompatibleRuntimeSnapshot(snapshot, fingerprint) {
  return Boolean(
    snapshot &&
    Number(snapshot.saveVersion) === SAVE_VERSION &&
    String(snapshot.engineVersion || '') === ENGINE_VERSION &&
    String(snapshot.fingerprint || '') === String(fingerprint || '')
  );
}

export function applyRuntimeSnapshot(state, snapshot) {
  if (!state || !snapshot) return state;
  state.gameCursorTime = Math.max(0, numberOr(snapshot.gameCursorTime));
  state.currentActionIndex = Math.floor(numberOr(snapshot.currentActionIndex, -1));
  state.consumedActionIds = new Set(snapshot.consumedActionIds || []);
  state.completedAdultSceneIds = new Set(snapshot.completedAdultSceneIds || []);
  state.maleSceneProgress = clamp(snapshot.maleSceneProgress, 0, 100);
  state.femaleSceneProgress = clamp(snapshot.femaleSceneProgress, 0, 100);
  state.adultMaleOrgasmProgress = clamp(snapshot.adultMaleOrgasmProgress, 0, 100);
  state.adultFemaleOrgasmProgress = clamp(snapshot.adultFemaleOrgasmProgress, 0, 100);
  state.adultMaleOrgasmCount = Math.max(0, Math.floor(numberOr(snapshot.adultMaleOrgasmCount)));
  state.adultFemaleOrgasmCount = Math.max(0, Math.floor(numberOr(snapshot.adultFemaleOrgasmCount)));
  state.adultSexUnlocked = Boolean(snapshot.adultSexUnlocked);
  state.adultUnlockedPositionIds = new Set(snapshot.adultUnlockedPositionIds || []);
  state.adultClimaxProgress = clamp(snapshot.adultClimaxProgress, 0, 100);
  state.adultCorePlaySeconds = Math.max(0, numberOr(snapshot.adultCorePlaySeconds));
  state.adultVisitedPositionIds = new Set(snapshot.adultVisitedPositionIds || []);
  state.adultMovementPlayCounts = new Map(snapshot.adultMovementPlayCounts || []);
  state.adultPreludePlayCounts = new Map(snapshot.adultPreludePlayCounts || []);
  state.adultComboCount = Math.max(0, Math.floor(numberOr(snapshot.adultComboCount)));
  state.adultPhaseMachine = String(snapshot.adultPhaseMachine || 'foreplay');
  state.adultLastUiPhase = String(snapshot.adultLastUiPhase || 'foreplay');
  state.activePositionId = snapshot.activePositionId || null;
  state.activeAdultCategory = snapshot.activeAdultCategory || null;
  state.activeMovementId = snapshot.activeMovementId || null;
  state.restoredAdultSceneId = snapshot.adultSceneId || null;
  return state;
}
