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
      const reportedGender = String(profile?.gender || '').toLowerCase();
      const speaker = { speakerId: `speaker-${identity}-${String(speakers.length + 1).padStart(3, '0')}`,
        providerId: key, gender: ['male', 'female'].includes(reportedGender) ? reportedGender : null,
        emotion: profile?.emotion ?? null };
      speakers.push(speaker);
      identities.set(key, speaker);
    }
    return identities.get(key);
  };
  const utterances = [];
  const audioEvents = [];
  let current = null;
  let pendingSpacing = [];
  const finish = (nextBoundaryStart = null) => {
    if (!current) return;
    const speech = current.words.filter(word => word.type === 'word' && nonempty(word.text));
    if (!speech.length) throw fail('EMPTY_SPEECH_UTTERANCE');
    let sourceStart = speech.reduce((minimum, word) => Math.min(minimum, word.start), Infinity);
    let sourceEnd = speech.reduce((maximum, word) => Math.max(maximum, word.end), -Infinity);
    let timingRepair = null;

    // Scribe can occasionally return a meaningful very-short word with equal
    // start/end timestamps. Keep the provider's word timestamps untouched, but
    // derive a conservative utterance interval from adjacent provider evidence
    // so one rounded token cannot abort the entire video pipeline.
    if (sourceEnd === sourceStart) {
      const point = sourceStart;
      const laterEvidence = current.words
        .flatMap(word => [word.start, word.end])
        .filter(value => finite(value) && value > point && value <= duration);
      if (finite(nextBoundaryStart) && nextBoundaryStart > point && nextBoundaryStart <= duration) {
        laterEvidence.push(nextBoundaryStart);
      }
      const nearestLater = laterEvidence.length ? Math.min(...laterEvidence) : null;
      if (finite(nearestLater)) {
        sourceEnd = Math.min(nearestLater, point + 1.5);
      } else if (finite(nextBoundaryStart) && nextBoundaryStart <= point && point > 0) {
        // When the next provider token begins at the same rounded timestamp,
        // keep that next boundary intact and borrow a small interval before it.
        sourceStart = Math.max(0, point - 0.5);
      } else if (point < duration) {
        sourceEnd = Math.min(duration, point + 0.5);
      } else if (point > 0) {
        sourceStart = Math.max(0, point - 0.5);
      }
      if (sourceEnd > sourceStart) timingRepair = 'zero-duration-provider-timestamp';
    }

    if (sourceEnd <= sourceStart) throw fail('INVALID_SPEECH_DURATION');
    utterances.push({ segmentId: `segment-${identity}-${String(utterances.length + 1).padStart(6, '0')}`,
      speakerId: current.speaker.speakerId, sourceText: evidenceText(current.words), displaySubtitleText: '',
      sourceStart, sourceEnd, words: current.words, language,
      confidence: current.confidence, gender: current.speaker.gender, emotion: current.speaker.emotion,
      ...(timingRepair ? { timingRepair } : {}) });
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
      finish(start);
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
    if (current && (current.speaker !== speaker || sentenceEnd || distant)) finish(start);
    if (!current) current = { speaker, words: pendingSpacing, confidence: input.confidence ?? null };
    pendingSpacing = [];
    current.words.push(word);
  }
  finish(duration);
  // A provider text without timed words cannot authorize invented timestamps.
  if (!utterances.length && nonempty(response.text) && !audioEvents.length) throw fail('SCRIBE_SPEECH_TIMING_MISSING');
  return { version: 1, source: { hash: sourceHash, duration }, language, speakers, utterances, audioEvents,
    ...(pendingSpacing.length ? { trailingSpacing: pendingSpacing } : {}) };
}

export function applySpeakerHints(transcript, hints = {}) {
  if (!transcript || !Array.isArray(transcript.speakers) || !Array.isArray(transcript.utterances)) {
    throw fail('CANONICAL_UTTERANCES_REQUIRED');
  }
  if (!hints || typeof hints !== 'object' || Array.isArray(hints) || !Object.keys(hints).length) {
    return transcript;
  }

  const source = structuredClone(transcript);
  const known = new Set(source.speakers.map(row => String(row.speakerId)));
  const clean = {};
  for (const [speakerId, hint] of Object.entries(hints)) {
    if (!known.has(speakerId) || !hint || typeof hint !== 'object' || Array.isArray(hint)) continue;
    clean[speakerId] = {
      characterId: nonempty(hint.characterId) ? String(hint.characterId).trim() : null,
      gender: ['male', 'female'].includes(hint.gender) ? hint.gender : null,
      emotion: nonempty(hint.emotion) ? String(hint.emotion).trim().slice(0, 80) : null,
      tone: nonempty(hint.tone) ? String(hint.tone).trim().slice(0, 80) : null,
    };
  }
  if (!Object.keys(clean).length) return transcript;

  // Several Scribe diarization IDs may be fragments of the same visible
  // person. Only a verified visual character match is allowed to merge them;
  // gender or list order alone never merges speakers.
  const groups = new Map();
  for (const speaker of source.speakers) {
    const id = String(speaker.speakerId);
    const hint = clean[id];
    const key = hint?.characterId ? `character:${hint.characterId}` : `speaker:${id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(speaker);
  }

  const remap = new Map();
  const mergedSpeakers = [];
  for (const members of groups.values()) {
    const canonical = members[0];
    const memberIds = members.map(row => String(row.speakerId));
    const memberHints = memberIds.map(id => clean[id]).filter(Boolean);
    const characterIds = [...new Set(memberHints.map(row => row.characterId).filter(Boolean))];
    const genders = [...new Set(memberHints.map(row => row.gender).filter(Boolean))];
    const emotions = memberHints.map(row => row.emotion).filter(Boolean);
    const tones = memberHints.map(row => row.tone).filter(Boolean);
    const gender = genders.length === 1 ? genders[0] :
      (['male', 'female'].includes(canonical.gender) ? canonical.gender : null);
    const emotion = emotions[0] || canonical.emotion || null;
    const tone = tones[0] || canonical.tone || null;

    const merged = { ...canonical,
      ...(members.length > 1 ? { providerIds: members.map(row => row.providerId).filter(value => value != null) } : {}),
      ...(characterIds.length === 1 ? { characterId: characterIds[0] } : {}),
      gender, emotion, ...(tone ? { tone } : {}) };
    mergedSpeakers.push(merged);
    for (const id of memberIds) remap.set(id, merged.speakerId);
  }

  const profileById = new Map(mergedSpeakers.map(row => [String(row.speakerId), row]));
  source.speakers = mergedSpeakers;
  source.utterances = source.utterances.map(row => {
    const speakerId = remap.get(String(row.speakerId)) || row.speakerId;
    const profile = profileById.get(String(speakerId));
    return { ...row, speakerId,
      gender: profile?.gender ?? row.gender ?? null,
      emotion: profile?.emotion ?? row.emotion ?? null,
      ...(profile?.tone ? { tone: profile.tone } : {}) };
  });
  source.audioEvents = (source.audioEvents || []).map(row => ({
    ...row, speakerId: row.speakerId == null ? null : (remap.get(String(row.speakerId)) || row.speakerId)
  }));
  return source;
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
