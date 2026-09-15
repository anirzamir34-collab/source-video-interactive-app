const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function adultPositionFamily(value) {
  const text = String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/\b(oral(?:\s+seks)?|sakso|blowjob|fellatio|cunnilingus)\b/.test(text)) return 'oral';
  if (/\b(manuel\s+uyarim|manual\s+stimulation|handjob|masturbasyon)\b/.test(text)) return 'manual';
  if (/\b(reverse\s+cowgirl|reverse\s+rider|ters\s+kovboy|ters\s+cowgirl|ters\s+rider|ters\s+kucak(?:ta)?|arkasi\s+donuk\s+kovboy|sirtini\s+donerek\s+ustte)\b/.test(text)) return 'reverse-cowgirl';
  if (/\b(lap\s+dance|kucakta|kucaginda|lotus|yuz\s+yuze\s+oturarak|seated\s+face[\s-]?to[\s-]?face)\b/.test(text)) return 'seated-facing';
  if (/\b(prone[\s-]?bone|pronebone|flat[\s-]?doggy|yuzustu\s+arkadan|yuzukoyun\s+arkadan)\b/.test(text)) return 'prone-bone';
  if (/\b(piledriver|omuzda|bacaklar\s+yukari|legs\s+up)\b/.test(text)) return 'legs-up';
  if (/\b(misyoner|missionary)\b/.test(text)) return 'missionary';
  if (/\b(kovboy|cowgirl|rider|kadin ustte)\b/.test(text)) return 'cowgirl';
  if (/\b(ters\s+kasik|reverse\s+spoon)\b/.test(text)) return 'reverse-spoon';
  if (/\b(kasik|spoon|yan yatarak|side[\s-]?lying|yan\s+pozisyon)\b/.test(text)) return 'spoon';
  if (/\b(arkadan|doggy(?:\s+style)?|dort\s+ayak)\b/.test(text) && /\b(ayakta|standing)\b/.test(text)) {
    return 'standing-rear';
  }
  if (/\b(arkadan|doggy(?:\s+style)?|dort\s+ayak)\b/.test(text)) return 'rear';
  if (/\b(oturarak|seated|chair|sandalye|koltukta)\b/.test(text)) return 'seated';
  if (/\b(ayakta|standing)\b/.test(text)) return 'standing';
  return '';
}

export function verifiedAdultPositionFamily(action = {}) {
  if (action?.sourceVerified !== true) return '';
  return adultPositionFamily([
    action.positionLabel,
    action.positionId,
    action.label,
    action.movementType
  ].filter(Boolean).join(' '));
}

export function resolveVerifiedAdultPosition(action = {}) {
  const labelFamily = adultPositionFamily(action.positionLabel);
  const idFamily = adultPositionFamily(action.positionId);
  const actionFamily = action?.sourceVerified === true
    ? adultPositionFamily([action.label, action.movementType].filter(Boolean).join(' '))
    : '';
  const declared = [labelFamily, idFamily, actionFamily].filter(Boolean);
  const explicitPositionLabel = /\b(pozisyon\w*|position\w*)\b/i.test(String(action.label || ''));
  const correctedFromAction = Boolean(
    explicitPositionLabel &&
    actionFamily &&
    [labelFamily, idFamily].some(family => family && family !== actionFamily)
  );
  if (new Set(declared).size > 1 && !correctedFromAction) {
    return { family: '', correctedFromAction: false };
  }
  return {
    family: correctedFromAction ? actionFamily : (declared[0] || ''),
    correctedFromAction
  };
}

export function movementBelongsToVerifiedPosition(action = {}, canonicalId = '') {
  const source = [
    action.label,
    action.movementType,
    action.activityEvidence,
    action.sensoryEvidence
  ].filter(Boolean).join(' ');
  const family = adultPositionFamily(source);
  if (family && family !== canonicalId) return false;
  if (family && family === canonicalId) return true;

  const text = String(source || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Only an explicit change to another configuration is a transition.
  // Words describing the ongoing verified activity (vaginal, penetration,
  // kissing or touching) are legitimate position-local movement choices.
  return !/\b(gecis|transition|pozisyon\s+degistir|donerken|yonlendir)\b/.test(text);
}

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
  { minSeconds = 10, maxVariants = 4, baseLabel = '' } = {}
) {
  const start = Math.max(0, Number(positionStart) || 0);
  const end = Math.max(start, Number(positionEnd) || start);
  const minimum = Math.max(10, Number(minSeconds) || 10);
  const limit = Math.max(1, Math.min(4, Math.floor(Number(maxVariants) || 4)));
  const positionDuration = end - start;
  const rawSource = (Array.isArray(movements) ? movements : [])
    .map(item => ({
      ...item,
      loopStartTime: Math.max(start, Number(item?.loopStartTime)),
      loopEndTime: Math.min(end, Number(item?.loopEndTime))
    }))
    .filter(item => item.loopEndTime - item.loopStartTime >= minimum)
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));

  const source = rawSource.reduce((items, item) => {
    const duplicateIndex = items.findIndex(existing => {
      const overlap = Math.max(0,
        Math.min(existing.loopEndTime, item.loopEndTime) -
        Math.max(existing.loopStartTime, item.loopStartTime)
      );
      const shorter = Math.min(
        existing.loopEndTime - existing.loopStartTime,
        item.loopEndTime - item.loopStartTime
      );
      return shorter > 0 && overlap / shorter >= 0.88;
    });
    if (duplicateIndex < 0) items.push(item);
    else if (Number(item.confidence || 0) > Number(items[duplicateIndex].confidence || 0)) {
      items[duplicateIndex] = item;
    }
    return items;
  }, []).sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));

  if (!source.length || positionDuration < minimum) return [];

  const desired = Math.min(
    limit,
    Math.floor(positionDuration / minimum),
    positionDuration >= 60 ? 4 : positionDuration >= 30 ? 3 : positionDuration >= 20 ? 2 : 1
  );

  const naturallyDistinct = source.filter((item, index, list) =>
    index === 0 || Number(item.loopStartTime) >= Number(list[index - 1].loopEndTime) - 0.25
  );
  if (naturallyDistinct.length >= desired) return naturallyDistinct.slice(0, limit);

  const sliceDuration = positionDuration / desired;
  return Array.from({ length: desired }, (_, index) => {
    const sliceStart = start + sliceDuration * index;
    const sliceEnd = index === desired - 1 ? end : start + sliceDuration * (index + 1);
    const rankedEvidence = source.map(item => ({
      item,
      overlap: Math.max(0,
        Math.min(Number(item.loopEndTime), sliceEnd) -
        Math.max(Number(item.loopStartTime), sliceStart)
      )
    })).sort((a, b) => b.overlap - a.overlap);
    const evidence = rankedEvidence[0]?.item || source[0];
    const tempoDirectlySupported = Number(rankedEvidence[0]?.overlap || 0) >= (sliceEnd - sliceStart) * 0.65;
    const labelBase = String(baseLabel || evidence.label || 'Gerçek pozisyon sekansı')
      .replace(/\s+·\s+(?:Bölüm|Sekans)\s+\d+$/iu, '');
    return {
      ...evidence,
      id: `${evidence.id}:variant-${index + 1}-${Math.round(sliceStart * 1000)}`,
      label: `${labelBase} · Sekans ${index + 1}`,
      loopStartTime: sliceStart,
      loopEndTime: sliceEnd,
      movementTempo: tempoDirectlySupported ? evidence.movementTempo : 'unclear',
      sourceVerified: true,
      derivedFromVerifiedSegment: evidence.id,
      derivedFromVerifiedPosition: !tempoDirectlySupported
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

export function pickNextChronologicalVariant(variants, currentId = null) {
  const playable = (Array.isArray(variants) ? variants : [])
    .filter(item =>
      item &&
      Number.isFinite(Number(item.loopStartTime)) &&
      Number.isFinite(Number(item.loopEndTime)) &&
      Number(item.loopEndTime) > Number(item.loopStartTime)
    )
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));

  if (!playable.length) return null;
  const currentIndex = playable.findIndex(item => item.id === currentId);
  if (currentIndex < 0) return playable[0];
  return playable[currentIndex + 1] || null;
}

export function pickNearbyRhythmVariant(
  variants,
  currentMovement = null,
  mediaTime = null,
  playCounts = new Map(),
  { maxForwardSeconds = 35, backwardTolerance = 0.2 } = {}
) {
  const playable = (Array.isArray(variants) ? variants : [])
    .filter(item =>
      item &&
      Number.isFinite(Number(item.loopStartTime)) &&
      Number.isFinite(Number(item.loopEndTime)) &&
      Number(item.loopEndTime) > Number(item.loopStartTime)
    );
  if (!playable.length) return null;

  const currentStart = Number(currentMovement?.loopStartTime);
  const currentEnd = Number(currentMovement?.loopEndTime);
  const cursor = mediaTime !== null && mediaTime !== undefined && Number.isFinite(Number(mediaTime))
    ? Number(mediaTime)
    : (Number.isFinite(currentStart) ? currentStart : Number(playable[0].loopStartTime));
  const floor = Number.isFinite(currentStart)
    ? currentStart - Math.max(0, Number(backwardTolerance) || 0)
    : Number.NEGATIVE_INFINITY;
  const ceilingAnchor = Number.isFinite(currentEnd) ? Math.max(cursor, currentEnd) : cursor;
  const ceiling = ceilingAnchor + Math.max(5, Number(maxForwardSeconds) || 35);
  const local = playable.filter(item => {
    const start = Number(item.loopStartTime);
    return start >= floor && start <= ceiling;
  });
  if (!local.length) return null;

  const alternatives = local.length > 1
    ? local.filter(item => item.id !== currentMovement?.id)
    : local;
  const pool = alternatives.length ? alternatives : local;
  return [...pool].sort((a, b) => {
    const distanceA = Math.abs(Number(a.loopStartTime) - cursor);
    const distanceB = Math.abs(Number(b.loopStartTime) - cursor);
    if (distanceA !== distanceB) return distanceA - distanceB;
    const countA = Number(playCounts?.get?.(a.id) || 0);
    const countB = Number(playCounts?.get?.(b.id) || 0);
    if (countA !== countB) return countA - countB;
    return Number(a.loopStartTime) - Number(b.loopStartTime);
  })[0] || null;
}

export function findAdultSceneForTimeline(
  scenes,
  { action = null, time = null, completedSceneIds = new Set(), tolerance = 0.15 } = {}
) {
  const isCompleted = id => completedSceneIds?.has?.(id) || false;
  const available = (Array.isArray(scenes) ? scenes : [])
    .filter(scene => scene && !isCompleted(scene.id))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  if (!available.length) return null;

  const sceneId = String(action?.adultSceneId || '').trim();
  if (sceneId) {
    const exact = available.find(scene =>
      scene.id === sceneId || (Array.isArray(scene.sourceSceneIds) && scene.sourceSceneIds.includes(sceneId))
    );
    if (exact) return exact;
  }

  const hasExplicitTime = time !== null && time !== undefined && Number.isFinite(Number(time));
  const point = hasExplicitTime ? Number(time) : Number(action?.startTime);
  if (Number.isFinite(point)) {
    const containing = available.find(scene =>
      point >= Number(scene.startTime) - tolerance && point < Number(scene.endTime) - 0.01
    );
    if (containing) return containing;
  }

  const actionStart = Number(action?.startTime);
  const actionEnd = Number(action?.endTime);
  if (!Number.isFinite(actionStart) || !Number.isFinite(actionEnd) || actionEnd <= actionStart) return null;
  return available
    .map(scene => ({
      scene,
      overlap: Math.max(0, Math.min(actionEnd, Number(scene.endTime)) - Math.max(actionStart, Number(scene.startTime)))
    }))
    .filter(item => item.overlap >= Math.min(1, (actionEnd - actionStart) * 0.25))
    .sort((a, b) => b.overlap - a.overlap)[0]?.scene || null;
}

export function consolidateVerifiedPositions(positions = []) {
  const groups = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!position?.familyId) continue;
    const key = String(position.familyId);
    const sourceId = String(position.id || key);
    const movements = (Array.isArray(position.movements) ? position.movements : [])
      .map(movement => ({ ...movement, sourcePositionId: movement.sourcePositionId || sourceId }));
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...position,
        id: `position:${key}`,
        occurrenceId: key,
        startTime: Number(position.startTime),
        endTime: Number(position.endTime),
        sourcePositionIds: [sourceId],
        sourceRanges: [{
          id: sourceId,
          startTime: Number(position.startTime),
          endTime: Number(position.endTime)
        }],
        movements
      });
      continue;
    }
    existing.startTime = Math.min(existing.startTime, Number(position.startTime));
    existing.endTime = Math.max(existing.endTime, Number(position.endTime));
    existing.sourcePositionIds.push(sourceId);
    existing.sourceRanges.push({
      id: sourceId,
      startTime: Number(position.startTime),
      endTime: Number(position.endTime)
    });
    existing.movements.push(...movements);
    if (Number(position.activityTypeConfidence || 0) > Number(existing.activityTypeConfidence || 0)) {
      existing.activityType = position.activityType;
      existing.activityTypeConfidence = position.activityTypeConfidence;
      existing.categoryId = position.categoryId;
      existing.categoryLabel = position.categoryLabel;
    }
  }

  const clustered = [];
  for (const position of groups.values()) {
    const seen = new Set();
    position.movements = position.movements
      .filter(movement => {
        const key = String(movement.id || [
          Number(movement.loopStartTime).toFixed(3),
          Number(movement.loopEndTime).toFixed(3),
          String(movement.label || '')
        ].join('|'));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
    const ranges = [...position.sourceRanges]
      .filter(range => Number.isFinite(range.startTime) && Number.isFinite(range.endTime))
      .sort((a, b) => a.startTime - b.startTime);
    const clusters = [];
    let cluster = null;
    for (const range of ranges) {
      if (!cluster || range.startTime > cluster.endTime + 1.25) {
        cluster = {
          id: `${position.familyId}:continuous-${Math.round(range.startTime * 1000)}`,
          startTime: range.startTime,
          endTime: range.endTime,
          sourceIds: [String(range.id)]
        };
        clusters.push(cluster);
      } else {
        cluster.endTime = Math.max(cluster.endTime, range.endTime);
        cluster.sourceIds.push(String(range.id));
      }
    }

    for (const item of clusters) {
      const sourceIds = new Set(item.sourceIds);
      const clusterMovements = position.movements
        .filter(movement => {
          if (sourceIds.has(String(movement.sourcePositionId || ''))) return true;
          const start = Number(movement.loopStartTime);
          const end = Number(movement.loopEndTime);
          return Number.isFinite(start) && Number.isFinite(end) &&
            start >= item.startTime - 0.2 && end <= item.endTime + 0.2;
        })
        .map(movement => ({ ...movement, sourcePositionId: item.id }));
      clustered.push({
        ...position,
        id: `position:${item.id}`,
        occurrenceId: item.id,
        startTime: item.startTime,
        endTime: item.endTime,
        sourcePositionIds: [...sourceIds],
        sourceRanges: ranges.filter(range => sourceIds.has(String(range.id))),
        movements: clusterMovements
      });
    }
  }
  return clustered.sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

export function buildVerifiedMovementChoices(movements = [], positionLabel = '', maxChoices = 3) {
  const limit = Math.max(1, Math.min(3, Math.floor(Number(maxChoices) || 3)));
  const clean = value => String(value || '')
    .replace(/\s+·\s+(?:Bölüm|Sekans)\s+\d+$/iu, '')
    .replace(/\s+·\s+Gerçek sekans$/iu, '')
    .trim();
  const normalize = value => clean(value).toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const positionKey = normalize(positionLabel);
  const tempoLabels = { slow: 'Yavaş hareket', moderate: 'Ritmik hareket', fast: 'Hızlı hareket' };
  const actionLabels = [
    [/(\bop|\bopus|\bdudak|kiss)/u, 'Öpüşmeyi sürdür'],
    [/(gogus|breast).*(oksa|okus|dokun|touch|caress)|(oksa|okus|dokun|touch|caress).*(gogus|breast)/u, 'Göğüslerine dokun'],
    [/(okus|oksa|sivaz|touch|caress)/u, 'Okşamayı sürdür'],
    [/(tut|kavra|bel|kalca|gogus|hold|grip)/u, 'Tutuşu değiştir'],
    [/(derin|deep)/u, 'Derin hareketi sürdür'],
    [/(sert|guclu|hard|thrust)/u, 'Sert hareketi sürdür'],
    [/(hizli|fast)/u, 'Hızlı hareketi sürdür'],
    [/(ritm|tempo|cadence)/u, 'Ritmi sürdür'],
    [/(yavas|slow)/u, 'Yavaş hareketi sürdür']
  ];
  const verified = (Array.isArray(movements) ? movements : [])
    .filter(movement => movement?.sourceVerified === true)
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
  if (!verified.length) return [];

  // One position object represents one uninterrupted occurrence. If malformed
  // input contains another occurrence, keep only the earliest one instead of
  // exposing a card that can jump to a different body configuration.
  const occurrence = String(verified[0].sourcePositionId || 'single-occurrence');
  const local = verified.filter(item =>
    String(item.sourcePositionId || 'single-occurrence') === occurrence
  );
  const cardCount = Math.min(limit, local.length);
  const cards = [];
  let cursor = 0;

  for (let index = 0; index < cardCount; index += 1) {
    const remaining = local.length - cursor;
    const remainingCards = cardCount - index;
    const size = Math.min(3, Math.max(1, Math.ceil(remaining / remainingCards)));
    const variants = local.slice(cursor, cursor + size);
    cursor += size;
    const first = variants[0];
    const tempo = normalizeMovementTempo(first.movementTempo);
    const rawLabel = clean(first.label)
      .split('·')
      .map(part => part.trim())
      .filter(part => !/\b(?:nefes|bakis|gorunum|ses|duygu|saniye|sn|gercek\s+(?:kesit|sekans)|bagli\s+gercek)\b/iu.test(normalize(part)))
      .join(' · ')
      .trim();
    const normalizedRaw = normalize(rawLabel);
    const concreteChange = /(hizli|yavas|ritm|sert|derin|op|okus|oksa|tut|kavra|dokun|temas|kalca|gogus|bel|yon|aci|tempo|hareket)/u.test(normalizedRaw);
    const meaningfulLabel = rawLabel && normalizedRaw !== positionKey &&
      !normalizedRaw.startsWith(positionKey + ' ·') &&
      !/^(gercek hareket|gercek sekans|seçenek|secenek|option|choice|hareket)\s*\d*$/u.test(normalizedRaw) &&
      concreteChange;
    const actionForVariant = variant => {
      const text = normalize([
        variant?.label,
        variant?.movementType,
        variant?.activityEvidence,
        variant?.sensoryEvidence
      ].filter(Boolean).join(' '));
      return actionLabels.find(([pattern]) => pattern.test(text))?.[1] || '';
    };
    const inferredLabels = variants.map(actionForVariant).filter(Boolean);
    const inferredAction = inferredLabels.length
      ? [...new Set(inferredLabels)].sort((a, b) =>
        inferredLabels.filter(label => label === b).length -
        inferredLabels.filter(label => label === a).length
      )[0]
      : '';
    const variantsText = normalize(variants.map(item => [
      item.label,
      item.movementType,
      item.activityEvidence,
      item.sensoryEvidence
    ].filter(Boolean).join(' ')).join(' '));
    const label = meaningfulLabel
      ? rawLabel
      : inferredAction || tempoLabels[tempo] || `${clean(positionLabel) || 'Doğrulanmış pozisyon'} sekansını oynat`;
    const tempoVariants = ['fast', 'moderate', 'slow'].map(kind =>
      variants.find(item => normalizeMovementTempo(item.movementTempo) === kind)
    ).filter(Boolean);
    const hasTempoShift = new Set(variants.map(item => normalizeMovementTempo(item.movementTempo)).filter(item => item !== 'unclear')).size > 1;

    cards.push({
      id: `movement-choice:${occurrence}:${index + 1}`,
      label,
      tempo,
      hasTempoShift,
      tempoVariants,
      sourcePositionId: occurrence,
      variants
    });
  }

  // Several chronological clips of the same observed action are variants of
  // one choice, not separate "Cut 1/2/3" choices. Clicking the card cycles its
  // verified clips through the existing variant picker.
  const groupedCards = [];
  cards.forEach(card => {
    const key = normalize(card.label);
    const existing = groupedCards.find(item => normalize(item.label) === key);
    if (!existing) {
      groupedCards.push({ ...card });
      return;
    }
    existing.variants = [...existing.variants, ...card.variants]
      .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime))
      .slice(0, 3);
    existing.tempoVariants = ['fast', 'moderate', 'slow'].map(kind =>
      existing.variants.find(item => normalizeMovementTempo(item.movementTempo) === kind)
    ).filter(Boolean);
    existing.hasTempoShift = new Set(
      existing.variants
        .map(item => normalizeMovementTempo(item.movementTempo))
        .filter(item => item !== 'unclear')
    ).size > 1;
  });

  const labelCounts = new Map();
  return groupedCards.map((card, index) => {
    const key = normalize(card.label);
    const seen = (labelCounts.get(key) || 0) + 1;
    labelCounts.set(key, seen);
    const total = groupedCards.filter(item => normalize(item.label) === key).length;
    return {
      ...card,
      label: total > 1 ? `${card.label} · Kesit ${seen}` : card.label,
      displayIndex: index + 1
    };
  });
}

export function isEnergeticSexMoment(movement = null) {
  if (!movement || movement.sourceVerified !== true) return false;
  const tempo = normalizeMovementTempo(movement.movementTempo);
  if (tempo === 'fast') return true;
  const text = String([
    movement.label,
    movement.movementType,
    movement.activityEvidence,
    movement.sensoryEvidence
  ].filter(Boolean).join(' '))
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /\b(hizli|sert|derin|guclu|thrust|hard|deep)\b/.test(text);
}

export function dedupeVerifiedTimelineActions(actions = []) {
  const byId = new Map();
  const withoutId = new Map();
  for (const action of (Array.isArray(actions) ? actions : [])) {
    if (!action) continue;
    const id = String(action.actionId || '').trim();
    const fallbackKey = [
      Number(action.startTime).toFixed(3),
      Number(action.endTime).toFixed(3),
      String(action.label || '').trim().toLocaleLowerCase('tr-TR')
    ].join('|');
    const target = id ? byId : withoutId;
    const key = id || fallbackKey;
    const existing = target.get(key);
    if (!existing || Number(action.confidence || 0) > Number(existing.confidence || 0)) {
      target.set(key, action);
    }
  }
  return [...byId.values(), ...withoutId.values()]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime) || Number(a.endTime) - Number(b.endTime));
}

const TEMPO_ORDER = Object.freeze(['slow', 'moderate', 'fast']);

export function normalizeMovementTempo(value) {
  const tempo = String(value || '').trim().toLowerCase();
  if (tempo === 'medium' || tempo === 'normal') return 'moderate';
  return TEMPO_ORDER.includes(tempo) ? tempo : 'unclear';
}

export function playbackRateForTapTempo(value) {
  return { slow: 0.88, moderate: 1, fast: 1.12 }[normalizeMovementTempo(value)] || 1;
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
