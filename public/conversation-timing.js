// Playback timing only: these rows never create or classify story actions.
export function conversationEnd(time, source = [], dub = [], { dubEnabled = false, offset = 0, duration = Infinity } = {}) {
  if (!Number.isFinite(time)) return time;
  const rows = [...source.map(row => ({ start: row.startTime, end: row.endTime })),
    ...(dubEnabled ? dub.map(row => ({ start: row.start - offset,
      end: (row.words?.length ? Math.max(...row.words.map(word => word.end)) : row.end) - offset })) : [])]
    .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start)
    .sort((a, b) => a.start - b.start);
  let end = time, found = false;
  for (const row of rows) {
    if (row.end + .12 <= time) continue;
    if (row.start > end + (found ? .15 : .03)) break;
    end = Math.max(end, row.end + .12); found = true;
  }
  return Math.min(duration, end);
}
