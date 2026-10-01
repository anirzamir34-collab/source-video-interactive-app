// Source-time eligibility is independent of asynchronous synthesis and decoding.
// Once a natural start is crossed, its utterance stays due until playback is
// acknowledged or an explicit seek cancels that visit.
export const DUB_LIFECYCLE = Object.freeze({
  GENERATED: 'GENERATED', CACHED: 'CACHED', PREPARING: 'PREPARING', READY: 'READY',
  DUE: 'DUE', PLAYING: 'PLAYING', PLAYED: 'PLAYED',
  SKIPPED_BY_EXPLICIT_SEEK: 'SKIPPED_BY_EXPLICIT_SEEK', FAILED: 'FAILED'
});

export function createDubScheduler(segments = [], options = {}) {
  const getId = options.getId || ((segment, index) =>
    String(segment.segmentId ?? segment.id ?? `${segment.startTime}:${segment.endTime}:${index}`));
  const rows = [];
  const byId = new Map();
  const pending = new Map();
  const actualPlayed = new Set();
  let pendingOrder = [];
  let generation = options.generation ?? 0;
  let visit = 0;
  let cursor = 0;
  let time = null;
  let seekTime = null;
  let furthestSeekTime = -Infinity;
  const explicitlySkipped = new Set();
  let startCount = 0;
  let playAttemptCount = 0;

  for (const [index, segment] of segments.entries()) {
    const startTime = Number(segment?.startTime);
    const endTime = Number(segment?.endTime);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) continue;
    const id = String(getId(segment, index));
    if (byId.has(id)) throw new Error(`Duplicate dubbing segment id: ${id}`);
    const row = {
      id, segment, startTime, endTime, originalIndex: index,
      preparationState: DUB_LIFECYCLE.GENERATED, visit: -1,
      playbackStarts: 0, preparationReason: null,
      playAttemptCount: 0, lastPlayAttemptTime: null, lastPlayAttemptGeneration: null
    };
    rows.push(row);
    byId.set(id, row);
  }
  rows.sort((a, b) => a.startTime - b.startTime || a.originalIndex - b.originalIndex);
  rows.forEach((row, index) => { row.index = index; });

  // The balanced interval index lets an initial position or seek find all
  // overlapping voices without searching the entire preceding timeline.
  function buildIntervals(low, high) {
    if (low >= high) return null;
    const middle = (low + high) >>> 1;
    const left = buildIntervals(low, middle);
    const right = buildIntervals(middle + 1, high);
    return {
      row: rows[middle], left, right,
      minStart: rows[low].startTime,
      maxEnd: Math.max(rows[middle].endTime, left?.maxEnd ?? -Infinity, right?.maxEnd ?? -Infinity)
    };
  }
  const intervals = buildIntervals(0, rows.length);

  function position(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Dubbing time must be finite.');
    return Math.max(0, number);
  }

  function upperBound(value) {
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].startTime <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function activeAt(value, node = intervals, result = []) {
    if (!node || node.minStart > value || node.maxEnd <= value) return result;
    activeAt(value, node.left, result);
    if (node.row.startTime <= value && value < node.row.endTime) result.push(node.row);
    if (node.row.startTime <= value) activeAt(value, node.right, result);
    return result;
  }

  // Visit state is reset lazily. A seek only touches pending and active voices;
  // readiness and cumulative playback evidence belong to the source, not a visit.
  function visitRow(row) {
    if (row.visit === visit) return row;
    row.visit = visit;
    row.due = null;
    row.lastDue = null;
    row.playedThisVisit = false;
    row.playing = false;
    row.playAttempt = false;
    row.ended = false;
    row.reason = row.preparationReason;
    row.state = seekTime !== null && row.endTime <= seekTime
      ? DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK : row.preparationState;
    row.explicitSeekGeneration = seekTime !== null ? generation : null;
    row.skipReason = row.state === DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK
      ? 'EXPLICIT_SEEK_PAST_SEGMENT' : null;
    return row;
  }

  function insertPending(row) {
    if (pending.has(row.id)) return;
    let low = 0, high = pendingOrder.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pendingOrder[middle].index < row.index) low = middle + 1;
      else high = middle;
    }
    pendingOrder.splice(low, 0, row);
    pending.set(row.id, row);
  }

  function removePending(row) {
    if (!pending.delete(row.id)) return;
    let low = 0, high = pendingOrder.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pendingOrder[middle].index < row.index) low = middle + 1;
      else high = middle;
    }
    pendingOrder.splice(low, 1);
  }

  function latch(row, origin, selectedTime) {
    visitRow(row);
    if (row.due || row.playedThisVisit || row.state === DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK) return;
    row.due = Object.freeze({
      origin, time: selectedTime, offset: origin === 'explicit-seek' ? selectedTime - row.startTime : 0,
      generation
    });
    row.lastDue = row.due;
    row.state = row.preparationState === DUB_LIFECYCLE.FAILED ? DUB_LIFECYCLE.FAILED : DUB_LIFECYCLE.DUE;
    row.ended = false;
    insertPending(row);
  }

  function view(row) {
    visitRow(row);
    return {
      id: row.id, segment: row.segment, startTime: row.startTime, endTime: row.endTime,
      state: row.state, preparationState: row.preparationState, generation,
      due: row.due, playedThisVisit: row.playedThisVisit, playing: row.playing,
      ended: row.ended, actualPlayed: actualPlayed.has(row.id),
      playbackStarts: row.playbackStarts, reason: row.reason,
      playAttemptCount: row.playAttemptCount, lastPlayAttemptTime: row.lastPlayAttemptTime,
      lastPlayAttemptGeneration: row.lastPlayAttemptGeneration,
      explicitSeekGeneration: row.explicitSeekGeneration, skipReason: row.skipReason
    };
  }

  function due() { return pendingOrder.map(view); }

  function active(value = time ?? 0) {
    return activeAt(position(value)).map(view);
  }

  function upcoming(value = time ?? 0, count = 6) {
    const selectedTime = position(value);
    const selected = activeAt(selectedTime);
    const wanted = Math.max(0, Math.min(rows.length, Math.floor(Number(count) || 0)));
    let next = upperBound(selectedTime);
    // Keep every simultaneous voice, even when it exceeds the prefetch budget.
    // Active starts are <= selectedTime and future starts are > selectedTime,
    // so concatenation is stable and no segment can appear in both groups.
    while (selected.length < wanted && next < rows.length) selected.push(rows[next++]);
    return selected.map(view);
  }

  function initialize(value) {
    time = value;
    cursor = upperBound(value);
    for (const row of activeAt(value)) latch(row, 'natural', value);
  }

  function update(value) {
    const nextTime = position(value);
    if (time === null) initialize(nextTime);
    else {
      const nextCursor = upperBound(nextTime);
      // Ordinary backwards clock adjustments never replay or cancel a line.
      // Only seek() resets the cursor and establishes a new playback visit.
      while (cursor < nextCursor) latch(rows[cursor++], 'natural', nextTime);
      time = nextTime;
    }
    return due();
  }

  function seek(value, nextGeneration) {
    const selectedTime = position(value);
    generation = nextGeneration ?? (typeof generation === 'number' ? generation + 1 : visit + 1);
    visit += 1;
    time = selectedTime;
    seekTime = selectedTime;
    furthestSeekTime = Math.max(furthestSeekTime, selectedTime);
    cursor = upperBound(selectedTime);
    pending.clear();
    pendingOrder = [];
    for (const row of activeAt(selectedTime)) latch(row, 'explicit-seek', selectedTime);
    return due();
  }

  function currentRow(id, metadata = {}) {
    if (metadata.generation !== undefined && metadata.generation !== generation) return null;
    const row = byId.get(String(id));
    return row ? visitRow(row) : null;
  }

  function prepare(id, state, metadata) {
    const row = currentRow(id, metadata);
    if (!row) return false;
    row.preparationState = state;
    row.preparationReason = null;
    if (row.state !== DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK) row.reason = null;
    if (row.playedThisVisit) row.state = DUB_LIFECYCLE.PLAYED;
    else if (row.playing) row.state = DUB_LIFECYCLE.PLAYING;
    else if (row.due) row.state = DUB_LIFECYCLE.DUE;
    else if (row.state !== DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK) row.state = state;
    return true;
  }

  function markPlaying(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row || (!row.due && !row.playedThisVisit)) return false;
    row.playAttemptCount += 1;
    playAttemptCount += 1;
    row.lastPlayAttemptTime = metadata.time ?? time;
    row.lastPlayAttemptGeneration = generation;
    row.playing = true;
    row.playAttempt = true;
    row.ended = false;
    row.state = row.playedThisVisit ? DUB_LIFECYCLE.PLAYED : DUB_LIFECYCLE.PLAYING;
    return true;
  }

  function markPlayed(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row || !row.playAttempt) return false;
    row.playAttempt = false;
    row.playedThisVisit = true;
    row.playing = true;
    row.state = DUB_LIFECYCLE.PLAYED;
    row.reason = null;
    actualPlayed.add(row.id);
    row.playbackStarts += 1;
    startCount += 1;
    removePending(row);
    row.due = null;
    return true;
  }

  function markEnded(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row || !row.playing) return false;
    row.playing = false;
    row.playAttempt = false;
    row.ended = true;
    row.state = row.playedThisVisit ? DUB_LIFECYCLE.PLAYED
      : row.due ? DUB_LIFECYCLE.DUE : row.preparationState;
    return true;
  }

  function markPaused(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row) return false;
    row.playing = false;
    row.playAttempt = false;
    if (row.playedThisVisit) row.state = DUB_LIFECYCLE.PLAYED;
    else if (row.due) row.state = row.preparationState === DUB_LIFECYCLE.FAILED
      ? DUB_LIFECYCLE.FAILED : DUB_LIFECYCLE.DUE;
    return true;
  }

  function markFailed(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row) return false;
    const skipped = row.state === DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK;
    row.preparationState = DUB_LIFECYCLE.FAILED;
    row.preparationReason = String(metadata.reason || 'DUB_PLAYBACK_FAILED');
    if (!skipped) row.reason = row.preparationReason;
    row.playing = false;
    row.playAttempt = false;
    row.playedThisVisit = false;
    row.ended = false;
    row.state = skipped ? DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK : DUB_LIFECYCLE.FAILED;
    // A decoder failure after a successful start still needs recovery. Restore
    // eligibility from this visit's immutable selection, never from today's clock.
    if (!skipped && !row.due && row.lastDue) {
      row.due = row.lastDue;
      insertPending(row);
    }
    return true;
  }

  function markSkipped(id, metadata = {}) {
    const row = currentRow(id, metadata);
    if (!row) return false;
    removePending(row);
    row.due = null;
    row.lastDue = null;
    row.playing = false;
    row.playAttempt = false;
    row.playedThisVisit = false;
    row.state = DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK;
    row.reason = String(metadata.reason || 'EXPLICIT_SEEK');
    row.skipReason = row.reason;
    explicitlySkipped.add(row.id);
    return true;
  }

  function counts() {
    const result = {
      total: rows.length, generated: 0, cached: 0, preparing: 0, ready: 0,
      due: pending.size, playing: 0, playedThisVisit: 0, skipped: 0, failed: 0,
      actualPlayedCount: actualPlayed.size, startCount, playbackStarts: startCount,
      playAttemptCount,
      skippedByExplicitSeekCount: 0,
      states: Object.fromEntries(Object.values(DUB_LIFECYCLE).map(state => [state, 0]))
    };
    for (const row of rows) {
      visitRow(row);
      result.states[row.state] += 1;
      if (row.endTime <= furthestSeekTime || explicitlySkipped.has(row.id)) result.skippedByExplicitSeekCount += 1;
      if (row.preparationState === DUB_LIFECYCLE.GENERATED) result.generated += 1;
      if (row.preparationState === DUB_LIFECYCLE.CACHED) result.cached += 1;
      if (row.preparationState === DUB_LIFECYCLE.PREPARING) result.preparing += 1;
      if (row.preparationState === DUB_LIFECYCLE.READY) result.ready += 1;
      if (row.preparationState === DUB_LIFECYCLE.FAILED) result.failed += 1;
      if (row.playing) result.playing += 1;
      if (row.playedThisVisit) result.playedThisVisit += 1;
      if (row.state === DUB_LIFECYCLE.SKIPPED_BY_EXPLICIT_SEEK) result.skipped += 1;
    }
    return result;
  }

  const api = {
    update, seek, due, active, upcoming,
    get: id => { const row = byId.get(String(id)); return row ? view(row) : null; },
    markGenerated: (id, metadata = {}) => prepare(id, DUB_LIFECYCLE.GENERATED, metadata),
    markCached: (id, metadata = {}) => prepare(id, DUB_LIFECYCLE.CACHED, metadata),
    markPreparing: (id, metadata = {}) => prepare(id, DUB_LIFECYCLE.PREPARING, metadata),
    markReady: (id, metadata = {}) => prepare(id, DUB_LIFECYCLE.READY, metadata),
    markPlaying, markPlayed, markEnded, markPaused, markFailed, markSkipped,
    snapshot: () => rows.map(view), counts
  };
  api.transition = (id, state, metadata = {}) => {
    const method = {
      GENERATED: 'markGenerated', CACHED: 'markCached', PREPARING: 'markPreparing', READY: 'markReady',
      PLAYING: 'markPlaying', PLAYED: 'markPlayed', FAILED: 'markFailed',
      SKIPPED_BY_EXPLICIT_SEEK: 'markSkipped'
    }[state];
    return method ? api[method](id, metadata) : false;
  };
  if (options.initialTime !== undefined) initialize(position(options.initialTime));
  return api;
}
