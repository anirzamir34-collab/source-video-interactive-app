// Gameplay consumes only original speech at source-video times. Translated
// captions and generated audio never supply character or action evidence.
export function sourceContextAdapter(transcript) {
  if (!transcript) return null;
  if (!Array.isArray(transcript.utterances)) throw new Error('Kaynak konuşma zaman çizelgesi geçersiz.');
  const segments = transcript.utterances.map(row => {
    const startTime = row.sourceStart, endTime = row.sourceEnd;
    if (!row.segmentId || !row.speakerId || !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime || typeof row.sourceText !== 'string') {
      throw new Error('Kaynak konuşma kanıtı geçersiz.');
    }
    return { segmentId: row.segmentId, speakerId: row.speakerId,
      originalText: row.sourceText, text: row.sourceText, textTr: '', turkishText: '',
      startTime, endTime, gender: ['female', 'male'].includes(row.gender) ? row.gender : 'uncertain',
      speakerName: '', confidence: row.confidence, emotion: row.emotion ?? 'uncertain' };
  });
  return { sourceLanguage: transcript.language || 'unknown', timestampUnit: 'seconds', segments,
    speakers: (transcript.speakers || []).map(row => ({ speakerId: row.speakerId, providerId: row.providerId,
      gender: ['female', 'male'].includes(row.gender) ? row.gender : 'uncertain',
      emotion: row.emotion ?? 'uncertain', speakerName: '' })),
    nonSpeechEvents: (transcript.audioEvents || []).map(row => ({ eventId: row.eventId, speakerId: row.speakerId,
      type: row.type, text: row.text, logprob: row.logprob, startTime: row.start, endTime: row.end, evidence: row.text })) };
}

export function sourceSpeechOverlaps(left, right) {
  if (![left, right].every(row => Number.isFinite(row?.startTime) && Number.isFinite(row?.endTime) &&
      row.startTime >= 0 && row.endTime > row.startTime)) return false;
  return Math.min(left.endTime, right.endTime) - Math.max(left.startTime, right.startTime) > 0.04;
}
