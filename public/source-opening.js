// Keep verified model opening metadata through client normalization.
// A malformed or over-extended intro cannot hide a real source-backed action.
export function sourceOpeningTimeline(input = {}) {
  const duration = Number(input.videoDuration);
  const ceiling = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const valid = value => value !== null && value !== undefined &&
    String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Math.min(ceiling, Number(value)) : null;
  const earliestAction = (Array.isArray(input.actions) ? input.actions : [])
    .filter(item => item?.sourceVerified === true &&
      Number.isFinite(Number(item.startTime)) &&
      Number.isFinite(Number(item.endTime)) &&
      Number(item.endTime) > Number(item.startTime) && Number(item.startTime) >= 0)
    .reduce((first, item) => Math.min(first, Number(item.startTime)), Infinity);
  const declaredIntro = valid(input.introEndTime);
  const declaredPlayStart = valid(input.playStartTime);
  const requested = declaredPlayStart ?? declaredIntro ?? (Number.isFinite(earliestAction) ? earliestAction : 0);
  const playStartTime = Math.min(requested, earliestAction, ceiling);
  return {
    introEndTime: Math.min(declaredIntro ?? playStartTime, playStartTime),
    playStartTime: Number.isFinite(playStartTime) ? playStartTime : 0
  };
}
