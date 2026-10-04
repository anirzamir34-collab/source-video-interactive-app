// Playback timing only: these rows never create or classify story actions.
function audibleDubEnd(row) {
  const ends = (Array.isArray(row.words) ? row.words : []).map(word => word?.end).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : row.end;
}

export function conversationEnd(time, source = [], dub = [], { dubEnabled = false, offset = 0, duration = Infinity } = {}) {
  if (!Number.isFinite(time)) return time;
  const rows = [...source.map(row => ({ start: row.startTime, end: row.endTime })),
    ...(dubEnabled ? dub.map(row => ({ start: row.start - offset,
      end: audibleDubEnd(row) - offset })) : [])]
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
