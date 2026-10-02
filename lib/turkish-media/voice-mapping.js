import { MediaError } from './errors.js';

// ASR speaker labels are identities, not evidence of gender. Manual selections
// or verified source metadata may supply gender. Unknown gender is reported
// honestly; stable automatic allocation cannot verify the source person's sex.
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
    const gender = ['male', 'female'].includes(speaker.gender) ? speaker.gender : null;
    const appropriate = voice => !gender || String(voice.labels?.gender || '').toLowerCase() === gender;
    let voice = requested ? voices.get(String(requested)) : null;
    if (requested && (!voice || !appropriate(voice) || occupied.has(String(requested)))) {
      throw new MediaError('VOICE_MAPPING_INVALID', 'Kaydedilmiş konuşmacı sesi katalogda bulunamadı veya kimlikle uyumlu değil.', { status: 422 });
    }
    if (!voice) {
      voice = [...voices.values()].filter(candidate => !occupied.has(String(candidate.voice_id)) && appropriate(candidate))
        .sort((a, b) => {
          const turkish = v => [v.labels?.language, ...(v.verified_languages || []).map(item => item.language)].includes('tr') ? 1 : 0;
          return turkish(b) - turkish(a) || String(a.voice_id).localeCompare(String(b.voice_id));
        })[0];
    }
    if (!voice) throw new MediaError('VOICE_CATALOG_INSUFFICIENT', 'Her konuşmacı için ayrı ve uygun bir ses bulunamadı.', { status: 422 });
    occupied.add(String(voice.voice_id));
    result[id] = String(voice.voice_id);
  }
  return result;
}
