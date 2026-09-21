export const dubSpeakerKey = segment => String(segment?.speakerId || '').trim() || 'speaker-unknown';
const genderOf = value => ['female', 'male'].includes(value) ? value : 'uncertain';

export function buildDubSpeakerRoster(segments = [], profiles = []) {
  const roster = new Map();
  for (const segment of segments) {
    if (!String(segment?.turkishText || '').trim()) continue;
    const speakerId = dubSpeakerKey(segment);
    let row = roster.get(speakerId);
    if (!row) { row = { speakerId, female: 0, male: 0 }; roster.set(speakerId, row); }
    const gender = genderOf(segment.gender);
    if (gender !== 'uncertain') row[gender] += Math.max(0.25, Math.min(14,
      Number(segment.endTime) - Number(segment.startTime) || 1)) * Math.max(0.25, Number(segment.confidence) || 0.5);
  }
  return [...roster.values()].map(row => {
    const profile = profiles.find(item => dubSpeakerKey(item) === row.speakerId);
    const gender = row.female === row.male ? genderOf(profile?.gender) : row.female > row.male ? 'female' : 'male';
    return { speakerId: row.speakerId, gender };
  }).sort((a, b) => a.speakerId.localeCompare(b.speakerId));
}

export function validateDubVoicePlan(roster, assignments) {
  if (!Array.isArray(assignments) || assignments.length !== roster.length) throw new Error('Konuşmacıların ses eşlemesi eksik. Tekrar dene.');
  const plan = new Map();
  const used = new Set();
  const ids = new Set(roster.map(row => row.speakerId));
  for (const item of assignments) {
    if (!item || !ids.has(item.speakerId) || plan.has(item.speakerId) ||
        typeof item.voiceId !== 'string' || !item.voiceId.trim() || used.has(item.voiceId)) {
      throw new Error('Her konuşmacıya ayrı ve sabit bir ses atanamadı. Ses eşlemesini yeniden dene.');
    }
    used.add(item.voiceId);
    plan.set(item.speakerId, { speakerId: item.speakerId, voiceId: item.voiceId,
      voiceName: String(item.voiceName || ''), gender: genderOf(item.gender) });
  }
  return plan;
}
