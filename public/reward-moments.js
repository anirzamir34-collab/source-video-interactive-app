// Reward scenes: real moments of the video that the game keeps hidden and
// suddenly offers when something happens in play.
//   her_climax - a visible female climax; offered once the player has
//                brought her Lust to full during sex.
//   highlight  - the scene's most striking non-final moment; offered after
//                Lust has filled several times when the video has no
//                female climax.
// Nothing is invented: a reward is always a verified interval of the video.

export const REWARD_TYPES = Object.freeze(['her_climax', 'highlight']);
const MIN_SECONDS = 3;
const MAX_SECONDS = 45;

export function normalizeRewardMoments(rows = [], { chunkStart = null, chunkEnd = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const start = Number(chunkStart), end = Number(chunkEnd);
  const bounded = Number.isFinite(start) && Number.isFinite(end) && end > start;
  // Video-mode answers sometimes use clip-relative seconds.
  const relative = bounded && start >= 5 && list.length &&
    list.every(row => Number(row?.startTime) < start - 1 && Number(row?.endTime) <= end - start + 2);
  return list.map(row => {
    const type = String(row?.rewardType || '').trim().toLowerCase();
    const shift = relative ? start : 0;
    const startTime = Number(row?.startTime) + shift;
    const endTime = Number(row?.endTime) + shift;
    return {
      rewardType: type, startTime, endTime,
      label: String(row?.label || '').trim().slice(0, 60),
      partnerTrackId: String(row?.partnerTrackId || '').trim().slice(0, 60),
      evidence: String(row?.evidence || '').trim().slice(0, 200),
      sourceVerified: row?.sourceVerified === true
    };
  }).filter(row => REWARD_TYPES.includes(row.rewardType) && row.sourceVerified &&
    Number.isFinite(row.startTime) && Number.isFinite(row.endTime) &&
    row.endTime - row.startTime >= MIN_SECONDS && row.endTime - row.startTime <= MAX_SECONDS &&
    (!bounded || (row.startTime >= start - 1 && row.endTime <= end + 1)))
    .sort((a, b) => a.startTime - b.startTime)
    .map((row, index) => ({ ...row, id: `reward-${row.rewardType}-${Math.round(row.startTime * 1000)}-${index}` }));
}

export const rewardTitle = reward => reward?.label ||
  (reward?.rewardType === 'her_climax' ? 'Onu zirveye taşıdın' : 'Sahnenin en ateşli anı');

// Rewards that lie inside this scene's playable range.
export function rewardsForScene(rewards = [], scene = {}) {
  const start = Number(scene?.startTime), end = Number(scene?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return (Array.isArray(rewards) ? rewards : [])
    .filter(row => row.startTime >= start - 0.05 && row.endTime <= end + 0.05);
}

// For analyses without marked rewards: the scene's most intense real core
// movement, preferring the later part of the scene, is the highlight.
export function derivedHighlight(scene = {}, isCore = () => true) {
  const start = Number(scene?.startTime), end = Number(scene?.endTime);
  const span = Math.max(1, end - start);
  const candidates = (scene?.positions || []).filter(isCore).flatMap(position => position.movements || [])
    .filter(item => item?.sourceVerified === true &&
      Number(item.loopEndTime) - Number(item.loopStartTime) >= MIN_SECONDS)
    .map(item => {
      const intensity = Number(item.maleProgressRate || 1) +
        (String(item.movementTempo) === 'fast' ? 0.6 : 0) +
        (['harder', 'deeper', 'faster'].includes(String(item.movementChange)) ? 0.4 : 0);
      const lateness = (Number(item.loopStartTime) - start) / span;
      return { item, score: intensity + lateness * 0.5 };
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0]?.item;
  if (!best) return null;
  const startTime = Number(best.loopStartTime);
  return { id: `reward-derived-${Math.round(startTime * 1000)}`, rewardType: 'highlight', derived: true,
    startTime, endTime: Math.min(Number(best.loopEndTime), startTime + MAX_SECONDS),
    label: '', partnerTrackId: String(best.partnerTrackId || ''), sourceVerified: true };
}

// Which reward to offer now, if any.
export function pickAdultReward(rewards = [], { lustFills = 0, played = new Set(), offered = new Set() } = {}) {
  const fresh = row => !played.has(row.id) && !offered.has(row.id);
  const climax = rewards.find(row => row.rewardType === 'her_climax' && fresh(row));
  if (climax) return lustFills >= 2 ? climax : null;
  if (lustFills < 3) return null;
  return rewards.filter(row => row.rewardType === 'highlight').find(fresh) || null;
}
