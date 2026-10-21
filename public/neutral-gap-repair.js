// Separate, narrowly scoped saved-game repair. This is NOT a rewritten
// version of the full adult-interaction analysis request.
export const GAP_REPAIR_PROMPT_VERSION = 'neutral-timeline-v4';
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
Review ${start}–${end} seconds using only the supplied timestamped still frames.
Yetişkin içerik barındıran bu videoyu nesnel olarak analiz et. Görülebilen
olayları kısa, tarafsız ve grafik olmayan ifadelerle, doğru zaman aralıklarıyla
kaydet. Farklı sahneleri birbirine karıştırma; görünen olayın yerine başka bir
olay yazma. Görünmeyen ayrıntıları ve kişilerin niyetlerini tahmin etme.
Kamera açısı değişikliğini yeni bir eylem sayma. Doğrulanamayan veya işlenemeyen
bölümleri gerekçesiyle eksik bırak; analiz başarılıymış gibi gösterme.
Use brief, factual Turkish descriptions, without explicit sexual details.
Respect provider restrictions; if the source cannot be processed, do not override
that decision. Leave unverified intervals incomplete and explain them in warnings.
Still frames do not show continuous video: never infer unobserved moments.
A camera-only cut, a new camera angle and repeated motion are NOT player actions.
Do not report a description based solely on the motionProfile or sceneBoundaries.

Set sourceVerified=true only when multiple frames verify both the ordinary event
and its interval. Use absolute source-video seconds within the requested range;
do not extrapolate or invent times between distant frames.
Give an honest confidence from 0.0 to 1.0; omit uncertain events or use low
confidence. Do not invent events, participants, details or coverage.
Use actionType="story", choiceSurface="story", nonIntimate=true,
activityType="other", positionId="", positionLabel="", and no movement loops.
If nothing can be verified, return actions=[]. Never call a restricted or
uninspected interval complete.

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
