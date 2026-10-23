import test from 'node:test';
import assert from 'node:assert/strict';
import { snapActionBoundaries } from '../public/boundary-snap.js';

const cuts = [{ time: 11, kind: 'hard-cut', score: 60 }, { time: 29.5, kind: 'hard-cut', score: 70 }, { time: 50, kind: 'visual-transition', score: 40 }];
const motion = Array.from({ length: 80 }, (_, i) => [i, 10]);

test('a part that opens or ends on another shot is trimmed to the cut', () => {
  const { actions, changed } = snapActionBoundaries([
    { actionId: 's', startTime: 10, endTime: 30, loopStartTime: 10, loopEndTime: 30, label: 'Odaya gir' }
  ], { sceneBoundaries: cuts, motionProfile: motion });
  assert.equal(changed, 1);
  assert.equal(actions[0].startTime, 11);
  assert.equal(actions[0].endTime, 28.5);
  assert.equal(actions[0].loopStartTime, 11);
});

test('soft transitions, far cuts, short loops and outcomes are left alone', () => {
  const { actions, changed } = snapActionBoundaries([
    { actionId: 'a', startTime: 49, endTime: 60 },
    { actionId: 'b', startTime: 5, endTime: 9 },
    { actionId: 'c', startTime: 10.5, endTime: 15.8, positionId: 'rear', loopStartTime: 10.5, loopEndTime: 15.8 },
    { actionId: 'd', startTime: 10, endTime: 20, outcomeType: 'climax' }
  ], { sceneBoundaries: cuts, motionProfile: motion });
  assert.equal(changed, 0);
  assert.deepEqual(actions.map(a => a.startTime), [49, 5, 10.5, 10]);
});
