import { verifiedOccurrenceRanges, interactionClipGuard, interactionEntryClip, interactionEntryGuard } from './interaction-timeline.js';

export const INTERACTION_PHASES = Object.freeze(['APPROACH', 'CORE', 'OUTCOME', 'AFTERMATH']);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const phaseOf = row => INTERACTION_PHASES.includes(row?.phase) ? row.phase : null;
const rangesOf = row => row?.sourceVerified === true ? verifiedOccurrenceRanges(row) : [];
const startOf = row => Math.min(...rangesOf(row).map(range => range.startTime));
const addId = (ids, id) => [...new Set([...ids, id])];
const asList = value => Array.isArray(value) ? value : [];
const finiteTime = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value) : null;
const sourceKey = range => JSON.stringify([range.id, range.occurrenceId]);
const sceneIndexes = new WeakMap();

// A normalized scene is a source snapshot. Index it once, then reuse the same
// intervals for playback ticks, source identities, and trace diagnostics.
function interactionSceneIndex(scene) {
  const cached = sceneIndexes.get(scene);
  if (cached) return cached;
  const entries = [], rangesByRow = new Map(), firstStartById = new Map();
  const groupRows = new Set(scene.groups), groupById = new Map(), choiceById = new Map();
  const movementOwnerById = new Map(), movementById = new Map(), coreGroups = [], coreGroupIds = new Set();
  for (const group of scene.groups) {
    if (!groupById.has(group.id)) groupById.set(group.id, group);
    for (const movement of asList(group.movements)) {
      if (!movementOwnerById.has(movement.id)) movementOwnerById.set(movement.id, group);
      if (!movementById.has(movement.id)) movementById.set(movement.id, movement);
    }
  }
  for (const choice of scene.choices) if (!choiceById.has(choice.id)) choiceById.set(choice.id, choice);
  for (const row of [...scene.choices, ...scene.groups]) {
    const ranges = rangesOf(row);
    rangesByRow.set(row, ranges);
    if (!firstStartById.has(row.id)) firstStartById.set(row.id,
      ranges.length ? Math.min(...ranges.map(range => range.startTime)) : Infinity);
    for (const range of ranges) entries.push({ row, range, isGroup: groupRows.has(row), order: entries.length });
    if (groupRows.has(row) && row.phase === 'CORE' && ranges.length) {
      coreGroups.push(row); coreGroupIds.add(row.id);
    }
  }
  const byStart = [...entries].sort((a, b) => a.range.startTime - b.range.startTime || a.order - b.order);
  let latestEnd = -Infinity;
  const prefixEndTimes = byStart.map(entry => latestEnd = Math.max(latestEnd, entry.range.endTime));
  const byEnd = [...entries].sort((a, b) => a.range.endTime - b.range.endTime || b.order - a.order);
  coreGroups.sort((a, b) => firstStartById.get(a.id) - firstStartById.get(b.id));
  const index = { entries, byStart, prefixEndTimes, byEnd, rangesByRow, firstStartById,
    groupById, choiceById, movementById, movementOwnerById, coreGroups, coreGroupIds };
  sceneIndexes.set(scene, index);
  return index;
}

function indexedSourceAt(index, currentTime) {
  let low = 0, high = index.byStart.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.prefixEndTimes[middle] <= currentTime) low = middle + 1;
    else high = middle;
  }
  const matching = [];
  for (let cursor = low; cursor < index.byStart.length && index.byStart[cursor].range.startTime <= currentTime; cursor += 1) {
    const entry = index.byStart[cursor];
    if (entry.range.endTime > currentTime) matching.push(entry);
  }
  matching.sort((a, b) => b.range.startTime - a.range.startTime || a.order - b.order);
  low = 0; high = index.byEnd.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.byEnd[middle].range.endTime <= currentTime) low = middle + 1;
    else high = middle;
  }
  return { matching, previous: index.byEnd[low - 1] };
}

function intervalUnion(intervals = []) {
  const sorted = intervals.filter(interval => finiteTime(interval?.startTime) !== null &&
    finiteTime(interval?.endTime) !== null && Number(interval.endTime) > Number(interval.startTime))
    .map(interval => ({ startTime: Number(interval.startTime), endTime: Number(interval.endTime) }))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const result = [];
  for (const interval of sorted) {
    const previous = result[result.length - 1];
    if (previous && interval.startTime <= previous.endTime) previous.endTime = Math.max(previous.endTime, interval.endTime);
    else result.push({ ...interval });
  }
  return result;
}

const intervalDuration = intervals => intervalUnion(intervals)
  .reduce((total, interval) => total + interval.endTime - interval.startTime, 0);

function withoutIntervals(interval, excluded) {
  let remaining = [interval];
  for (const exclusion of excluded) {
    remaining = remaining.flatMap(part => {
      if (exclusion.endTime <= part.startTime || exclusion.startTime >= part.endTime) return [part];
      const pieces = [];
      if (exclusion.startTime > part.startTime) pieces.push({ ...part, endTime: exclusion.startTime });
      if (exclusion.endTime < part.endTime) pieces.push({ ...part, startTime: exclusion.endTime });
      return pieces;
    });
  }
  return remaining;
}

function permittedChoiceRanges(source, row) {
  const index = interactionSceneIndex(source);
  const owner = row.groupId ? index.groupById.get(row.groupId) : index.movementOwnerById.get(row.id);
  if (row.groupId && !owner) return [];
  if (owner?.progressionEnabled === false) return [];
  return (index.rangesByRow.get(row) || rangesOf(row)).filter(range => !owner || interactionClipGuard(owner, {
    ...row, startTime: range.startTime, endTime: range.endTime,
    sourcePositionId: row.sourcePositionId || range.id,
    sourceOccurrenceId: row.sourceOccurrenceId || range.occurrenceId
  }).allowed);
}

// The budget is indexed by verified source intervals. Labels and action names
// never participate in identity, duration, eligibility, or progress calculations.
export function createInteractionProgressBudget(scene, { selectionWeight = 0.2 } = {}) {
  const source = normalizeInteractionScene(scene);
  const coreStarts = source.groups.filter(row => row.phase === 'CORE').flatMap(rangesOf)
    .map(range => range.startTime);
  const firstCoreTime = coreStarts.length ? Math.min(...coreStarts) : null;
  const approach = [...source.choices, ...source.groups].filter(row => row.phase === 'APPROACH');
  const excluded = intervalUnion(approach.filter(row => row.progressionEnabled === false).flatMap(rangesOf));
  const seen = new Set();
  const entries = approach.filter(row => row.progressionEnabled !== false).flatMap(row =>
    permittedChoiceRanges(source, row).flatMap(range => {
      const endTime = firstCoreTime === null ? range.endTime : Math.min(range.endTime, firstCoreTime);
      if (endTime <= range.startTime) return [];
      return withoutIntervals({ ...range, endTime }, excluded).flatMap(part => {
        const key = JSON.stringify([part.id, part.occurrenceId, part.startTime, part.endTime]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...part, key, sourceKey: sourceKey(part), ownerId: row.id }];
      });
    })).sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  let latestEnd = -Infinity;
  const prefixEndTimes = entries.map(range => latestEnd = Math.max(latestEnd, range.endTime));
  const intervals = intervalUnion(entries);
  const openingStartTime = intervals[0]?.startTime ?? null;
  const openingEndTime = intervals[intervals.length - 1]?.endTime ?? null;
  return {
    entries, prefixEndTimes, intervals, firstCoreTime, openingStartTime, openingEndTime,
    verifiedDuration: intervalDuration(intervals), verifiedChoiceCount: entries.length,
    openingDuration: openingStartTime === null ? 0 : Math.max(0,
      (firstCoreTime ?? openingEndTime) - openingStartTime),
    selectionWeight: clamp(selectionWeight, 0, 1)
  };
}

function budgetEntriesAt(budget, startTime, endTime) {
  const entries = asList(budget?.entries);
  const prefix = asList(budget?.prefixEndTimes);
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (prefix[middle] <= startTime) low = middle + 1;
    else high = middle;
  }
  const result = [];
  for (let index = low; index < entries.length && entries[index].startTime < endTime; index += 1) {
    if (entries[index].endTime > startTime) result.push(entries[index]);
  }
  return result;
}

function verifiedCoverage(budget, observations) {
  return asList(observations).flatMap(observation => {
    const startTime = finiteTime(observation?.startTime), endTime = finiteTime(observation?.endTime);
    if (startTime === null || endTime === null || endTime <= startTime || observation?.playing === false || observation?.seek === true) return [];
    return budgetEntriesAt(budget, startTime, endTime).filter(entry =>
      (!observation.sourcePositionId || observation.sourcePositionId === entry.id) &&
      (!observation.sourceOccurrenceId || observation.sourceOccurrenceId === entry.occurrenceId) &&
      (!observation.sourceKey || observation.sourceKey === entry.sourceKey))
      .map(entry => ({ startTime: Math.max(startTime, entry.startTime), endTime: Math.min(endTime, entry.endTime),
        sourcePositionId: entry.id, sourceOccurrenceId: entry.occurrenceId, sourceKey: entry.sourceKey }));
  });
}

function compactCoverage(intervals) {
  const buckets = new Map();
  for (const interval of intervals) {
    const key = interval.sourceKey;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(interval);
  }
  return [...buckets.values()].flatMap(bucket => intervalUnion(bucket).map(interval => ({
    ...interval, sourceKey: bucket[0].sourceKey,
    sourcePositionId: bucket[0].sourcePositionId, sourceOccurrenceId: bucket[0].sourceOccurrenceId
  })));
}

export function computeInteractionProgress(budget, observations = {}) {
  const played = verifiedCoverage(budget, observations.playedRanges);
  const selected = verifiedCoverage(budget, observations.selectedRanges);
  const playedDuration = intervalDuration(played), selectedDuration = intervalDuration(selected);
  const total = Math.max(0, Number(budget?.verifiedDuration) || 0);
  const observedEndTime = played.length || selected.length
    ? Math.max(...[...played, ...selected].map(range => range.endTime)) : budget?.openingStartTime;
  const span = Math.max(0, Number(budget?.openingDuration) || 0);
  const frontierFraction = span > 0 && observedEndTime !== null
    ? clamp((observedEndTime - budget.openingStartTime) / span, 0, 1) : 0;
  const coverageValue = total > 0 ? 100 * (playedDuration + selectedDuration * budget.selectionWeight) / total : 0;
  // A future seek or a repeated interval cannot move this frontier. The final
  // verified CORE boundary is the authoritative transition to a full budget.
  const progressionValue = observations.coreBoundaryObserved === true ? 100 :
    clamp(Math.min(coverageValue, frontierFraction * 100, budget?.firstCoreTime === null ? 100 : 99), 0, 100);
  return { progressionValue, playedDuration, selectedDuration, observedEndTime,
    verifiedDuration: total, frontierFraction };
}

const emptyProgressObservations = () => ({ playedRanges: [], selectedRanges: [], coreBoundaryObserved: false });

export function observeInteractionPlayback(state, observation = {}) {
  if (!state.progressBudget || state.progressBudgetConsumed || observation.playing === false || observation.seek === true) return state;
  const verified = verifiedCoverage(state.progressBudget, [observation]);
  if (!verified.length) return state;
  const previous = state.progressObservations || emptyProgressObservations();
  const progressObservations = { ...previous,
    playedRanges: compactCoverage([...previous.playedRanges, ...verified]) };
  const progress = computeInteractionProgress(state.progressBudget, progressObservations);
  return normalizeInteractionRuntime({ ...state, progressObservations,
    progressionValue: Math.max(state.progressionValue, progress.progressionValue) });
}

// Completion is supplied only after the source clip actually finishes. Merely
// requesting a selection, seeking, or having play() rejected provides no credit.
export function completeInteractionSelection(state, choiceId, observation = {}) {
  if (!state.progressBudget || state.progressBudgetConsumed || observation.playing === false || observation.seek === true) return state;
  const choice = state.scene.choices.find(row => row.id === choiceId) ||
    state.scene.groups.flatMap(group => asList(group.movements)).find(row => row.id === choiceId);
  if (!choice || choice.progressionEnabled === false || choice.sourceVerified !== true) return state;
  const ranges = permittedChoiceRanges(state.scene, choice);
  const requestedOccurrence = observation.sourceOccurrenceId || observation.occurrenceId;
  const selected = ranges.find(range => (!requestedOccurrence || requestedOccurrence === range.occurrenceId) &&
    (!observation.sourcePositionId || observation.sourcePositionId === range.id) &&
    (finiteTime(observation.startTime) === null || (Number(observation.startTime) >= range.startTime - 0.05 &&
      Number(observation.startTime) < range.endTime)) &&
    (finiteTime(observation.endTime) === null || Number(observation.endTime) >= range.endTime - 0.05));
  if (!selected) return state;
  const credit = verifiedCoverage(state.progressBudget, [{ ...selected,
    sourcePositionId: selected.id, sourceOccurrenceId: selected.occurrenceId }]);
  if (!credit.length) return state;
  const previous = state.progressObservations || emptyProgressObservations();
  const progressObservations = { ...previous,
    selectedRanges: compactCoverage([...previous.selectedRanges, ...credit]) };
  const progress = computeInteractionProgress(state.progressBudget, progressObservations);
  return normalizeInteractionRuntime({ ...state, progressObservations,
    progressionValue: Math.max(state.progressionValue, progress.progressionValue),
    choicePlayCounts: { ...state.choicePlayCounts, [choiceId]: (Number(state.choicePlayCounts[choiceId]) || 0) + 1 } });
}

// The engine reads phase/identity metadata; it never assigns a phase from an
// action label. Invalid or unverified records remain outside the playable set.
export function normalizeInteractionScene(scene = {}) {
  const groups = (Array.isArray(scene.groups) ? scene.groups : [])
    .filter(group => group?.id && phaseOf(group) && rangesOf(group).length)
    .sort((left, right) => startOf(left) - startOf(right));
  const choices = (Array.isArray(scene.choices) ? scene.choices : [])
    .filter(choice => choice?.id && phaseOf(choice) && rangesOf(choice).length)
    .sort((left, right) => startOf(left) - startOf(right));
  return { ...scene, groups, choices };
}

export function progressionPacing({
  openingStartTime = 0, firstCoreTime = null, openingDuration = null,
  verifiedChoiceCount = 0, playbackPointsPerSecond = 1.25,
  selectionPoints = 12.5, target = 100
} = {}) {
  const measuredDuration = openingDuration == null
    ? (firstCoreTime == null ? 0 : Number(firstCoreTime) - Number(openingStartTime)) : Number(openingDuration);
  const duration = Math.max(0, Number.isFinite(measuredDuration) ? measuredDuration : 0);
  const count = Math.max(0, Math.floor(Number(verifiedChoiceCount) || 0));
  const expectedProgress = duration * Math.max(0, Number(playbackPointsPerSecond) || 0) +
    count * Math.max(0, Number(selectionPoints) || 0);
  const scale = expectedProgress > 0 ? Math.min(1, Math.max(0, Number(target) || 0) / expectedProgress) : 1;
  return { scale, openingDuration: duration, verifiedChoiceCount: count };
}

export function interactionProgressPacing(scene, {
  normalOpeningSeconds = 40, normalChoiceCount = 4, ...options
} = {}) {
  const source = normalizeInteractionScene(scene);
  const firstCoreTime = Math.min(...source.groups.filter(group => group.phase === 'CORE').map(startOf));
  const opening = source.choices.filter(choice => choice.phase === 'APPROACH' && choice.progressionEnabled !== false &&
    (!Number.isFinite(firstCoreTime) || startOf(choice) < firstCoreTime));
  const openingStart = Math.min(...opening.map(startOf));
  const openingEnd = Math.max(...opening.flatMap(rangesOf).map(range => range.endTime));
  const end = Number.isFinite(firstCoreTime) ? firstCoreTime : openingEnd;
  const openingDuration = Number.isFinite(openingStart) && Number.isFinite(end)
    ? Math.max(0, end - openingStart) : 0;
  const { scale } = progressionPacing({
    openingDuration, verifiedChoiceCount: opening.length,
    playbackPointsPerSecond: 50 / Math.max(1, Number(normalOpeningSeconds) || 40),
    selectionPoints: 50 / Math.max(1, Number(normalChoiceCount) || 4), ...options
  });
  return {
    progressionScale: scale, openingDuration,
    verifiedChoiceCount: opening.length,
    firstCoreTime: Number.isFinite(firstCoreTime) ? firstCoreTime : null
  };
}

export function createInteractionState(scene, { currentTime = 0, ...options } = {}) {
  const source = normalizeInteractionScene(scene);
  const pacing = interactionProgressPacing(source, options);
  const state = {
    scene: source, options, currentTime: Math.max(0, Number(currentTime) || 0),
    currentPhase: 'APPROACH', sourcePhase: 'APPROACH', progressionValue: 0,
    ...pacing, unlockedGroupIds: [], revealedGroupIds: [],
    activeGroupId: null, activeOccurrenceId: null, activeMovementId: null,
    pendingSelection: null, rhythm: { held: false, taps: 0 },
    choicePlayCounts: {}, unlockReason: null, lastSeekTarget: null,
    blockedSeekReason: null, panelVisible: Boolean(source.groups.length || source.choices.length),
    activeSourceRange: null, activeSourceGroupId: null,
    progressBudget: options.progressBudget ? createInteractionProgressBudget(source, options) : null,
    progressObservations: emptyProgressObservations(), progressBudgetConsumed: false
  };
  return advanceInteraction(state, state.currentTime);
}

export function switchInteractionScene(_state, scene, currentTime = 0, options = {}) {
  return createInteractionState(scene, { ...options, currentTime });
}

export function unlockNextCoreGroup(state, reason = 'progress-full') {
  const index = interactionSceneIndex(state.scene);
  const core = index.coreGroups;
  const activeIndex = core.findIndex(group => group.id === state.activeGroupId);
  const candidates = activeIndex >= 0 ? core.slice(activeIndex + 1) : core.filter(group =>
    index.rangesByRow.get(group).some(range => range.endTime > state.currentTime));
  const next = candidates.find(group => !state.unlockedGroupIds.includes(group.id));
  if (!next) return state;
  return {
    ...state, currentPhase: 'CORE', panelVisible: true, unlockReason: reason,
    progressBudgetConsumed: Boolean(state.progressBudget) || state.progressBudgetConsumed,
    unlockedGroupIds: addId(state.unlockedGroupIds, next.id),
    revealedGroupIds: addId(state.revealedGroupIds, next.id)
  };
}

// Call after source playback has actually begun/completed, rather than while a
// seek is pending. A rejected media play must not grant interaction progress.
export function progressForSelection(state, choiceId, baseIncrement = 25) {
  if (state.progressBudget) return completeInteractionSelection(state, choiceId);
  const choice = state.scene.choices.find(row => row.id === choiceId) ||
    state.scene.groups.flatMap(group => group.movements || []).find(row => row.id === choiceId);
  if (!choice || choice.sourceVerified !== true || !rangesOf(choice).length) return state;
  if (choice.progressionEnabled === false) return state;
  const owner = choice.groupId ? state.scene.groups.find(group => group.id === choice.groupId)
    : state.scene.groups.find(group => (group.movements || []).includes(choice));
  if (choice.groupId && !owner) return state;
  if (owner) {
    const range = rangesOf(choice)[0];
    const observed = { ...choice, startTime: range.startTime, endTime: range.endTime,
      sourcePositionId: choice.sourcePositionId || range.id,
      sourceOccurrenceId: choice.sourceOccurrenceId || range.occurrenceId };
    if (!interactionClipGuard(owner, observed).allowed) return state;
  }
  const previous = Math.max(0, Number(state.choicePlayCounts[choiceId]) || 0);
  const repeatScale = previous === 0 ? 1 : Math.max(0.1, 0.5 / Math.sqrt(previous));
  const pacing = choice.phase === 'APPROACH' ? state.progressionScale : 1;
  const next = {
    ...state,
    progressionValue: clamp(state.progressionValue + Math.max(0, Number(baseIncrement) || 0) * pacing * repeatScale, 0, 100),
    choicePlayCounts: { ...state.choicePlayCounts, [choiceId]: previous + 1 }
  };
  return state.progressionValue < 100 && next.progressionValue >= 100 ? unlockNextCoreGroup(next) : next;
}

export function advanceInteraction(state, requestedTime, options = {}) {
  const currentTime = Math.max(0, Number(requestedTime) || 0);
  const rewind = options.rewind ?? currentTime < state.currentTime - 0.05;
  const index = interactionSceneIndex(state.scene);
  const { matching, previous } = indexedSourceAt(index, currentTime);
  const group = matching.find(item => item.isGroup && item.row.phase !== 'APPROACH') ||
    matching.find(item => item.isGroup);
  const found = matching.find(item => ['OUTCOME', 'AFTERMATH'].includes(item.row.phase)) ||
    (group?.row.phase === 'CORE' ? group : matching[0]);
  const previousPhase = phaseOf(previous?.row);
  // Terminal phases require an actual verified boundary observation. A seek
  // into a gap after their metadata must not itself invent that transition.
  const gapPhase = rewind
    ? (previousPhase === 'CORE' || previousPhase === 'APPROACH' ? previousPhase : 'APPROACH')
    : state.sourcePhase;
  const sourcePhase = phaseOf(found?.row) || gapPhase || 'APPROACH';
  let next = {
    ...state, currentTime, sourcePhase,
    currentPhase: rewind || sourcePhase !== 'APPROACH' || state.currentPhase !== 'CORE'
      ? sourcePhase : state.currentPhase
  };
  if (rewind) {
    const progressObservations = state.progressBudget ? {
      ...(state.progressObservations || emptyProgressObservations()), coreBoundaryObserved: false,
      playedRanges: asList(state.progressObservations?.playedRanges).filter(range => range.startTime < currentTime)
        .map(range => ({ ...range, endTime: Math.min(range.endTime, currentTime) })),
      selectedRanges: asList(state.progressObservations?.selectedRanges).filter(range => range.endTime <= currentTime)
    } : state.progressObservations;
    next = {
      ...next, activeGroupId: group?.row.id || null,
      activeOccurrenceId: group?.range.occurrenceId || null,
      activeMovementId: null, pendingSelection: null, rhythm: { held: false, taps: 0 },
      choicePlayCounts: Object.fromEntries(Object.entries(state.choicePlayCounts)
        .filter(([id]) => (index.firstStartById.get(id) ?? startOf(index.movementById.get(id) || {})) <= currentTime)),
      ...(sourcePhase === 'APPROACH' ? {
        progressObservations,
        progressionValue: state.progressBudget ? computeInteractionProgress(state.progressBudget, progressObservations).progressionValue
          : state.progressionValue >= 100 ? 0 : state.progressionValue,
        progressBudgetConsumed: false
      } : {})
    };
  }
  if (group) {
    const interlude = !rewind && group.row.phase === 'APPROACH' && next.currentPhase === 'CORE';
    const changedGroup = next.activeGroupId !== group.row.id;
    next = {
      ...next, currentPhase: interlude ? 'CORE' : phaseOf(found?.row) || group.row.phase,
      activeSourceRange: { ...group.range }, activeSourceGroupId: group.row.id,
      ...(interlude ? {} : { activeGroupId: group.row.id, activeOccurrenceId: group.range.occurrenceId }),
      panelVisible: true,
      ...(changedGroup && !interlude ? { activeMovementId: null, pendingSelection: null, rhythm: { held: false, taps: 0 } } : {}),
      ...(group.row.phase === 'CORE' ? {
        unlockedGroupIds: addId(next.unlockedGroupIds, group.row.id),
        revealedGroupIds: addId(next.revealedGroupIds, group.row.id),
        unlockReason: state.unlockedGroupIds.includes(group.row.id) ? state.unlockReason : 'source-boundary',
        ...(state.progressBudget && !next.progressBudgetConsumed ? {
          progressionValue: 100, progressBudgetConsumed: true,
          progressObservations: { ...next.progressObservations, coreBoundaryObserved: true }
        } : {})
      } : {})
    };
  } else {
    next = { ...next, activeSourceRange: found ? { ...found.range } : null,
      activeSourceGroupId: found?.row.id || null };
  }
  return normalizeInteractionRuntime(next);
}

// This is the authoritative phase invariant, including for adapters that still
// publish compatibility aliases. An APPROACH override cannot hide earned CORE.
export function normalizeInteractionRuntime(state) {
  let next = { ...state, progressionValue: clamp(state.progressionValue, 0, 100) };
  const terminal = ['OUTCOME', 'AFTERMATH'].includes(next.sourcePhase) || next.outcomeActive === true ||
    (next.outcomePhase && next.outcomePhase !== 'idle');
  if (next.progressionValue < 100 || terminal) return next;
  const coreGroupIds = interactionSceneIndex(next.scene).coreGroupIds;
  const unlockedCore = next.unlockedGroupIds.some(id => coreGroupIds.has(id));
  if (!unlockedCore) next = unlockNextCoreGroup(next);
  if (next.unlockedGroupIds.some(id => coreGroupIds.has(id))) {
    next = { ...next, currentPhase: 'CORE', panelVisible: true,
      progressBudgetConsumed: Boolean(next.progressBudget) || next.progressBudgetConsumed };
  }
  return next;
}

// Events never seek media. source-time is a source observation; only an explicit
// rewind event resets opening progress. playback and selection-complete consume
// the opt-in opening budget once, leaving later CORE gates to their own progress.
export function transitionInteraction(state, event = {}) {
  switch (event.type) {
    case 'source-time': return advanceInteraction(state, event.currentTime, { rewind: event.rewind === true });
    case 'playback': return observeInteractionPlayback(state, event);
    case 'selection-complete': return completeInteractionSelection(state, event.choiceId, event);
    case 'progress': return normalizeInteractionRuntime({ ...state, progressionValue: event.value === undefined
      ? state.progressionValue + (Number(event.increment) || 0) : event.value });
    case 'unlock-core': return normalizeInteractionRuntime(unlockNextCoreGroup(state, event.reason));
    case 'select-group': return selectInteractionGroup(state, event.groupId).state;
    case 'select-choice': return selectInteractionChoice(state, event.choiceId, event.options).state;
    default: return normalizeInteractionRuntime(state);
  }
}

export function visibleApproachChoices(state, { forwardWindowSeconds = 30 } = {}) {
  // A configurable window is bounded so a UI setting cannot expose a distant
  // source event. Include the active clip's end to prepare its immediate next.
  const window = clamp(forwardWindowSeconds, 0, 60);
  const activeEnd = Number(state.pendingSelection?.endTime);
  const cursor = Math.max(state.currentTime, Number.isFinite(activeEnd) ? activeEnd : state.currentTime);
  const horizon = Math.min(state.currentTime + 60, cursor + window);
  return state.scene.choices.filter(choice => choice.phase === 'APPROACH' &&
    rangesOf(choice).some(range => range.endTime > state.currentTime && range.startTime <= horizon));
}

const opaqueIdentity = value => String(value ?? '').trim();
function queueCastIdentity(row = {}) {
  const declared = row.castIds ?? row.characterIds ?? row.participantIds;
  const identities = Array.isArray(declared) ? declared :
    [row.subjectId ?? row.subjectTrackId, row.partnerId ?? row.partnerTrackId];
  return [...new Set(identities.map(opaqueIdentity).filter(Boolean))].sort().join('\u0000');
}
const queueChainIdentity = row => opaqueIdentity(row?.chainId ?? row?.sourceChainId ?? row?.continuityId);
function queueSourceRanges(row) {
  const verified = rangesOf(row);
  if (verified.length) return verified;
  const startTime = finiteTime(row?.startTime), endTime = finiteTime(row?.endTime);
  return row?.sourceVerified === true && !asList(row.sourceRanges).length && startTime !== null && endTime !== null && endTime > startTime
    ? [{ id: row.id, occurrenceId: row.occurrenceId || row.id, startTime, endTime }] : [];
}

// Discovery follows successive verified intervals, rather than making a fixed
// window the sole criterion. Opaque cast/chain IDs fence the queue, and the
// absolute 60-second bound remains in force even for a very long active clip.
export function selectVerifiedChoiceQueue(candidates = [], {
  timelineFloor = 0, activeEndTime = null, limit = 5, maxForwardSeconds = 60,
  adjacencyGapSeconds = 2, firstCoreTime = null, castIds = null, chainId = null,
  activeChoiceId = null, choicePlayCounts = {}
} = {}) {
  const floor = Math.max(0, Number(timelineFloor) || 0);
  const safetyEnd = floor + clamp(maxForwardSeconds, 0, 60);
  const coreStart = finiteTime(firstCoreTime);
  const horizon = coreStart === null ? safetyEnd : Math.min(safetyEnd, coreStart);
  const gap = clamp(adjacencyGapSeconds, 0, 2);
  const count = Math.max(1, Math.min(5, Math.floor(Number(limit) || 5)));
  const rows = asList(candidates).flatMap(row => queueSourceRanges(row)
    .filter(range => range.endTime > floor + 0.05 && range.startTime <= horizon &&
      (coreStart === null || range.startTime < coreStart))
    .map(range => ({ row, range, cast: queueCastIdentity(row), chain: queueChainIdentity(row) })))
    .sort((a, b) => a.range.startTime - b.range.startTime || a.range.endTime - b.range.endTime);
  if (!rows.length) return [];
  const active = rows.find(item => item.row.id === activeChoiceId);
  const seed = active || rows[0];
  const cast = castIds === null ? seed.cast : queueCastIdentity({ castIds });
  const chain = chainId === null ? seed.chain : opaqueIdentity(chainId);
  const compatible = rows.filter(item => (!cast || item.cast === cast) && (!chain || item.chain === chain));
  let frontier = Math.min(horizon, Math.max(floor, finiteTime(activeEndTime) ?? floor, seed.range.startTime));
  const reachable = [];
  const seenRanges = new Set(), seenRows = new Set();
  for (const item of compatible) {
    if (item.range.startTime > frontier + gap) break;
    frontier = Math.min(horizon, Math.max(frontier, item.range.endTime));
    // A duplicate source interval under another UI ID is still one choice.
    const rangeKey = JSON.stringify([item.range.id, item.range.occurrenceId, item.range.startTime, item.range.endTime]);
    const rowKey = JSON.stringify([item.row.id, item.row.movementId, item.row.occurrenceId]);
    if (seenRanges.has(rangeKey) || seenRows.has(rowKey)) continue;
    seenRanges.add(rangeKey); seenRows.add(rowKey);
    reachable.push(item);
  }
  const plays = item => Math.max(0, Number(choicePlayCounts[item.row.id] ?? item.row.playCount) || 0);
  const fresh = reachable.filter(item => plays(item) === 0);
  const repeated = reachable.filter(item => plays(item) > 0)
    .sort((a, b) => plays(a) - plays(b) || a.range.startTime - b.range.startTime);
  // Do not keep a completed clip on screen while a new verified chronological
  // choice is available. Repeats are a fallback only after the reachable fresh
  // queue is exhausted, preventing one early clip from appearing to loop forever.
  const pool = fresh.length ? fresh : repeated;
  return pool.slice(0, count).map(item => item.row);
}

const blockedSelection = (state, reason) => ({
  state: { ...state, blockedSeekReason: reason }, target: null, blockedReason: reason
});

export function selectInteractionGroup(state, groupId) {
  const group = state.scene.groups.find(row => row.id === groupId);
  if (!group) return blockedSelection(state, 'unverified-group');
  if (group.phase === 'CORE' && !state.unlockedGroupIds.includes(groupId))
    return blockedSelection(state, 'locked-group');
  const entry = interactionEntryClip(group);
  if (!entry) return blockedSelection(state, 'missing-verified-entry');
  const guard = interactionEntryGuard(group, entry);
  if (!guard.allowed) return blockedSelection(state, guard.reason);
  const target = { ...entry, occurrenceId: guard.sourceRange.occurrenceId };
  return {
    state: {
      ...state, currentPhase: ['OUTCOME', 'AFTERMATH'].includes(group.phase) ? state.currentPhase : group.phase,
      activeGroupId: groupId,
      activeOccurrenceId: guard.coreOccurrenceId || target.occurrenceId, activeMovementId: null,
      progressionValue: !state.progressBudget && state.activeGroupId !== groupId ? 0 : state.progressionValue,
      pendingSelection: target, lastSeekTarget: target.startTime,
      blockedSeekReason: null, panelVisible: true
    }, target, blockedReason: null
  };
}

export function selectInteractionChoice(state, choiceId, options = {}) {
  const choice = state.scene.choices.find(row => row.id === choiceId);
  if (!choice) return blockedSelection(state, 'unverified-choice');
  if (choice.phase === 'APPROACH' && !visibleApproachChoices(state, options).includes(choice))
    return blockedSelection(state, 'outside-approach-window');
  const group = choice.groupId ? state.scene.groups.find(row => row.id === choice.groupId) : choice;
  if (!group) return blockedSelection(state, 'missing-source-group');
  if (group.phase === 'CORE' && !state.unlockedGroupIds.includes(group.id))
    return blockedSelection(state, 'locked-group');
  const choiceRanges = rangesOf(choice);
  const requestedOccurrence = options.occurrenceId || options.sourceOccurrenceId;
  const range = choiceRanges.find(item => (!requestedOccurrence || requestedOccurrence === item.occurrenceId) &&
    (choice.phase !== 'APPROACH' || item.endTime > state.currentTime)) ||
    (!requestedOccurrence && choice.phase !== 'APPROACH' ? choiceRanges[0] : null);
  if (!range) return blockedSelection(state, 'unverified-choice');
  const target = {
    ...range, sourceVerified: true, sourcePositionId: choice.sourcePositionId || range.id,
    sourceOccurrenceId: choice.sourceOccurrenceId || range.occurrenceId,
    occurrenceId: choice.occurrenceId || range.occurrenceId
  };
  const guard = interactionClipGuard(group, target, { occurrenceId: target.occurrenceId });
  if (!guard.allowed) return blockedSelection(state, guard.reason);
  return {
    state: {
      ...state, activeGroupId: choice.groupId || null,
      activeOccurrenceId: guard.sourceRange.occurrenceId, activeMovementId: choice.id,
      pendingSelection: target, lastSeekTarget: target.startTime,
      blockedSeekReason: null, panelVisible: true
    }, target, blockedReason: null
  };
}

export function interactionTrace(state, { overlayCount = 0, playbackBlocked = false, playbackFailureReason = null } = {}) {
  const index = interactionSceneIndex(state.scene);
  const budget = state.progressBudget || createInteractionProgressBudget(state.scene);
  const observations = state.progressObservations || emptyProgressObservations();
  const observedCoverage = [...verifiedCoverage(budget, observations.playedRanges),
    ...verifiedCoverage(budget, observations.selectedRanges)];
  const coverageBySource = new Map();
  for (const interval of observedCoverage) {
    if (!coverageBySource.has(interval.sourceKey)) coverageBySource.set(interval.sourceKey, []);
    coverageBySource.get(interval.sourceKey).push(interval);
  }
  const entriesByOwner = new Map();
  for (const entry of budget.entries) entriesByOwner.set(entry.ownerId, (entriesByOwner.get(entry.ownerId) || 0) + 1);
  const played = budget.entries.filter(entry => {
    const coverage = asList(coverageBySource.get(entry.sourceKey)).map(interval => ({
      startTime: Math.max(entry.startTime, interval.startTime), endTime: Math.min(entry.endTime, interval.endTime)
    }));
    return intervalDuration(coverage) >= entry.endTime - entry.startTime - 1e-7 ||
      (!state.progressBudget && entriesByOwner.get(entry.ownerId) === 1 &&
        (Number(state.choicePlayCounts[entry.ownerId]) || 0) > 0);
  });
  const playedKeys = new Set(played.map(entry => entry.key));
  const unlockedCoreIds = state.unlockedGroupIds.filter(id => index.coreGroupIds.has(id));
  const visibleCoreIds = state.revealedGroupIds.filter(id => index.coreGroupIds.has(id));
  return {
    currentPhase: state.currentPhase, progressionValue: state.progressionValue,
    progressionScale: state.progressionScale,
    progressBudgetConsumed: Boolean(state.progressBudgetConsumed),
    progressBudget: state.progressBudget ? {
      ...computeInteractionProgress(budget, observations), firstCoreTime: budget.firstCoreTime,
      openingStartTime: budget.openingStartTime, openingEndTime: budget.openingEndTime,
      openingDuration: budget.openingDuration, verifiedChoiceCount: budget.verifiedChoiceCount,
      selectionWeight: budget.selectionWeight
    } : null,
    uniqueApproachCount: budget.entries.length, playedUniqueApproachCount: played.length,
    remainingApproachIds: [...new Set(budget.entries.filter(entry => !playedKeys.has(entry.key)).map(entry => entry.ownerId))],
    unlockedCoreIds: [...new Set(unlockedCoreIds)], visibleCoreIds: [...new Set(visibleCoreIds)],
    unlockedGroupIds: [...state.unlockedGroupIds], revealedGroupIds: [...state.revealedGroupIds],
    activeGroupId: state.activeGroupId, activeOccurrenceId: state.activeOccurrenceId,
    activeMovementId: state.activeMovementId,
    activeSourceRange: state.activeSourceRange ? { ...state.activeSourceRange } : null,
    sourceRanges: index.entries.filter(entry => entry.isGroup)
      .map(entry => ({ ...entry.range, groupId: entry.row.id })),
    unlockReason: state.unlockReason, lastSeekTarget: state.lastSeekTarget,
    blockedSeekReason: state.blockedSeekReason,
    panelVisible: state.panelVisible, overlayCount: Math.max(0, Number(overlayCount) || 0),
    playbackBlocked: Boolean(playbackBlocked), playbackFailureReason
  };
}
