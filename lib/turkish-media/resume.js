import { MediaError } from './errors.js';

// Input for completing a saved partial dub: only the still-missing lines are
// voiced. Everything else (transcript, Turkish lines, voices, the lines
// already in the saved mix) comes from the saved game and is checked here.
const id = value => typeof value === 'string' && /^[A-Za-z0-9:_.-]{1,160}$/.test(value);
const num = value => Number.isFinite(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;

export function sanitizeDubResume(value) {
  if (value === undefined || value === null) return null;
  const invalid = detail => new MediaError('DUB_RESUME_INVALID', `Eksik dublaj bilgileri geçersiz: ${detail}.`, { status: 400 });
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('biçim');
  const transcript = value.sourceTranscript;
  if (!transcript || transcript.version !== 1 || !Array.isArray(transcript.utterances) || !Array.isArray(transcript.speakers) ||
      transcript.utterances.length > 6000 || transcript.speakers.length > 64) throw invalid('kaynak konuşma');
  const speakers = new Map();
  for (const speaker of transcript.speakers) {
    if (!id(speaker?.speakerId) || speakers.has(speaker.speakerId)) throw invalid('konuşmacı');
    speakers.set(speaker.speakerId, speaker);
  }
  const utterances = new Map();
  for (const row of transcript.utterances) {
    if (!id(row?.segmentId) || utterances.has(row.segmentId) || !speakers.has(row.speakerId) ||
        !num(row.sourceStart) || !num(row.sourceEnd) || row.sourceEnd <= row.sourceStart || row.sourceStart < 0 ||
        !text(row.sourceText, 4000)) throw invalid('konuşma aralığı');
    utterances.set(row.segmentId, row);
  }
  const translations = Array.isArray(value.translatedUtterances) ? value.translatedUtterances : [];
  const translated = new Set();
  for (const row of translations) {
    if (!utterances.has(row?.segmentId) || translated.has(row.segmentId) || !text(row.translatedText, 4000) ||
        !row.translatedText.trim()) throw invalid('Türkçe çeviri');
    translated.add(row.segmentId);
  }
  if (translated.size !== utterances.size) throw invalid('çeviri kapsamı');
  const voices = value.voiceMapping;
  if (!voices || typeof voices !== 'object' || Array.isArray(voices) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(voices))) throw invalid('sesler');
  const voiceMapping = {};
  for (const [speakerId, voiceId] of Object.entries(voices)) {
    if (!speakers.has(speakerId) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(voiceId))) throw invalid('sesler');
    voiceMapping[speakerId] = String(voiceId);
  }
  const dubs = Array.isArray(value.dubSegments) ? value.dubSegments : [];
  const dubbed = new Set();
  const dubSegments = dubs.map(row => {
    if (!utterances.has(row?.segmentId) || dubbed.has(row.segmentId) || row.speakerId !== utterances.get(row.segmentId).speakerId ||
        !num(row.start) || !num(row.end) || row.end <= row.start || row.start < 0) throw invalid('dublaj zamanları');
    dubbed.add(row.segmentId);
    return row;
  });
  const pending = Array.isArray(value.pendingSegmentIds) ? [...new Set(value.pendingSegmentIds)] : [];
  if (!pending.length) throw invalid('eksik cümle yok');
  for (const segmentId of pending) {
    if (!utterances.has(segmentId) || dubbed.has(segmentId)) throw invalid('eksik cümle');
    if (!voiceMapping[utterances.get(segmentId).speakerId]) throw invalid('eksik cümlenin sesi');
  }
  const unverified = value.qualityReport?.unverifiedSpeakerIds;
  return { sourceTranscript: transcript, translatedUtterances: translations, voiceMapping, dubSegments,
    pendingSegmentIds: pending,
    qualityReport: { unverifiedSpeakerIds: Array.isArray(unverified) ? unverified.filter(id).slice(0, 64) : [] } };
}
