import { MediaError } from './errors.js';

const normalize = value => String(value || '').normalize('NFKD').toLowerCase()
  .replace(/[^a-z0-9ğüşöçıİ]+/giu, ' ').trim();

const tokens = value => new Set(normalize(value).split(/\s+/u).filter(Boolean));

function voiceText(voice) {
  const labels = Object.entries(voice?.labels || {}).flatMap(([key, value]) => [key, value]);
  const verified = (voice?.verified_languages || []).flatMap(row => [row?.language, row?.accent, row?.locale]);
  return normalize([
    voice?.name, voice?.description, voice?.category, voice?.preview_url,
    ...labels, ...verified
  ].filter(Boolean).join(' '));
}

function turkishScore(voice) {
  const direct = String(voice?.labels?.language || '').toLowerCase();
  const verified = (voice?.verified_languages || []).map(row => String(row?.language || '').toLowerCase());
  return direct === 'tr' || verified.includes('tr') || verified.includes('turkish') ? 120 : 0;
}

const emotionAliases = {
  happy: ['happy', 'cheerful', 'bright', 'warm', 'upbeat', 'friendly', 'mutlu', 'neşeli', 'sicak'],
  excited: ['excited', 'energetic', 'dynamic', 'lively', 'enthusiastic', 'heyecanli', 'enerjik'],
  sad: ['sad', 'soft', 'gentle', 'melancholic', 'emotional', 'uzgun', 'duygusal', 'yumusak'],
  angry: ['angry', 'intense', 'strong', 'dramatic', 'assertive', 'ofkeli', 'sert', 'guclu'],
  calm: ['calm', 'soft', 'gentle', 'relaxed', 'soothing', 'sakin', 'yumusak'],
  neutral: ['neutral', 'natural', 'conversational', 'balanced', 'casual', 'dogal', 'sohbet'],
};

function styleTerms(speaker) {
  const raw = [speaker?.emotion, speaker?.tone, speaker?.style, speaker?.age].filter(Boolean);
  const result = new Set(raw.flatMap(value => [...tokens(value)]));
  for (const term of [...result]) {
    for (const [key, aliases] of Object.entries(emotionAliases)) {
      if (term === key || aliases.includes(term)) aliases.forEach(alias => result.add(normalize(alias)));
    }
  }
  return result;
}

function scoreVoice(voice, speaker) {
  const gender = ['male', 'female'].includes(speaker?.gender) ? speaker.gender : null;
  const voiceGender = String(voice?.labels?.gender || '').toLowerCase();
  if (gender && voiceGender && voiceGender !== gender) return -Infinity;

  let score = turkishScore(voice);
  if (gender && voiceGender === gender) score += 100;
  const haystack = voiceText(voice);
  for (const term of styleTerms(speaker)) {
    if (term && haystack.includes(term)) score += 18;
  }
  if (/conversational|natural|narration|casual|dialogue|sohbet|dogal/u.test(haystack)) score += 8;
  if (/young|adult|middle aged|mature|youth|genç|olgun/u.test(haystack) &&
      normalize(speaker?.age) && haystack.includes(normalize(speaker.age))) score += 10;
  return score;
}

// One stable Turkish voice is chosen automatically for every logical source
// speaker. Verified visual speaker metadata may provide gender/tone/emotion;
// catalogue labels are used only to rank generated voices, never as source
// evidence. Manual/previous assignments remain supported for saved projects.
export function mapSpeakerVoices(speakers, catalog, previous = {}, manual = {}) {
  const speakerIds = new Set(speakers.map(speaker => String(speaker.speakerId)));
  for (const mapping of [previous, manual]) {
    if (Object.keys(mapping).some(id => !speakerIds.has(id))) {
      throw new MediaError('VOICE_SPEAKER_UNKNOWN', 'Ses atamasındaki konuşmacı bu kaynak videoda bulunamadı.', { status: 422 });
    }
  }
  const voices = new Map(catalog.map(voice => [String(voice.voice_id), voice]));
  const occupied = new Set();
  const result = {};

  for (const speaker of speakers) {
    const id = String(speaker.speakerId);
    const requested = manual[id] || previous[id];
    let voice = requested ? voices.get(String(requested)) : null;
    if (requested && (!voice || !Number.isFinite(scoreVoice(voice, speaker)) || occupied.has(String(requested)))) {
      throw new MediaError('VOICE_MAPPING_INVALID', 'Kaydedilmiş konuşmacı sesi katalogda bulunamadı veya konuşmacı profiliyle uyumlu değil.', { status: 422 });
    }

    if (!voice) {
      voice = [...voices.values()]
        .filter(candidate => !occupied.has(String(candidate.voice_id)) && Number.isFinite(scoreVoice(candidate, speaker)))
        .sort((a, b) => scoreVoice(b, speaker) - scoreVoice(a, speaker) ||
          String(a.voice_id).localeCompare(String(b.voice_id)))[0];
    }

    if (!voice) {
      throw new MediaError('VOICE_CATALOG_INSUFFICIENT',
        'Konuşmacı profiline uygun otomatik Türkçe ses bulunamadı.', { status: 422 });
    }
    occupied.add(String(voice.voice_id));
    result[id] = String(voice.voice_id);
  }
  return result;
}
