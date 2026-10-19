// Ordinary story dialogue that sits inside an opening (Lust) scene belongs to
// the normal story panel. It is offered only when real playback reaches its
// source start: the clip that just ended must end where the dialogue begins.
const ADJACENT_BEFORE_SECONDS = 0.3;
const ADJACENT_AFTER_SECONDS = 1.5;

export function nextSceneDialogueInterlude(dialogue = [], endTime, { sceneStart = -Infinity, played = () => false } = {}) {
  const end = Number(endTime);
  if (!Number.isFinite(end)) return null;
  const floor = Number.isFinite(Number(sceneStart)) ? Number(sceneStart) : -Infinity;
  return (Array.isArray(dialogue) ? dialogue : [])
    .filter(item => item?.sourceVerified === true && item.id &&
      Number.isFinite(Number(item.startTime)) && Number(item.endTime) > Number(item.startTime) &&
      Number(item.startTime) >= floor - 0.05 &&
      Number(item.startTime) >= end - ADJACENT_BEFORE_SECONDS &&
      Number(item.startTime) <= end + ADJACENT_AFTER_SECONDS &&
      !played(item.id))
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))[0] || null;
}
