import { createHash } from 'node:crypto';

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const rowsOf = value => Array.isArray(value) ? value : value?.utterances;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function timestamp(value, duration, label, optional = false) {
  if (optional && value == null) return null;
  if (!finite(value) || value < 0 || value > duration) throw fail('INVALID_SOURCE_TIMESTAMP', { label });
  return value;
}

function evidenceText(words) {
  if (words.some(word => word.type === 'spacing')) return words.map(word => word.text).join('').trim();
  return words.map(word => word.text).join(' ').replace(/\s+([,.;:!?])/gu, '$1').trim();
}

// Preserve the provider's original word evidence. Malformed speech fails the
// request; a provider-rounded zero-duration word gets only a bounded canonical
// utterance interval so one valid token cannot abort the whole video.
export function normalizeScribeTranscript(response, { sourceHash, duration } = {}) {
  if (!nonempty(sourceHash) || !finite(duration) || duration <= 0) throw fail('INVALID_TRANSCRIPT_SOURCE');
  if (!response || !Array.isArray(response.words)) throw fail('SCRIBE_WORDS_REQUIRED');
  const identity = /^[a-f\d]{64}$/iu.test(sourceHash) ? sourceHash.toLowerCase() :
    createHash('sha256').update(sourceHash).digest('hex');
  const language = response.language_code ?? response.language ?? null;
  const speakers = [];
  const identities = new Map();
  const profiles = Array.isArray(response.speakers) ? response.speakers : [];
  const speakerFor = providerId => {
    const key = providerId == null ? null : String(providerId);
    if (!identities.has(key)) {
      const profile = profiles.find(row => String(row?.speaker_id ?? row?.providerId ?? '') === key);
      const speaker = { speakerId: `speaker-${identity}-${String(speakers.length + 1).padStart(3, '0')}`,
        providerId: key, gender: profile?.gender ?? null, emotion: profile?.emotion ?? null };
      speakers.push(speaker);
      identities.set(key, speaker);
    }
    return identities.get(key);
  };
  const utterances = [];
  const audioEvents = [];
  let current = null;
  let pendingSpacing = [];
  const finish = () => {
    if (!current) return;
    const speech = current.words.filter(word => word.type === 'word' && nonempty(word.text));
    if (!speech.length) throw fail('EMPTY_SPEECH_UTTERANCE');
    const sourceStart = speech.reduce((minimum, word) => Math.min(minimum, word.start), Infinity);
    const sourceEnd = speech.reduce((maximum, word) => Math.max(maximum, word.end), -Infinity);
    if (sourceEnd <= sourceStart) throw fail('INVALID_SPEECH_DURATION');
    utterances.push({ segmentId: `segment-${identity}-${String(utterances.length + 1).padStart(6, '0')}`,
      speakerId: current.speaker.speakerId, sourceText: evidenceText(current.words), displaySubtitleText: '',
      sourceStart, sourceEnd, words: current.words, language,
      confidence: current.confidence, gender: current.speaker.gender, emotion: current.speaker.emotion });
    current = null;
  };

  for (const [index, input] of response.words.entries()) {
    if (!input || typeof input !== 'object' || typeof input.text !== 'string') throw fail('INVALID_SCRIBE_WORD', { index });
    const type = input.type ?? 'word';
    if (!['word', 'spacing', 'audio_event'].includes(type)) throw fail('UNKNOWN_SCRIBE_WORD_TYPE', { index, type });
    const optional = type !== 'word';
    const start = timestamp(input.start, duration, `words[${index}].start`, optional);
    const end = timestamp(input.end, duration, `words[${index}].end`, optional);
    if (start != null && end != null && end < start) throw fail('INVALID_SOURCE_TIMESTAMP', { index });
    const word = { ...input, text: input.text, start, end, type, logprob: input.logprob ?? null };
    if (type === 'audio_event') {
      finish();
      audioEvents.push({ ...word, eventId: `event-${identity}-${String(index + 1).padStart(6, '0')}`,
        speakerId: input.speaker_id == null ? null : speakerFor(input.speaker_id).speakerId });
      continue;
    }
    if (type === 'spacing') {
      if (current) current.words.push(word);
      else pendingSpacing.push(word);
      continue;
    }
    if (!nonempty(word.text)) throw fail('EMPTY_SCRIBE_SPEECH_WORD', { index });
    const speaker = speakerFor(input.speaker_id ?? input.speakerId);
    const previousSpeech = current?.words.findLast(item => item.type === 'word');
    const sentenceEnd = previousSpeech && /[.!?…]["'”’)]*\s*$/u.test(previousSpeech.text);
    const distant = previousSpeech && start - previousSpeech.end > 1.5;
    if (current && (current.speaker !== speaker || sentenceEnd || distant)) finish();
    if (!current) current = { speaker, words: pendingSpacing, confidence: input.confidence ?? null };
    pendingSpacing = [];
    current.words.push(word);
  }
  finish();
  // A provider text without timed words cannot authorize invented timestamps.
  if (!utterances.length && nonempty(response.text) && !audioEvents.length) throw fail('SCRIBE_SPEECH_TIMING_MISSING');
  return { version: 1, source: { hash: sourceHash, duration }, language, speakers, utterances, audioEvents,
    ...(pendingSpacing.length ? { trailingSpacing: pendingSpacing } : {}) };
}

// Identity is the link between transcription, translation and audio. Source
// timestamps and original speech remain authoritative throughout the pipeline.
export function assertSegmentCoverage(source, translated, dubs) {
  const utterances = rowsOf(source);
  if (!Array.isArray(utterances)) throw fail('CANONICAL_UTTERANCES_REQUIRED');
  const expected = new Map();
  for (const row of utterances) {
    if (!nonempty(row?.segmentId) || !nonempty(row?.speakerId) || expected.has(row.segmentId)) {
      throw fail('INVALID_CANONICAL_SEGMENT_ID');
    }
    expected.set(row.segmentId, row);
  }
  const inspect = (rows, stage) => {
    if (!Array.isArray(rows) || rows.length !== expected.size) throw fail('SEGMENT_COVERAGE_MISMATCH', { stage });
    const seen = new Set();
    for (const row of rows) {
      const original = expected.get(row?.segmentId);
      if (!original || seen.has(row.segmentId) || row.speakerId !== original.speakerId) {
        throw fail('SEGMENT_IDENTITY_MISMATCH', { stage, segmentId: row?.segmentId });
      }
      for (const key of ['sourceStart', 'sourceEnd', 'sourceText']) {
        if (row[key] != null && row[key] !== original[key]) throw fail('SOURCE_EVIDENCE_MUTATED', { stage, key });
      }
      if (stage === 'translation' && !nonempty(row.translatedText)) throw fail('EMPTY_SEGMENT_TRANSLATION', { segmentId: row.segmentId });
      seen.add(row.segmentId);
    }
  };
  inspect(translated, 'translation');
  if (dubs !== undefined) inspect(dubs, 'dub');
  return true;
}

export function sourceContextAdapter(transcript, translations) {
  if (!Array.isArray(transcript?.utterances)) throw fail('CANONICAL_UTTERANCES_REQUIRED');
  if (translations !== undefined) assertSegmentCoverage(transcript, translations);
  const translated = new Map((translations || []).map(row => [row.segmentId, row]));
  return { sourceLanguage: transcript.language || 'unknown', timestampUnit: 'seconds',
    segments: transcript.utterances.map(row => ({ segmentId: row.segmentId, speakerId: row.speakerId,
      originalText: row.sourceText, text: row.sourceText,
      textTr: translated.get(row.segmentId)?.translatedText || '',
      turkishText: translated.get(row.segmentId)?.translatedText || '',
      startTime: row.sourceStart, endTime: row.sourceEnd,
      gender: ['female', 'male'].includes(row.gender) ? row.gender : 'uncertain',
      speakerName: '', confidence: row.confidence, emotion: row.emotion ?? 'uncertain' })),
    speakers: (transcript.speakers || []).map(row => ({ ...row,
      gender: ['female', 'male'].includes(row.gender) ? row.gender : 'uncertain', speakerName: '' })),
    nonSpeechEvents: (transcript.audioEvents || []).map(row => ({ ...row,
      startTime: row.start, endTime: row.end, evidence: row.text })) };
}
