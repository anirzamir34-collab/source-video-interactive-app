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
