const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const DEFAULT_OUTCOME_UNLOCK_PROGRESS = 92;
export const DEFAULT_POSITION_UNLOCK_PROGRESS = 35;
export const DEFAULT_BONUS_UNLOCK_PROGRESS = 78;
export const MIN_CORE_PLAY_SECONDS_FOR_OUTCOME = 75;

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
  corePlaySeconds = 0,
  requiredCorePlaySeconds = MIN_CORE_PLAY_SECONDS_FOR_OUTCOME
} = {}) {
  const visited = Math.max(0, Math.floor(Number(coreVisitedCount) || 0));
  const playedSeconds = Math.max(0, Number(corePlaySeconds) || 0);
  if (visited < 1) return false;
  if (playedSeconds < Math.max(MIN_CORE_PLAY_SECONDS_FOR_OUTCOME, Number(requiredCorePlaySeconds) || 0)) return false;
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
    return clamp(DEFAULT_BONUS_UNLOCK_PROGRESS + order * 7, 78, 96);
  }
  if (category === 'other') {
    return clamp(58 + order * 10, 58, 90);
  }
  return clamp(DEFAULT_POSITION_UNLOCK_PROGRESS + order * 12, 35, 82);
}

export function requiredCorePlaySecondsForOutcome(sceneDuration = 0) {
  const duration = Math.max(0, Number(sceneDuration) || 0);
  return clamp(duration * 0.62, MIN_CORE_PLAY_SECONDS_FOR_OUTCOME, 300);
}

export function expandVerifiedMovementVariants(
  movements,
  positionStart,
  positionEnd,
  { minSeconds = 10, maxVariants = 4 } = {}
) {
  const start = Math.max(0, Number(positionStart) || 0);
  const end = Math.max(start, Number(positionEnd) || start);
  const minimum = Math.max(10, Number(minSeconds) || 10);
  const limit = Math.max(1, Math.min(4, Math.floor(Number(maxVariants) || 4)));
  const source = (Array.isArray(movements) ? movements : [])
    .filter(item => Number(item?.loopEndTime) - Number(item?.loopStartTime) >= minimum)
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));

  if (!source.length || source.length >= 3 || end - start < minimum * 2) {
    return source.slice(0, limit);
  }

  const positionDuration = end - start;
  const desired = Math.min(
    limit,
    Math.max(source.length, positionDuration >= 60 ? 4 : positionDuration >= 30 ? 3 : 2)
  );
  const coverageStart = Math.max(start, Math.min(...source.map(item => Number(item.loopStartTime))));
  const coverageEnd = Math.min(end, Math.max(...source.map(item => Number(item.loopEndTime))));
  const coverage = coverageEnd - coverageStart;
  if (coverage < desired * minimum) return source.slice(0, limit);

  const sliceDuration = coverage / desired;
  return Array.from({ length: desired }, (_, index) => {
    const sliceStart = coverageStart + sliceDuration * index;
    const sliceEnd = index === desired - 1 ? coverageEnd : coverageStart + sliceDuration * (index + 1);
    const evidence = source.find(item =>
      Number(item.loopStartTime) < sliceEnd && Number(item.loopEndTime) > sliceStart
    ) || source[0];
    return {
      ...evidence,
      id: `${evidence.id}:variant-${index + 1}`,
      label: `${String(evidence.label || 'Gerçek hareket').replace(/\s+·\s+Bölüm\s+\d+$/iu, '')} · Bölüm ${index + 1}`,
      loopStartTime: sliceStart,
      loopEndTime: sliceEnd,
      derivedFromVerifiedSegment: evidence.id
    };
  });
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

const TEMPO_ORDER = Object.freeze(['slow', 'moderate', 'fast']);

export function normalizeMovementTempo(value) {
  const tempo = String(value || '').trim().toLowerCase();
  if (tempo === 'medium' || tempo === 'normal') return 'moderate';
  return TEMPO_ORDER.includes(tempo) ? tempo : 'unclear';
}

export function groupVerifiedMovementsByTempo(movements = []) {
  const groups = { slow: [], moderate: [], fast: [] };
  for (const movement of Array.isArray(movements) ? movements : []) {
    const tempo = normalizeMovementTempo(movement?.movementTempo);
    const duration = Number(movement?.loopEndTime) - Number(movement?.loopStartTime);
    if (movement?.sourceVerified === true && tempo !== 'unclear' && duration >= 2) {
      groups[tempo].push(movement);
    }
  }
  return groups;
}

export function tapRhythm(timestamps = [], now = null, windowMs = 2200) {
  const current = Number.isFinite(Number(now))
    ? Number(now)
    : Number(timestamps?.[timestamps.length - 1]);
  const recent = (Array.isArray(timestamps) ? timestamps : [])
    .map(Number)
    .filter(value => Number.isFinite(value) && current - value >= 0 && current - value <= windowMs)
    .sort((a, b) => a - b);

  if (recent.length < 2) return { tempo: 'unclear', tapsPerSecond: 0, sampleCount: recent.length };

  const intervals = recent.slice(1).map((value, index) => value - recent[index])
    .filter(value => value >= 80 && value <= 1800)
    .slice(-3);
  if (!intervals.length) return { tempo: 'unclear', tapsPerSecond: 0, sampleCount: recent.length };

  const weightedTotal = intervals.reduce((sum, interval, index) => {
    const weight = 2 ** index;
    return sum + interval * weight;
  }, 0);
  const weightTotal = intervals.reduce((sum, _interval, index) => sum + 2 ** index, 0);
  const intervalMs = weightedTotal / weightTotal;
  const tapsPerSecond = 1000 / intervalMs;
  const tempo = tapsPerSecond >= 3.6 ? 'fast' : tapsPerSecond >= 2.05 ? 'moderate' : 'slow';

  return {
    tempo,
    tapsPerSecond: Number(tapsPerSecond.toFixed(2)),
    sampleCount: intervals.length + 1
  };
}

export function nearestAvailableTempo(requestedTempo, groups = {}) {
  const requested = normalizeMovementTempo(requestedTempo);
  const available = TEMPO_ORDER.filter(tempo => Array.isArray(groups?.[tempo]) && groups[tempo].length);
  if (!available.length) return null;
  if (available.includes(requested)) return requested;
  const requestedIndex = Math.max(0, TEMPO_ORDER.indexOf(requested));
  return [...available].sort((a, b) =>
    Math.abs(TEMPO_ORDER.indexOf(a) - requestedIndex) -
    Math.abs(TEMPO_ORDER.indexOf(b) - requestedIndex)
  )[0];
}
