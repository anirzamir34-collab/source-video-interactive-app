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
  if (/\b(lap\s+dance|kucakta|kucaginda|kucagindaki|kucaginda\s+oturan|lotus|yuz\s+yuze\s+oturarak|seated\s+face[\s-]?to[\s-]?face)\b/.test(text)) return 'seated-facing';
  if (/\b(prone[\s-]?bone|pronebone|flat[\s-]?doggy|yuzustu\s+arkadan|yuzukoyun\s+arkadan)\b/.test(text)) return 'prone-bone';
  if (/\b(piledriver|omuzda|bacak(?:lar)?\s+(?:yukari(?:da)?|havada)|legs[\s-]+up)\b/.test(text)) return 'legs-up';
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

export function initialWarmupBeforeFirstPosition(foreplay = [], positions = []) {
  const verifiedPositions = (Array.isArray(positions) ? positions : [])
    .filter(position => Number.isFinite(Number(position?.startTime)));
  if (!verifiedPositions.length) return [];

  const firstPositionStart = Math.min(...verifiedPositions.map(position => Number(position.startTime)));
  return (Array.isArray(foreplay) ? foreplay : []).filter(item => {
    const startTime = Number(item?.startTime);
    const endTime = Number(item?.endTime);
    return Number.isFinite(startTime) && Number.isFinite(endTime) &&
      endTime > startTime && endTime <= firstPositionStart + 0.05;
  });
}

export function selectSequentialApproachChoices(candidates = [], {
  timelineFloor = 0,
  limit = 5
} = {}) {
  const floor = Math.max(0, Number(timelineFloor) || 0);
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 5));
  const seen = new Set();
  const forward = (Array.isArray(candidates) ? candidates : [])
    .filter(item => {
      const startTime = Number(item?.startTime);
      const endTime = Number(item?.endTime);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return false;
      if (endTime <= floor + 0.05) return false;
      const key = `${String(item?.kind || '')}:${String(item?.id || '')}:${String(item?.movementId || '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));

  const fresh = forward.filter(item => Math.max(0, Number(item.playCount) || 0) === 0);
  const repeated = forward
    .filter(item => Math.max(0, Number(item.playCount) || 0) > 0)
    .sort((a, b) => Number(a.playCount) - Number(b.playCount) || Number(a.startTime) - Number(b.startTime));

  return [...fresh, ...repeated].slice(0, safeLimit);
}

export function verifiedPartnerTransition(action = {}) {
  const previousPartnerTrackId = String(action?.previousPartnerTrackId || '').trim();
  const partnerTrackId = String(action?.partnerTrackId || '').trim();
  const startTime = Number(action?.startTime);
  const endTime = Number(action?.endTime);
  const valid = action?.sourceVerified === true &&
    action?.groupScene === true &&
    action?.partnerSwitch === true &&
    String(action?.actionType || '').toLowerCase() === 'partner_transition' &&
    previousPartnerTrackId && partnerTrackId &&
    previousPartnerTrackId !== partnerTrackId &&
    Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
  if (!valid) return null;
  return {
    id: String(action.actionId || `partner-transition-${Math.round(startTime * 1000)}`),
    label: String(action.label || `${partnerTrackId} partnerine geç`),
    startTime,
    endTime,
    previousPartnerTrackId,
    partnerTrackId,
    partnerLabel: String(action.partnerLabel || '').trim(),
    partnerEvidence: String(action.partnerEvidence || '').trim()
  };
}

export function positionOccurrenceGroups(position = {}) {
  const ranges = (Array.isArray(position?.sourceRanges) ? position.sourceRanges : [])
    .map(range => ({
      id: String(range?.id || ''),
      startTime: Number(range?.startTime),
      endTime: Number(range?.endTime)
    }))
    .filter(range => range.id && Number.isFinite(range.startTime) &&
      Number.isFinite(range.endTime) && range.endTime > range.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const groups = [];
  for (const range of ranges) {
    const previous = groups[groups.length - 1];
    if (previous && range.startTime <= previous.endTime + 0.25) {
      previous.endTime = Math.max(previous.endTime, range.endTime);
      previous.sourcePositionIds.push(range.id);
      continue;
    }
    groups.push({
      id: range.id,
      startTime: range.startTime,
      endTime: range.endTime,
      sourcePositionIds: [range.id]
    });
  }
  return groups;
}

export function movementsForPositionOccurrence(position = {}, occurrenceId = '') {
  const groups = positionOccurrenceGroups(position);
  const group = occurrenceId
    ? groups.find(item => item.id === String(occurrenceId))
    : groups[0];
  if (!group) return [];
  const sourceIds = new Set(group.sourcePositionIds);
  return (Array.isArray(position?.movements) ? position.movements : [])
    .filter(movement => {
      const startTime = Number(movement?.loopStartTime ?? movement?.startTime);
      const endTime = Number(movement?.loopEndTime ?? movement?.endTime);
      const sourceMatch = sourceIds.has(String(movement?.sourcePositionId || ''));
      const partnerMatch = !position.partnerTrackId || !movement.partnerTrackId ||
        String(position.partnerTrackId) === String(movement.partnerTrackId);
      const timeMatch = Number.isFinite(startTime) && Number.isFinite(endTime) &&
        startTime >= group.startTime - 0.05 && endTime <= group.endTime + 0.05;
      return sourceMatch && timeMatch && partnerMatch;
    })
    .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
}

export function assignAdultSceneOccurrenceIds(actions = [], maxSilentGapSeconds = 45) {
  const input = Array.isArray(actions) ? actions : [];
  const assignments = new Array(input.length).fill('');
  const runCounts = new Map();
  let activeRawId = '';
  let activeOccurrenceId = '';
  let previousEnd = NaN;

  input
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action?.adultScene === true || String(action?.adultSceneId || '').trim())
    .sort((left, right) => Number(left.action?.startTime) - Number(right.action?.startTime))
    .forEach(({ action, index }) => {
      const startTime = Number(action?.startTime);
      const endTime = Number(action?.endTime);
      const rawId = String(action?.adultSceneId || '').trim() ||
        `adult-${Math.round(Number(action?.adultSceneStartTime ?? startTime) || 0)}`;
      const gap = Number.isFinite(previousEnd) && Number.isFinite(startTime)
        ? startTime - previousEnd
        : 0;
      const startsNewRun = rawId !== activeRawId || gap > Math.max(1, Number(maxSilentGapSeconds) || 45);
      if (startsNewRun) {
        const run = Number(runCounts.get(rawId) || 0) + 1;
        runCounts.set(rawId, run);
        activeRawId = rawId;
        activeOccurrenceId = run === 1 ? rawId : `${rawId}#${run}`;
      }
      assignments[index] = activeOccurrenceId;
      if (Number.isFinite(endTime)) previousEnd = endTime;
    });

  return assignments;
}

export function verifiedAdultPositionFamily(action = {}) {
  if (action?.sourceVerified !== true) return '';
  return resolveVerifiedAdultPosition(action).family;
}

export function adultPositionFamilyFromBodyConfiguration(action = {}) {
  const orientation = String(action.receiverBodyOrientation || '').trim().toLowerCase();
  const support = String(action.receiverSupport || '').trim().toLowerCase();
  const confidence = Number(action.positionConfigurationConfidence);
  if (!Number.isFinite(confidence) || confidence < 0.78 || !String(action.positionEvidence || '').trim()) return '';
  if (orientation === 'on_top_facing' && support === 'straddling') return 'cowgirl';
  if (orientation === 'on_top_away' && support === 'straddling') return 'reverse-cowgirl';
  if (orientation === 'face_down_flat' && support === 'torso_flat') return 'prone-bone';
  if (orientation === 'on_back' && support === 'back_flat') return 'missionary';
  if (orientation === 'hands_knees' && support === 'hands_knees') return 'rear';
  return '';
}

export function resolveVerifiedAdultPosition(action = {}) {
  const structuralFamily = adultPositionFamilyFromBodyConfiguration(action);
  const labelFamily = adultPositionFamily(action.positionLabel);
  const idFamily = adultPositionFamily(action.positionId);
  const activityFamily = ['oral', 'manual'].includes(String(action.activityType || '').toLowerCase())
    ? String(action.activityType).toLowerCase()
    : '';
  const activityIsVerified = Boolean(
    activityFamily &&
    Number(action.activityTypeConfidence || 0) >= 0.72 &&
    String(action.activityEvidence || '').trim()
  );
  const actionFamily = action?.sourceVerified === true
    ? adultPositionFamily([action.label, action.movementType].filter(Boolean).join(' '))
    : '';
  // Position metadata describes the parent body configuration. Movement text
  // describes what happens inside it and must never reclassify a verified
  // cowgirl row merely because it contains words such as "kucağında".
  // Prefer the human-readable position label, then the id, and only infer from
  // the action when the provider omitted both parent fields.
  const normalizedPositionLabel = String(action.positionLabel || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıİ]/g, 'i')
    .replace(/ğ/g, 'g');
  // "Kucakta/yüz yüze" describes orientation, not a new parent position,
  // when the same verified provider label explicitly says Cowgirl/Kovboy and
  // its positionId agrees. Keep that occurrence under the Cowgirl tab instead
  // of manufacturing a separate seated-facing position card.
  const explicitCowgirlMetadata =
    idFamily === 'cowgirl' &&
    /\b(kovboy|cowgirl|rider|kadin\s+ustte)\b/i.test(normalizedPositionLabel);
  const declaredFamily = explicitCowgirlMetadata
    ? idFamily
    : (labelFamily || idFamily || '');
  const explicitNamedActionPosition = /\b(?:(?:kovboy|cowgirl|rider)(?:\s+pozisyon(?:u|unda)?)?|kadin\s+ustte|ters\s+(?:kovboy|cowgirl)|reverse\s+(?:cowgirl|rider)|misyoner|missionary|doggy(?:\s+style)?|prone[\s-]?bone|kasik|spoon|ayakta\s+arkadan)\b/iu.test(
    String(action.label || '')
  );
  const correctedFromAction = Boolean(
    declaredFamily && actionFamily && actionFamily !== declaredFamily && explicitNamedActionPosition
  );
  const textualFamily = correctedFromAction ? actionFamily : (declaredFamily || actionFamily || '');
  // Oral/manual identify the observed act itself. Body support alone cannot
  // turn either activity into missionary, prone-bone or another penetrative
  // position, so protect the verified act before structural inference.
  const protectedActivityFamily = activityIsVerified || ['oral', 'manual'].includes(labelFamily) ||
    ['oral', 'manual'].includes(idFamily)
    ? (activityIsVerified ? activityFamily : (labelFamily || idFamily))
    : '';
  const correctedFromStructure = Boolean(
    !protectedActivityFamily && structuralFamily && structuralFamily !== textualFamily
  );
  const family = protectedActivityFamily || structuralFamily || textualFamily;
  return {
    family,
    correctedFromAction: Boolean(protectedActivityFamily && protectedActivityFamily !== declaredFamily) ||
      correctedFromStructure || correctedFromAction || Boolean(!declaredFamily && actionFamily)
  };
}

export function movementBelongsToVerifiedPosition(action = {}, canonicalId = '') {
  const structuralFamily = adultPositionFamilyFromBodyConfiguration(action);
  if (structuralFamily && structuralFamily !== canonicalId) return false;
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
  const actionType = String(action.actionType || '').toLowerCase();
  if (['body_transition', 'partner_transition', 'camera_transition'].includes(actionType)) return false;
  return !/\b(gecis|transition|pozisyon(?:una|a)?\s+gec|pozisyon\s+degistir|ustune\s+cik|yuzustu\s+don|donerken|yonlendir)\b/.test(text);
}

export const DEFAULT_OUTCOME_UNLOCK_PROGRESS = 92;
export const DEFAULT_POSITION_UNLOCK_PROGRESS = 35;
export const DEFAULT_BONUS_UNLOCK_PROGRESS = 78;
export const MIN_CORE_PLAY_SECONDS_FOR_OUTCOME = 75;
export const MIN_VERIFIED_POSITION_SECONDS = 3;
export const FEMALE_ORGASM_CYCLE_SECONDS = 165;
export const MALE_ORGASM_CYCLE_SECONDS = 235;

export function isPlayableVerifiedPositionDuration(startTime, endTime) {
  const start = Number(startTime);
  const end = Number(endTime);
  return Number.isFinite(start) && Number.isFinite(end) &&
    end - start >= MIN_VERIFIED_POSITION_SECONDS;
}

export function adultPlaybackProgressDelta({
  elapsed = 0,
  maleRate = 1,
  femaleRate = 1,
  warmup = false
} = {}) {
  const seconds = clamp(elapsed, 0, 0.25);
  const safeMaleRate = clamp(maleRate, 0.25, 2.5);
  const safeFemaleRate = clamp(femaleRate, 0.25, 2.5);
  return {
    lust: seconds * (warmup ? 0.24 : 0.22) * safeFemaleRate,
    maleOrgasm: warmup ? 0 : seconds * (100 / MALE_ORGASM_CYCLE_SECONDS) * safeMaleRate,
    femaleOrgasm: warmup ? 0 : seconds * (100 / FEMALE_ORGASM_CYCLE_SECONDS) * safeFemaleRate
  };
}

export function shouldAdvanceMaleOrgasm(femaleProgress = 0, femaleOrgasmCount = 0) {
  return Math.max(0, Number(femaleOrgasmCount) || 0) > 0 ||
    clamp(femaleProgress, 0, 100) >= 35;
}

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
  { minSeconds = 10, maxVariants = 4, baseLabel = '', splitEachMovement = false } = {}
) {
  const start = Math.max(0, Number(positionStart) || 0);
  const end = Math.max(start, Number(positionEnd) || start);
  const minimum = Math.max(MIN_VERIFIED_POSITION_SECONDS, Number(minSeconds) || 10);
  const limit = Math.max(1, Math.min(24, Math.floor(Number(maxVariants) || 4)));
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

  if (splitEachMovement) {
    const variants = [];
    for (const item of source) {
      const itemStart = Number(item.loopStartTime);
      const itemEnd = Number(item.loopEndTime);
      const duration = itemEnd - itemStart;
      const desiredParts = duration >= 18 ? 3 : duration >= 10 ? 2 : 1;
      const partCount = Math.max(1, Math.min(desiredParts, Math.floor(duration / minimum)));
      for (let index = 0; index < partCount && variants.length < limit; index += 1) {
        const partStart = itemStart + (duration / partCount) * index;
        const partEnd = index === partCount - 1
          ? itemEnd
          : itemStart + (duration / partCount) * (index + 1);
        variants.push({
          ...item,
          id: `${item.id}:variant-${index + 1}-${Math.round(partStart * 1000)}`,
          label: partCount > 1
            ? `${String(item.label || baseLabel || 'Gerçek pozisyon hareketi').replace(/\s+·\s+(?:Bölüm|Sekans)\s+\d+$/iu, '')} · Sekans ${index + 1}`
            : item.label || baseLabel || 'Gerçek pozisyon hareketi',
          loopStartTime: partStart,
          loopEndTime: partEnd,
          sourceVerified: true,
          derivedFromVerifiedSegment: item.id
        });
      }
    }
    return variants;
  }

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
  const repeatFactor = Math.max(0.25, 1 - repeats * 0.2);
  const comboBonus = Math.min(1, Math.max(0, Number(comboCount) || 0) * 0.18);
  const base = 3 * repeatFactor + comboBonus;

  return {
    male: clamp(base * clamp(maleRate, 0.25, 2.5), 0.4, 7),
    female: clamp(base * clamp(femaleRate, 0.25, 2.5), 0.4, 7)
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
  const repeatFactor = Math.max(0.22, 1 - repeats * 0.22);
  const noveltyBonus =
    (positionNew ? 1.5 : 0) +
    (positionChanged ? 0.75 : 0) +
    (movementNew ? 2 : 0);
  const comboBonus = Math.min(1.5, Math.max(0, Number(comboCount) || 0) * 0.25);
  const base = 2 * repeatFactor + noveltyBonus + comboBonus;

  return {
    male: clamp(base * clamp(maleRate, 0.25, 2.5), 0.4, 9),
    female: clamp(base * clamp(femaleRate, 0.25, 2.5), 0.4, 9)
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

export function consolidateVerifiedPositions(positions = [], { mergeDistantReturns = false } = {}) {
  const clusters = [];
  const sorted = [...(Array.isArray(positions) ? positions : [])]
    .filter(position => position?.familyId)
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  for (const position of sorted) {
    if (!position?.familyId) continue;
    const partnerKey = String(position.partnerTrackId || '').trim() || 'partner-unknown';
    const role = String(position.progressionRole || '').trim();
    const route = Number(position.activityTypeConfidence || 0) >= 0.78
      ? String(position.activityType || '') : '';
    const routeSuffix = route && route !== 'unclear' ? `:${route}` : '';
    const roleSuffix = (role ? `:${role}` : '') + routeSuffix;
    const positionId = partnerKey === 'partner-unknown'
      ? `position:${position.familyId}${roleSuffix}`
      : `position:${position.familyId}:${partnerKey}${roleSuffix}`;
    const occurrenceId = partnerKey === 'partner-unknown'
      ? `${String(position.familyId)}${roleSuffix}`
      : `${position.familyId}:${partnerKey}${roleSuffix}`;
    const key = `${String(position.familyId)}::${partnerKey}::${role}::${routeSuffix}`;
    const sourceId = String(position.id || key);
    const movements = (Array.isArray(position.movements) ? position.movements : [])
      .map(movement => ({ ...movement, sourcePositionId: movement.sourcePositionId || sourceId }));
    // Keep separate continuous returns separate unless a caller explicitly
    // requests an encounter-wide summary. Playback uses the continuous form.
    const existing = [...clusters].reverse().find(item =>
      item.clusterKey === key && (
        mergeDistantReturns || Number(position.startTime) <= Number(item.endTime) + 0.25
      )
    );
    if (!existing) {
      const occurrenceNumber = clusters.filter(item => item.clusterKey === key).length + 1;
      clusters.push({
        ...position,
        id: occurrenceNumber === 1 ? positionId : `${positionId}:occ-${occurrenceNumber}`,
        occurrenceId: occurrenceNumber === 1 ? occurrenceId : `${occurrenceId}:occ-${occurrenceNumber}`,
        clusterKey: key,
        partnerTrackId: partnerKey === 'partner-unknown' ? '' : partnerKey,
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

  const consolidated = [];
  for (const position of clusters) {
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
    consolidated.push({
      ...position,
      startTime: Math.min(...ranges.map(range => range.startTime)),
      endTime: Math.max(...ranges.map(range => range.endTime)),
      sourcePositionIds: ranges.map(range => String(range.id)),
      sourceRanges: ranges,
      movements: position.movements,
      clusterKey: undefined
    });
  }
  return consolidated.sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

export function buildVerifiedMovementChoices(movements = [], positionLabel = '', maxChoices = 4) {
  const limit = Math.max(1, Math.min(16, Math.floor(Number(maxChoices) || 4)));
  const clean = value => String(value || '')
    .replace(/\s+·\s+Gerçek sekans$/iu, '')
    .replace(/\s+·\s+(?:Bölüm|Sekans)\s+\d+$/iu, '')
    .replace(/\s+sekansını oynat$/iu, ' oynat')
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

  // One canonical position can occur several times in the source. Group every
  // verified clip by its concrete action label so one tab can expose all real
  // returns to the same movement instead of silently keeping only occurrence 1.
  const occurrence = 'all-occurrences';
  const grouped = [];
  verified.forEach(item => {
    const key = normalize(item.label) || `${normalizeMovementTempo(item.movementTempo)}:${normalize(item.movementType)}`;
    const existing = grouped.find(group => group.key === key);
    if (existing) existing.items.push(item);
    else grouped.push({ key, items: [item] });
  });
  const cardGroups = grouped.slice(0, limit);
  grouped.slice(limit).forEach((group, index) => {
    cardGroups[index % cardGroups.length].items.push(...group.items);
  });
  const cards = [];

  for (let index = 0; index < cardGroups.length; index += 1) {
    const variants = [...cardGroups[index].items]
      .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
    const first = variants[0];
    const tempo = normalizeMovementTempo(first.movementTempo);
    const rawLabel = clean(first.label)
      .split('·')
      .map(part => part.trim())
      .filter(part => !/\b(?:nefes|bakis|gorunum|ses|duygu|saniye|sn|gercek\s+(?:kesit|sekans)|bagli\s+gercek)\b/iu.test(normalize(part)))
      .join(' · ')
      .trim();
    const normalizedRaw = normalize(rawLabel);
    const meaningfulLabel = rawLabel && normalizedRaw !== positionKey &&
      !normalizedRaw.startsWith(positionKey + ' ·') &&
      !/^(gercek hareket|gercek sekans|seçenek|secenek|option|choice|hareket)\s*\d*$/u.test(normalizedRaw);
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
      .sort((a, b) => Number(a.loopStartTime) - Number(b.loopStartTime));
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

export function summarizeMovementChoiceCoverage(choices = []) {
  const cards = Array.isArray(choices) ? choices : [];
  const variantIds = cards.flatMap(card =>
    (Array.isArray(card?.variants) ? card.variants : [])
      .map(variant => String(variant?.id || '').trim())
      .filter(Boolean)
  );
  return {
    choiceCount: cards.length,
    variantCount: variantIds.length,
    uniqueVariantCount: new Set(variantIds).size
  };
}

export function summarizeAdultSceneGraph(scenes = []) {
  const sceneReports = (Array.isArray(scenes) ? scenes : []).map(scene => {
    const positions = (Array.isArray(scene?.positions) ? scene.positions : []).map(position => ({
      id: String(position?.id || ''),
      familyId: String(position?.familyId || ''),
      occurrenceId: String(position?.occurrenceId || ''),
      label: String(position?.label || ''),
      startTime: Number(position?.startTime),
      endTime: Number(position?.endTime),
      duration: Number((Number(position?.endTime) - Number(position?.startTime)).toFixed(3)),
      sourcePositionIds: [...(position?.sourcePositionIds || [])].map(String),
      sourceRanges: (position?.sourceRanges || []).map(range => ({
        id: String(range?.id || ''),
        startTime: Number(range?.startTime),
        endTime: Number(range?.endTime)
      })),
      movementCount: Array.isArray(position?.movements) ? position.movements.length : 0,
      movementChoiceCount: Array.isArray(position?.movementChoices) ? position.movementChoices.length : 0,
      movementChoices: (position?.movementChoices || []).map(choice => ({
        id: String(choice?.id || ''),
        label: String(choice?.label || ''),
        sourcePositionId: String(choice?.sourcePositionId || ''),
        variantCount: Array.isArray(choice?.variants) ? choice.variants.length : 0,
        variants: (choice?.variants || []).map(variant => ({
          id: String(variant?.id || variant?.actionId || ''),
          label: String(variant?.label || ''),
          startTime: Number(variant?.loopStartTime ?? variant?.startTime),
          endTime: Number(variant?.loopEndTime ?? variant?.endTime),
          sourcePositionId: String(variant?.sourcePositionId || '')
        }))
      })),
      groupScene: position?.groupScene === true,
      partnerTrackId: String(position?.partnerTrackId || ''),
      partnerLabel: String(position?.partnerLabel || '')
    }));
    const familyGroups = new Map();
    positions.forEach(position => {
      const family = position.familyId || 'unknown';
      if (!familyGroups.has(family)) familyGroups.set(family, []);
      familyGroups.get(family).push(position);
    });
    const duplicateFamilies = [...familyGroups.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([familyId, items]) => ({
        familyId,
        tabCount: items.length,
        occurrences: items.map(item => ({
          id: item.id,
          occurrenceId: item.occurrenceId,
          startTime: item.startTime,
          endTime: item.endTime,
          sourcePositionIds: item.sourcePositionIds
        }))
      }));
    return {
      id: String(scene?.id || ''),
      startTime: Number(scene?.startTime),
      endTime: Number(scene?.endTime),
      positionCount: positions.length,
      movementCount: positions.reduce((sum, item) => sum + item.movementCount, 0),
      movementChoiceCount: positions.reduce((sum, item) => sum + item.movementChoiceCount, 0),
      duplicateFamilies,
      positions
    };
  });
  return {
    sceneCount: sceneReports.length,
    positionCount: sceneReports.reduce((sum, scene) => sum + scene.positionCount, 0),
    movementCount: sceneReports.reduce((sum, scene) => sum + scene.movementCount, 0),
    movementChoiceCount: sceneReports.reduce((sum, scene) => sum + scene.movementChoiceCount, 0),
    duplicateFamilies: sceneReports.flatMap(scene =>
      scene.duplicateFamilies.map(item => ({ sceneId: scene.id, ...item }))
    ),
    scenes: sceneReports
  };
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
