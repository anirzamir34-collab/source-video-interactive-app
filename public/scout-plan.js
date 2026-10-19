// Two-pass analysis for long videos (25+ minutes).
//
// Pass 1 (scout): a cheap model looks at the whole video through sparse
// frames and labels the timeline: ordinary story, scene change, opening
// approach, intimate activity, or uncertain.
// Pass 2 (deep): approach, intimate, uncertain and scene-change ranges are
// sent to the deep model in small, frame-dense requests. Ordinary story
// ranges are grouped into fewer, wider requests. Every captured frame is
// still sent exactly once; only the request grouping changes, so no footage
// is skipped and the cost saving comes from fewer repeated prompts.

export const SCOUT_MIN_DURATION_SECONDS = 25 * 60;
export const SCOUT_KINDS = Object.freeze(['story', 'scene_change', 'approach', 'intimate', 'uncertain']);
const DETAILED_KINDS = new Set(['approach', 'intimate', 'uncertain', 'scene_change']);
const FRAMES_PER_SHEET = 12;

export function scoutEligible(duration, analysisTier) {
  return analysisTier === 'deep' && Number(duration) >= SCOUT_MIN_DURATION_SECONDS;
}

// Pick evenly spaced frame indexes (roughly one per `spacing` seconds) for
// the scout. Always keep the first and last frame.
export function scoutFrameIndexes(timestamps = [], spacing = 18) {
  const times = (Array.isArray(timestamps) ? timestamps : []).map(Number);
  if (!times.length) return [];
  const picked = [0];
  let next = times[0] + spacing;
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] >= next) {
      picked.push(index);
      next = times[index] + spacing;
    }
  }
  if (picked.at(-1) !== times.length - 1) picked.push(times.length - 1);
  return picked;
}

// Compose scout contact sheets by cropping the already captured tiles, so no
// second pass over the video file is needed.
export async function buildScoutSheets(storyboard, { spacing = 18, signal } = {}) {
  const indexes = scoutFrameIndexes(storyboard?.timestamps, spacing);
  const sheets = [], timestamps = [];
  if (!indexes.length || typeof createImageBitmap !== 'function') return { sheets, timestamps };
  const bitmapCache = new Map();
  const bitmapFor = async sheetIndex => {
    if (!bitmapCache.has(sheetIndex)) {
      bitmapCache.clear();
      bitmapCache.set(sheetIndex, await createImageBitmap(storyboard.sheets[sheetIndex]));
    }
    return bitmapCache.get(sheetIndex);
  };
  let canvas = null, ctx = null, cellWidth = 0, cellHeight = 0, slot = 0;
  const flush = async () => {
    if (!slot) return;
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value =>
      value ? resolve(value) : reject(new Error('Scout sheet could not be encoded.')), 'image/jpeg', 0.82));
    sheets.push(blob);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    slot = 0;
  };
  for (const frameIndex of indexes) {
    signal?.throwIfAborted?.();
    const sheetIndex = Math.floor(frameIndex / FRAMES_PER_SHEET);
    const tile = frameIndex % FRAMES_PER_SHEET;
    if (!storyboard.sheets[sheetIndex]) continue;
    const bitmap = await bitmapFor(sheetIndex);
    if (!canvas) {
      cellWidth = Math.floor(bitmap.width / 3);
      cellHeight = Math.floor(bitmap.height / 4);
      canvas = document.createElement('canvas');
      canvas.width = cellWidth * 3; canvas.height = cellHeight * 4;
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, (tile % 3) * cellWidth, Math.floor(tile / 3) * cellHeight, cellWidth, cellHeight,
      (slot % 3) * cellWidth, Math.floor(slot / 3) * cellHeight, cellWidth, cellHeight);
    timestamps.push(Number(storyboard.timestamps[frameIndex]));
    slot += 1;
    if (slot === FRAMES_PER_SHEET) await flush();
  }
  await flush();
  return { sheets, timestamps };
}

// Normalize and merge scout segments. Gaps and anything unlabeled become
// "uncertain" so they are analysed in detail rather than skipped.
export function normalizeScoutSegments(segments = [], duration = 0) {
  const total = Math.max(0, Number(duration) || 0);
  const rows = (Array.isArray(segments) ? segments : [])
    .map(row => ({ startTime: Math.max(0, Number(row?.startTime)), endTime: Math.min(total, Number(row?.endTime)),
      kind: SCOUT_KINDS.includes(row?.kind) ? row.kind : 'uncertain' }))
    .filter(row => Number.isFinite(row.startTime) && Number.isFinite(row.endTime) && row.endTime > row.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const filled = [];
  let cursor = 0;
  for (const row of rows) {
    if (row.startTime > cursor + 1) filled.push({ startTime: cursor, endTime: row.startTime, kind: 'uncertain' });
    const startTime = Math.max(cursor, row.startTime);
    if (row.endTime > startTime) filled.push({ ...row, startTime });
    cursor = Math.max(cursor, row.endTime);
  }
  if (total > cursor + 1) filled.push({ startTime: cursor, endTime: total, kind: 'uncertain' });
  return filled.reduce((merged, row) => {
    const last = merged.at(-1);
    if (last && last.kind === row.kind && row.startTime <= last.endTime + 0.5) last.endTime = Math.max(last.endTime, row.endTime);
    else merged.push({ ...row });
    return merged;
  }, []);
}

// Chunk the existing storyboard sheets from the scout timeline.
// Detailed ranges (with padding) -> at most `detailedSheets` sheets per request.
// Story ranges -> wide requests of up to `storySeconds` seconds.
export function scoutChunkPlan(storyboard, segments, {
  paddingSeconds = 25, detailedSheets = 2, storySeconds = 180, maxStorySheets = 6
} = {}) {
  const timestamps = (storyboard?.timestamps || []).map(Number);
  const sheetCount = Array.isArray(storyboard?.sheets) ? storyboard.sheets.length : 0;
  const duration = Number(storyboard?.duration) || timestamps.at(-1) || 0;
  if (!sheetCount || !timestamps.length) return null;
  const normalized = normalizeScoutSegments(segments, duration);
  const detailedRanges = normalized.filter(row => DETAILED_KINDS.has(row.kind))
    .map(row => ({ startTime: Math.max(0, row.startTime - paddingSeconds), endTime: Math.min(duration, row.endTime + paddingSeconds) }));
  const span = index => ({
    start: timestamps[index * FRAMES_PER_SHEET] ?? duration,
    end: timestamps[(index + 1) * FRAMES_PER_SHEET] ?? duration
  });
  const detailed = Array.from({ length: sheetCount }, (_, index) => {
    const { start, end } = span(index);
    return detailedRanges.some(range => range.startTime < end && range.endTime > start);
  });
  // The opening and closing sheets carry cast identity and the ending.
  detailed[0] = true; detailed[sheetCount - 1] = true;
  const chunks = [];
  for (let start = 0; start < sheetCount;) {
    let width = 1;
    if (detailed[start]) {
      while (width < detailedSheets && start + width < sheetCount && detailed[start + width]) width += 1;
    } else {
      while (width < maxStorySheets && start + width < sheetCount && !detailed[start + width] &&
        span(start + width).end - span(start).start <= storySeconds + 0.1) width += 1;
    }
    chunks.push({ firstSheet: start, sheetCount: width, focusTier: detailed[start] ? 'detailed' : 'overview' });
    start += width;
  }
  return {
    sheetsPerChunk: Math.max(...chunks.map(chunk => chunk.sheetCount)),
    chunkCount: chunks.length,
    chunks,
    adaptive: true,
    scout: true,
    segments: normalized,
    overviewChunkCount: chunks.filter(chunk => chunk.focusTier === 'overview').length,
    detailedChunkCount: chunks.filter(chunk => chunk.focusTier === 'detailed').length
  };
}
