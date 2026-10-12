// Historical occurrence regression oracle; production behavior uses gameplay-v2.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const oldSource = fs.readFileSync(new URL('./fixtures/legacy-gameplay-reference.txt', import.meta.url), 'utf8');

test('unlocked canonical position renders movements only from one continuous occurrence', () => {
  assert.match(oldSource, /const nextForwardOccurrence = occurrences\.find\(group => Number\(group\.startTime\) >= cursor - 0\.25[\s\S]*?const targetOccurrence = requestedOccurrence \|\| containingOccurrence \|\| nextForwardOccurrence \|\| retainedOccurrence/);
  assert.match(oldSource, /const occurrenceMovements = targetOccurrence[\s\S]*?movementsForPositionOccurrence\(position, targetOccurrence\.id\)/);
  assert.match(oldSource, /const localMovements = unlockedCore \? verifiedPositionMovements/);
});

test('panel family consolidation keeps distant source occurrences separate', () => {
  assert.match(oldSource, /consolidateVerifiedPositions\(scene\.positions, \{[\s\S]*?mergeDistantReturns: false[\s\S]*?\}\)/);
});


test('foreplay-only adult fragments survive until they can merge with the first core position', () => {
  assert.match(oldSource, /if \(!positions\.length\) \{[\s\S]*?verifiedForeplay[\s\S]*?foreplay: verifiedForeplay[\s\S]*?positions: \[\]/);
  assert.match(oldSource, /\.filter\(scene => scene\.positions\.length \|\| scene\.foreplay\.length\)/);
  assert.match(oldSource, /mergeAdultSceneFragments\([\s\S]*?\)\.filter\(scene => scene\.positions\?\.length \|\| scene\.foreplay\?\.length\)/);
});

test('first intimate approach uses its own overlay instead of the core panel or dialogue choices', () => {
  assert.match(oldSource, /const target = dialogueOnly \? els\.choices : els\.approachChoices/);
  // The card renderer, not a parallel timestamp guess, chooses the surface.
  assert.match(oldSource, /const selectedSurface = renderAdultApproachChoices\(scene, laterOverlay\)/);
  assert.match(oldSource, /setSurface\(selectedSurface\)/);
  assert.match(oldSource, /surface: 'story'/);
  assert.doesNotMatch(oldSource, /nextApproachSurface/);
});
