import { verifiedOccurrenceRanges, interactionClipGuard, interactionEntryClip } from './interaction-timeline.js';

export const INTERACTION_PHASES = Object.freeze(['APPROACH', 'CORE', 'OUTCOME', 'AFTERMATH']);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const phaseOf = row => INTERACTION_PHASES.includes(row?.phase) ? row.phase : null;
const rangesOf = row => row?.sourceVerified === true ? verifiedOccurrenceRanges(row) : [];
const startOf = row => Math.min(...rangesOf(row).map(range => range.startTime));
const atTime = (range, time) => time >= range.startTime && time < range.endTime;
const addId = (ids, id) => [...new Set([...ids, id])];

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
    blockedSeekReason: null, panelVisible: Boolean(source.groups.length || source.choices.length)
  };
  return advanceInteraction(state, state.currentTime);
}

export function switchInteractionScene(_state, scene, currentTime = 0, options = {}) {
  return createInteractionState(scene, { ...options, currentTime });
}

export function unlockNextCoreGroup(state, reason = 'progress-full') {
  const core = state.scene.groups.filter(group => group.phase === 'CORE' && group.id && rangesOf(group).length)
    .sort((left, right) => startOf(left) - startOf(right));
  const activeIndex = core.findIndex(group => group.id === state.activeGroupId);
  const candidates = activeIndex >= 0 ? core.slice(activeIndex + 1) : core.filter(group =>
    rangesOf(group).some(range => range.endTime > state.currentTime));
  const next = candidates.find(group => !state.unlockedGroupIds.includes(group.id));
  if (!next) return state;
  return {
    ...state, currentPhase: 'CORE', panelVisible: true, unlockReason: reason,
    unlockedGroupIds: addId(state.unlockedGroupIds, next.id),
    revealedGroupIds: addId(state.revealedGroupIds, next.id)
  };
}

// Call after source playback has actually begun/completed, rather than while a
// seek is pending. A rejected media play must not grant interaction progress.
export function progressForSelection(state, choiceId, baseIncrement = 25) {
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

export function advanceInteraction(state, requestedTime) {
  const currentTime = Math.max(0, Number(requestedTime) || 0);
  const rewind = currentTime < state.currentTime - 0.05;
  const records = [...state.scene.choices, ...state.scene.groups];
  const matching = records.flatMap(row => rangesOf(row)
    .filter(range => atTime(range, currentTime)).map(range => ({ row, range })))
    .sort((left, right) => right.range.startTime - left.range.startTime);
  const found = matching[0];
  const previous = records.flatMap(row => rangesOf(row)
    .filter(range => range.endTime <= currentTime).map(range => ({ row, range })))
    .sort((left, right) => right.range.endTime - left.range.endTime)[0];
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
  const group = matching.find(item => state.scene.groups.includes(item.row));
  if (rewind) {
    next = {
      ...next, activeGroupId: group?.row.id || null,
      activeOccurrenceId: group?.range.occurrenceId || null,
      activeMovementId: null, pendingSelection: null, rhythm: { held: false, taps: 0 },
      choicePlayCounts: Object.fromEntries(Object.entries(state.choicePlayCounts)
        .filter(([id]) => startOf([...records, ...state.scene.groups.flatMap(row => row.movements || [])]
          .find(row => row.id === id) || {}) <= currentTime))
    };
  }
  if (group) {
    const changedGroup = next.activeGroupId !== group.row.id;
    next = {
      ...next, currentPhase: group.row.phase, activeGroupId: group.row.id,
      activeOccurrenceId: group.range.occurrenceId, panelVisible: true,
      ...(changedGroup ? { activeMovementId: null, pendingSelection: null, rhythm: { held: false, taps: 0 } } : {}),
      ...(group.row.phase === 'CORE' ? {
        unlockedGroupIds: addId(next.unlockedGroupIds, group.row.id),
        revealedGroupIds: addId(next.revealedGroupIds, group.row.id),
        unlockReason: state.unlockedGroupIds.includes(group.row.id) ? state.unlockReason : 'source-boundary'
      } : {})
    };
  }
  return next;
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
  const guard = interactionClipGuard(group, entry);
  if (!guard.allowed) return blockedSelection(state, guard.reason);
  const target = { ...entry, occurrenceId: guard.sourceRange.occurrenceId };
  return {
    state: {
      ...state, currentPhase: group.phase, activeGroupId: groupId,
      activeOccurrenceId: target.occurrenceId, activeMovementId: null,
      progressionValue: state.activeGroupId !== groupId ? 0 : state.progressionValue,
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
  const range = rangesOf(choice)[0];
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
      activeOccurrenceId: target.occurrenceId, activeMovementId: choice.id,
      pendingSelection: target, lastSeekTarget: target.startTime,
      blockedSeekReason: null, panelVisible: true
    }, target, blockedReason: null
  };
}

export function interactionTrace(state, { overlayCount = 0, playbackBlocked = false, playbackFailureReason = null } = {}) {
  return {
    currentPhase: state.currentPhase, progressionValue: state.progressionValue,
    progressionScale: state.progressionScale,
    unlockedGroupIds: [...state.unlockedGroupIds], revealedGroupIds: [...state.revealedGroupIds],
    activeGroupId: state.activeGroupId, activeOccurrenceId: state.activeOccurrenceId,
    activeMovementId: state.activeMovementId,
    sourceRanges: state.scene.groups.flatMap(group => rangesOf(group)
      .map(range => ({ ...range, groupId: group.id }))),
    unlockReason: state.unlockReason, lastSeekTarget: state.lastSeekTarget,
    blockedSeekReason: state.blockedSeekReason,
    panelVisible: state.panelVisible, overlayCount: Math.max(0, Number(overlayCount) || 0),
    playbackBlocked: Boolean(playbackBlocked), playbackFailureReason
  };
}
