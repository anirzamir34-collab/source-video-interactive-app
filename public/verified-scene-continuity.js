// Source-evidence continuity: visual cuts are not new gameplay occurrences.
// Preserve every original clip range; these helpers describe grouping and phase,
// NEVER expand footage into a gap or generate new selectable clips.
const number = value => value === null || value === undefined || value === '' ? NaN : Number(value);
const valid = row => Number.isFinite(number(row?.startTime)) &&
  Number.isFinite(number(row?.endTime)) && number(row.endTime) > number(row.startTime);

/** Group cut-separated clips only when their exact source occurrence agrees.
 * Unlike temporal adjacency alone, equal labels/actors do not establish a run.
 * The observed clip duration bounds acceptable unseen footage: long unexplained
 * gaps create distinct returns even when a provider reuses an occurrence id.
 */
export function sameVerifiedSourceRun(previous, current) {
  if (!valid(previous) || !valid(current)) return false;
  const identity = String(previous.id || '').trim();
  if (!identity || identity !== String(current.id || '').trim()) return false;
  const gap = number(current.startTime) - number(previous.endTime);
  if (gap <= 0) return true;
  const observedDuration = Math.max(number(previous.endTime) - number(previous.startTime),
    number(current.endTime) - number(current.startTime));
  const cutBudget = Math.min(12, Math.max(3, observedDuration / 2));
  return gap <= cutBudget;
}

const openingActivity = position => ['oral', 'manual'].includes(String(position?.familyId || '').toLowerCase()) ||
  ['oral', 'manual'].includes(String(position?.categoryId || '').toLowerCase());
const supportedMotion = position => (position?.movements || []).some(movement =>
  movement?.sourceVerified === true &&
  ['slow', 'moderate', 'fast'].includes(String(movement.movementTempo || '').toLowerCase()));

/** Distinguish preparation/entry from the first clear core motion by evidence,
 * not by label or the model's broad scene envelope. Ambiguous preceding poses
 * remain opening choices only if a later verified core movement exists.
 * If no such movement exists, keep the earliest non-opening position playable.
 */
// Oral and manual activity are sexual acts and belong to the sex panel as
// positions. Only non-sexual opening contact (touching, kissing, undressing)
// stays in the first approach panel, which is built from approach actions.
export function assignVerifiedOpeningRoles(positions = []) {
  const ordered = [...positions].sort((a, b) => number(a?.startTime) - number(b?.startTime));
  const firstMotion = ordered.find(position => openingActivity(position) || supportedMotion(position));
  const firstCore = firstMotion || ordered[0];
  const firstCoreTime = firstCore ? number(firstCore.startTime) : Infinity;
  return positions.map(position => {
    const beforeCore = number(position.startTime) < firstCoreTime - 0.05;
    const preparatoryPose = !openingActivity(position) && !supportedMotion(position) &&
      Boolean(firstMotion) && beforeCore;
    return { ...position, progressionRole: preparatoryPose ? 'foreplay' : 'core' };
  });
}
