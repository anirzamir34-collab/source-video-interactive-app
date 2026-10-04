import test from 'node:test';
import assert from 'node:assert/strict';
import { dubEndLimit } from '../lib/turkish-media/timing.js';

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
