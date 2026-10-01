const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
const textKey = value => clean(value).normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/[\p{P}\p{S}]/gu, '').trim();

export function dubSegmentKey(segment, fallbackIndex = 0) {
  if (!segment) return '';
  const stableId = String(segment.segmentId || '').trim();
  if (stableId) return stableId;

  const start = Number(segment.startTime) || 0;
  const end = Number(segment.endTime) || start;
  const speaker = String(segment.speakerId || segment.gender || 'speaker');
  const text = String(segment.turkishText || '').trim().slice(0, 48);
  return `dub-${fallbackIndex}-${start.toFixed(3)}-${end.toFixed(3)}-${speaker}-${text}`;
}

// A decimal alone is ambiguous: 3.04 can be seconds or 03:04. Require
// collection-wide evidence of impossible speech durations before repairing
// legacy output. Dedicated ASR seconds always take precedence.
export function repairDialogueTimestamps(rows = [], duration = 0, { timestampUnit = '' } = {}) {
  const segments = Array.isArray(rows) ? rows : [];
  const limit = Number(duration);
  const unchanged = reason => ({ segments, report: { repaired: false, reason } });
  if (timestampUnit === 'seconds' || (!timestampUnit && segments.some(row => row?.timestampUnit === 'seconds'))) return unchanged('explicit-seconds');
  const explicit = timestampUnit === 'minute.second';
  if (!Number.isFinite(limit) || limit <= 0) return unchanged('unknown-duration');
  if (!explicit && (limit < 300 || segments.length < 6)) return unchanged('insufficient-evidence');
  const decimal = value => {
    if (value == null || value === '' || typeof value === 'boolean') return NaN;
    const n = Number(value);
    const hundredths = Math.round(n * 100);
    if (!Number.isFinite(n) || n < 0 || Math.abs(n * 100 - hundredths) > 0.000001 || hundredths % 100 > 59) return NaN;
    return Math.floor(hundredths / 100) * 60 + hundredths % 100;
  };
  const converted = segments.map(row => ({ ...row,
    startTime: decimal(row?.startTime), endTime: decimal(row?.endTime) }));
  if (converted.some(row => !Number.isFinite(row.startTime) || !Number.isFinite(row.endTime) ||
      row.endTime <= row.startTime || row.endTime > limit)) return unchanged('invalid-minute-second-range');
  const rawMax = Math.max(...segments.map(row => Number(row.endTime)));
  const convertedMax = Math.max(...converted.map(row => row.endTime));
  if (!explicit) {
    if (rawMax > Math.min(20, limit / 40) || convertedMax < 120) return unchanged('not-collapsed');
    let impossible = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const row = segments[i];
      const words = clean(row.originalText || row.turkishText).split(/\s+/u).filter(Boolean).length;
      const rawLength = Number(row.endTime) - Number(row.startTime);
      const repairedLength = converted[i].endTime - converted[i].startTime;
      if (words && rawLength > 0 && rawLength < words * 0.06 && repairedLength >= words * 0.06) impossible += 1;
    }
    if (impossible < Math.ceil(segments.length * 0.8)) return unchanged('plausible-seconds');
  }
  converted.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  return { segments: converted, report: {
    repaired: true, mode: 'minute.second', rawMax, convertedMax, videoDuration: limit,
    timestamps: segments.map(row => ({ segmentId: row.segmentId,
      originalStartTime: Number(row.startTime), originalEndTime: Number(row.endTime),
      startTime: decimal(row.startTime), endTime: decimal(row.endTime) }))
  } };
}

// Preserve cached block IDs and sentence grouping so repaired timestamps do
// not orphan previously generated audio or create new spoken text.
export function normalizeDialogueTimeline(dialogue, duration) {
  if (!dialogue) return dialogue;
  const pinIds = rows => (Array.isArray(rows) ? rows : []).map((row, index) =>
    row && typeof row === 'object' ? { ...row, segmentId: dubSegmentKey(row, index) } : row);
  const result = repairDialogueTimestamps(pinIds(dialogue.segments), duration, dialogue);
  const blockResult = Array.isArray(dialogue.dubSegments)
    ? repairDialogueTimestamps(pinIds(dialogue.dubSegments), duration, {
      timestampUnit: result.report.repaired ? 'minute.second' : dialogue.timestampUnit
    }) : null;
  const captions = normalizeDialogueSegments(result.segments, duration);
  const blocks = blockResult ? normalizeDialogueSegments(blockResult.segments, duration) : null;
  const captionTiming = inspectDialogueTiming(captions, duration);
  const blockTiming = blocks ? inspectDialogueTiming(blocks, duration) : captionTiming;
  const timingIntegrity = !captionTiming.valid ? captionTiming : blockTiming;
  return { ...dialogue,
    segments: timingIntegrity.valid ? captions : [],
    ...(blocks ? { dubSegments: timingIntegrity.valid ? blocks : [] } : {}),
    ...(!timingIntegrity.valid ? { unresolvedSegments: captions,
      unresolvedDubSegments: blocks || [], timingIntegrity } :
      { timingIntegrity: dialogue.timingIntegrity?.valid === false && !captions.length
        ? dialogue.timingIntegrity : timingIntegrity }),
    timestampUnit: 'seconds',
    timestampRepair: result.report.repaired ? result.report :
      (blockResult?.report.repaired ? blockResult.report : (dialogue.timestampRepair || result.report))
  };
}

// Normalize spacing without guessing which words were really spoken.
export function naturalizeTurkishSpeech(value) {
  // Text alone cannot distinguish a real repetition from an ASR error.
  // Never invent an interjection or delete source words to mask audio issues.
  return clean(value);
}

// Only collapse duplicate observations of the same speaker at the same time.
// Repeated words later in the video and simultaneous different voices survive.
export function uniqueTimedSpeech(rows = [], { textField = 'originalText', tolerance = 0.12 } = {}) {
  const result = [];
  const byText = new Map();
  for (const original of Array.isArray(rows) ? rows : []) {
    if (!original || typeof original !== 'object') continue;
    const row = { ...original, speakerId: clean(original.speakerId) || 'speaker-unknown',
      startTime: Number(original.startTime), endTime: Number(original.endTime) };
    if (!Number.isFinite(row.startTime) || !Number.isFinite(row.endTime) || row.startTime < 0 || row.endTime <= row.startTime) continue;
    const content = textKey(row[textField] || row.turkishText);
    if (!content) continue;
    const key = `${row.speakerId}\u0000${content}`;
    const matches = byText.get(key) || [];
    const duplicate = matches.find(item => Math.abs(item.startTime - row.startTime) <= tolerance &&
      Math.abs(item.endTime - row.endTime) <= tolerance);
    if (duplicate) continue;
    matches.push(row);
    byText.set(key, matches);
    result.push(row);
  }
  return result.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

export function normalizeDialogueSegments(rows = [], duration = Infinity) {
  const limit = Number(duration) > 0 ? Number(duration) : Infinity;
  const seenIds = new Set();
  return uniqueTimedSpeech(rows).filter(row => row.startTime < limit).map((row, index) => {
    let segmentId = clean(row.segmentId) || `dlg-${index + 1}`;
    if (seenIds.has(segmentId)) {
      const base = `${segmentId}:${index + 1}`;
      segmentId = base;
      let suffix = 1;
      while (seenIds.has(segmentId)) segmentId = `${base}:${suffix++}`;
    }
    seenIds.add(segmentId);
    return {
      ...row,
      segmentId,
      turkishText: naturalizeTurkishSpeech(row.turkishText),
      endTime: Math.min(limit, row.endTime)
    };
  });
}

// A source interval cannot contain several different turns by the same voice
// at precisely the same bounds. Do not guess replacement times from row order.
export function inspectDialogueTiming(rows = [], duration = 0) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number(duration) > 0 ? Number(duration) : Infinity;
  const intervals = new Set();
  const bySpeakerInterval = new Map();
  let invalidRangeCount = 0;
  let maxSameSpeakerIntervalCount = 0;
  let originalMin = Infinity;
  let originalMax = 0;
  for (const row of list) {
    const start = Number(row?.startTime), end = Number(row?.endTime);
    if (row?.startTime == null || row?.endTime == null || !Number.isFinite(start) ||
        !Number.isFinite(end) || start < 0 || end <= start || end > limit + 0.05) {
      invalidRangeCount++;
      continue;
    }
    originalMin = Math.min(originalMin, start);
    originalMax = Math.max(originalMax, end);
    const interval = `${start.toFixed(3)}:${end.toFixed(3)}`;
    intervals.add(interval);
    const key = `${clean(row.speakerId) || 'speaker-unknown'}:${interval}`;
    // Identical observations are deduplicated elsewhere; count distinct speech.
    const turns = bySpeakerInterval.get(key) || new Set();
    turns.add(textKey(row.originalText || row.turkishText) || clean(row.segmentId));
    bySpeakerInterval.set(key, turns);
    maxSameSpeakerIntervalCount = Math.max(maxSameSpeakerIntervalCount, turns.size);
  }
  const reason = invalidRangeCount ? 'INVALID_SOURCE_INTERVAL' :
    maxSameSpeakerIntervalCount >= 3 ? 'SAME_SPEAKER_COLLAPSED_INTERVALS' : '';
  return { valid: !reason, reason, segmentCount: list.length, invalidRangeCount,
    distinctIntervalCount: intervals.size, maxSameSpeakerIntervalCount,
    originalMin: Number.isFinite(originalMin) ? originalMin : 0, originalMax,
    requiresSourceRetiming: Boolean(reason) };
}

export function requireDialogueTiming(rows, duration) {
  const report = inspectDialogueTiming(rows, duration);
  if (!report.valid) throw Object.assign(new Error(`DIALOGUE_TIMING_INVALID:${report.reason}`), {
    code: 'DIALOGUE_TIMING_INVALID', timingIntegrity: report
  });
  return report;
}
