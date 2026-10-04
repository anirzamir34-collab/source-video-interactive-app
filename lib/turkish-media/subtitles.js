import { assertSegmentCoverage } from './model.js';
import { dubEndLimit } from './timing.js';

const fail = code => Object.assign(new Error(code), { code });
const MAX_LINE = 42;
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const chars = value => [...value].length;
const joins = words => clean(words.map(word => word.text).join(' ')).replace(/\s+([,.;:!?])/gu, '$1');

function linesFor(value) {
  const text = clean(value);
  if (chars(text) <= MAX_LINE) return { text, warnings: [] };
  const tokens = text.split(' ');
  let best = null;
  for (let index = 1; index < tokens.length; index++) {
    const first = tokens.slice(0, index).join(' '), last = tokens.slice(index).join(' ');
    const score = Math.max(chars(first), chars(last)) * 2 + Math.abs(chars(first) - chars(last));
    if (!best || score < best.score) best = { first, last, score };
  }
  if (!best) return { text, warnings: ['SUBTITLE_LINE_TOO_LONG'] };
  return { text: `${best.first}\n${best.last}`,
    warnings: Math.max(chars(best.first), chars(best.last)) > MAX_LINE ? ['SUBTITLE_LINE_TOO_LONG'] : [] };
}

function cue(segment, start, end, text, words, index = 0) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw fail('INVALID_SUBTITLE_CUE_TIME');
  const wrapped = linesFor(text);
  if (!wrapped.text) throw fail('EMPTY_SUBTITLE_CUE');
  return { cueId: `${segment.segmentId}:${index}`, segmentId: segment.segmentId,
    speakerId: segment.speakerId, start, end, text: wrapped.text, words,
    ...(wrapped.warnings.length ? { warnings: wrapped.warnings } : {}) };
}

// Source subtitles use source speech intervals only. Turkish word timestamps
// come from validated native timestamps or forced alignment on actual audio.
export function buildSubtitleTracks(transcript, translated, dubs = []) {
  assertSegmentCoverage(transcript, translated, dubs.length ? dubs : undefined);
  const translations = new Map(translated.map(row => [row.segmentId, row]));
  const byId = new Map(dubs.map(row => [row.segmentId, row]));
  const source_tr = [], dub_tr = [];
  for (const segment of transcript.utterances) {
    const translation = translations.get(segment.segmentId);
    source_tr.push(cue(segment, segment.sourceStart, segment.sourceEnd,
      translation.displaySubtitleText || translation.translatedText, []));
    const dub = byId.get(segment.segmentId);
    if (!dub) continue;
    const dubStart = dub.start ?? segment.sourceStart, dubEnd = dub.end ?? segment.sourceEnd;
    if (dubStart !== segment.sourceStart || dubEnd < segment.sourceEnd || dubEnd > dubEndLimit(transcript, segment) + .00005)
      throw fail('INVALID_DUB_WORD_ALIGNMENT');
    if (!Array.isArray(dub.words) || !dub.words.length) throw fail('DUB_WORD_ALIGNMENT_REQUIRED');
    let group = [];
    let index = 0;
    let lastStart = -Infinity;
    const finish = () => {
      if (!group.length) return;
      dub_tr.push(cue(segment, Math.min(...group.map(word => word.start)), Math.max(...group.map(word => word.end)),
        joins(group), group, index++));
      group = [];
    };
    for (const input of dub.words) {
      if (!input || !clean(input.text) || !Number.isFinite(input.start) || !Number.isFinite(input.end) ||
          input.start < dubStart || input.end > dubEnd || input.end <= input.start || input.start < lastStart) {
        throw fail('INVALID_DUB_WORD_ALIGNMENT');
      }
      lastStart = input.start;
      if (group.length && (chars(joins([...group, input])) > MAX_LINE * 2 || input.start - group.at(-1).end > 1)) finish();
      group.push({ ...input });
      if (/[.!?…]["'”’)]*\s*$/u.test(input.text)) finish();
    }
    finish();
  }
  const order = (a, b) => a.start - b.start || a.end - b.end || a.cueId.localeCompare(b.cueId);
  return { source_tr: source_tr.sort(order), dub_tr: dub_tr.sort(order) };
}

function timestamp(value, separator) {
  if (!Number.isFinite(value) || value < 0) throw fail('INVALID_SUBTITLE_EXPORT_TIME');
  const milliseconds = Math.round(value * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(milliseconds % 1000).padStart(3, '0')}`;
}

function exportCues(cues, separator, webVtt) {
  if (!Array.isArray(cues)) throw fail('SUBTITLE_CUES_REQUIRED');
  return cues.map((row, index) => {
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start) throw fail('INVALID_SUBTITLE_EXPORT_TIME');
    // Cue text cannot create another cue or interpret source speech as markup.
    const text = String(row.text ?? '').replace(/\r/gu, '').split('\n').filter(Boolean).join('\n');
    if (!text.trim()) throw fail('EMPTY_SUBTITLE_CUE');
    const safe = webVtt ? text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;') : text;
    return `${index + 1}\n${timestamp(row.start, separator)} --> ${timestamp(row.end, separator)}\n${safe}\n`;
  }).join('\n');
}

export const toSrt = cues => exportCues(cues, ',', false);
export const toWebVtt = cues => `WEBVTT\n\n${exportCues(cues, '.', true)}`;
