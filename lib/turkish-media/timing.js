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
