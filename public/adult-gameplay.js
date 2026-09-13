const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const DEFAULT_OUTCOME_UNLOCK_PROGRESS = 82;
export const DEFAULT_POSITION_UNLOCK_PROGRESS = 35;
export const DEFAULT_BONUS_UNLOCK_PROGRESS = 72;
export const MIN_CORE_PLAY_SECONDS_FOR_OUTCOME = 18;

export function averageAdultProgress(maleProgress, femaleProgress) {
  const male = clamp(maleProgress, 0, 100);
  const female = clamp(femaleProgress, 0, 100);
  return clamp((male + female) / 2, 0, 100);
}

export function normalizeOutcomeUnlockProgress(value, fallback = DEFAULT_OUTCOME_UNLOCK_PROGRESS) {
  const resolved = Number.isFinite(Number(value)) ? Number(value) : fallback;
  return clamp(resolved, 60, 100);
}

export function isOutcomeUnlocked(outcome, maleProgress, femaleProgress) {
  const required = normalizeOutcomeUnlockProgress(outcome?.unlockProgress);
  return averageAdultProgress(maleProgress, femaleProgress) >= required;
}

export function canUnlockOutcome({
  outcome,
  climaxProgress = 0,
  coreVisitedCount = 0,
  corePlaySeconds = 0
} = {}) {
  const visited = Math.max(0, Math.floor(Number(coreVisitedCount) || 0));
  const playedSeconds = Math.max(0, Number(corePlaySeconds) || 0);
  if (visited < 1) return false;
  if (playedSeconds < MIN_CORE_PLAY_SECONDS_FOR_OUTCOME) return false;
  return isOutcomeUnlocked(outcome, climaxProgress, climaxProgress);
}

export function positionUnlockProgress({
  categoryId = '',
  familyId = '',
  index = 0,
  bootstrap = false
} = {}) {
  if (bootstrap) return 0;
  const category = String(categoryId || '').toLowerCase();
  const family = String(familyId || '').toLowerCase();
  const order = Math.max(0, Number(index) || 0);

  if (category === 'oral' || category === 'manual' || family === 'oral' || family === 'manual') {
    return 0;
  }
  if (category === 'anal') {
    return clamp(DEFAULT_BONUS_UNLOCK_PROGRESS + order * 8, 72, 94);
  }
  if (category === 'other') {
    return clamp(58 + order * 10, 58, 90);
  }
  return clamp(DEFAULT_POSITION_UNLOCK_PROGRESS + order * 12, 35, 82);
}

export const ADULT_PHASE_ORDER = Object.freeze({
  foreplay: 0,
  positions: 1,
  reward: 2,
  final: 3
});

export function adultDiscoveryPhase({
  hasCoreUnlocked = false,
  hasBonusUnlocked = false,
  hasOutcomeUnlocked = false
} = {}) {
  if (hasOutcomeUnlocked) return 'final';
  if (hasBonusUnlocked) return 'reward';
  if (hasCoreUnlocked) return 'positions';
  return 'foreplay';
}

export function requiredWarmupDiscoveries(totalChoices = 0) {
  const total = Math.max(0, Math.floor(Number(totalChoices) || 0));
  if (!total) return 0;
  return Math.min(total, Math.max(1, Math.ceil(total * 0.7)));
}

export function canUnlockCorePositions({
  flow = 0,
  warmupTotal = 0,
  warmupUniquePlayed = 0
} = {}) {
  const total = Math.max(0, Math.floor(Number(warmupTotal) || 0));
  if (!total) return true;
  const played = Math.max(0, Math.floor(Number(warmupUniquePlayed) || 0));
  return clamp(flow, 0, 100) >= DEFAULT_POSITION_UNLOCK_PROGRESS &&
    played >= requiredWarmupDiscoveries(total);
}

export function canUnlockBonusPositions({
  flow = 0,
  coreVisitedCount = 0,
  corePositionCount = 0,
  bootstrap = false
} = {}) {
  if (bootstrap) return true;
  const coreCount = Math.max(0, Math.floor(Number(corePositionCount) || 0));
  const visited = Math.max(0, Math.floor(Number(coreVisitedCount) || 0));
  return clamp(flow, 0, 100) >= DEFAULT_BONUS_UNLOCK_PROGRESS &&
    (coreCount === 0 || visited >= 1);
}

export function monotonicAdultPhase(proposed = 'foreplay', previous = 'foreplay') {
  const proposedRank = ADULT_PHASE_ORDER[proposed] ?? 0;
  const previousRank = ADULT_PHASE_ORDER[previous] ?? 0;
  return proposedRank >= previousRank ? proposed : previous;
}

export function computeWarmupSelectionDelta({
  repeatCount = 0,
  comboCount = 0,
  maleRate = 1,
  femaleRate = 1
} = {}) {
  const repeats = Math.max(0, Number(repeatCount) || 0);
  const repeatFactor = Math.max(0.35, 1 - repeats * 0.18);
  const comboBonus = Math.min(2, Math.max(0, Number(comboCount) || 0) * 0.35);
  const base = 5.5 * repeatFactor + comboBonus;

  return {
    male: clamp(base * clamp(maleRate, 0.25, 2.5), 0.75, 11),
    female: clamp(base * clamp(femaleRate, 0.25, 2.5), 0.75, 11)
  };
}

export function computeAdultSelectionDelta({
  repeatCount = 0,
  positionNew = false,
  positionChanged = false,
  movementNew = false,
  comboCount = 0,
  maleRate = 1,
  femaleRate = 1
} = {}) {
  const repeats = Math.max(0, Number(repeatCount) || 0);
  const repeatFactor = Math.max(0.3, 1 - repeats * 0.2);
  const noveltyBonus =
    (positionNew ? 2.5 : 0) +
    (positionChanged ? 1.25 : 0) +
    (movementNew ? 3.75 : 0);
  const comboBonus = Math.min(2.5, Math.max(0, Number(comboCount) || 0) * 0.5);
  const base = 3.5 * repeatFactor + noveltyBonus + comboBonus;

  return {
    male: clamp(base * clamp(maleRate, 0.25, 2.5), 0.75, 14),
    female: clamp(base * clamp(femaleRate, 0.25, 2.5), 0.75, 14)
  };
}

export function pickNextVariant(variants, currentId = null, playCounts = new Map()) {
  const playable = (Array.isArray(variants) ? variants : [])
    .filter(item =>
      item &&
      Number.isFinite(Number(item.loopStartTime)) &&
      Number.isFinite(Number(item.loopEndTime)) &&
      Number(item.loopEndTime) > Number(item.loopStartTime)
    );

  if (!playable.length) return null;

  const alternatives = playable.length > 1
    ? playable.filter(item => item.id !== currentId)
    : playable;

  const pool = alternatives.length ? alternatives : playable;

  return [...pool].sort((a, b) => {
    const countA = Number(playCounts?.get?.(a.id) || 0);
    const countB = Number(playCounts?.get?.(b.id) || 0);
    if (countA !== countB) return countA - countB;
    return Number(a.loopStartTime) - Number(b.loopStartTime);
  })[0] || null;
}
