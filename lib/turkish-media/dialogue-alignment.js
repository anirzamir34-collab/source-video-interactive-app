const canonical = text => String(text).normalize('NFC').toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, '');

// Reuse only the provider's measured character times for the exact input.
// Voice ranges select the input; actual extracted duration maps its audio clock.
export function nativeDialogueWords(alignment, segments, inputIndex, text, duration) {
  if (!alignment || !Array.isArray(segments) || !(duration > 0)) return null;
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (!Array.isArray(characters) || !characters.length || starts?.length !== characters.length || ends?.length !== characters.length) return null;
  const ranges = segments.filter(row => row.dialogue_input_index === inputIndex);
  if (!ranges.length) return null;
  const start = Math.min(...ranges.map(row => row.start_time_seconds));
  const end = Math.max(...ranges.map(row => row.end_time_seconds));
  const scale = duration / (end - start);
  if (!Number.isFinite(scale) || scale < .75 || scale > 1.25) return null;
  const indices = new Set();
  for (const range of ranges) {
    if (!Number.isInteger(range.character_start_index) || !Number.isInteger(range.character_end_index) ||
      range.character_start_index < 0 || range.character_end_index > characters.length ||
      range.character_end_index <= range.character_start_index) return null;
    for (let i = range.character_start_index; i < range.character_end_index; i++) indices.add(i);
  }
  const ordered = [...indices].sort((a, b) => a - b);
  if (canonical(ordered.map(i => characters[i]).join('')) !== canonical(text)) return null;
  const words = [];
  let current;
  const flush = () => { if (current && canonical(current.text)) words.push(current); current = null; };
  for (const i of ordered) {
    if (typeof characters[i] !== 'string' || !Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || ends[i] < starts[i]) return null;
    if (/^\s*$/u.test(characters[i])) { flush(); continue; }
    const localStart = (starts[i] - start) * scale, localEnd = (ends[i] - start) * scale;
    if (localStart < -.05 || localEnd > duration + .05) return null;
    if (!current) current = { text: '', start: Math.max(0, localStart), end: 0 };
    current.text += characters[i]; current.end = Math.max(current.end, Math.min(duration, localEnd));
  }
  flush();
  return words.length && words.every(word => word.end > word.start) ? words : null;
}

export function fitNativeDialogueWords(parts, text, fitted) {
  if (!parts.length || !(fitted?.tempo >= 1) || !Number.isFinite(fitted.tempo) || !(fitted.duration > 0)) return null;
  const result = []; let offset = 0;
  const mapped = value => (value - (fitted.sourceOffset || 0) - (fitted.removedPauses || []).reduce((sum, pause) =>
    sum + Math.max(0, Math.min(value, pause.end) - pause.start), 0)) / fitted.tempo;
  for (const part of parts) {
    if (!part.nativeWords?.length || !(part.nativeDuration > 0)) return null;
    for (const word of part.nativeWords) result.push({ text: word.text,
      start: mapped(offset + word.start), end: mapped(offset + word.end) });
    offset += part.nativeDuration;
  }
  if (canonical(result.map(word => word.text).join('')) !== canonical(text) ||
    result.some(word => word.start < 0 || word.end <= word.start || word.end > fitted.duration + .05)) return null;
  return result;
}
