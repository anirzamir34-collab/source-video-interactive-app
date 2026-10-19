import test from 'node:test';
import assert from 'node:assert/strict';
import { isVocalization, separateVocalizations } from '../lib/turkish-media/vocalization.js';

const u = text => ({ sourceText: text });

test('moans and bare exclamations stay original; real dialogue is dubbed', () => {
  for (const text of ['Ah!', 'Ohhh...', 'Mmm', 'Oh, oh, oh', 'Yes, yes', 'Oh my god', 'Fuck...', 'Ahh, fuck', 'Uh-huh', 'Yesss'])
    assert.equal(isVocalization(u(text)), true, text);
  for (const text of ['Yes.', 'No.', 'Please sit down.', 'Oh, I did not know that.', 'Are you okay?', 'Right here, baby, come on in.', 'Okay.'])
    assert.equal(isVocalization(u(text)), false, text);
});

test('vocalizations move into non-speech audio events with their source timing', () => {
  const transcript = { utterances: [
    { segmentId: 's1', speakerId: 'a', sourceText: 'Where were you?', sourceStart: 1, sourceEnd: 2 },
    { segmentId: 's2', speakerId: 'b', sourceText: 'Ahh, ahh', sourceStart: 3, sourceEnd: 3.4 }
  ], audioEvents: [{ eventId: 'e', start: 0.5, end: 0.6, text: '(laughs)' }] };
  assert.equal(separateVocalizations(transcript), 1);
  assert.deepEqual(transcript.utterances.map(row => row.segmentId), ['s1']);
  assert.deepEqual(transcript.audioEvents.map(row => [row.eventId, row.start, row.end]), [['e', 0.5, 0.6], ['vocal-s2', 3, 3.4]]);
});
