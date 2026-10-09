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
  let best = null, bestRatio = Infinity;
  for (let lag = minimumLag; lag <= maximumLag; lag++) {
    let difference = 0, localEnergy = 0;
    for (let i = 0; i < data.length - lag; i++) {
      const delta = data[i] - data[i + lag];
      difference += delta * delta;
      localEnergy += data[i] * data[i] + data[i + lag] * data[i + lag];
    }
    const ratio = difference / Math.max(localEnergy, .00001);
    // Select the first good period, not its louder second or third harmonic.
    if (ratio < .16 && (!best || ratio < bestRatio * .95)) { best = lag; bestRatio = ratio; }
  }
  return best && bestRatio < .16 ? sampleRate / best : null;
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
      for (const row of utterances.slice(0, 12)) {
        for (const fraction of [.25, .5, .75]) {
          signal?.throwIfAborted();
          const center = row.sourceStart + (row.sourceEnd - row.sourceStart) * fraction;
          const start = Math.max(row.sourceStart, center - .085);
          if (start + .17 > row.sourceEnd || start + .17 > pcm.duration) continue;
          const count = 8192, frame = Buffer.alloc(count * pcm.block);
          const offset = pcm.dataOffset + Math.round(start * pcm.rate) * pcm.block;
          if ((await handle.read(frame, 0, frame.length, offset)).bytesRead !== frame.length) continue;
          const mono = new Float32Array(count / 4);
          for (let i = 0; i < mono.length; i++) {
            const at = i * 4 * pcm.block;
            mono[i] = (frame.readFloatLE(at) + frame.readFloatLE(at + 4)) / 2;
          }
          const frequency = fundamentalFrequency(mono);
          if (frequency) samples.push(frequency);
        }
      }
      const gender = classifyPitchSamples(samples);
      if (gender) result[speaker.speakerId] = { gender, evidence: 'source-acoustic-f0', sampleCount: samples.length };
    }
  } finally { await handle.close(); }
  return result;
}
