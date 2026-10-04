import test from 'node:test';
import assert from 'node:assert/strict';
import { repairSavedAudio } from '../public/saved-audio.js';

function floatWave(values, extended = false) {
  const fmtSize = extended ? 40 : 16, dataAt = 20 + fmtSize + 8;
  const buffer = new ArrayBuffer(dataAt + values.length * 4), view = new DataView(buffer);
  const tag = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, fmtSize, true); view.setUint16(20, extended ? 65534 : 3, true);
  view.setUint16(22, 2, true); view.setUint32(24, 48000, true); view.setUint32(28, 384000, true);
  view.setUint16(32, 8, true); view.setUint16(34, 32, true);
  if (extended) { view.setUint16(36, 22, true); view.setUint16(38, 32, true); view.setUint16(44, 3, true); }
  tag(dataAt - 8, 'data'); view.setUint32(dataAt - 4, values.length * 4, true);
  values.forEach((value, i) => view.setFloat32(dataAt + i * 4, value, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

for (const extended of [false, true]) test(`legacy ${extended ? 'extensible' : 'float'} WAV becomes audible PCM without changing frames or stereo order`, async () => {
  const source = floatWave([0, 0, .5, -.5, 1, -1, 1.2, -1.2], extended), progress = [];
  const output = await repairSavedAudio(source, value => progress.push(value));
  assert.notEqual(output, source);
  const view = new DataView(await output.arrayBuffer());
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => view.getInt16(44 + 2 * i, true)), [0, 0, 16384, -16384, 32767, -32768, 32767, -32768]);
  assert.equal(view.getUint32(40, true) / view.getUint16(32, true), 4, 'same four stereo frames');
  assert.equal(progress.at(-1), 1);
  assert.equal(await repairSavedAudio(output), output, 'repair runs only once');
});

test('MP3 stays unchanged and broken legacy audio never produces a silent replacement', async () => {
  const mp3 = new Blob(['mp3'], { type: 'audio/mpeg' });
  assert.equal(await repairSavedAudio(mp3), mp3);
  const bad = floatWave([NaN, 0]);
  await assert.rejects(repairSavedAudio(bad), /geçersiz örnek/);
  await assert.rejects(repairSavedAudio(floatWave([0, 0]).slice(0, 48, 'audio/wav')), /eksik/);
});
