// Separate, narrowly scoped saved-game repair. This is NOT a rewritten
// version of the full adult-interaction analysis request.
export const GAP_REPAIR_PROMPT_VERSION = 'neutral-timeline-v2';
export const GAP_REPAIR_VALIDATOR_VERSION = 'neutral-validator-v2';

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
- confidence is an honest probability from 0.0 to 1.0, assessed from the frames.
  A generic sample number is NOT evidence and must not be copied. For uncertain
  events use a low confidence or omit the event; never inflate confidence.
- Times MUST use absolute source-video seconds, not seconds relative to this chunk.
  Do not invent start/end times between two distant sampled frames.
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
"label":"short factual Turkish action description","confidence":number}
Treat actions=[] as a legitimate result. The application tracks incomplete
time separately; you do not need to invent observations for coverage.

Frame timestamps (source seconds): ${asSafeJson(timestamps, 8000)}
Measured local visual changes (hints only): ${asSafeJson(motionProfile, 6000)}
Potential scene cuts (hints only): ${asSafeJson(sceneBoundaries, 3000)}
Requested interval: ${start}–${end} seconds.
`;
}

// Aggregate, content-free diagnostics: no labels, frames or participant data.
export function inspectNeutralRepairActions(actions = [], range = {}) {
  const start = Number(range.startTime), end = Number(range.endTime);
  const counts = { invalidObject: 0, notSourceVerified: 0, nonNeutral: 0,
    invalidType: 0, invalidTime: 0, missingLabel: 0, lowConfidence: 0 };
  const accepted = [];
  const input = Array.isArray(actions) ? actions : [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { counts.invalidObject++; continue; }
    if (item.sourceVerified !== true) { counts.notSourceVerified++; continue; }
    if (item.nonIntimate !== true || item.positionId || item.positionLabel ||
        item.positionOccurrenceId || item.adultScene === true) { counts.nonNeutral++; continue; }
    if (item.actionType !== 'story' || item.choiceSurface !== 'story') { counts.invalidType++; continue; }
    const timeStart = Number(item.startTime), timeEnd = Number(item.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
        !Number.isFinite(timeStart) || !Number.isFinite(timeEnd) ||
        timeStart < start || timeEnd > end || timeEnd - timeStart < 0.25) {
      counts.invalidTime++; continue;
    }
    if (String(item.label || '').trim().length <= 3) { counts.missingLabel++; continue; }
    // A low/unsupplied confidence is never silently raised.
    if (!Number.isFinite(Number(item.confidence)) || Number(item.confidence) < 0.4) {
      counts.lowConfidence++; continue;
    }
    accepted.push({ ...item, nonIntimate: true, activityType: 'other',
      positionId: '', positionLabel: '', loopStartTime: null, loopEndTime: null,
      verifiedSubsequences: [], adultScene: false, outcomeType: 'none' });
  }
  return { actions: accepted, diagnostics: {
    modelRawActionsCount: input.length,
    repairValidatorAcceptedCount: accepted.length,
    repairValidatorRejected: counts
  } };
}

export function verifiedNeutralRepairActions(actions = [], range = {}) {
  return inspectNeutralRepairActions(actions, range).actions;
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
