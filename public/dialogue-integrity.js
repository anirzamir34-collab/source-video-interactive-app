const clean = value => String(value || '').trim().replace(/\s+/g, ' ');
const textKey = value => clean(value).normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/[\p{P}\p{S}]/gu, '').trim();

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
