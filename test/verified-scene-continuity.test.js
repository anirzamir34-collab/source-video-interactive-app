import test from 'node:test';
import assert from 'node:assert/strict';
import { sameVerifiedSourceRun, assignVerifiedOpeningRoles } from '../public/verified-scene-continuity.js';
import { positionOccurrenceGroups, movementsForPositionOccurrence } from '../public/adult-gameplay.js';

const clip = (id, startTime, endTime) => ({ id, sourceVerified: true, startTime, endTime });
const movement = (id, startTime, endTime, extra = {}) => ({
  id, sourceVerified: true, sourcePositionId: 'occ-3',
  loopStartTime: startTime, loopEndTime: endTime, startTime, endTime, ...extra
});

test('three evidence-identical cut-separated clips share one logical occurrence, never the unobserved gaps', () => {
  const position = {
    id: 'rear', sourceVerified: true,
    sourceRanges: [clip('occ-3', 237.553, 256.749), clip('occ-3', 259.149, 275.945),
      clip('occ-3', 278.345, 287.943)],
    movements: [movement('a', 237.553, 256.749),movement('b', 259.149, 275.945),
      movement('c', 278.345, 287.943)]
  };
  const groups = positionOccurrenceGroups(position);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceRanges.length, 3);
  assert.deepEqual(groups[0].sourceRanges.map(row => [row.startTime, row.endTime]),
    [[237.553, 256.749],[259.149, 275.945],[278.345, 287.943]]);
  assert.deepEqual(movementsForPositionOccurrence(position, groups[0].id).map(row => row.id), ['a','b','c']);
});

test('identical scene labels cannot join distinct source identities, even across a very short cut', () => {
  assert.equal(sameVerifiedSourceRun(clip('a', 10, 20),clip('b', 20.1, 29)),false);
  assert.equal(sameVerifiedSourceRun(clip('a', 10, 20),clip('a', 100, 120)),false);
  assert.equal(sameVerifiedSourceRun(clip('a', 10, 20),clip('a', 22.4, 30)),true);
  assert.equal(sameVerifiedSourceRun(clip('', 10, 20),clip('', 22, 30)),false);
  assert.equal(sameVerifiedSourceRun(clip('a', 10, 10),clip('a', 11, 12)),false);
});

test('one provider ID reused after a distant discontinuity retains independent occurrences', () => {
  const position = { sourceRanges: [clip('same', 10, 20),clip('same', 90, 100)] };
  const groups = positionOccurrenceGroups(position);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].id, groups[1].id);
});

test('ordinary pose and early preparation actions precede first motion-backed core', () => {
  const items = [
    { id:'seated',familyId:'seated-facing',startTime:223,
      movements:[{sourceVerified:true,movementTempo:'unclear',movementType:'posture'}] },
    { id:'warmup',familyId:'oral',startTime:230,
      movements:[{sourceVerified:true,movementTempo:'moderate'}] },
    { id:'core',familyId:'rear',startTime:237,
      movements:[{sourceVerified:true,movementTempo:'moderate'}] },
    { id:'return',familyId:'oral',startTime:280,
      movements:[{sourceVerified:true,movementTempo:'moderate'}] }
  ];
  const classified=assignVerifiedOpeningRoles(items);
  assert.deepEqual(classified.map(x=>x.progressionRole),['foreplay','foreplay','core','core'],
    'opening oral/manual belong to the first approach panel');
  assert.equal(items[0].progressionRole,undefined,'classification must not mutate providers');
});

test('a sole verified pose remains available when no clearer core evidence exists', () => {
  const items=[{id:'alone',familyId:'seated-facing',startTime:9,
    movements:[{sourceVerified:true,movementTempo:'unclear'}]}];
  assert.equal(assignVerifiedOpeningRoles(items)[0].progressionRole,'core');
});
