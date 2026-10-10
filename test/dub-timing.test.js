import test from 'node:test';
import assert from 'node:assert/strict';
import { dubEndLimit, dubTimingGroups, planDubWindows, validDubWindow, dubTimingDiagnostics } from '../lib/turkish-media/timing.js';

test('dub slack stops at the next speech, overlapping speech, audio event and video end', () => {
  const turn = { segmentId: 'a', sourceStart: 1, sourceEnd: 2 };
  const transcript = { source: { duration: 6 }, utterances: [turn], audioEvents: [] };
  assert.equal(dubEndLimit(transcript, turn), 3);
  transcript.utterances.push({ segmentId: 'b', sourceStart: 2.4, sourceEnd: 3 });
  assert.equal(dubEndLimit(transcript, turn), 2.4);
  transcript.audioEvents.push({ start: 2.1, end: 2.3 });
  assert.equal(dubEndLimit(transcript, turn), 2.1);
  transcript.utterances.push({ segmentId: 'c', sourceStart: 1.5, sourceEnd: 2.5 });
  assert.equal(dubEndLimit(transcript, turn), 2);
  transcript.utterances = [turn]; transcript.audioEvents = []; transcript.source.duration = 2.05;
  assert.equal(dubEndLimit(transcript, turn), 2.05);
});

test('one speaker can share a phrase window while real events, overlaps and speaker changes stay isolated', () => {
  const a = { segmentId: 'a', speakerId: 'man', sourceStart: 1, sourceEnd: 1.4 };
  const b = { segmentId: 'b', speakerId: 'man', sourceStart: 1.5, sourceEnd: 4 };
  const c = { segmentId: 'c', speakerId: 'woman', sourceStart: 4.1, sourceEnd: 5 };
  const transcript = { source: { duration: 6 }, utterances: [a, b, c], audioEvents: [] };
  assert.deepEqual(dubTimingGroups(transcript).map(group => group.map(row => row.segmentId)), [['a', 'b'], ['c']]);
  const windows = planDubWindows(transcript, new Map([['a', 1], ['b', 1], ['c', .5]]));
  assert.ok(windows.get('a').end > a.sourceEnd);
  assert.ok(windows.get('b').start >= windows.get('a').end);
  assert.ok(windows.get('b').end <= c.sourceStart);
  assert.equal(validDubWindow(transcript, b, windows.get('b').start, windows.get('b').end), true);
  assert.equal(validDubWindow(transcript, b, 1.6, 4.2), false);
  transcript.audioEvents.push({ start: 1.42, end: 1.48 });
  assert.equal(dubTimingGroups(transcript).length, 3);
  transcript.audioEvents = []; b.sourceStart = 1.2;
  assert.equal(dubTimingGroups(transcript).length, 3);
});

test('phrase budgets stay positive, ordered and inside their source window even with unequal speech lengths', () => {
  const utterances = Array.from({ length: 8 }, (_, i) => ({ segmentId: String(i), speakerId: 'a', sourceStart: i,
    sourceEnd: i + .9 }));
  const transcript = { source: { duration: 8.1 }, utterances, audioEvents: [] };
  for (const duration of [.1, 1, 4, 20]) {
    const windows = planDubWindows(transcript, new Map(utterances.map((turn, i) => [turn.segmentId, i % 2 ? duration : .3])));
    let end = 0;
    for (const turn of utterances) {
      const window = windows.get(turn.segmentId);
      assert.ok(window.start >= end - 1e-8); assert.ok(window.end > window.start);
      assert.ok(validDubWindow(transcript, turn, window.start, window.end)); end = window.end;
    }
    assert.ok(end <= 8.1);
  }
});


test('dub timing diagnostics isolate impossible tempo and overlapping intervals without changing source data', () => {
  const inputs = [
    { segmentId: 'one', start: 1, end: 7, tempo: 1.1 },
    { segmentId: 'two', start: 2, end: 3, tempo: 78.5267 },
    { segmentId: 'three', start: 4, end: 5, tempo: 2.5 },
    { segmentId: 'next-scene', start: 12, end: 16, tempo: 1 }
  ];
  const copy = structuredClone(inputs);
  const quality = dubTimingDiagnostics(inputs);
  assert.equal(quality.extremeTempoCount, 2);
  assert.deepEqual(quality.extremeTempoSegments.map(row => row.segmentId), ['two', 'three']);
  assert.equal(quality.extremeTempoSegments[0].tempo, 78.53);
  assert.equal(quality.overlappingDubSegmentCount, 2);
  assert.deepEqual(quality.overlappingDubSegments.map(row => row.secondId), ['two', 'three']);
  assert.deepEqual(inputs, copy);
});
