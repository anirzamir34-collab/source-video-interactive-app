import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueTimedSpeech, normalizeDialogueSegments, naturalizeTurkishSpeech } from '../public/dialogue-integrity.js';
import { buildDubBlocks } from '../public/playback-logic.js';

const line = (extra = {}) => ({ segmentId: 'one', speakerId: 'speaker-a', startTime: 1, endTime: 2,
  originalText: 'Hello!', turkishText: 'Merhaba!', ...extra });

test('duplicate observations disappear but real repetitions and overlapping different voices survive', () => {
  const rows = [line(), line({ segmentId: 'copy', startTime: 1.03, endTime: 2.04, originalText: 'hello' }),
    line({ segmentId: 'repeat', startTime: 3, endTime: 4 }), line({ segmentId: 'other', speakerId: 'speaker-b' })];
  assert.deepEqual(uniqueTimedSpeech(rows).map(item => item.segmentId), ['one', 'other', 'repeat']);
  assert.equal(rows.length, 4);
});

test('normalization repairs cache-key collisions, rejects invalid intervals and clips to the actual video', () => {
  const rows = [null, line(), line({ startTime: 3, endTime: 8 }),
    line({ segmentId: 'one:2', startTime: 4, endTime: 5 }), line({ startTime: 6, endTime: 7 }),
    line({ startTime: -1 }), line({ endTime: 1 }), line({ startTime: NaN })];
  const normalized = normalizeDialogueSegments(rows, 6);
  assert.equal(normalized.length, 3);
  assert.equal(new Set(normalized.map(item => item.segmentId)).size, 3);
  assert.deepEqual(normalized.map(item => [item.startTime, item.endTime]), [[1, 2], [3, 6], [4, 5]]);
  assert.deepEqual(normalizeDialogueSegments(normalized, 6), normalized);
});

test('one timed speech block per caption preserves pauses and a later real repetition', () => {
  const rows = [line(), line({ startTime: 2.1, endTime: 3 }), line({ startTime: 5, endTime: 6 })];
  const blocks = buildDubBlocks(rows);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map(item => [item.startTime, item.endTime, item.turkishText]),
    rows.map(item => [item.startTime, item.endTime, item.turkishText]));
  assert.equal(new Set(blocks.map(item => item.segmentId)).size, 3);
});

test('explicit legacy merging cannot combine contradictory speaker annotations', () => {
  const blocks = buildDubBlocks([line({ gender: 'female' }),
    line({ segmentId: 'two', startTime: 2, endTime: 3, gender: 'male' })], { mergeAdjacent: true });
  assert.equal(blocks.length, 2);
});

test('Turkish dub text repairs the isolated A/ah artefact without deleting timed repetitions', () => {
  assert.equal(naturalizeTurkishSpeech('A evet A evet'), 'Ah, evet');
  assert.equal(naturalizeTurkishSpeech('Tamam, evet.'), 'Tamam, evet.');
  const rows = normalizeDialogueSegments([
    line({ segmentId: 'a', startTime: 1, endTime: 2, turkishText: 'A evet' }),
    line({ segmentId: 'b', startTime: 4, endTime: 5, turkishText: 'A evet' })
  ]);
  assert.deepEqual(rows.map(row => row.turkishText), ['Ah, evet', 'Ah, evet']);
});

test('adjacent subtitle rows from one speaker form a complete dub utterance', () => {
  const blocks = buildDubBlocks([
    line({ segmentId: 'a', startTime: 1, endTime: 3, turkishText: 'Bu cümle' }),
    line({ segmentId: 'b', startTime: 3.2, endTime: 5, turkishText: 'burada bitiyor.' }),
    line({ segmentId: 'c', speakerId: 'speaker-b', startTime: 5.1, endTime: 6, turkishText: 'Yanıt.' })
  ], { mergeAdjacent: true, maxGap: 0.5, maxDuration: 18 });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].turkishText, 'Bu cümle burada bitiyor.');
  assert.deepEqual(blocks[0].sourceSegmentIds, ['a', 'b']);
});
