import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSceneIntroductions, sourcePositionAtTime, sceneEntrySeekTarget } from '../public/scene-entry.js';

test('reentering a source scene at a later position keeps the current frame', () => {
  const scene = { startTime: 443.537, endTime: 1034.92 };
  assert.equal(sceneEntrySeekTarget(scene, 720.747, true, false), null);
  assert.equal(sceneEntrySeekTarget(scene, 430, true, false), 443.537);
  assert.equal(sceneEntrySeekTarget(scene, 720.747, true, true), null);
});

const action = (start, end, extra = {}) => ({ startTime: start, endTime: end, subjectTrackId: 'a',
  partnerTrackId: 'b', sourceVerified: true, confidence: .95, kind: 'introduction', ...extra });
const eligible = item => item.kind === 'introduction';

test('adjacent verified introductions acquire scene membership without changing their source records', () => {
  const rows = [action(0, 5, { kind: 'dialogue' }), action(5, 10), action(10, 14), action(40, 50, { kind: 'chapter' })];
  const original = JSON.stringify(rows);
  const result = matchSceneIntroductions(rows, [{ action: rows[3], sceneId: 'chapter-1' }], eligible);
  assert.deepEqual([...result.keys()], [rows[2], rows[1]]);
  assert.deepEqual([...result.values()], ['chapter-1', 'chapter-1']);
  assert.equal(JSON.stringify(rows), original);
});

test('a continuous verified introduction crosses a provider scene ID change into the first position', () => {
  const rows = [action(217, 230, { adultScene: true, adultSceneId: 'intro' }),
    action(230, 319, { adultScene: true, adultSceneId: 'intro' }),
    action(319, 328, { adultScene: true, adultSceneId: 'main' }),
    action(328, 346, { adultScene: true, adultSceneId: 'main', kind: 'chapter' })];
  const result = matchSceneIntroductions(rows, [{ action: rows[3], sceneId: 'main' }], eligible);
  assert.deepEqual([...result.keys()], [rows[2], rows[1], rows[0]]);
  assert.equal(result.get(rows[0]), 'main');
  rows[1].endTime = 318;
  assert.equal(matchSceneIntroductions(rows, [{ action: rows[3], sceneId: 'main' }], eligible).has(rows[0]), false);
});

test('dialogue, cast changes, unverified data, scene conflicts and long gaps bound introductions', () => {
  for (const extra of [{ kind: 'dialogue' }, { partnerTrackId: 'c' }, { sourceVerified: false },
    { confidence: .2 }, { confidence: undefined }, { adultSceneId: 'other' }, { endTime: 4 }]) {
    const first = action(0, 2), boundary = action(2, 10, extra), anchor = action(50, 60, { kind: 'chapter' });
    assert.equal(matchSceneIntroductions([first, boundary, anchor], [{ action: anchor, sceneId: 'main' }], eligible).size, 0);
  }
});

test('source membership follows exact intervals, including returns, but never broad parent gaps', () => {
  const position = { id: 'one', startTime: 0, endTime: 200, sourceRanges: [
    { startTime: 10, endTime: 20 }, { startTime: 90, endTime: 100 }] };
  for (const time of [10, 15, 90, 95]) assert.equal(sourcePositionAtTime([position], time), position);
  for (const time of [0, 20, 50, 100, NaN]) assert.equal(sourcePositionAtTime([position], time), null);
  assert.equal(sourcePositionAtTime([{ startTime: 0, endTime: 200 }], 50), null);
});
