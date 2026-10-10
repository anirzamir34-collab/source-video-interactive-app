// PCM is placed on a 48 kHz clock. A boundary may round by half a sample;
// reserve one sample for the two independently rounded clocks and arithmetic.
export const DUB_TIME_TOLERANCE = 1 / 48000 + 1e-9;

// A dub may borrow at most one second of verified silence. Never shift a
// source word or cross another speaker, an audio event, or the video's end.
export function dubEndLimit(transcript, turn) {
  let end = Math.min(transcript.source?.duration ?? turn.sourceEnd, turn.sourceEnd + 1);
  for (const row of [...transcript.utterances, ...(transcript.audioEvents || [])]) {
    if (row.segmentId === turn.segmentId) continue;
    const start = row.sourceStart ?? row.start, stop = row.sourceEnd ?? row.end;
    if (!Number.isFinite(start)) continue;
    if (start >= turn.sourceEnd) end = Math.min(end, start);
    else if (Number.isFinite(stop) && stop > turn.sourceEnd) end = turn.sourceEnd;
  }
  return Math.max(turn.sourceEnd, end);
}

// Sentence punctuation is a transcription boundary, not a new speaker or a
// scene cut. Adjacent sentences by one speaker may share their speech window.
// Never pool a real overlap, an audio event, a speaker change or a long pause.
export function dubTimingGroups(transcript) {
  const ordered = [...transcript.utterances].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  const events = transcript.audioEvents || [];
  const overlaps = turn => ordered.some(other => other !== turn &&
    other.sourceStart < turn.sourceEnd && other.sourceEnd > turn.sourceStart);
  const groups = [];
  for (const turn of ordered) {
    const group = groups.at(-1), previous = group?.at(-1);
    const eventBetween = previous && events.some(row => Number.isFinite(row.start) && Number.isFinite(row.end) &&
      row.start < turn.sourceEnd && row.end > previous.sourceStart);
    if (previous && previous.speakerId === turn.speakerId && turn.sourceStart >= previous.sourceEnd &&
      turn.sourceStart - previous.sourceEnd <= .8 && turn.sourceEnd - group[0].sourceStart <= 12 &&
      !eventBetween && !overlaps(previous) && !overlaps(turn)) group.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

export function planDubWindows(transcript, durations, maxTempo = 1.2) {
  const windows = new Map(transcript.utterances.map(turn => [turn.segmentId, { start: turn.sourceStart, end: turn.sourceEnd }]));
  for (const group of dubTimingGroups(transcript)) {
    const measured = group.map(turn => durations.get(turn.segmentId));
    if (group.length < 2 || measured.some(value => !(value > 0)) ||
      !group.some((turn, i) => measured[i] > (turn.sourceEnd - turn.sourceStart) * maxTempo)) continue;
    const first = group[0], last = group.at(-1), limit = dubEndLimit(transcript, last);
    const pauses = group.slice(1).map((turn, i) => Math.min(.06, turn.sourceStart - group[i].sourceEnd));
    const pauseTotal = pauses.reduce((sum, value) => sum + value, 0);
    const speechTotal = measured.reduce((sum, value) => sum + value, 0);
    // Leave a small processing margin at the preferred tempo. When the whole
    // phrase is longer, a single measured shortening pass precedes adaptation.
    const required = speechTotal / (maxTempo * .99) + pauseTotal;
    const end = Math.min(limit, Math.max(last.sourceEnd, first.sourceStart + required));
    const tempo = Math.max(maxTempo * .99, speechTotal / (end - first.sourceStart - pauseTotal));
    const minimum = measured.map(value => value / tempo);
    let start = first.sourceStart;
    for (let i = 0; i < group.length; i++) {
      const rest = minimum.slice(i + 1).reduce((sum, value) => sum + value, 0) + pauses.slice(i).reduce((sum, value) => sum + value, 0);
      const stop = i === group.length - 1 ? end :
        Math.max(start + minimum[i], Math.min(group[i].sourceEnd, end - rest));
      windows.set(group[i].segmentId, { start, end: stop });
      if (i < group.length - 1) {
        const latest = end - rest + pauses[i];
        start = Math.max(stop + pauses[i], Math.min(group[i + 1].sourceStart, latest));
      }
    }
  }
  return windows;
}

export function validDubWindow(transcript, turn, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return false;
  const group = dubTimingGroups(transcript).find(rows => rows.some(row => row.segmentId === turn.segmentId));
  return start >= group[0].sourceStart - .00005 && end <= dubEndLimit(transcript, group.at(-1)) + .00005;
}
export const DUB_TIMING_VERSION = 'speech-windows-v4-sample-fit';


// Diagnostics only: identify precisely which recorded voice intervals had to be
// accelerated excessively or shared timeline space. This does not alter the
// spoken text, source timing, voice mapping, or finished audio output.
export function dubTimingDiagnostics(segments = [], threshold = 2) {
  const rows = (Array.isArray(segments) ? segments : [])
    .filter(row => Number.isFinite(Number(row?.start)) && Number.isFinite(Number(row?.end)) &&
      Number(row.end) > Number(row.start))
    .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));
  const extreme = rows.filter(row => Number(row.tempo) > threshold);
  const overlaps = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const end = Math.min(Number(rows[j].end), Number(rows[i].end));
      if (end - Number(rows[i].start) > 0.03) {
        overlaps.push({ firstId: String(rows[j].segmentId), secondId: String(rows[i].segmentId),
          overlapSeconds: Number((end - Number(rows[i].start)).toFixed(3)) });
      }
    }
  }
  return {
    extremeTempoCount: extreme.length,
    extremeTempoSegments: extreme.slice(0, 20).map(row => ({
      segmentId: String(row.segmentId), start: Number(row.start), end: Number(row.end),
      tempo: Number(Number(row.tempo).toFixed(2))
    })),
    overlappingDubSegmentCount: overlaps.length,
    overlappingDubSegments: overlaps.slice(0, 20)
  };
}
