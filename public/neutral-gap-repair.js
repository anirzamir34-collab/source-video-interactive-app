// Separate, narrowly scoped saved-game repair. This is NOT a rewritten
// version of the full adult-interaction analysis request.
export const GAP_REPAIR_PROMPT_VERSION = 'neutral-timeline-v1';

export const GAP_REPAIR_SYSTEM_INSTRUCTION = `You are a factual video timeline assistant.
Return only short, non-graphic, directly verifiable events from provided
timestamped frames. Respect all provider content restrictions.
Do not describe sexual anatomy, sexual acts, or explicit sexual details.
Do not infer invisible events or manufacture gameplay choices.
When no ordinary event can be safely established, return an empty action array.`;

const asSafeJson = (value, max = 8000) => {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  return JSON.stringify(parsed ?? []).slice(0, max);
};

export function buildGapRepairPrompt({
  chunkStart, chunkEnd, timestamps = [], motionProfile = [], sceneBoundaries = []
} = {}) {
  const start = Number(chunkStart), end = Number(chunkEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Invalid gap repair interval');
  }
  return `VIDEOQUEST SAVED GAME — NEUTRAL TIMELINE RECOVERY
This request is ONLY for ordinary, non-graphic, directly observable source events.
It does not ask for the adult gameplay taxonomy, sexual positioning, physical
contact details, intimate interactions or reinterpretation of restricted frames.
If the provider cannot process this source, do not attempt to override that decision.

Analyze the supplied timestamped frame sheets within ${start}–${end} seconds.
Frames are still images, not a continuous video: never infer unobserved moments.
Identify only meaningful, ordinary actions that can be visually confirmed, e.g.
a person enters or leaves a room, visibly moves to another location, a clearly
ordinary non-intimate gesture, or a narrative-relevant scene transition.
A camera-only cut, a new camera angle and repeated motion are NOT player actions.
Do not report a description based solely on the motionProfile or sceneBoundaries.

For each verified ordinary action, return:
- startTime and endTime strictly inside the requested range, covering only
  the frames that show the event; no extrapolation.
- a brief neutral Turkish label, clearly supported by the frames.
- sourceVerified=true ONLY if the actual event and playable interval are
  independently visible in multiple frames.
- actionType="story", choiceSurface="story", nonIntimate=true,
  activityType="other", positionId="", positionLabel="", and no movement loops.
If no such event can be safely verified, return actions=[].
Never add filler, fake transitions, invented participants, fake actions or
graphic descriptions. Never call a restricted or uninspected interval complete.

Return a single JSON object (no markdown) with these keys:
{"available":true,"actions":[],"analysisGaps":[],"warnings":[]}
Each actions item must contain:
{"startTime":number,"endTime":number,"sourceVerified":true,
"actionType":"story","choiceSurface":"story","nonIntimate":true,
"label":"short factual Turkish action description","confidence":0.0}
Treat actions=[] as a legitimate result. The application tracks incomplete
time separately; you do not need to invent observations for coverage.

Frame timestamps (source seconds): ${asSafeJson(timestamps, 8000)}
Measured local visual changes (hints only): ${asSafeJson(motionProfile, 6000)}
Potential scene cuts (hints only): ${asSafeJson(sceneBoundaries, 3000)}
Requested interval: ${start}–${end} seconds.
`;
}

export function verifiedNeutralRepairActions(actions = [], range = {}) {
  const start = Number(range.startTime), end = Number(range.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return (Array.isArray(actions) ? actions : []).filter(item => item?.sourceVerified === true &&
    item?.nonIntimate === true && item?.actionType === 'story' &&
    item?.choiceSurface === 'story' && !item?.positionId && !item?.positionLabel &&
    Number.isFinite(Number(item.startTime)) && Number.isFinite(Number(item.endTime)) &&
    Number(item.startTime) >= start && Number(item.endTime) <= end &&
    Number(item.endTime) - Number(item.startTime) >= 0.25 &&
    String(item.label || '').trim().length > 3).map(item => ({
      ...item, nonIntimate: true, activityType: 'other', positionId: '',
      positionLabel: '', loopStartTime: null, loopEndTime: null,
      verifiedSubsequences: [], adultScene: false, outcomeType: 'none'
    }));
}

export function uncoveredNeutralRepairIntervals(gap, actions = []) {
  const start = Number(gap?.startTime), end = Number(gap?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const clips = (Array.isArray(actions) ? actions : [])
    .filter(action => action?.sourceVerified === true &&
      Number.isFinite(Number(action.startTime)) && Number.isFinite(Number(action.endTime)))
    .map(action => ({ startTime: Math.max(start, Number(action.startTime)),
      endTime: Math.min(end, Number(action.endTime)) }))
    .filter(clip => clip.endTime > clip.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const gaps = [];
  let cursor = start;
  for (const clip of clips) {
    if (clip.startTime > cursor + 0.05) gaps.push({
      startTime: cursor, endTime: clip.startTime, reason: 'NEUTRAL_REPAIR_UNVERIFIED'
    });
    cursor = Math.max(cursor, clip.endTime);
  }
  if (end > cursor + 0.05) gaps.push({
    startTime: cursor, endTime: end, reason: 'NEUTRAL_REPAIR_UNVERIFIED'
  });
  return gaps;
}
