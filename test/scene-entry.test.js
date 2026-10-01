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

test('the optional scene flag does not reject adjacent same-cast evidence across provider IDs', () => {
  const intro = action(5, 9.8, { adultScene: false, adultSceneId: 'intro' });
  const anchor = action(10, 20, { adultScene: true, adultSceneId: 'main', kind: 'chapter' });
  const original = structuredClone([intro, anchor]);
  const decisions = [];
  const result = matchSceneIntroductions([intro, anchor], [{ action: anchor, sceneId: 'main' }], eligible, 45,
    (item, reason) => decisions.push([item, reason]));
  assert.equal(result.get(intro), 'main');
  assert.deepEqual(decisions, [[intro, 'VERIFIED_SAME_CAST_INTRODUCTION']]);
  assert.deepEqual([intro, anchor], original);
  const distant = { ...intro, endTime: 9.7 };
  assert.equal(matchSceneIntroductions([distant, anchor], [{ action: anchor, sceneId: 'main' }], eligible).size, 0);
});

test('same participant names cannot substitute swapped source roles or an invalid observed interval', () => {
  const anchor = action(10, 20, { kind: 'chapter' });
  for (const patch of [{ subjectTrackId: 'b', partnerTrackId: 'a' }, { startTime: null }, { startTime: -1 }]) {
    const intro = action(5, 10, patch);
    assert.equal(matchSceneIntroductions([intro, anchor], [{ action: anchor, sceneId: 'main' }], eligible).size, 0);
  }
});

test('dialogue, cast changes, unverified data, scene conflicts and long gaps bound introductions', () => {
  for (const extra of [{ kind: 'dialogue' }, { partnerTrackId: 'c' }, { sourceVerified: false },
    { confidence: .2 }, { confidence: undefined }, { adultSceneId: 'other' }, { endTime: 4 }]) {
    const first = action(0, 2), boundary = action(2, 10, extra), anchor = action(50, 60, { kind: 'chapter' });
    assert.equal(matchSceneIntroductions([first, boundary, anchor], [{ action: anchor, sceneId: 'main' }], eligible).size, 0);
  }
});

test('source membership follows exact intervals, including returns, but never broad parent gaps', () => {
  const position = { id: 'one', sourceVerified: true, startTime: 0, endTime: 200, sourceRanges: [
    { startTime: 10, endTime: 20 }, { startTime: 90, endTime: 100 }] };
  for (const time of [10, 15, 90, 95]) assert.equal(sourcePositionAtTime([position], time), position);
  for (const time of [0, 20, 50, 100, NaN]) assert.equal(sourcePositionAtTime([position], time), null);
  assert.equal(sourcePositionAtTime([{ startTime: 0, endTime: 200 }], 50), null);
});

test('source boundary never reveals unverified groups or rejected ranges', () => {
  const range = { id: 'source', startTime: 10, endTime: 20 };
  for (const sourceVerified of [undefined, false, 'true']) {
    assert.equal(sourcePositionAtTime([{ id: 'one', sourceVerified, sourceRanges: [range] }], 15), null);
  }
  assert.equal(sourcePositionAtTime([{ id: 'one', sourceVerified: true,
    sourceRanges: [{ ...range, sourceVerified: false }] }], 15), null);
});

test('the first verified opening interval is retained with the same cast and adjacent source boundaries', () => {
  const rows = [action(0, 45), action(45, 90), action(90, 130),
    action(130, 150, { kind: 'chapter' })];
  const before = JSON.stringify(rows);
  const result = matchSceneIntroductions(rows, [{ action: rows[3], sceneId: 'chapter' }], eligible);
  assert.equal(result.get(rows[0]), 'chapter');
  assert.equal(JSON.stringify(rows), before);
  rows[1].partnerTrackId = 'other';
  assert.equal(matchSceneIntroductions(rows, [{ action: rows[3], sceneId: 'chapter' }], eligible).has(rows[0]), false);
});
