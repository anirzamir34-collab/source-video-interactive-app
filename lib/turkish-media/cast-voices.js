// Crowded scenes: the transcription often hears four people as two voices.
// Using the cast the video analysis saw (who is a man, who is a woman, who is
// young or mature), one voice holding two people of the same gender is split
// at the widest pitch gap between its lines, and every voice is paired with a
// person: lower voices with older people, higher voices with younger ones.
// The result is one stable dubbing voice per person.

export const AGE_GROUPS = Object.freeze(['young', 'adult', 'mature', 'senior']);
const AGE_RANK = { young: 0, adult: 1, mature: 2, senior: 3 };

export function normalizeCastProfiles(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map(row => ({
    characterId: String(row?.characterId || '').trim().slice(0, 160),
    gender: ['male', 'female'].includes(row?.gender) ? row.gender : null,
    ageGroup: AGE_GROUPS.includes(row?.ageGroup) ? row.ageGroup : null,
  })).filter(row => row.characterId && row.gender);
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

// Widest gap between the sorted line medians of one voice; both sides must
// hold at least two lines and the gap must be clearly audible.
export function widestPitchGap(utteranceMedians = {}) {
  const rows = Object.entries(utteranceMedians).filter(([, hz]) => Number.isFinite(hz)).sort((a, b) => a[1] - b[1]);
  if (rows.length < 4) return null;
  let best = null;
  for (let index = 2; index <= rows.length - 2; index++) {
    const gap = rows[index][1] - rows[index - 1][1];
    if (!best || gap > best.gap) best = { gap, index };
  }
  if (!best) return null;
  const low = rows.slice(0, best.index), high = rows.slice(best.index);
  const centre = (median(low.map(row => row[1])) + median(high.map(row => row[1]))) / 2;
  if (best.gap < Math.max(30, centre * 0.14)) return null;
  return { gap: best.gap, low: low.map(row => row[0]), high: high.map(row => row[0]),
    lowHz: median(low.map(row => row[1])), highHz: median(high.map(row => row[1])) };
}

const keyOf = row => String(row.segmentId ?? `${row.sourceStart}`);

export function splitSameGenderSpeakers(transcript, measured = {}, cast = []) {
  for (const gender of ['male', 'female']) {
    const need = cast.filter(row => row.gender === gender).length;
    let guard = 0;
    while (guard++ < 8) {
      const speakers = (transcript.speakers || []).filter(row => row.gender === gender);
      if (speakers.length >= need) break;
      const candidate = speakers.map(speaker => ({ speaker, split: widestPitchGap(measured[speaker.speakerId]?.utteranceMedians) }))
        .filter(row => row.split).sort((a, b) => b.split.gap - a.split.gap)[0];
      if (!candidate) break;
      const { speaker, split } = candidate;
      const side = new Map([...split.low.map(key => [key, 'lo']), ...split.high.map(key => [key, 'hi'])]);
      const own = transcript.utterances.filter(row => row.speakerId === speaker.speakerId);
      const labelled = own.filter(row => side.has(keyOf(row)));
      const sideOf = row => side.get(keyOf(row)) || side.get(keyOf(labelled.reduce((best, item) =>
        Math.abs(item.sourceStart - row.sourceStart) < Math.abs(best.sourceStart - row.sourceStart) ? item : best)));
      const ids = { lo: `${speaker.speakerId}-lo`, hi: `${speaker.speakerId}-hi` };
      const counts = { lo: 0, hi: 0 };
      for (const row of own) { const part = sideOf(row); row.speakerId = ids[part]; counts[part] += 1; }
      const { characterId, ...rest } = speaker;
      const children = ['lo', 'hi'].map(part => ({ ...rest, speakerId: ids[part], gender, splitFrom: speaker.speakerId,
        profileEvidence: 'source-acoustic-f0-same-gender', pitchHz: part === 'lo' ? split.lowHz : split.highHz }));
      transcript.speakers.splice(transcript.speakers.indexOf(speaker), 1, ...children);
      const majority = counts.lo >= counts.hi ? ids.lo : ids.hi;
      for (const event of transcript.audioEvents || []) if (event.speakerId === speaker.speakerId) event.speakerId = majority;
    }
  }
  return transcript;
}

// Pairs every voice with a person of the same gender and records the age the
// voice should sound like. A voice the analysis already tied to one person
// keeps that person; the rest pair lowest pitch with the oldest person.
export function assignCastAges(transcript, measured = {}, cast = []) {
  for (const speaker of transcript.speakers || []) {
    if (!Number.isFinite(speaker.pitchHz) && Number.isFinite(measured[speaker.speakerId]?.medianHz)) {
      speaker.pitchHz = measured[speaker.speakerId].medianHz;
    }
  }
  for (const gender of ['male', 'female']) {
    const people = cast.filter(row => row.gender === gender);
    if (!people.length) continue;
    const speakers = (transcript.speakers || []).filter(row => row.gender === gender);
    const taken = new Set();
    for (const speaker of speakers) {
      const person = people.find(row => row.characterId === speaker.characterId);
      if (person && !taken.has(person.characterId)) { taken.add(person.characterId); if (person.ageGroup) speaker.ageGroup = person.ageGroup; }
    }
    const openSpeakers = speakers.filter(row => !row.characterId || !people.some(person => person.characterId === row.characterId))
      .sort((a, b) => (Number.isFinite(a.pitchHz) ? a.pitchHz : 999) - (Number.isFinite(b.pitchHz) ? b.pitchHz : 999));
    const openPeople = people.filter(row => !taken.has(row.characterId))
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (AGE_RANK[b.row.ageGroup] ?? 1) - (AGE_RANK[a.row.ageGroup] ?? 1) || a.index - b.index)
      .map(item => item.row);
    openSpeakers.forEach((speaker, index) => {
      const person = openPeople[index];
      if (!person) return;
      speaker.characterId = person.characterId;
      if (person.ageGroup) speaker.ageGroup = person.ageGroup;
    });
  }
  for (const row of transcript.utterances || []) {
    const speaker = transcript.speakers.find(item => item.speakerId === row.speakerId);
    if (speaker) row.gender = speaker.gender ?? row.gender;
  }
  return transcript;
}

// Voice catalogue preference from the age and the measured pitch of a voice.
const LOW = /\b(deep|low|husky|raspy|gravelly|mature|smoky|rich|resonant|bass|baritone|grave|sultry)\b/u;
const HIGH = /\b(light|bright|high|sweet|airy|youthful|young|cute|soft|girly|petite)\b/u;
export function voiceFitScore(voice, speaker = {}) {
  let score = 0;
  const label = String(voice?.labels?.age || '').toLowerCase().replace(/[_-]+/g, ' ');
  const text = [voice?.name, voice?.description, ...Object.values(voice?.labels || {})].filter(Boolean).join(' ').toLowerCase();
  const voiceAge = /old|elderly|senior/.test(label) ? 'senior' : /middle/.test(label) ? 'mature' : /young/.test(label) ? 'young' : '';
  const table = {
    senior: { senior: 45, mature: 20, young: -45 },
    mature: { mature: 40, senior: 12, young: -30 },
    adult: { mature: 8, young: 6, senior: -20 },
    young: { young: 30, mature: -10, senior: -45 },
  };
  if (speaker.ageGroup && voiceAge) score += table[speaker.ageGroup]?.[voiceAge] ?? 0;
  const hz = Number(speaker.pitchHz);
  if (Number.isFinite(hz) && ['male', 'female'].includes(speaker.gender)) {
    const [low, high] = speaker.gender === 'female' ? [190, 230] : [108, 140];
    if (hz < low) score += (LOW.test(text) ? 22 : 0) - (HIGH.test(text) ? 12 : 0);
    if (hz > high) score += (HIGH.test(text) ? 22 : 0) - (LOW.test(text) ? 12 : 0);
  }
  return score;
}

// Last automatic step for a voice whose gender stayed open: its measured
// pitch decides (below ~165 Hz male, above female); without a pitch, the
// gender the video shows more speaking people of. Only when nothing at all is
// known does the voice stay open for a manual choice.
export function resolveOpenGenders(transcript, measured = {}, cast = [], castGenders = null) {
  const counts = { male: 0, female: 0 };
  for (const row of cast) if (row.gender) counts[row.gender] += 1;
  if (!counts.male && !counts.female && castGenders) {
    counts.male = Number(castGenders.male) || 0; counts.female = Number(castGenders.female) || 0;
  }
  const majority = counts.male > counts.female ? 'male' : counts.female > counts.male ? 'female' : null;
  for (const speaker of transcript?.speakers || []) {
    if (['male', 'female'].includes(speaker.gender)) continue;
    const hz = Number(measured[speaker.speakerId]?.medianHz);
    const gender = Number.isFinite(hz) ? (hz < 165 ? 'male' : 'female') : majority;
    if (!gender) continue;
    speaker.gender = gender;
    speaker.profileEvidence = Number.isFinite(hz) ? 'source-acoustic-f0-automatic' : 'cast-majority';
    if (Number.isFinite(hz) && !Number.isFinite(speaker.pitchHz)) speaker.pitchHz = hz;
    for (const row of transcript.utterances || []) if (row.speakerId === speaker.speakerId) row.gender = gender;
  }
  return transcript;
}

// Per-line check: a line whose own measured pitch clearly contradicts the
// gender of the voice it was given (a man's line inside a woman's voice, or
// the reverse, after diarization merged them) moves to the closest voice of
// the right gender, or to a new voice of that gender. Thresholds are far
// apart so a man raising his voice or a low-voiced woman stays where she is.
export function correctUtteranceGenders(transcript, measured = {}) {
  const keyOf = row => String(row.segmentId ?? `${row.sourceStart}`);
  const pitchOf = speaker => Number(speaker.pitchHz ?? measured[speaker.speakerId]?.medianHz);
  const moved = [];
  for (const row of transcript?.utterances || []) {
    const speaker = transcript.speakers.find(item => item.speakerId === row.speakerId);
    if (!speaker || !['male', 'female'].includes(speaker.gender)) continue;
    const hz = Number(measured[speaker.speakerId]?.utteranceMedians?.[keyOf(row)]);
    if (!Number.isFinite(hz)) continue;
    const wrong = speaker.gender === 'male' ? hz >= 215 : hz <= 130;
    if (!wrong) continue;
    const gender = speaker.gender === 'male' ? 'female' : 'male';
    const candidates = transcript.speakers.filter(item => item.gender === gender && item.speakerId !== speaker.speakerId);
    let target = candidates.filter(item => Number.isFinite(pitchOf(item)))
      .sort((a, b) => Math.abs(pitchOf(a) - hz) - Math.abs(pitchOf(b) - hz))[0] || candidates[0];
    if (!target) {
      const id = `${speaker.speakerId}-${gender === 'female' ? 'f' : 'm'}`;
      target = transcript.speakers.find(item => item.speakerId === id);
      if (!target) {
        const { characterId, ageGroup, ...rest } = speaker;
        target = { ...rest, speakerId: id, gender, splitFrom: speaker.speakerId, pitchHz: hz,
          profileEvidence: 'source-acoustic-f0-line' };
        transcript.speakers.push(target);
      }
    }
    row.speakerId = target.speakerId;
    row.gender = gender;
    moved.push(row.segmentId);
  }
  return moved;
}
