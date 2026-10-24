import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueBatches } from '../lib/turkish-media/pipeline.js';
import { loadMediaConfig } from '../lib/turkish-media/config.js';

test('single-turn synthesis sends every spoken line on its own', () => {
  const utterances = [
    { segmentId: 'a', speakerId: 'm', sourceStart: 0, sourceEnd: 1 },
    { segmentId: 'b', speakerId: 'w', sourceStart: 1.2, sourceEnd: 2 },
    { segmentId: 'c', speakerId: 'm', sourceStart: 2.1, sourceEnd: 3 }];
  const translations = utterances.map(row => ({ segmentId: row.segmentId, translatedText: 'Buraya gel.' }));
  const voices = { m: 'vm', w: 'vw' };
  assert.equal(dialogueBatches(utterances, translations, voices).length, 1, 'the older mode pools the conversation');
  assert.deepEqual(dialogueBatches(utterances, translations, voices, { singleTurn: true }).map(batch => batch.map(turn => turn.segmentId)),
    [['a'], ['b'], ['c']]);
  assert.equal(loadMediaConfig({ DUB_SINGLE_TURN: 'true' }).dubSingleTurn, true);
});
