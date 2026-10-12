// Legacy analysis diagnostics only. Live progression belongs to gameplay-state.js.
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
