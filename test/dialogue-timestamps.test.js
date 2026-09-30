import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeDialogueTimeline, repairDialogueTimestamps } from '../public/dialogue-integrity.js';
import { dubSegmentKey } from '../public/playback-logic.js';

// Representative legacy values, not a claim about an unavailable user report.
const times = [3.04, 3.11, 3.18, 3.25, 3.32, 3.39, 3.46, 3.53,
  4.00, 4.07, 4.14, 4.21, 4.28, 4.35, 4.42, 4.49, 4.56, 5.03, 5.09];
const rows = () => times.map((startTime, index) => ({
  segmentId: `dialogue-${index}`, speakerId: index % 2 ? 'speaker-b' : 'speaker-a',
  startTime, endTime: Number((startTime + .02).toFixed(2)),
  originalText: 'We are ready now.', turkishText: 'Şimdi hepimiz hazırız.'
}));

test('long video minute.second dialogue timestamp repair maps 3.04 to 184 and 5.09 to 309', () => {
  const source = rows();
  const result = repairDialogueTimestamps(source, 900);
  assert.equal(result.report.repaired, true);
  assert.deepEqual(result.segments[0], { ...source[0], startTime: 184, endTime: 186 });
  assert.equal(result.segments.at(-1).startTime, 309);
  assert.equal(result.segments.at(-1).endTime, 311);
  assert.equal(result.report.timestamps.length, 19);
  assert.equal(source[0].startTime, 3.04, 'the original provider evidence stays intact');
  assert.ok(result.segments.every((row, i, list) => row.endTime <= 900 && (!i || row.startTime >= list[i - 1].startTime)));
});

test('explicit seconds and plausible early speech on a long video never convert', () => {
  const source = rows();
  assert.equal(repairDialogueTimestamps(source, 900, { timestampUnit: 'seconds' }).segments, source);
  const genuine = source.map(row => ({ ...row, endTime: row.startTime + .35, originalText: 'Hi.' }));
  assert.equal(repairDialogueTimestamps(genuine, 900).report.repaired, false);
  const precise = source.map(row => ({ ...row, startTime: row.startTime + .001 }));
  assert.equal(repairDialogueTimestamps(precise, 900).report.repaired, false);
  assert.equal(repairDialogueTimestamps(source, 90).report.repaired, false);
  assert.equal(repairDialogueTimestamps(source.slice(0, 3), 900).report.repaired, false);
});

test('invalid seconds digits, reversed ranges, mixed ASR seconds and out-of-duration conversion are rejected', () => {
  for (const extra of [{ startTime: 3.70 }, { endTime: 3.03 }, { startTime: null }]) {
    const source = rows(); source[0] = { ...source[0], ...extra };
    assert.equal(repairDialogueTimestamps(source, 900).report.repaired, false);
  }
  assert.equal(repairDialogueTimestamps(rows(), 300).report.repaired, false);
  const mixed = rows(); mixed[0].timestampUnit = 'seconds';
  assert.equal(repairDialogueTimestamps(mixed, 900).report.repaired, false);
});

test('cached captions and generated dub blocks repair together without losing audio keys', () => {
  const source = rows();
  const blocks = source.map(row => ({ ...row, segmentId: `dub-block:${row.segmentId}`, sourceSegmentIds: [row.segmentId] }));
  const cached = new Map(blocks.map(row => [dubSegmentKey(row), 'generated-audio']));
  const result = normalizeDialogueTimeline({ segments: source, dubSegments: blocks }, 900);
  assert.equal(result.segments[0].startTime, 184);
  assert.equal(result.dubSegments[0].startTime, 184);
  assert.ok(result.dubSegments.every(row => cached.has(dubSegmentKey(row))));
  assert.deepEqual(normalizeDialogueTimeline(result, 900), result, 'repair is idempotent');
});

test('legacy cache keys without a provider segment ID survive timestamp repair', () => {
  const blocks = rows().map(({ segmentId, ...row }) => row);
  const keys = blocks.map(dubSegmentKey);
  const result = normalizeDialogueTimeline({ segments: blocks, dubSegments: blocks }, 900);
  assert.deepEqual(result.dubSegments.map(dubSegmentKey), keys);
});

test('server repairs provider rows before ASR merge; client also normalizes saved timelines', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(server.indexOf('const dialogueTimeRepair = repairDialogueTimestamps(') < server.indexOf('const groundedSegments = asr.segments.map('));
  assert.match(app, /normalizeDialogueTimeline\(game\.payload\.dialogue, game\.duration\)/);
  assert.match(server, /timestampRepair: dialogueTimeRepair\.report/);
});
