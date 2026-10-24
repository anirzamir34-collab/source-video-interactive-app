import test from 'node:test';
import assert from 'node:assert/strict';
import { alignBoundariesToSpeech, speechIntervals } from '../public/speech-boundaries.js';

test('a boundary inside a sentence moves to the end of that sentence', () => {
  const { actions, changed } = alignBoundariesToSpeech([
    { actionId: 'a', startTime: 0, endTime: 10 },
    { actionId: 'b', startTime: 10, endTime: 20 }
  ], [{ startTime: 8, endTime: 9.9 }, { startTime: 10.1, endTime: 12.5 }]);
  assert.equal(changed, 1);
  assert.equal(actions[0].endTime, 12.5);
  assert.equal(actions[1].startTime, 12.5);
});

test('a sentence that only just started pulls the edge back; long sentences and short loops are left alone', () => {
  const back = alignBoundariesToSpeech([{ startTime: 0, endTime: 10 }, { startTime: 10, endTime: 30 }],
    [{ startTime: 9, endTime: 16 }]).actions;
  assert.equal(back[0].endTime, 9);
  const long = alignBoundariesToSpeech([{ startTime: 0, endTime: 10 }, { startTime: 10, endTime: 30 }],
    [{ startTime: 5, endTime: 20 }]);
  assert.equal(long.changed, 0);
  const loops = alignBoundariesToSpeech([
    { startTime: 0, endTime: 10, positionId: 'missionary', loopStartTime: 0, loopEndTime: 10 },
    { startTime: 10, endTime: 15.5, positionId: 'missionary', loopStartTime: 10, loopEndTime: 15.5 }
  ], [{ startTime: 9.5, endTime: 11 }]);
  assert.equal(loops.actions[0].endTime, 9.5, 'moving forward would leave the second loop under 5 s, so the edge moves back');
  assert.deepEqual(speechIntervals([{ start: 1, end: 2 }, { start: 2.2, end: 3 }]), [{ start: 1, end: 3 }]);
});
