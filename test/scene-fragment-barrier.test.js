import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
const end = source.indexOf('\nfunction prepareAdultScenes()', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

const chapter = (id, startTime, endTime) => ({ id, startTime, endTime,
  postSceneTime: endTime, foreplay: [], positions: [], outcomes: [] });

test('an excluded source interval separates nearby interactive chapters', () => {
  const scenes = [chapter('first', 10, 20), chapter('second', 35, 45)];
  assert.equal(context.mergeAdultSceneFragments(scenes).length, 1);
  assert.equal(context.mergeAdultSceneFragments(scenes, [], [{ startTime: 22, endTime: 33 }]).length, 2);
});

test('a distant return and verified intervening dialogue keep chapters separate', () => {
  const first = chapter('first', 10, 20);
  const distant = chapter('distant', 60, 70);
  assert.equal(context.mergeAdultSceneFragments([first, distant]).length, 2);
  const nearby = chapter('nearby', 30, 40);
  assert.equal(context.mergeAdultSceneFragments([first, nearby], [{
    sourceVerified: true, actionType: 'dialogue', startTime: 22, endTime: 26
  }]).length, 2);
});

test('adjacent same-pair chapters merge despite different redundant participant lists', () => {
  const clip = (startTime, endTime, participantTrackIds = []) => ({
    startTime, endTime, sourceVerified: true, familyId: 'oral',
    subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A',
    participantTrackIds, groupScene: false
  });
  // Real Android diagnosis: the opening at 71.5–188 had no CORE group,
  // while the next 188–884.8 chapter had the first CORE position.
  const opening = { ...chapter('adult-scene-001', 71.5, 188),
    foreplay: [clip(71.5, 110.6, ['MAIN_MALE', 'PARTNER_A'])],
    positions: [clip(110.6, 188, ['MAIN_MALE', 'PARTNER_A'])] };
  const continuing = { ...chapter('adult-001', 188, 884.8),
    positions: [{ ...clip(188, 387.1, []), familyId: 'oral' },
      { ...clip(387.1, 769.6, ['PARTNER_A']), familyId: 'standing-rear' }] };
  const result = context.mergeAdultSceneFragments([opening, continuing]);
  assert.equal(result.length, 1);
  assert.equal(result[0].startTime, 71.5);
  assert.equal(result[0].endTime, 884.8);
  assert.deepEqual(Array.from(result[0].positions, item => [item.startTime, item.endTime]),
    [[110.6, 188], [188, 387.1], [387.1, 769.6]]);
  assert.deepEqual(Array.from(result[0].sourceSceneIds), ['adult-scene-001', 'adult-001']);
});

test('an actually different partner and group cast still separate chapters', () => {
  const pair = (partnerTrackId, participantTrackIds = [], groupScene = false) => ({
    subjectTrackId: 'MAIN_MALE', partnerTrackId, participantTrackIds,
    groupScene, sourceVerified: true, startTime: 10, endTime: 20
  });
  const a = { ...chapter('a', 10, 20), positions: [pair('PARTNER_A')] };
  const different = { ...chapter('b', 20, 30),
    positions: [{ ...pair('PARTNER_B'), startTime: 20, endTime: 30 }] };
  assert.equal(context.mergeAdultSceneFragments([a, different]).length, 2);
  const group = { ...chapter('group', 20, 30),
    positions: [{ ...pair('PARTNER_A', ['PARTNER_A', 'PARTNER_B'], true),
      startTime: 20, endTime: 30 }] };
  assert.equal(context.mergeAdultSceneFragments([a, group]).length, 2);
});
