// Neutral provider records for interaction/playback regressions. Phase, identity,
// occurrence, and display fields are declared evidence, never inferred labels.
const cast = { subjectTrackId: 'performer-left', partnerTrackId: 'performer-right', routeNamespace: 'route-opaque' };
const sourceRange = (id, startTime, endTime, occurrenceId) => ({ id, startTime, endTime, occurrenceId, sourceVerified: true });

const observedChoice = (id, startTime, endTime, overrides = {}) => ({
  id, label: `Observed ${id}`, phase: 'APPROACH', sourceVerified: true,
  occurrenceId: `${id}-visit`, startTime, endTime, castIds: ['performer-left', 'performer-right'],
  chainId: 'opening-chain', ...cast,
  sourceRanges: [sourceRange(`${id}-source`, startTime, endTime, `${id}-visit`)], ...overrides
});

function coreGroup(id, startTime, endTime, entryStart, entryEnd) {
  const occurrenceId = `${id}-visit`, positionId = `${id}-source`;
  const entryRange = { ...sourceRange(`${id}-entry-source`, entryStart, entryEnd, `${id}-entry-visit`),
    ...cast, entryForGroupId: id, coreOccurrenceId: occurrenceId };
  const movements = [0, 1, 2].map(index => {
    const from = startTime + 2 + index * 5, to = from + 4;
    return { id: `${id}-movement-${index}`, phase: 'CORE', groupId: id, sourceVerified: true,
      ...cast, sourcePositionId: positionId, sourceOccurrenceId: occurrenceId, occurrenceId,
      startTime: from, endTime: to, loopStartTime: from, loopEndTime: to,
      sourceRanges: [sourceRange(positionId, from, to, occurrenceId)],
      label: index < 2 ? 'Provider action α' : 'Provider action β',
      actionType: index < 2 ? 'opaque-action-a' : 'opaque-action-b',
      sourceActionId: index < 2 ? `${id}-observed-a` : `${id}-observed-b`, movementTempo: 'steady' };
  });
  return { id, phase: 'CORE', familyId: 'opaque-family', sourceVerified: true, ...cast,
    label: 'Opaque family τ', positionLabel: 'Provider family Ω', occurrenceId,
    sourceRanges: [sourceRange(positionId, startTime, endTime, occurrenceId)],
    entryRange, movements };
}

export function neutralInteractionFixture() {
  const first = coreGroup('core-a', 44, 76, 42, 44);
  const second = coreGroup('core-b', 96, 124, 94, 96);
  const choices = [
    observedChoice('approach-a', 0, 8), observedChoice('approach-b', 8, 16),
    observedChoice('dialogue', 16, 20, { progressionEnabled: false }),
    observedChoice('approach-c', 20, 28), observedChoice('approach-d', 28, 36),
    observedChoice('approach-e', 36, 42), observedChoice('entry-a', 42, 44),
    observedChoice('interlude-choice', 76, 94, { chainId: 'interlude-chain' }),
    observedChoice('entry-b', 94, 96, { chainId: 'interlude-chain' }),
    observedChoice('unverified-choice', 1, 43, { sourceVerified: false }),
    ...first.movements, ...second.movements
  ];
  const interlude = observedChoice('interlude', 76, 94, { chainId: 'interlude-chain', movements: [] });
  const uncertain = { ...coreGroup('unverified-core', 86, 90, 84, 86), sourceVerified: false };
  const invalidMovement = { ...first.movements[0], id: 'unverified-movement', sourceVerified: false };
  first.movements.push(invalidMovement);
  return {
    scene: { id: 'neutral-playback-fixture', choices, groups: [first, interlude, second, uncertain] },
    first, second, invalidMovement
  };
}
