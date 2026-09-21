function problem(message) {
  return Object.assign(new Error(message), { status: 422, code: 'ELEVENLABS_VOICE_PLAN_UNAVAILABLE' });
}

export function allocateSpeakerVoices(speakers, voices, { previous = [], genderOf, score } = {}) {
  if (!Array.isArray(speakers) || !speakers.length || speakers.length > 64 ||
      speakers.some(row => !row || typeof row.speakerId !== 'string' || !row.speakerId.trim() || row.speakerId.length > 120 ||
        !['female', 'male', 'uncertain'].includes(row.gender)) ||
      new Set(speakers.map(row => row.speakerId)).size !== speakers.length || !Array.isArray(previous)) {
    throw problem('Konuşmacı listesi geçersiz veya 64 kişi sınırını aşıyor.');
  }
  const available = new Map(voices.filter(voice => voice?.voice_id).map(voice => [voice.voice_id, voice]));
  const assignments = new Map();
  const used = new Set();
  // Unknown catalog metadata is not evidence of a matching voice. Do not let
  // a language score silently replace a known speaker with the opposite voice.
  const fits = (voice, speaker) => speaker.gender === 'uncertain' || genderOf(voice) === speaker.gender;
  const assign = (speaker, voice) => {
    assignments.set(speaker.speakerId, { speakerId: speaker.speakerId, gender: speaker.gender,
      voiceId: voice.voice_id, voiceName: String(voice.name || '') });
    used.add(voice.voice_id);
  };
  for (const row of previous) {
    const speaker = speakers.find(item => item.speakerId === row?.speakerId);
    const voice = available.get(row?.voiceId);
    if (!speaker || !voice || used.has(voice.voice_id) || assignments.has(speaker.speakerId) || !fits(voice, speaker)) {
      throw problem('Önceden atanmış bir ses artık kullanılamıyor. Karakter sesi değiştirilmedi; dublajı yeniden hazırlamak gerekiyor.');
    }
    assign(speaker, voice);
  }
  // Constrained speakers choose first. Backtracking matching prevents a neutral
  // voice or unknown speaker from consuming the only suitable voice for another.
  const candidates = speaker => [...available.values()].filter(voice => !used.has(voice.voice_id) && fits(voice, speaker))
    .sort((a, b) => score(b, speaker.gender) - score(a, speaker.gender) || a.voice_id.localeCompare(b.voice_id));
  const pending = speakers.filter(row => !assignments.has(row.speakerId))
    .sort((a, b) => candidates(a).length - candidates(b).length || a.speakerId.localeCompare(b.speakerId));
  const matches = new Map();
  const place = (speaker, seen) => {
    for (const voice of candidates(speaker)) {
      if (seen.has(voice.voice_id)) continue;
      seen.add(voice.voice_id);
      const other = matches.get(voice.voice_id);
      if (!other || place(other, seen)) { matches.set(voice.voice_id, speaker); return true; }
    }
    return false;
  };
  for (const speaker of pending) {
    if (!place(speaker, new Set())) throw problem(`${speakers.length} konuşmacı için yeterli farklı ve uygun ses bulunamadı. ElevenLabs hesabına daha fazla uygun ses ekle. Aynı ses iki kişiye atanmadı.`);
  }
  for (const [voiceId, speaker] of matches) assign(speaker, available.get(voiceId));
  return speakers.map(row => assignments.get(row.speakerId));
}
