// Measured intensity of the real video, second by second, from two signals
// the app already has:
//   motion - frame-to-frame visual change of the storyboard (0-100);
//   voice  - moans, breaths and gasps: Scribe audio events and short
//            sound-only lines ("ahh", "mmm", "oh god") of the transcript.
// Nothing here is guessed by AI. It drives tempo buttons (a part where the
// video really moves faster gets "Hızlan"), Lust speed, quiet haptics on the
// hottest moments and the "en ateşli an" reward.

const SOUND = /^(?:o+h*|a+h*|h?m+h?m*|mhm+|u+h+|h+u+h+|e+h+|h+a+(?:h+a+)*h*|o+w+|w+o+a+h*|y+e+a+h*|y+e+s+|f+u+c+k+|g+o+d+|b+a+b+y+|d+a+|д+а+|о+х*|а+х*|м+м+|о+й+|ах+|ох+)$/u;
const VOCAL_TAG = /moan|breath|pant|gasp|sigh|groan|whimper|scream|inhale|exhale|nefes|inle|soluk|stöhn|gemido|jadeo/iu;

const words = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\s'-]/gu, ' ').split(/[\s-]+/).filter(Boolean);

export function isVocalSound(row = {}) {
  if (row.kind === 'vocalization') return true;
  const text = String(row.text ?? row.sourceText ?? '');
  if (VOCAL_TAG.test(text)) return true;
  const list = words(text);
  return list.length > 0 && list.length <= 6 && list.every(word => SOUND.test(word));
}

const percentile = (values, share) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};

export function buildIntensityTrack({ motionProfile = [], audioEvents = [], utterances = [], duration = 0 } = {}) {
  const motionRows = (Array.isArray(motionProfile) ? motionProfile : [])
    .map(row => [Number(row?.time ?? row?.[0]), Number(row?.score ?? row?.[1])])
    .filter(([time, score]) => Number.isFinite(time) && Number.isFinite(score))
    .sort((a, b) => a[0] - b[0]);
  const end = Math.max(Number(duration) || 0, motionRows.at(-1)?.[0] || 0);
  const seconds = Math.max(0, Math.ceil(end) + 1);
  const motion = new Float32Array(seconds);
  const counts = new Uint16Array(seconds);
  for (const [time, score] of motionRows) {
    const index = Math.min(seconds - 1, Math.max(0, Math.floor(time)));
    motion[index] += score; counts[index] += 1;
  }
  for (let i = 0; i < seconds; i++) motion[i] = counts[i] ? motion[i] / counts[i] : NaN;
  // Fill gaps between samples so every second has a value.
  let last = NaN;
  for (let i = 0; i < seconds; i++) { if (Number.isFinite(motion[i])) last = motion[i]; else motion[i] = last; }
  last = NaN;
  for (let i = seconds - 1; i >= 0; i--) { if (Number.isFinite(motion[i])) last = motion[i]; else motion[i] = last; }
  const valid = [...motion].filter(Number.isFinite);
  // Camera cuts produce single huge spikes; the 90th percentile is "very busy".
  const high = Math.max(1, percentile(valid, 0.9));

  const voice = new Float32Array(seconds);
  const vocal = [...(audioEvents || []), ...(utterances || [])].filter(isVocalSound);
  for (const row of vocal) {
    const start = Number(row.start ?? row.startTime ?? row.sourceStart);
    const stop = Number(row.end ?? row.endTime ?? row.sourceEnd ?? start + 0.6);
    if (!Number.isFinite(start)) continue;
    for (let i = Math.max(0, Math.floor(start) - 1); i <= Math.min(seconds - 1, Math.ceil(stop) + 1); i++) {
      voice[i] = Math.min(1, voice[i] + (i >= Math.floor(start) && i <= Math.ceil(stop) ? 0.55 : 0.25));
    }
  }
  const hasVoice = vocal.length > 0;
  const motionAt = index => Number.isFinite(motion[index]) ? Math.min(1, motion[index] / high) : 0.5;
  const indexOf = time => Math.min(seconds - 1, Math.max(0, Math.floor(Number(time) || 0)));
  const at = time => {
    if (!seconds) return { motion: 0.5, voice: 0, value: 0.5 };
    const index = indexOf(time);
    const m = motionAt(index), v = voice[index];
    return { motion: m, voice: v, value: hasVoice ? Math.min(1, 0.65 * m + 0.35 * v + (v > 0.5 ? 0.1 : 0)) : m };
  };
  const mean = (start, stop, key = 'value') => {
    const from = indexOf(start), to = indexOf(stop);
    if (!seconds || to < from) return null;
    let sum = 0;
    for (let i = from; i <= to; i++) sum += at(i)[key];
    return sum / (to - from + 1);
  };
  return { seconds, hasMotion: valid.length > 0, hasVoice, at, mean };
}

// Marks each real movement of a position as measured fast / slow / steady,
// compared with the other parts of the same position.
export function measuredMovementFlavors(movements = [], track) {
  const result = new Map();
  if (!track?.hasMotion) return result;
  const rows = movements.map(item => {
    const start = Number(item.loopStartTime ?? item.startTime), end = Number(item.loopEndTime ?? item.endTime);
    return { id: item.id, value: Number.isFinite(start) && end - start >= 3 ? track.mean(start, end, 'motion') : null };
  }).filter(row => row.id && Number.isFinite(row.value));
  if (rows.length < 3) return result;
  const median = percentile(rows.map(row => row.value), 0.5) || 0.01;
  for (const row of rows) {
    const ratio = row.value / median;
    result.set(row.id, ratio >= 1.3 ? 'fast' : ratio <= 0.72 ? 'slow' : 'steady');
  }
  return result;
}

// Lust and pleasure speed: calm moments fill a bit slower, the hottest ones
// clearly faster (0.7-1.5).
export const intensityRate = sample => 0.7 + 0.8 * Math.max(0, Math.min(1, Number(sample?.value ?? 0.5)));
