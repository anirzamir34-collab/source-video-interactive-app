import { open } from 'node:fs/promises';
import { readPcm } from './pcm.js';

// Acoustic evidence supplements diarization. It never identifies a person or
// infers age. The overlap band deliberately stays unresolved for manual review.
export function classifyPitchSamples(samples) {
  const values = samples.filter(value => Number.isFinite(value) && value >= 70 && value <= 320)
    .sort((a, b) => a - b);
  if (values.length < 8) return null;
  const middle = values[Math.floor(values.length / 2)];
  const agreement = values.filter(value => Math.abs(value - middle) <= 25).length / values.length;
  if (agreement < .72) return null;
  if (middle <= 150 && values.filter(value => value <= 165).length / values.length >= .8) return 'male';
  if (middle >= 185 && values.filter(value => value >= 170).length / values.length >= .8) return 'female';
  return null;
}

// Lenient decision for speakers the strict test leaves open: a trimmed median
// on either side of the ~165 Hz male/female boundary, or a clear majority.
export function classifyPitchLenient(samples) {
  const values = samples.filter(value => Number.isFinite(value) && value >= 70 && value <= 320)
    .sort((a, b) => a - b);
  if (values.length < 5) return null;
  const cut = Math.floor(values.length * .15);
  const core = values.slice(cut, values.length - cut);
  const middle = core[Math.floor(core.length / 2)];
  if (middle <= 160) return 'male';
  if (middle >= 172) return 'female';
  const low = values.filter(value => value < 165).length / values.length;
  return low >= .65 ? 'male' : low <= .35 ? 'female' : null;
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

// One diarization ID sometimes contains both a man and a woman. Classify each
// utterance on its own and report the speaker as mixed only when both clearly
// low and clearly high utterances are present in meaningful numbers.
export function utteranceGenderSplit(utteranceMedians = {}) {
  const entries = Object.entries(utteranceMedians).filter(([, hz]) => Number.isFinite(hz));
  const male = entries.filter(([, hz]) => hz <= 152), female = entries.filter(([, hz]) => hz >= 182);
  if (male.length < 2 || female.length < 2) return null;
  const minority = Math.min(male.length, female.length) / (male.length + female.length);
  if (minority < .2) return null;
  return Object.fromEntries([...male.map(([key]) => [key, 'male']), ...female.map(([key]) => [key, 'female'])]);
}

export function fundamentalFrequency(samples, sampleRate = 12000) {
  if (!samples || samples.length < 1200) return null;
  let mean = 0, energy = 0;
  for (const value of samples) mean += value;
  mean /= samples.length;
  const data = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    data[i] = samples[i] - mean;
    energy += data[i] * data[i];
  }
  if (energy / samples.length < .00008) return null;
  const minimumLag = Math.floor(sampleRate / 320), maximumLag = Math.ceil(sampleRate / 70);
  const candidateRatios = [];
  for (let lag = minimumLag; lag <= maximumLag; lag++) {
    let difference = 0, localEnergy = 0;
    for (let i = 0; i < data.length - lag; i++) {
      const delta = data[i] - data[i + lag];
      difference += delta * delta;
      localEnergy += data[i] * data[i] + data[i + lag] * data[i + lag];
    }
    candidateRatios.push(difference / Math.max(localEnergy, .00001));
  }
  // A later multiple of the true period can have an even lower ratio.
  // Use the earliest qualified LOCAL minimum, not the deepest minimum;
  // otherwise a 220 Hz voice may be measured as 110 Hz or 73 Hz.
  for (let index = 0; index < candidateRatios.length; index++) {
    const ratio = candidateRatios[index];
    const left = index > 0 ? candidateRatios[index - 1] : Infinity;
    const right = index + 1 < candidateRatios.length ? candidateRatios[index + 1] : Infinity;
    if (ratio < .16 && ratio <= left && ratio <= right) {
      return sampleRate / (minimumLag + index);
    }
  }
  return null;
}

export async function inferSpeakerProfiles(file, transcript, { signal } = {}) {
  const pcm = await readPcm(file);
  if (!pcm || pcm.code !== 3 || pcm.rate !== 48000 || pcm.channels !== 2 || pcm.block !== 8) return {};
  const handle = await open(file, 'r');
  const result = {};
  try {
    for (const speaker of transcript?.speakers || []) {
      if (['male', 'female'].includes(speaker.gender)) continue;
      const utterances = (transcript.utterances || []).filter(row => row.speakerId === speaker.speakerId &&
        row.sourceEnd - row.sourceStart >= .25).sort((a, b) => b.sourceEnd - b.sourceStart);
      const samples = [];
      const utteranceMedians = {};
      for (const row of utterances.slice(0, 24)) {
        const rowSamples = [];
        const count = 8192, windowSeconds = count / pcm.rate;
        const available = Math.min(row.sourceEnd, pcm.duration) - row.sourceStart - windowSeconds;
        if (available < 0) continue;
        const windowCount = Math.min(12, Math.floor(available / .12) + 1);
        for (let index = 0; index < windowCount; index++) {
          signal?.throwIfAborted();
          const start = row.sourceStart + (windowCount === 1 ? available / 2 : available * index / (windowCount - 1));
          const frame = Buffer.alloc(count * pcm.block);
          const offset = pcm.dataOffset + Math.round(start * pcm.rate) * pcm.block;
          if ((await handle.read(frame, 0, frame.length, offset)).bytesRead !== frame.length) continue;
          const mono = new Float32Array(count / 4);
          for (let i = 0; i < mono.length; i++) {
            const at = i * 4 * pcm.block;
            mono[i] = (frame.readFloatLE(at) + frame.readFloatLE(at + 4)) / 2;
          }
          const frequency = fundamentalFrequency(mono);
          if (frequency) { samples.push(frequency); rowSamples.push(frequency); }
        }
        const key = String(row.segmentId ?? `${row.sourceStart}`);
        if (rowSamples.length >= 2) utteranceMedians[key] = median(rowSamples);
      }
      const split = utteranceGenderSplit(utteranceMedians);
      if (split) {
        result[speaker.speakerId] = { gender: null, mixed: true, utteranceGenders: split,
          evidence: 'source-acoustic-f0-per-utterance', sampleCount: samples.length };
        continue;
      }
      const strict = classifyPitchSamples(samples);
      const gender = strict || classifyPitchLenient(samples);
      if (gender) result[speaker.speakerId] = { gender, sampleCount: samples.length,
        evidence: strict ? 'source-acoustic-f0' : 'source-acoustic-f0-lenient' };
    }
  } finally { await handle.close(); }
  return result;
}
